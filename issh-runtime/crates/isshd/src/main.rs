use issh_runtime_pane::{PaneOpenSpec, PaneStore, MAX_PANE_BATCH_BYTES};
use issh_runtime_protocol::{
    HealthResult, RpcError, RpcErrorResponse, RpcRequest, RpcResponse, INVALID_PARAMS,
    INVALID_REQUEST, MAX_MESSAGE_BYTES, MESSAGE_TOO_LARGE, METHOD_NOT_FOUND, PARSE_ERROR,
    PROTOCOL_VERSION,
};
use issh_runtime_session::{LocalSessionSpec, SessionStore, MAX_SESSION_BATCH_BYTES};
use issh_runtime_ssh::{SshConnection, SshConnectionSpec};
use issh_runtime_workspace::{SessionSnapshot, WorkspaceStore};
use serde::de::DeserializeOwned;
use serde::Deserialize;
use serde_json::Value;
use std::env;
use std::io;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

#[cfg(windows)]
mod windows_security;

const DEFAULT_PIPE_NAME: &str = r"\\.\pipe\issh-runtime-v1";

#[derive(Debug)]
struct Options {
    pipe_name: String,
    database_path: PathBuf,
    once: bool,
}

struct RuntimeState {
    started_at_unix_ms: u128,
    panes: Mutex<PaneStore>,
    sessions: Mutex<SessionStore>,
    workspace: Mutex<WorkspaceStore>,
}

impl RuntimeState {
    fn open(
        started_at_unix_ms: u128,
        database_path: &std::path::Path,
    ) -> Result<Self, issh_runtime_workspace::WorkspaceError> {
        Ok(Self {
            started_at_unix_ms,
            panes: Mutex::new(PaneStore::new()),
            sessions: Mutex::new(SessionStore::new()),
            workspace: Mutex::new(WorkspaceStore::open(database_path, now_unix_ms())?),
        })
    }

