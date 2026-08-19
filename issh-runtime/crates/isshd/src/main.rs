use issh_runtime_protocol::{
    HealthResult, RpcError, RpcErrorResponse, RpcRequest, RpcResponse, INVALID_PARAMS,
    INVALID_REQUEST, MAX_MESSAGE_BYTES, MESSAGE_TOO_LARGE, METHOD_NOT_FOUND, PARSE_ERROR,
    PROTOCOL_VERSION,
};
use issh_runtime_workspace::{SessionSnapshot, WorkspaceStore};
use serde::de::DeserializeOwned;
use serde::Deserialize;
use serde_json::Value;
use std::env;
use std::io;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

#[cfg(windows)]
mod windows_security;

const DEFAULT_PIPE_NAME: &str = r"\\.\pipe\issh-runtime-v1";

#[derive(Debug)]
struct Options {
    pipe_name: String,
    once: bool,
}

struct RuntimeState {
    started_at_unix_ms: u128,
    workspace: Mutex<WorkspaceStore>,
}

impl RuntimeState {
    fn new(started_at_unix_ms: u128) -> Self {
        Self {
            started_at_unix_ms,
            workspace: Mutex::new(WorkspaceStore::default()),
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

impl Options {
    fn parse() -> Result<Self, String> {
        let mut pipe_name = env::var("ISSH_RUNTIME_PIPE")
            .ok()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| DEFAULT_PIPE_NAME.to_string());
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
                "--once" => once = true,
                "--help" | "-h" => {
                    println!("Usage: isshd [--pipe <name>] [--once]");
                    std::process::exit(0);
                }
                unknown => return Err(format!("Unknown argument: {unknown}")),
            }
        }

        Ok(Self { pipe_name, once })
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let options =
        Options::parse().map_err(|message| io::Error::new(io::ErrorKind::InvalidInput, message))?;
    let started_at_unix_ms = SystemTime::now().duration_since(UNIX_EPOCH)?.as_millis();
    let state = Arc::new(RuntimeState::new(started_at_unix_ms));

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

    let mut first = true;
    loop {
        let server = create_pipe(&options.pipe_name, first)?;
        first = false;
        server.connect().await?;
        handle_client(server, &state).await?;
        if options.once {
            return Ok(());
        }
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
        dispatch(&message, state)
    };

    server.write_all(&response).await?;
    server.write_all(b"\n").await?;
    server.flush().await?;
    Ok(())
}

fn dispatch(message: &[u8], state: &RuntimeState) -> Vec<u8> {
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
                    "workspace.create",
                    "workspace.list",
                    "workspace.bind",
                    "workspace.unbind",
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
                workspace.sync_sessions(params.sessions)
            })
        }
        "session.list" => with_workspace(state, id, |workspace| {
            Ok::<_, issh_runtime_workspace::WorkspaceError>(workspace.list_sessions())
        }),
        "workspace.create" => {
            let params = match parse_params::<WorkspaceCreateParams>(request.params) {
                Ok(params) => params,
                Err(error) => return serialize_error(id, error.code, error.message),
            };
            with_workspace(state, id, |workspace| {
                workspace.create_workspace(params.name, now_unix_ms())
            })
        }
        "workspace.list" => with_workspace(state, id, |workspace| {
            Ok::<_, issh_runtime_workspace::WorkspaceError>(workspace.list_workspaces())
        }),
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
                workspace.unbind(&params.workspace_id, &params.session_id)
            })
        }
        _ => serialize_error(id, METHOD_NOT_FOUND, "Method not found"),
    }
}

fn parse_params<T: DeserializeOwned>(params: Option<Value>) -> Result<T, RpcError> {
    serde_json::from_value(params.unwrap_or_else(|| Value::Object(Default::default())))
        .map_err(|error| RpcError::new(INVALID_PARAMS, format!("Invalid params: {error}")))
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

fn now_unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
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
        RuntimeState::new(123)
    }

    #[test]
    fn dispatches_health() {
        let response = dispatch(
            br#"{"jsonrpc":"2.0","id":"health","method":"runtime.health","params":{}}"#,
            &state(),
        );
        let value: Value = serde_json::from_slice(&response).expect("response should be JSON");

        assert_eq!(value["id"], "health");
        assert_eq!(value["result"]["protocolVersion"], PROTOCOL_VERSION);
        assert!(value["result"]["capabilities"]
            .as_array()
            .expect("capabilities should be an array")
            .contains(&Value::String("workspace.bind".to_string())));
    }

    #[test]
    fn returns_parse_error_for_invalid_json() {
        let response = dispatch(b"not-json", &state());
        let value: Value = serde_json::from_slice(&response).expect("response should be JSON");
        assert_eq!(value["error"]["code"], PARSE_ERROR);
    }

    #[test]
    fn returns_method_not_found() {
        let response = dispatch(
            br#"{"jsonrpc":"2.0","id":9,"method":"missing.method"}"#,
            &state(),
        );
        let value: Value = serde_json::from_slice(&response).expect("response should be JSON");
        assert_eq!(value["id"], 9);
        assert_eq!(value["error"]["code"], METHOD_NOT_FOUND);
    }

    #[test]
    fn syncs_session_and_binds_workspace() {
        let state = state();
        let sync = dispatch(
            br#"{"jsonrpc":"2.0","id":1,"method":"session.sync","params":{"sessions":[{"id":"tab-1","title":"SSH","customTitle":null,"active":true,"focused":true,"profileType":"ssh","profileName":"server","profileId":"profile-1","host":"example.test","user":"developer","port":22,"connected":true}]}}"#,
            &state,
        );
        let sync: Value = serde_json::from_slice(&sync).expect("sync should return JSON");
        assert_eq!(sync["result"]["sessionCount"], 1);

        let created = dispatch(
            br#"{"jsonrpc":"2.0","id":2,"method":"workspace.create","params":{"name":"Operations"}}"#,
            &state,
        );
        let created: Value = serde_json::from_slice(&created).expect("create should return JSON");
        assert_eq!(created["result"]["id"], "workspace-1");

        let bound = dispatch(
            br#"{"jsonrpc":"2.0","id":3,"method":"workspace.bind","params":{"workspaceId":"workspace-1","sessionId":"tab-1"}}"#,
            &state,
        );
        let bound: Value = serde_json::from_slice(&bound).expect("bind should return JSON");
        assert_eq!(bound["result"]["bindings"][0]["sessionId"], "tab-1");
    }
}
