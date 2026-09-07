use crate::RuntimeManager;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs::{self, OpenOptions};
use std::io;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

pub const MANAGEMENT_PORT: u16 = 33555;
const MAX_HTTP_BODY: usize = 256 * 1024;
const MAX_HTTP_HEADER: usize = 32 * 1024;
const PROBE_COMMAND: &str = r#"sh -lc 'for name in pi omp codex claude opencode hermes hermes-agent opsclaw chatgpt; do
    path="$(command -v "$name" 2>/dev/null)"
    if [ ! -f "$path" ] || [ ! -x "$path" ]; then
        path=""
        for dir in "$HOME/.local/bin" "$HOME/.npm-global/bin" "$HOME/.npm/bin" "$HOME/.bun/bin" "$HOME/.cargo/bin" "$HOME/.opencode/bin" "$HOME/.hermes/venv/bin" "$HOME/.local/share/pi-node"/*/bin "${NVM_DIR:-$HOME/.nvm}"/versions/node/*/bin "$HOME/.local/share/fnm/node-versions"/*/installation/bin "$HOME/.volta/bin"; do
            if [ -f "$dir/$name" ] && [ -x "$dir/$name" ]; then path="$dir/$name"; break; fi
        done
    fi
    if [ -n "$path" ]; then printf "%s\t%s\n" "$name" "$path"; fi
done'"#;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagementStatus {
    pub enabled: bool,
    pub running: bool,
    pub port: u16,
    pub url: String,
    pub token_configured: bool,
    pub last_error: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct ManagementConfig {
    token: String,
}

struct ManagementShared {
    manager: Arc<RuntimeManager>,
    user_data: PathBuf,
    token: Mutex<String>,
    bootstrap: Mutex<HashMap<String, (String, std::time::Instant)>>,
    sessions: Mutex<HashMap<String, std::time::Instant>>,
    enabled: AtomicBool,
    last_error: Mutex<Option<String>>,
}

pub struct ManagementServerHandle {
    shutdown: Arc<AtomicBool>,
}

impl ManagementServerHandle {
    pub fn stop(&self) {
        self.shutdown.store(true, Ordering::Release);
    }
}

pub struct ManagementServerRuntime {
    shared: Arc<ManagementShared>,
    handle: Mutex<Option<ManagementServerHandle>>,
}

impl ManagementServerRuntime {
    pub fn new(user_data: PathBuf, manager: Arc<RuntimeManager>) -> Self {
        let token = load_or_create_token(&user_data).unwrap_or_else(|error| {
            eprintln!("[management] unable to load token: {error}");
            generate_token()
        });
        Self {
            shared: Arc::new(ManagementShared {
                manager,
                user_data,
                token: Mutex::new(token),
                bootstrap: Mutex::new(HashMap::new()),
                sessions: Mutex::new(HashMap::new()),
                enabled: AtomicBool::new(true),
                last_error: Mutex::new(None),
            }),
            handle: Mutex::new(None),
        }
    }

    pub async fn start(&self) -> Result<(), String> {
        if self.is_running() {
            return Ok(());
        }
        let listener = match TcpListener::bind(("127.0.0.1", MANAGEMENT_PORT)).await {
            Ok(listener) => listener,
            Err(error) => {
                self.set_error(format!("无法监听 127.0.0.1:{MANAGEMENT_PORT}：{error}"));
                return Err(error.to_string());
            }
        };
        self.set_error(String::new());
        let shutdown = Arc::new(AtomicBool::new(false));
        let task_shutdown = shutdown.clone();
        let shared = self.shared.clone();
        tauri::async_runtime::spawn(async move {
            accept_loop(listener, shared, task_shutdown).await;
        });
        *self
            .handle
            .lock()
            .map_err(|_| "管理服务器状态不可用".to_string())? =
            Some(ManagementServerHandle { shutdown });
        if let Ok(token) = self.shared.token.lock() {
            if let Err(error) = crate::agent_hub::write_discovery(&token) {
                eprintln!("[management] {error}");
            }
        }
        Ok(())
    }

    pub fn stop(&self) {
        if let Ok(mut guard) = self.handle.lock() {
            if let Some(handle) = guard.take() {
                handle.stop();
            }
        }
    }

    pub fn is_running(&self) -> bool {
        self.handle
            .lock()
            .map(|guard| guard.is_some())
            .unwrap_or(false)
    }

    pub fn status(&self) -> ManagementStatus {
        ManagementStatus {
            enabled: self.shared.enabled.load(Ordering::Acquire),
            running: self.is_running(),
            port: MANAGEMENT_PORT,
            url: format!("http://127.0.0.1:{MANAGEMENT_PORT}"),
            token_configured: self
                .shared
                .token
                .lock()
                .map(|token| !token.is_empty())
                .unwrap_or(false),
            last_error: self
                .shared
                .last_error
                .lock()
                .ok()
                .and_then(|error| error.clone()),
        }
    }

    pub fn set_enabled(&self, enabled: bool) {
        self.shared.enabled.store(enabled, Ordering::Release);
    }

    pub fn rotate_token(&self) -> Result<String, String> {
        let token = generate_token();
        save_token(&self.shared.user_data, &token)?;
        *self
            .shared
            .token
            .lock()
            .map_err(|_| "管理服务器令牌状态不可用".to_string())? = token.clone();
        if let Ok(mut sessions) = self.shared.sessions.lock() {
            sessions.clear();
        }
        if let Err(error) = crate::agent_hub::write_discovery(&token) {
            eprintln!("[management] {error}");
        }
        Ok(token)
    }

    fn open_url_shared(shared: &ManagementShared) -> Result<String, String> {
        let bootstrap = generate_token();
        shared
            .bootstrap
            .lock()
            .map_err(|_| "管理服务器引导状态不可用".to_string())?
            .insert(
                bootstrap.clone(),
                (
                    bootstrap.clone(),
                    std::time::Instant::now() + Duration::from_secs(60),
                ),
            );
        Ok(format!(
            "http://127.0.0.1:{MANAGEMENT_PORT}/#bootstrap={bootstrap}"
        ))
    }

    fn exchange_bootstrap(&self, bootstrap: &str) -> Result<String, String> {
        let (value, expires_at) = self
            .shared
            .bootstrap
            .lock()
            .map_err(|_| "管理服务器引导状态不可用".to_string())?
            .remove(bootstrap)
            .ok_or_else(|| "引导地址已失效，请从 issh 设置页重新打开".to_string())?;
        if expires_at <= std::time::Instant::now() || value != bootstrap {
            return Err("引导地址已失效，请从 issh 设置页重新打开".to_string());
        }
        let session = generate_token();
        self.shared
            .sessions
            .lock()
            .map_err(|_| "管理服务器会话状态不可用".to_string())?
            .insert(
                session.clone(),
                std::time::Instant::now() + Duration::from_secs(15 * 60),
            );
        Ok(session)
    }

    pub async fn rpc(&self, method: &str, params: Value) -> Result<Value, String> {
        if !matches!(
            method,
            "management.status"
                | "management.enable"
                | "management.disable"
                | "management.rotateToken"
        ) && !self.shared.enabled.load(Ordering::Acquire)
        {
            return Err("管理服务器已暂停".to_string());
        }
        match method {
            "hub.health" => Ok(json!({ "version": "0.4.0", "protocolVersion": "1" })),
            "provider.list" => Ok(json!([{ "kind": "issh", "status": "connected" }])),
            "management.status" => {
                serde_json::to_value(self.status()).map_err(|error| error.to_string())
            }
            "management.enable" => {
                self.set_enabled(true);
                serde_json::to_value(self.status()).map_err(|error| error.to_string())
            }
            "management.disable" => {
                self.set_enabled(false);
                serde_json::to_value(self.status()).map_err(|error| error.to_string())
            }
            "management.rotateToken" => {
                let token = self.rotate_token()?;
                Ok(json!({ "token": token, "status": self.status() }))
            }
            "mgmt.probeAgents" => self.probe_agents().await,
            "runtime.health" | "session.list" | "workspace.list" | "workspace.create"
            | "workspace.delete" | "workspace.bind" | "workspace.unbind" | "agent.list"
            | "agent.register" | "agent.unregister" | "agent.authorize" => {
                runtime_call(&self.shared.manager, method, params).await
            }
            _ => Err(format!("管理 RPC 不允许 method：{method}")),
        }
    }

    async fn probe_agents(&self) -> Result<Value, String> {
        let sessions = runtime_call(&self.shared.manager, "session.list", Value::Null).await?;
        let workspaces = runtime_call(&self.shared.manager, "workspace.list", Value::Null).await?;
        let session_values = sessions.as_array().cloned().unwrap_or_default();
        let mut bound = Vec::new();
        for workspace in workspaces.as_array().cloned().unwrap_or_default() {
            for binding in workspace
                .get("bindings")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
            {
                if let Some(session_id) = binding.get("sessionId").and_then(Value::as_str) {
                    if !bound.iter().any(|id: &String| id == session_id) {
                        bound.push(session_id.to_string());
                    }
                }
            }
        }
        let mut agents = Vec::new();
        let mut errors = Vec::new();
        for session_id in bound {
            let session = session_values.iter().find(|session| {
                session.get("id").and_then(Value::as_str) == Some(session_id.as_str())
            });
            let profile_type = session
                .and_then(|value| value.get("profileType"))
                .and_then(Value::as_str)
                .unwrap_or("local");
            let result = if profile_type == "ssh" {
                runtime_call(
                    &self.shared.manager,
                    "ssh.execReadonly",
                    json!({
                        "sessionId": session_id,
                        "command": PROBE_COMMAND,
                        "timeoutMs": 10000,
                        "maxOutputBytes": 16 * 1024,
                    }),
                )
                .await
            } else {
                runtime_call(
                    &self.shared.manager,
                    "session.probeAgents",
                    json!({ "sessionId": session_id }),
                )
                .await
            };
            match result {
                Ok(value) => {
                    let output = value
                        .get("output")
                        .and_then(Value::as_str)
                        .unwrap_or_default();
                    for line in output.lines() {
                        let mut parts = line.splitn(2, '\t');
                        if let (Some(name), Some(path)) = (parts.next(), parts.next()) {
                            if !name.is_empty() && !path.is_empty() {
                                agents.push(
                                    json!({ "sessionId": session_id, "name": name, "path": path }),
                                );
                            }
                        }
                    }
                }
                Err(error) => errors.push(format!("{session_id}: {error}")),
            }
        }
        Ok(json!({ "agents": agents, "errors": errors }))
    }

    fn set_error(&self, message: String) {
        if let Ok(mut error) = self.shared.last_error.lock() {
            *error = if message.is_empty() {
                None
            } else {
                Some(message)
            };
        }
    }
}

async fn runtime_call(
    manager: &RuntimeManager,
    method: &str,
    params: Value,
) -> Result<Value, String> {
    let mut request =
        json!({ "jsonrpc": "2.0", "id": format!("management-{method}"), "method": method });
    if !params.is_null() {
        request["params"] = params;
    }
    let response = tokio::time::timeout(Duration::from_secs(30), manager.request(request))
        .await
        .map_err(|_| "Runtime 请求超时".to_string())??;
    if let Some(error) = response.get("error") {
        return Err(error
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("Runtime 请求失败")
            .to_string());
    }
    Ok(response.get("result").cloned().unwrap_or(Value::Null))
}

async fn accept_loop(
    listener: TcpListener,
    shared: Arc<ManagementShared>,
    shutdown: Arc<AtomicBool>,
) {
    loop {
        if shutdown.load(Ordering::Acquire) {
            break;
        }
        match tokio::time::timeout(Duration::from_millis(250), listener.accept()).await {
            Ok(Ok((stream, _))) => {
                let request_shared = shared.clone();
                tauri::async_runtime::spawn(async move {
                    let _ = handle_connection(stream, request_shared).await;
                });
            }
            Ok(Err(error)) => {
                eprintln!("[management] accept failed: {error}");
            }
            Err(_) => {}
        }
    }
}

async fn handle_connection(mut stream: TcpStream, shared: Arc<ManagementShared>) -> io::Result<()> {
    let mut buffer = Vec::with_capacity(4096);
    let header_end;
    loop {
        let mut chunk = [0u8; 2048];
        let read = tokio::time::timeout(Duration::from_secs(5), stream.read(&mut chunk)).await??;
        if read == 0 {
            return Ok(());
        }
        buffer.extend_from_slice(&chunk[..read]);
        if buffer.len() > MAX_HTTP_HEADER + MAX_HTTP_BODY {
            return respond(
                &mut stream,
                413,
                "text/plain; charset=utf-8",
                b"Request too large",
            )
            .await;
        }
        if let Some(position) = buffer.windows(4).position(|window| window == b"\r\n\r\n") {
            header_end = position + 4;
            break;
        }
    }
    let header_text = String::from_utf8_lossy(&buffer[..header_end]);
    let mut lines = header_text.split("\r\n");
    let request_line = lines.next().unwrap_or_default();
    let mut request_parts = request_line.split_whitespace();
    let method = request_parts.next().unwrap_or_default().to_string();
    let path = request_parts.next().unwrap_or_default().to_string();
    let mut content_length = 0usize;
    let mut authorization = None;
    for line in lines {
        if let Some((name, value)) = line.split_once(':') {
            if name.eq_ignore_ascii_case("content-length") {
                content_length = value.trim().parse().unwrap_or(MAX_HTTP_BODY + 1);
            }
            if name.eq_ignore_ascii_case("authorization") {
                authorization = Some(value.trim().to_string());
            }
        }
    }
    if content_length > MAX_HTTP_BODY {
        return respond(
            &mut stream,
            413,
            "text/plain; charset=utf-8",
            b"Request too large",
        )
        .await;
    }
    let total = header_end + content_length;
    while buffer.len() < total {
        let mut chunk = [0u8; 4096];
        let read = tokio::time::timeout(Duration::from_secs(5), stream.read(&mut chunk)).await??;
        if read == 0 {
            break;
        }
        buffer.extend_from_slice(&chunk[..read]);
    }
    if buffer.len() < total {
        return respond(
            &mut stream,
            400,
            "text/plain; charset=utf-8",
            b"Incomplete request",
        )
        .await;
    }
    if method == "GET" {
        return serve_static(&mut stream, &path).await;
    }
    if method == "POST" && path == "/bootstrap" {
        let request: Value = match serde_json::from_slice(&buffer[header_end..total]) {
            Ok(value) => value,
            Err(_) => {
                return respond_json(
                    &mut stream,
                    400,
                    &json!({ "error": { "code": -32700, "message": "Invalid JSON" } }),
                )
                .await
            }
        };
        let bootstrap = request
            .get("bootstrap")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let runtime = ManagementServerRuntime {
            shared: shared.clone(),
            handle: Mutex::new(Some(ManagementServerHandle {
                shutdown: Arc::new(AtomicBool::new(false)),
            })),
        };
        return match runtime.exchange_bootstrap(bootstrap) {
            Ok(token) => {
                respond_json(
                    &mut stream,
                    200,
                    &json!({ "token": token, "expiresIn": 900 }),
                )
                .await
            }
            Err(error) => {
                respond_json(
                    &mut stream,
                    401,
                    &json!({ "error": { "code": -32001, "message": error } }),
                )
                .await
            }
        };
    }
    if method != "POST" || path != "/rpc" {
        return respond(&mut stream, 404, "text/plain; charset=utf-8", b"Not found").await;
    }
    let expected = shared
        .token
        .lock()
        .map(|token| token.clone())
        .unwrap_or_default();
    let authorized = authorization
        .as_deref()
        .and_then(|value| value.strip_prefix("Bearer "))
        .map(|candidate| {
            if candidate == expected {
                return true;
            }
            shared
                .sessions
                .lock()
                .map(|mut sessions| {
                    let now = std::time::Instant::now();
                    sessions.retain(|_, expires_at| *expires_at > now);
                    sessions.contains_key(candidate)
                })
                .unwrap_or(false)
        })
        .unwrap_or(false);
    if !authorized {
        return respond_json(
            &mut stream,
            401,
            &json!({ "error": { "code": -32001, "message": "Unauthorized" } }),
        )
        .await;
    }
    let request: Value = match serde_json::from_slice(&buffer[header_end..total]) {
        Ok(value) => value,
        Err(_) => {
            return respond_json(
                &mut stream,
                400,
                &json!({ "error": { "code": -32700, "message": "Invalid JSON" } }),
            )
            .await
        }
    };
    let id = request.get("id").cloned().unwrap_or(Value::Null);
    let rpc_method = request
        .get("method")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let params = request.get("params").cloned().unwrap_or(Value::Null);
    let response = match shared_rpc(&shared, rpc_method, params).await {
        Ok(result) => {
            append_audit(&shared, rpc_method, true, None);
            json!({ "jsonrpc": "2.0", "id": id, "result": result })
        }
        Err(error) => {
            append_audit(&shared, rpc_method, false, Some(&error));
            json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32000, "message": error } })
        }
    };
    respond_json(&mut stream, 200, &response).await
}

async fn shared_rpc(
    shared: &ManagementShared,
    method: &str,
    params: Value,
) -> Result<Value, String> {
    // hub.bootstrap 必须把一次性引导令牌写进监听器共享状态（而非临时 runtime 的
    // 私有状态），否则 exchange_bootstrap 在监听器侧找不到该令牌。
    if method == "hub.bootstrap" {
        return ManagementServerRuntime::open_url_shared(shared).map(|url| json!({ "url": url }));
    }
    // A temporary runtime wrapper keeps all request handling in one place while
    // sharing the listener's state and avoiding a second data store.
    let runtime = ManagementServerRuntime {
        shared: Arc::new(ManagementShared {
            manager: shared.manager.clone(),
            user_data: shared.user_data.clone(),
            token: Mutex::new(
                shared
                    .token
                    .lock()
                    .map(|token| token.clone())
                    .unwrap_or_default(),
            ),
            bootstrap: Mutex::new(HashMap::new()),
            sessions: Mutex::new(HashMap::new()),
            enabled: AtomicBool::new(shared.enabled.load(Ordering::Acquire)),
            last_error: Mutex::new(
                shared
                    .last_error
                    .lock()
                    .ok()
                    .and_then(|error| error.clone()),
            ),
        }),
        handle: Mutex::new(Some(ManagementServerHandle {
            shutdown: Arc::new(AtomicBool::new(false)),
        })),
    };
    // Keep mutations on the listener's shared state after dispatch.
    let result = runtime.rpc(method, params).await;
    if method == "management.enable" {
        shared.enabled.store(true, Ordering::Release);
    }
    if method == "management.disable" {
        shared.enabled.store(false, Ordering::Release);
    }
    if method == "management.rotateToken" {
        if let Ok(new_token) = runtime.shared.token.lock().map(|token| token.clone()) {
            if let Ok(mut token) = shared.token.lock() {
                *token = new_token;
            }
        }
        if let Ok(mut sessions) = shared.sessions.lock() {
            sessions.clear();
        }
    }
    result
}

async fn serve_static(stream: &mut TcpStream, path: &str) -> io::Result<()> {
    let (content_type, body) = match path {
        "/" | "/index.html" => (
            "text/html; charset=utf-8",
            include_bytes!("../../agent-dashboard/embed/index.html").as_slice(),
        ),
        "/app.js" => (
            "application/javascript; charset=utf-8",
            include_bytes!("../../agent-dashboard/embed/app.js").as_slice(),
        ),
        "/style.css" => (
            "text/css; charset=utf-8",
            include_bytes!("../../agent-dashboard/embed/style.css").as_slice(),
        ),
        _ if !path.contains("..") && !path.contains('\\') => (
            "text/html; charset=utf-8",
            include_bytes!("../../agent-dashboard/embed/index.html").as_slice(),
        ),
        _ => return respond(stream, 404, "text/plain; charset=utf-8", b"Not found").await,
    };
    respond(stream, 200, content_type, body).await
}

async fn respond_json(stream: &mut TcpStream, status: u16, value: &Value) -> io::Result<()> {
    let body = serde_json::to_vec(value).unwrap_or_else(|_| b"{}".to_vec());
    respond(stream, status, "application/json; charset=utf-8", &body).await
}

async fn respond(
    stream: &mut TcpStream,
    status: u16,
    content_type: &str,
    body: &[u8],
) -> io::Result<()> {
    let reason = match status {
        200 => "OK",
        400 => "Bad Request",
        401 => "Unauthorized",
        404 => "Not Found",
        413 => "Payload Too Large",
        _ => "Error",
    };
    let header = format!("HTTP/1.1 {status} {reason}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n", body.len());
    stream.write_all(header.as_bytes()).await?;
    stream.write_all(body).await
}

fn token_path(user_data: &Path) -> PathBuf {
    user_data.join("management-server.json")
}

fn append_audit(shared: &ManagementShared, method: &str, ok: bool, error: Option<&str>) {
    let path = shared.user_data.join("management-audit.jsonl");
    let entry = json!({
        "timestamp": now_unix_ms(),
        "method": method,
        "ok": ok,
        "error": error,
    });
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(file, "{entry}");
    }
}

fn load_or_create_token(user_data: &Path) -> Result<String, String> {
    let path = token_path(user_data);
    if let Ok(raw) = fs::read_to_string(&path) {
        if let Ok(config) = serde_json::from_str::<ManagementConfig>(&raw) {
            if !config.token.is_empty() {
                return Ok(config.token);
            }
        }
    }
    let token = generate_token();
    save_token(user_data, &token)?;
    Ok(token)
}

fn save_token(user_data: &Path, token: &str) -> Result<(), String> {
    fs::create_dir_all(user_data).map_err(|error| format!("无法创建管理配置目录：{error}"))?;
    let path = token_path(user_data);
    let temp = path.with_extension("json.tmp");
    let content = serde_json::to_vec_pretty(&ManagementConfig {
        token: token.to_string(),
    })
    .map_err(|error| error.to_string())?;
    fs::write(&temp, &content).map_err(|error| format!("无法写入管理令牌：{error}"))?;
    match fs::rename(&temp, &path) {
        Ok(()) => Ok(()),
        Err(rename_error) => fs::write(&path, content)
            .map_err(|write_error| format!("无法保存管理令牌：{rename_error}; {write_error}")),
    }
}

fn generate_token() -> String {
    use rand::RngCore;
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

#[allow(dead_code)]
fn now_unix_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_millis())
        .unwrap_or_default()
}