    #[cfg(test)]
    fn in_memory(started_at_unix_ms: u128) -> Self {
        Self {
            started_at_unix_ms,
            panes: Mutex::new(PaneStore::new()),
            sessions: Mutex::new(SessionStore::new()),
            workspace: Mutex::new(
                WorkspaceStore::open_in_memory(now_unix_ms())
                    .expect("in-memory workspace should open"),
            ),
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionSyncParams {
    sessions: Vec<SessionSnapshot>,
}

#[derive(Deserialize)]
struct WorkspaceCreateParams {
    name: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceBindingParams {
    workspace_id: String,
    session_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceIdParams {
    workspace_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentRegisterParams {
    workspace_id: String,
    name: String,
    adapter: Option<String>,
    session_id: Option<String>,
    scopes: Option<Vec<String>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentAuthorizeParams {
    agent_id: String,
    scope: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentPromptParams {
    agent_id: String,
    prompt: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TaskIdParams {
    task_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TaskCompleteParams {
    task_id: String,
    output: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TaskFailParams {
    task_id: String,
    error: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct EventListParams {
    workspace_id: String,
    #[serde(default)]
    after_sequence: i64,
    #[serde(default = "default_event_limit")]
    limit: usize,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PaneOpenParams {
    id: String,
    workspace_id: String,
    session_id: String,
    title: String,
    columns: u16,
    rows: u16,
    producer_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PaneIdParams {
    pane_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PaneProducerParams {
    pane_id: String,
    producer_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PaneClaimParams {
    pane_id: String,
    owner_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PaneReleaseParams {
    pane_id: String,
    owner_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PaneWriteParams {
    pane_id: String,
    owner_id: String,
    data: Vec<u8>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PaneResizeParams {
    pane_id: String,
    actor_id: String,
    columns: u16,
    rows: u16,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PanePushOutputParams {
    pane_id: String,
    producer_id: String,
    data: Vec<u8>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PaneSubscribeParams {
    pane_id: String,
    #[serde(default)]
    after_sequence: u64,
    #[serde(default = "default_pane_max_events")]
    max_events: usize,
    #[serde(default = "default_pane_max_bytes")]
    max_bytes: usize,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LocalSessionOpenParams {
    #[serde(default = "default_local_session_title")]
    title: String,
    cwd: Option<PathBuf>,
    #[serde(default = "default_session_columns")]
    columns: u16,
    #[serde(default = "default_session_rows")]
    rows: u16,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionIdParams {
    session_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionWriteParams {
    session_id: String,
    data: Vec<u8>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionResizeParams {
    session_id: String,
    columns: u16,
    rows: u16,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionSubscribeParams {
    session_id: String,
    #[serde(default)]
    after_sequence: u64,
    #[serde(default = "default_session_max_events")]
    max_events: usize,
    #[serde(default = "default_session_max_bytes")]
    max_bytes: usize,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SshProbeParams {
    host: String,
    port: u16,
    username: String,
    password: Option<String>,
    private_key_path: Option<PathBuf>,
    private_key_passphrase: Option<String>,
    expected_host_key: String,
}

fn default_local_session_title() -> String {
    "本地终端".to_string()
}

fn default_session_columns() -> u16 {
    120
}

fn default_session_rows() -> u16 {
    36
}

fn default_session_max_events() -> usize {
    64
}

fn default_session_max_bytes() -> usize {
    MAX_SESSION_BATCH_BYTES
}

fn default_pane_max_events() -> usize {
    64
}

fn default_pane_max_bytes() -> usize {
    MAX_PANE_BATCH_BYTES
}

fn default_event_limit() -> usize {
    100
}

impl Options {
    fn parse() -> Result<Self, String> {
        let mut pipe_name = env::var("ISSH_RUNTIME_PIPE")
            .ok()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| DEFAULT_PIPE_NAME.to_string());
        let mut database_path = env::var_os("ISSH_RUNTIME_DATABASE")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("issh-runtime.sqlite3"));
        let mut once = false;
        let mut args = env::args().skip(1);

        while let Some(arg) = args.next() {
            match arg.as_str() {
                "--pipe" => {
                    pipe_name = args
                        .next()
                        .filter(|value| !value.trim().is_empty())
                        .ok_or_else(|| "--pipe requires a non-empty value".to_string())?;
                }
                "--database" => {
                    database_path = args
                        .next()
                        .filter(|value| !value.trim().is_empty())
                        .map(PathBuf::from)
                        .ok_or_else(|| "--database requires a non-empty value".to_string())?;
                }
                "--once" => once = true,
                "--help" | "-h" => {
                    println!("Usage: isshd [--pipe <name>] [--database <path>] [--once]");
                    std::process::exit(0);
                }
                unknown => return Err(format!("Unknown argument: {unknown}")),
            }
        }

        Ok(Self {
            pipe_name,
            database_path,
            once,
        })
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let options =
        Options::parse().map_err(|message| io::Error::new(io::ErrorKind::InvalidInput, message))?;
    let started_at_unix_ms = SystemTime::now().duration_since(UNIX_EPOCH)?.as_millis();
    if let Some(parent) = options
        .database_path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
    {
        std::fs::create_dir_all(parent)?;
    }
    let state = Arc::new(RuntimeState::open(
        started_at_unix_ms,
        &options.database_path,
    )?);

    run(options, state).await?;
    Ok(())
}

#[cfg(windows)]
async fn run(options: Options, state: Arc<RuntimeState>) -> io::Result<()> {
    use tokio::net::windows::named_pipe::{NamedPipeServer, ServerOptions};

    fn create_pipe(pipe_name: &str, first: bool) -> io::Result<NamedPipeServer> {
        let mut security = windows_security::PipeSecurityAttributes::for_current_user()?;
        let mut options = ServerOptions::new();
        options
            .first_pipe_instance(first)
            .reject_remote_clients(true)
            .in_buffer_size((MAX_MESSAGE_BYTES + 1) as u32)
            .out_buffer_size((MAX_MESSAGE_BYTES + 1) as u32);
        // SAFETY: `security` owns both the SECURITY_ATTRIBUTES structure and
        // its descriptor for the duration of CreateNamedPipeW. Windows copies
        // the descriptor while creating the pipe.
        unsafe { options.create_with_security_attributes_raw(pipe_name, security.as_mut_ptr()) }
    }

    let mut server = create_pipe(&options.pipe_name, true)?;
    loop {
        server.connect().await?;
        if options.once {
            return handle_client(server, &state).await;
        }

        // Create the next listening instance before replying to this client.
        // Otherwise rapid sequential RPCs can land between pipe instances and
        // fail with ENOENT even though the Runtime process is healthy.
        let connected = server;
        server = create_pipe(&options.pipe_name, false)?;
        let client_state = Arc::clone(&state);
        tokio::spawn(async move {
            let _ = handle_client(connected, &client_state).await;
        });
    }
}

#[cfg(not(windows))]
async fn run(_options: Options, _state: Arc<RuntimeState>) -> io::Result<()> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "Phase 0 only implements Windows Named Pipe transport",
    ))
}

#[cfg(windows)]
async fn handle_client(
    mut server: tokio::net::windows::named_pipe::NamedPipeServer,
    state: &RuntimeState,
) -> io::Result<()> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let mut message = Vec::with_capacity(1024);
    let mut chunk = [0_u8; 1024];
    let mut oversized = false;

    loop {
        let read = server.read(&mut chunk).await?;
        if read == 0 {
            break;
        }
        if let Some(newline) = chunk[..read].iter().position(|byte| *byte == b'\n') {
            if message.len() + newline > MAX_MESSAGE_BYTES {
                oversized = true;
            } else {
                message.extend_from_slice(&chunk[..newline]);
            }
            break;
        }
        if message.len() + read > MAX_MESSAGE_BYTES {
            oversized = true;
            break;
        }
        message.extend_from_slice(&chunk[..read]);
    }

    let response = if oversized {
        serialize_error(Value::Null, MESSAGE_TOO_LARGE, "Message exceeds 64 KiB")
    } else {
        dispatch(&message, state).await
    };

    server.write_all(&response).await?;
    server.write_all(b"\n").await?;
    server.flush().await?;
    Ok(())
}

async fn dispatch(message: &[u8], state: &RuntimeState) -> Vec<u8> {
    let request = match serde_json::from_slice::<RpcRequest>(message) {
        Ok(request) => request,
        Err(_) => return serialize_error(Value::Null, PARSE_ERROR, "Invalid JSON"),
    };

    let id = request.id.clone();
    if let Err(error) = request.validate() {
        return serialize_error(id, error.code, error.message);
    }

    if request
        .params
        .as_ref()
        .is_some_and(|params| !params.is_object() && !params.is_null())
    {
        return serialize_error(id, INVALID_REQUEST, "params must be an object or null");
    }

    match request.method.as_str() {
        "runtime.health" => serde_json::to_vec(&RpcResponse::new(
            id,
            HealthResult {
                protocol_version: PROTOCOL_VERSION,
                runtime_version: env!("CARGO_PKG_VERSION"),
                pid: std::process::id(),
                started_at_unix_ms: state.started_at_unix_ms,
                capabilities: vec![
                    "runtime.health",
                    "session.sync",
                    "session.list",
                    "session.openLocal",
                    "session.snapshot",
                    "session.write",
                    "session.resize",
                    "session.subscribe",
                    "session.close",
                    "ssh.probe",
                    "workspace.create",
                    "workspace.list",
                    "workspace.bind",
                    "workspace.unbind",
                    "agent.register",
                    "agent.list",
                    "agent.authorize",
                    "task.prompt",
                    "task.start",
                    "task.wait",
                    "task.read",
                    "task.list",
                    "task.cancel",
                    "task.complete",
                    "task.fail",
                    "event.list",
                    "pane.list",
                    "pane.open",
                    "pane.snapshot",
                    "pane.close",
                    "pane.claimInput",
                    "pane.releaseInput",
                    "pane.write",
                    "pane.resize",
                    "pane.pushOutput",
                    "pane.subscribe",
                ],
            },
        ))
        .expect("health response serialization cannot fail"),
        "session.sync" => {
            let params = match parse_params::<SessionSyncParams>(request.params) {
                Ok(params) => params,
                Err(error) => return serialize_error(id, error.code, error.message),
            };
            with_workspace(state, id, |workspace| {
                workspace.sync_sessions(params.sessions, now_unix_ms())
            })
        }
        "session.list" => with_workspace(state, id, |workspace| {
            Ok::<_, issh_runtime_workspace::WorkspaceError>(workspace.list_sessions())
        }),
        "session.openLocal" => {
            let params = match parse_params::<LocalSessionOpenParams>(request.params) {
                Ok(params) => params,
                Err(error) => return serialize_error(id, error.code, error.message),
            };
            with_sessions(state, id, |sessions| {
                sessions.open_local(LocalSessionSpec {
                    title: params.title,
                    cwd: params.cwd,
                    columns: params.columns,
                    rows: params.rows,
                })
            })
        }
        "session.snapshot" => {
            let params = match parse_params::<SessionIdParams>(request.params) {
                Ok(params) => params,
                Err(error) => return serialize_error(id, error.code, error.message),
            };
            with_sessions(state, id, |sessions| sessions.snapshot(&params.session_id))
        }
        "session.write" => {
            let params = match parse_params::<SessionWriteParams>(request.params) {
                Ok(params) => params,
                Err(error) => return serialize_error(id, error.code, error.message),
            };
            with_sessions(state, id, |sessions| {
                sessions.write(&params.session_id, params.data)
            })
        }
        "session.resize" => {
            let params = match parse_params::<SessionResizeParams>(request.params) {
                Ok(params) => params,
                Err(error) => return serialize_error(id, error.code, error.message),
            };
            with_sessions(state, id, |sessions| {
                sessions.resize(&params.session_id, params.columns, params.rows)
            })
        }
        "session.subscribe" => {
            let params = match parse_params::<SessionSubscribeParams>(request.params) {
                Ok(params) => params,
                Err(error) => return serialize_error(id, error.code, error.message),
            };
            with_sessions(state, id, |sessions| {
                sessions.subscribe(
                    &params.session_id,
                    params.after_sequence,
                    params.max_events,
                    params.max_bytes,
                )
            })
        }
        "session.close" => {
            let params = match parse_params::<SessionIdParams>(request.params) {
                Ok(params) => params,
                Err(error) => return serialize_error(id, error.code, error.message),
            };
            with_sessions(state, id, |sessions| sessions.close(&params.session_id))
        }
        "ssh.probe" => {
            let params = match parse_params::<SshProbeParams>(request.params) {
                Ok(params) => params,
                Err(error) => return serialize_error(id, error.code, error.message),
            };
            let connection = match SshConnection::connect(SshConnectionSpec {
                host: params.host,
                port: params.port,
                username: params.username,
                password: params.password,
                private_key_path: params.private_key_path,
                private_key_passphrase: params.private_key_passphrase,
                expected_host_key: params.expected_host_key,
            })
            .await
            {
                Ok(connection) => connection,
                Err(error) => return serialize_error(id, INVALID_PARAMS, error.to_string()),
            };
            if let Err(error) = connection.disconnect().await {
                return serialize_error(id, -32603, error.to_string());
            }
            serde_json::to_vec(&RpcResponse::new(
                id,
                serde_json::json!({ "connected": true }),
            ))
            .expect("SSH probe response serialization cannot fail")
        }
        "pane.list" => with_panes(state, id, |panes| {
            Ok::<_, issh_runtime_pane::PaneError>(panes.list())
        }),
        "pane.open" => {
            let params = match parse_params::<PaneOpenParams>(request.params) {
                Ok(params) => params,
                Err(error) => return serialize_error(id, error.code, error.message),
            };
            with_panes(state, id, |panes| {
                panes.open(PaneOpenSpec {
                    id: params.id,
                    workspace_id: params.workspace_id,
                    session_id: params.session_id,
                    title: params.title,
                    columns: params.columns,
                    rows: params.rows,
                    producer_id: params.producer_id,
                })
            })
        }
        "pane.snapshot" => {
            let params = match parse_params::<PaneIdParams>(request.params) {
                Ok(params) => params,
                Err(error) => return serialize_error(id, error.code, error.message),
            };
            with_panes(state, id, |panes| panes.snapshot(&params.pane_id))
        }
        "pane.close" => {
            let params = match parse_params::<PaneProducerParams>(request.params) {
                Ok(params) => params,
                Err(error) => return serialize_error(id, error.code, error.message),
            };
            with_panes(state, id, |panes| {
                panes.close(&params.pane_id, &params.producer_id)
            })
        }
        "pane.claimInput" => {
            let params = match parse_params::<PaneClaimParams>(request.params) {
                Ok(params) => params,
                Err(error) => return serialize_error(id, error.code, error.message),
            };
            with_panes(state, id, |panes| {
                panes.claim_input(&params.pane_id, params.owner_id)
            })
        }
        "pane.releaseInput" => {
            let params = match parse_params::<PaneReleaseParams>(request.params) {
                Ok(params) => params,
                Err(error) => return serialize_error(id, error.code, error.message),
            };
            with_panes(state, id, |panes| {
                panes.release_input(&params.pane_id, &params.owner_id)
            })
        }
        "pane.write" => {
            let params = match parse_params::<PaneWriteParams>(request.params) {
                Ok(params) => params,
                Err(error) => return serialize_error(id, error.code, error.message),
            };
            with_panes(state, id, |panes| {
                panes.write(&params.pane_id, &params.owner_id, params.data)
            })
        }
        "pane.resize" => {
            let params = match parse_params::<PaneResizeParams>(request.params) {
                Ok(params) => params,
                Err(error) => return serialize_error(id, error.code, error.message),
            };
            with_panes(state, id, |panes| {
                panes.resize(
                    &params.pane_id,
                    &params.actor_id,
                    params.columns,
                    params.rows,
                )
            })
        }
        "pane.pushOutput" => {
            let params = match parse_params::<PanePushOutputParams>(request.params) {
                Ok(params) => params,
                Err(error) => return serialize_error(id, error.code, error.message),
            };
            with_panes(state, id, |panes| {
                panes.push_output(&params.pane_id, &params.producer_id, params.data)
            })
        }
        "pane.subscribe" => {
            let params = match parse_params::<PaneSubscribeParams>(request.params) {
                Ok(params) => params,
                Err(error) => return serialize_error(id, error.code, error.message),
            };
            with_panes(state, id, |panes| {
                panes.subscribe(
                    &params.pane_id,
                    params.after_sequence,
                    params.max_events,
                    params.max_bytes,
                )
            })
        }
        "workspace.create" => {
            let params = match parse_params::<WorkspaceCreateParams>(request.params) {
                Ok(params) => params,
                Err(error) => return serialize_error(id, error.code, error.message),
            };
            with_workspace(state, id, |workspace| {
                workspace.create_workspace(params.name, now_unix_ms())
            })
        }
        "workspace.list" => with_workspace(state, id, |workspace| workspace.list_workspaces()),
        "workspace.bind" => {
            let params = match parse_params::<WorkspaceBindingParams>(request.params) {
                Ok(params) => params,
                Err(error) => return serialize_error(id, error.code, error.message),
            };
            with_workspace(state, id, |workspace| {
                workspace.bind(&params.workspace_id, &params.session_id, now_unix_ms())
            })
        }
        "workspace.unbind" => {
            let params = match parse_params::<WorkspaceBindingParams>(request.params) {
                Ok(params) => params,
                Err(error) => return serialize_error(id, error.code, error.message),
            };
            with_workspace(state, id, |workspace| {
                workspace.unbind(&params.workspace_id, &params.session_id, now_unix_ms())
            })
        }
        "agent.register" => {
            let params = match parse_params::<AgentRegisterParams>(request.params) {
                Ok(params) => params,
                Err(error) => return serialize_error(id, error.code, error.message),
            };
            with_workspace(state, id, |workspace| {
                workspace.register_agent(
                    &params.workspace_id,
                    params.name,
                    params.adapter.unwrap_or_else(|| "llm".to_string()),
                    params.session_id,
                    params.scopes,
                    now_unix_ms(),
                )
            })
        }
        "agent.list" => {
            let params = match parse_params::<WorkspaceIdParams>(request.params) {
                Ok(params) => params,
                Err(error) => return serialize_error(id, error.code, error.message),
            };
            with_workspace(state, id, |workspace| {
                workspace.list_agents(&params.workspace_id)
            })
        }
        "agent.authorize" => {
            let params = match parse_params::<AgentAuthorizeParams>(request.params) {
                Ok(params) => params,
                Err(error) => return serialize_error(id, error.code, error.message),
            };
            with_workspace(state, id, |workspace| {
                workspace.authorize_agent(&params.agent_id, &params.scope, now_unix_ms())
            })
        }
        "task.prompt" => {
            let params = match parse_params::<AgentPromptParams>(request.params) {
                Ok(params) => params,
                Err(error) => return serialize_error(id, error.code, error.message),
            };
            with_workspace(state, id, |workspace| {
                workspace.create_task(&params.agent_id, params.prompt, now_unix_ms())
            })
        }
        "task.start" => {
            task_operation::<TaskIdParams, _, _>(state, id, request.params, |workspace, params| {
                workspace.start_task(&params.task_id, now_unix_ms())
            })
        }
        "task.wait" => {
            task_operation::<TaskIdParams, _, _>(state, id, request.params, |workspace, params| {
                workspace.wait_task(&params.task_id)
            })
        }
        "task.read" => {
            task_operation::<TaskIdParams, _, _>(state, id, request.params, |workspace, params| {
                workspace.get_task(&params.task_id)
            })
        }
        "task.list" => {
            let params = match parse_params::<WorkspaceIdParams>(request.params) {
                Ok(params) => params,
                Err(error) => return serialize_error(id, error.code, error.message),
            };
            with_workspace(state, id, |workspace| {
                workspace.list_tasks(&params.workspace_id)
            })
        }
        "task.cancel" => {
            task_operation::<TaskIdParams, _, _>(state, id, request.params, |workspace, params| {
                workspace.cancel_task(&params.task_id, now_unix_ms())
            })
        }
        "task.complete" => task_operation::<TaskCompleteParams, _, _>(
            state,
            id,
            request.params,
            |workspace, params| {
                workspace.complete_task(&params.task_id, params.output, now_unix_ms())
            },
        ),
        "task.fail" => task_operation::<TaskFailParams, _, _>(
            state,
            id,
            request.params,
            |workspace, params| workspace.fail_task(&params.task_id, params.error, now_unix_ms()),
        ),
        "event.list" => {
            let params = match parse_params::<EventListParams>(request.params) {
                Ok(params) => params,
                Err(error) => return serialize_error(id, error.code, error.message),
            };
            with_workspace(state, id, |workspace| {
                workspace.list_events(&params.workspace_id, params.after_sequence, params.limit)
            })
        }
        _ => serialize_error(id, METHOD_NOT_FOUND, "Method not found"),
    }
}

fn task_operation<P, T, F>(
    state: &RuntimeState,
    id: Value,
    params: Option<Value>,
    operation: F,
) -> Vec<u8>
where
    P: DeserializeOwned,
    T: serde::Serialize,
    F: FnOnce(&mut WorkspaceStore, P) -> Result<T, issh_runtime_workspace::WorkspaceError>,
{
    let params = match parse_params::<P>(params) {
        Ok(params) => params,
        Err(error) => return serialize_error(id, error.code, error.message),
    };
    with_workspace(state, id, |workspace| operation(workspace, params))
}

fn parse_params<T: DeserializeOwned>(params: Option<Value>) -> Result<T, RpcError> {
    serde_json::from_value(params.unwrap_or_else(|| Value::Object(Default::default())))
        .map_err(|error| RpcError::new(INVALID_PARAMS, format!("Invalid params: {error}")))
}

fn with_panes<T, F>(state: &RuntimeState, id: Value, operation: F) -> Vec<u8>
where
    T: serde::Serialize,
    F: FnOnce(&mut PaneStore) -> Result<T, issh_runtime_pane::PaneError>,
{
    let mut panes = match state.panes.lock() {
        Ok(panes) => panes,
        Err(_) => return serialize_error(id, -32603, "Pane state is unavailable"),
    };
    match operation(&mut panes) {
        Ok(result) => serde_json::to_vec(&RpcResponse::new(id, result))
            .expect("pane response serialization cannot fail"),
        Err(error) => serialize_error(id, INVALID_PARAMS, error.to_string()),
    }
}

fn with_sessions<T, F>(state: &RuntimeState, id: Value, operation: F) -> Vec<u8>
where
    T: serde::Serialize,
    F: FnOnce(&mut SessionStore) -> Result<T, issh_runtime_session::SessionError>,
{
    let mut sessions = match state.sessions.lock() {
        Ok(sessions) => sessions,
        Err(_) => return serialize_error(id, -32603, "Session state is unavailable"),
    };
    match operation(&mut sessions) {
        Ok(result) => serde_json::to_vec(&RpcResponse::new(id, result))
            .expect("session response serialization cannot fail"),
        Err(error) => serialize_error(id, INVALID_PARAMS, error.to_string()),
    }
}

fn with_workspace<T, F>(state: &RuntimeState, id: Value, operation: F) -> Vec<u8>
where
    T: serde::Serialize,
    F: FnOnce(&mut WorkspaceStore) -> Result<T, issh_runtime_workspace::WorkspaceError>,
{
    let mut workspace = match state.workspace.lock() {
        Ok(workspace) => workspace,
        Err(_) => return serialize_error(id, -32603, "Workspace state is unavailable"),
    };
    match operation(&mut workspace) {
        Ok(result) => serde_json::to_vec(&RpcResponse::new(id, result))
            .expect("workspace response serialization cannot fail"),
        Err(error) => serialize_error(id, INVALID_PARAMS, error.to_string()),
    }
}

fn now_unix_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

fn serialize_error(id: Value, code: i32, message: impl Into<String>) -> Vec<u8> {
    serde_json::to_vec(&RpcErrorResponse::new(id, RpcError::new(code, message)))
        .expect("error response serialization cannot fail")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state() -> RuntimeState {
        RuntimeState::in_memory(123)
    }

    #[tokio::test]
    async fn dispatches_health() {
        let response = dispatch(
            br#"{"jsonrpc":"2.0","id":"health","method":"runtime.health","params":{}}"#,
            &state(),
        )
        .await;
        let value: Value = serde_json::from_slice(&response).expect("response should be JSON");

        assert_eq!(value["id"], "health");
        assert_eq!(value["result"]["protocolVersion"], PROTOCOL_VERSION);
        assert!(value["result"]["capabilities"]
            .as_array()
            .expect("capabilities should be an array")
            .contains(&Value::String("workspace.bind".to_string())));
    }

    #[tokio::test]
    async fn returns_parse_error_for_invalid_json() {
        let response = dispatch(b"not-json", &state()).await;
        let value: Value = serde_json::from_slice(&response).expect("response should be JSON");
        assert_eq!(value["error"]["code"], PARSE_ERROR);
    }

    #[tokio::test]
    async fn returns_method_not_found() {
        let response = dispatch(
            br#"{"jsonrpc":"2.0","id":9,"method":"missing.method"}"#,
            &state(),
        )
        .await;
        let value: Value = serde_json::from_slice(&response).expect("response should be JSON");
        assert_eq!(value["id"], 9);
        assert_eq!(value["error"]["code"], METHOD_NOT_FOUND);
    }

    #[tokio::test]
    async fn syncs_session_and_binds_workspace() {
        let state = state();
        let sync = dispatch(
            br#"{"jsonrpc":"2.0","id":1,"method":"session.sync","params":{"sessions":[{"id":"tab-1","title":"SSH","customTitle":null,"active":true,"focused":true,"profileType":"ssh","profileName":"server","profileId":"profile-1","host":"example.test","user":"developer","port":22,"connected":true}]}}"#,
            &state,
        )
        .await;
        let sync: Value = serde_json::from_slice(&sync).expect("sync should return JSON");
        assert_eq!(sync["result"]["sessionCount"], 1);

        let created = dispatch(
            br#"{"jsonrpc":"2.0","id":2,"method":"workspace.create","params":{"name":"Operations"}}"#,
            &state,
        )
        .await;
        let created: Value = serde_json::from_slice(&created).expect("create should return JSON");
        assert_eq!(created["result"]["id"], "workspace-1");

        let bound = dispatch(
            br#"{"jsonrpc":"2.0","id":3,"method":"workspace.bind","params":{"workspaceId":"workspace-1","sessionId":"tab-1"}}"#,
            &state,
        )
        .await;
        let bound: Value = serde_json::from_slice(&bound).expect("bind should return JSON");
        assert_eq!(bound["result"]["bindings"][0]["sessionId"], "tab-1");
    }

    #[tokio::test]
    async fn dispatches_pane_lifecycle_and_input_ownership() {
        let state = state();
        let opened = dispatch(
            br#"{"jsonrpc":"2.0","id":1,"method":"pane.open","params":{"id":"pane-1","workspaceId":"workspace-1","sessionId":"session-1","title":"Operations","columns":120,"rows":40,"producerId":"herdr-session"}}"#,
            &state,
        )
        .await;
        let opened: Value = serde_json::from_slice(&opened).expect("pane should open");
        assert_eq!(opened["result"]["state"], "attached");

        let claimed = dispatch(
            br#"{"jsonrpc":"2.0","id":2,"method":"pane.claimInput","params":{"paneId":"pane-1","ownerId":"agent-a"}}"#,
            &state,
        )
        .await;
        let claimed: Value = serde_json::from_slice(&claimed).expect("input should be claimed");
        assert_eq!(claimed["result"]["inputOwner"], "agent-a");

        let write = dispatch(
            br#"{"jsonrpc":"2.0","id":3,"method":"pane.write","params":{"paneId":"pane-1","ownerId":"agent-a","data":[27,91,65]}}"#,
            &state,
        )
        .await;
        let write: Value = serde_json::from_slice(&write).expect("write should return JSON");
        assert_eq!(write["result"]["acceptedBytes"], 3);

        let output = dispatch(
            br#"{"jsonrpc":"2.0","id":4,"method":"pane.pushOutput","params":{"paneId":"pane-1","producerId":"herdr-session","data":[0,255,27]}}"#,
            &state,
        )
        .await;
        let output: Value = serde_json::from_slice(&output).expect("output should return JSON");
        assert_eq!(output["result"]["data"], serde_json::json!([0, 255, 27]));

        let subscription = dispatch(
            br#"{"jsonrpc":"2.0","id":5,"method":"pane.subscribe","params":{"paneId":"pane-1","afterSequence":0,"maxEvents":10,"maxBytes":100}}"#,
            &state,
        )
        .await;
        let subscription: Value =
            serde_json::from_slice(&subscription).expect("subscription should return JSON");
        assert_eq!(subscription["result"]["events"][0]["sequence"], 1);
        assert_eq!(subscription["result"]["nextAfterSequence"], 1);
    }

    #[tokio::test]
    async fn rejects_pane_input_hijack() {
        let state = state();
        dispatch(
            br#"{"jsonrpc":"2.0","id":1,"method":"pane.open","params":{"id":"pane-1","workspaceId":"workspace-1","sessionId":"session-1","title":"Operations","columns":120,"rows":40,"producerId":"herdr-session"}}"#,
            &state,
        )
        .await;
        dispatch(
            br#"{"jsonrpc":"2.0","id":2,"method":"pane.claimInput","params":{"paneId":"pane-1","ownerId":"agent-a"}}"#,
            &state,
        )
        .await;
        let response = dispatch(
            br#"{"jsonrpc":"2.0","id":3,"method":"pane.claimInput","params":{"paneId":"pane-1","ownerId":"agent-b"}}"#,
            &state,
        )
        .await;
        let response: Value = serde_json::from_slice(&response).expect("response should be JSON");
        assert_eq!(response["error"]["code"], INVALID_PARAMS);
        assert!(response["error"]["message"]
            .as_str()
            .expect("error message")
            .contains("owned by agent-a"));
    }
}
