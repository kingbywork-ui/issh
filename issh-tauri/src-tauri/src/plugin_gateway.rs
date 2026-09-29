use crate::host_profiles::HostProfileMutation;
use crate::mcp_stdio::LocalMcpManager;
use crate::RuntimeManager;
use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

const API_VERSION: &str = "1";

fn api_version_supported(version: &str) -> bool {
    version == API_VERSION || version == "2" || version == "3"
}
const MAX_REQUEST_BYTES: usize = 64 * 1024;
const MAX_SEEN_REQUESTS: usize = 2048;
const MAX_AUDIT_ENTRIES: usize = 1000;

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginGatewayRequest {
    pub request_id: String,
    pub plugin_id: String,
    pub api_version: String,
    pub method: String,
    #[serde(default)]
    pub args: Value,
    #[serde(default)]
    pub permissions: Vec<String>,
    pub deadline_ms: Option<u64>,
    pub trace_id: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginGatewayError {
    pub code: String,
    pub message: String,
    pub retryable: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginGatewayResponse {
    pub request_id: String,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<PluginGatewayError>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PluginGatewayAuditEntry {
    pub timestamp: String,
    pub request_id: String,
    pub plugin_id: String,
    pub method: String,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_code: Option<String>,
}

#[derive(Default)]
pub struct PluginGatewayState {
    seen: Mutex<HashSet<String>>,
    seen_order: Mutex<VecDeque<String>>,
    audit: Mutex<VecDeque<PluginGatewayAuditEntry>>,
    mcp: LocalMcpManager,
    streams: tokio::sync::Mutex<HashMap<String, StreamEntry>>,
}

struct StreamEntry {
    owner: String,
    receiver: tokio::sync::mpsc::Receiver<StreamEvent>,
    task: tokio::task::JoinHandle<()>,
}

enum StreamEvent {
    Chunk(Vec<u8>),
    End,
    Error(String),
}

impl PluginGatewayState {
    fn claim_request(&self, id: &str) -> Result<(), String> {
        let mut seen = self
            .seen
            .lock()
            .map_err(|_| "网关请求状态不可用".to_string())?;
        if seen.contains(id) {
            return Err("请求 ID 重复，已拒绝重放请求".to_string());
        }
        seen.insert(id.to_string());
        let mut order = self
            .seen_order
            .lock()
            .map_err(|_| "网关请求状态不可用".to_string())?;
        order.push_back(id.to_string());
        if order.len() > MAX_SEEN_REQUESTS {
            if let Some(expired) = order.pop_front() {
                seen.remove(&expired);
            }
        }
        Ok(())
    }

    fn audit(&self, request: &PluginGatewayRequest, ok: bool, error_code: Option<&str>) {
        let entry = PluginGatewayAuditEntry {
            timestamp: chrono_like_timestamp(),
            request_id: request.request_id.clone(),
            plugin_id: request.plugin_id.clone(),
            method: request.method.clone(),
            ok,
            error_code: error_code.map(str::to_string),
        };
        if let Ok(mut audit) = self.audit.lock() {
            audit.push_back(entry);
            while audit.len() > MAX_AUDIT_ENTRIES {
                audit.pop_front();
            }
        }
    }

    pub fn read_audit(&self) -> Result<Vec<PluginGatewayAuditEntry>, String> {
        self.audit
            .lock()
            .map(|entries| entries.iter().cloned().collect())
            .map_err(|_| "网关审计状态不可用".to_string())
    }

    pub fn clear_audit(&self) -> Result<(), String> {
        self.audit
            .lock()
            .map(|mut entries| entries.clear())
            .map_err(|_| "网关审计状态不可用".to_string())
    }
}

fn chrono_like_timestamp() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default();
    millis.to_string()
}

fn response_ok(request_id: &str, data: Value) -> PluginGatewayResponse {
    PluginGatewayResponse {
        request_id: request_id.to_string(),
        ok: true,
        data: Some(data),
        error: None,
    }
}

fn response_error(
    request_id: &str,
    code: &str,
    message: impl Into<String>,
    retryable: bool,
) -> PluginGatewayResponse {
    PluginGatewayResponse {
        request_id: request_id.to_string(),
        ok: false,
        data: None,
        error: Some(PluginGatewayError {
            code: code.to_string(),
            message: message.into(),
            retryable,
        }),
    }
}

fn required_permission(method: &str) -> Option<&'static str> {
    match method {
        "runtime.health" => None,
        "session.list" | "session.current" | "session.read" | "session.probeAgents" => {
            Some("session.read")
        }
        "session.write" | "terminal.write" => Some("terminal.write"),
        "terminal.read" => Some("terminal.read"),
        "profiles.read" => Some("profiles.read"),
        "profiles.mutate" => Some("profiles.write"),
        "vault.status" | "vault.unlock" | "vault.getSecret" => Some("vault.read"),
        "ssh.exec" => Some("ssh.exec"),
        "network.fetch" => Some("network.fetch"),
        "workspace.list" => Some("workspace.read"),
        "workspace.create" | "workspace.delete" | "workspace.bind" | "workspace.unbind" => {
            Some("workspace.write")
        }
        "agent.list" => Some("agent.read"),
        "agent.register" | "agent.unregister" | "agent.authorize" => Some("agent.write"),
        "sftp.open" | "sftp.list" | "sftp.read" | "sftp.stat" | "sftp.close" => Some("sftp.read"),
        "sftp.write" | "sftp.mkdir" | "sftp.remove" | "sftp.removeDir" | "sftp.rename"
        | "sftp.chmod" => Some("sftp.write"),
        "fs.userPaths" | "fs.readLocalText" => Some("fs.read"),
        "ssh.execReadonly" => Some("ssh.execReadonly"),
        "http.postJson" | "http.streamOpen" | "http.streamPoll" | "http.streamClose" => {
            Some("network.postJson")
        }
        "mcp.connect" | "mcp.listTools" | "mcp.callTool" | "mcp.disconnect" => Some("mcp.stdio"),
        _ => None,
    }
}

fn permission_allowed(request: &PluginGatewayRequest, required: &str) -> bool {
    static_plugin_capabilities(&request.plugin_id)
        .map(|capabilities| capabilities.contains(&required))
        .unwrap_or(false)
}

fn static_plugin_capabilities(plugin_id: &str) -> Option<&'static [&'static str]> {
    match plugin_id {
        "issh-plugin-config-sync" => Some(&[
            "ui.settings.register",
            "profiles.read",
            "profiles.write",
            "network.fetch",
            "vault.read",
        ]),
        "issh-plugin-linkifier" => Some(&["terminal.decorate"]),
        "issh-plugin-llm" => Some(&[
            "ui.settings.register",
            "terminal.decorate",
            "fs.read",
            "ssh.exec",
            "network.postJson",
        ]),
        "issh-plugin-ai-assistant" => Some(&[
            "ui.panel.register",
            "terminal.read",
            "terminal.write",
            "network.postJson",
            "mcp.stdio",
            "mcp.remote",
        ]),
        "issh-plugin-sandbox-demo" => Some(&[
            "ui.panel.register",
            "terminal.decorate",
            "profiles.read",
            "profiles.write",
        ]),
        "issh-plugin-serial" => Some(&["ui.panel.register"]),
        _ => None,
    }
}

fn runtime_method(method: &str) -> Option<(&str, Option<&'static str>)> {
    match method {
        "runtime.health" => Some(("runtime.health", None)),
        "session.list" => Some(("session.list", Some("session.read"))),
        "session.current" => Some(("session.list", Some("session.read"))),
        "session.probeAgents" => Some((method, Some("session.read"))),
        "session.read" | "terminal.read" => Some(("session.subscribe", Some("session.read"))),
        "session.write" | "terminal.write" => Some(("session.write", Some("terminal.write"))),
        "ssh.exec" => Some(("ssh.execReadonly", Some("ssh.exec"))),
        "ssh.execReadonly" => Some(("ssh.execReadonly", Some("ssh.execReadonly"))),
        "sftp.open" | "sftp.list" | "sftp.read" | "sftp.stat" | "sftp.close" => {
            Some((method, Some("sftp.read")))
        }
        "sftp.write" | "sftp.mkdir" | "sftp.remove" | "sftp.removeDir" | "sftp.rename"
        | "sftp.chmod" => Some((method, Some("sftp.write"))),
        "vault.status" | "vault.getSecret" => Some((method, Some("vault.read"))),
        "workspace.list" => Some((method, Some("workspace.read"))),
        "workspace.create" | "workspace.delete" | "workspace.bind" | "workspace.unbind" => {
            Some((method, Some("workspace.write")))
        }
        "agent.list" => Some((method, Some("agent.read"))),
        "agent.register" | "agent.unregister" | "agent.authorize" => {
            Some((method, Some("agent.write")))
        }
        _ => None,
    }
}

fn network_host_allowed(url: &str) -> Result<(), String> {
    let parsed = url::Url::parse(url).map_err(|_| "network.fetch URL 无效".to_string())?;
    if parsed.scheme() != "https" {
        return Err("network.fetch 仅允许 https".to_string());
    }
    match parsed.host_str() {
        Some("api.github.com" | "raw.githubusercontent.com" | "cdn.jsdelivr.net") => Ok(()),
        Some(host) => Err(format!("network.fetch 未允许域名：{host}")),
        None => Err("network.fetch 缺少域名".to_string()),
    }
}

async fn network_fetch(args: &Value) -> Result<Value, String> {
    let url = args
        .get("url")
        .and_then(Value::as_str)
        .ok_or_else(|| "network.fetch 需要 url".to_string())?;
    network_host_allowed(url)?;
    let method = args.get("method").and_then(Value::as_str).unwrap_or("GET");
    if !matches!(method, "GET" | "POST" | "PATCH") {
        return Err("network.fetch 仅允许 GET、POST 或 PATCH".to_string());
    }
    let body = args.get("body").and_then(Value::as_str);
    if body.is_some_and(|value| value.len() > 256 * 1024) {
        return Err("network.fetch 请求体超过 256 KiB 限制".to_string());
    }
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|error| error.to_string())?;
    let mut request = client
        .request(
            reqwest::Method::from_bytes(method.as_bytes()).map_err(|error| error.to_string())?,
            url,
        )
        .header("User-Agent", "issh-plugin-gateway/1");
    if let Some(headers) = args.get("headers").and_then(Value::as_object) {
        for (name, value) in headers {
            if !matches!(
                name.to_ascii_lowercase().as_str(),
                "authorization" | "content-type" | "accept"
            ) {
                return Err(format!("network.fetch 不允许请求头：{name}"));
            }
            let value = value
                .as_str()
                .ok_or_else(|| format!("network.fetch 请求头无效：{name}"))?;
            request = request.header(name, value);
        }
    }
    if let Some(body) = body {
        request = request.body(body.to_string());
    }
    let response = request.send().await.map_err(|error| error.to_string())?;
    network_host_allowed(response.url().as_str())?;
    let status = response.status();
    let bytes = response.bytes().await.map_err(|error| error.to_string())?;
    if bytes.len() > 4 * 1024 * 1024 {
        return Err("network.fetch 响应超过 4 MiB 限制".to_string());
    }
    Ok(
        json!({ "status": status.as_u16(), "ok": status.is_success(), "body": String::from_utf8_lossy(&bytes) }),
    )
}

const DEFAULT_LOCAL_TEXT_MAX: u64 = 1024 * 1024;
const HARD_LOCAL_TEXT_MAX: u64 = 4 * 1024 * 1024;

/// 返回用户目录路径（home/appData），供插件定位 shell 历史文件。
pub fn user_paths_value() -> Value {
    let home = std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(|value| value.to_string_lossy().into_owned());
    let app_data = std::env::var_os("APPDATA")
        .or_else(|| {
            std::env::var_os("HOME")
                .map(|home| PathBuf::from(home).join(".config").into_os_string())
        })
        .map(|value| value.to_string_lossy().into_owned());
    json!({ "home": home, "appData": app_data })
}

fn shell_history_paths() -> Vec<PathBuf> {
    let mut paths = Vec::new();
    if let Some(home) = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")) {
        let home = PathBuf::from(home);
        paths.push(home.join(".bash_history"));
        paths.push(home.join(".zsh_history"));
        paths.push(
            home.join(".local")
                .join("share")
                .join("fish")
                .join("fish_history"),
        );
    }
    if let Some(app_data) = std::env::var_os("APPDATA") {
        paths.push(
            PathBuf::from(app_data)
                .join("Microsoft")
                .join("Windows")
                .join("PowerShell")
                .join("PSReadLine")
                .join("ConsoleHost_history.txt"),
        );
    }
    paths
}

fn normalize_path_key(path: &Path) -> String {
    path.to_string_lossy().replace('/', "\\").to_lowercase()
}

/// 校验目标路径是否属于允许读取的 shell 历史文件（bash/zsh/fish/PSReadLine）。
pub fn is_shell_history_path(path: &str) -> bool {
    let target = normalize_path_key(Path::new(path));
    shell_history_paths()
        .iter()
        .any(|candidate| normalize_path_key(candidate) == target)
}

/// 读取本地 shell 历史文件：路径白名单 + 大小上限 + UTF-8，缺失/非 UTF-8 按 None 处理。
pub fn read_shell_history_file(
    path: &str,
    max_bytes: Option<u64>,
) -> Result<Option<String>, String> {
    if !is_shell_history_path(path) {
        return Err(format!("仅允许读取 shell 历史文件：{path}"));
    }
    let limit = max_bytes
        .unwrap_or(DEFAULT_LOCAL_TEXT_MAX)
        .min(HARD_LOCAL_TEXT_MAX);
    let metadata = match std::fs::metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("无法读取文件信息 {path}：{error}")),
    };
    if !metadata.is_file() {
        return Ok(None);
    }
    if metadata.len() > limit {
        return Err(format!("文件超过大小上限（{limit} 字节）：{path}"));
    }
    match std::fs::read_to_string(path) {
        Ok(content) => Ok(Some(content)),
        Err(error) if error.kind() == std::io::ErrorKind::InvalidData => Ok(None),
        Err(error) => Err(format!("读取本地文件失败 {path}：{error}")),
    }
}

/// 受控 JSON POST：任意 http/https URL（LLM 端点等用户配置目标），
/// 限制请求体/响应大小、超时、请求头白名单，并禁止重定向。
async fn http_post_json(args: &Value) -> Result<Value, String> {
    let url = args
        .get("url")
        .and_then(Value::as_str)
        .ok_or_else(|| "http.postJson 需要 url".to_string())?;
    let parsed = url::Url::parse(url).map_err(|_| "http.postJson URL 无效".to_string())?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("http.postJson 仅允许 http/https".to_string());
    }
    if parsed.host_str().is_none() {
        return Err("http.postJson 缺少主机名".to_string());
    }
    let body = args
        .get("body")
        .and_then(Value::as_str)
        .ok_or_else(|| "http.postJson 需要 body".to_string())?;
    if body.len() > 256 * 1024 {
        return Err("http.postJson 请求体超过 256 KiB 限制".to_string());
    }
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|error| error.to_string())?;
    let mut request = client
        .post(url)
        .header("User-Agent", "issh-plugin-gateway/1");
    if let Some(headers) = args.get("headers").and_then(Value::as_object) {
        for (name, value) in headers {
            if !matches!(
                name.to_ascii_lowercase().as_str(),
                "authorization" | "content-type" | "accept" | "x-api-key" | "anthropic-version"
            ) {
                return Err(format!("http.postJson 不允许请求头：{name}"));
            }
            let value = value
                .as_str()
                .ok_or_else(|| format!("http.postJson 请求头无效：{name}"))?;
            request = request.header(name, value);
        }
    }
    let response = request
        .body(body.to_string())
        .send()
        .await
        .map_err(|error| error.to_string())?;
    let status = response.status();
    let bytes = response.bytes().await.map_err(|error| error.to_string())?;
    if bytes.len() > 4 * 1024 * 1024 {
        return Err("http.postJson 响应超过 4 MiB 限制".to_string());
    }
    Ok(
        json!({ "status": status.as_u16(), "ok": status.is_success(), "body": String::from_utf8_lossy(&bytes) }),
    )
}

async fn http_stream_open(
    state: &PluginGatewayState,
    plugin: &str,
    stream_id: &str,
    args: &Value,
) -> Result<Value, String> {
    let url = args
        .get("url")
        .and_then(Value::as_str)
        .ok_or("http.streamOpen 需要 url")?;
    let parsed = url::Url::parse(url).map_err(|_| "流式请求 URL 无效")?;
    if !matches!(parsed.scheme(), "http" | "https") || parsed.host_str().is_none() {
        return Err("流式请求仅允许 http/https URL".to_string());
    }
    let body = args
        .get("body")
        .and_then(Value::as_str)
        .ok_or("http.streamOpen 需要 body")?;
    if body.len() > 256 * 1024 {
        return Err("流式请求体超过 256 KiB".to_string());
    }
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(180))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| e.to_string())?;
    let mut request = client
        .post(url)
        .header("User-Agent", "issh-plugin-gateway/1");
    if let Some(headers) = args.get("headers").and_then(Value::as_object) {
        for (name, value) in headers {
            if !matches!(
                name.to_ascii_lowercase().as_str(),
                "authorization" | "content-type" | "accept" | "x-api-key" | "anthropic-version"
            ) {
                return Err(format!("流式请求不允许请求头：{name}"));
            }
            request = request.header(name, value.as_str().ok_or("流式请求头无效")?);
        }
    }
    let response = request
        .body(body.to_string())
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = response.status();
    if !status.is_success() {
        let mut response = response;
        let mut message = Vec::new();
        while message.len() < 4096 {
            match response.chunk().await.map_err(|e| e.to_string())? {
                Some(bytes) => {
                    message.extend_from_slice(&bytes[..bytes.len().min(4096 - message.len())])
                }
                None => break,
            }
        }
        return Err(format!(
            "模型请求失败（HTTP {}）：{}",
            status.as_u16(),
            String::from_utf8_lossy(&message)
        ));
    }
    let mut streams = state.streams.lock().await;
    if streams.len() >= 8 {
        return Err("流式连接数超过上限".to_string());
    }
    let id = stream_id.to_string();
    let (sender, receiver) = tokio::sync::mpsc::channel(32);
    let task = tokio::spawn(async move {
        let mut response = response;
        let mut total = 0usize;
        loop {
            match response.chunk().await {
                Ok(Some(bytes)) => {
                    total += bytes.len();
                    if total > 4 * 1024 * 1024 {
                        let _ = sender
                            .send(StreamEvent::Error("流式响应超过 4 MiB".to_string()))
                            .await;
                        break;
                    }
                    if sender
                        .send(StreamEvent::Chunk(bytes.to_vec()))
                        .await
                        .is_err()
                    {
                        break;
                    }
                }
                Ok(None) => {
                    let _ = sender.send(StreamEvent::End).await;
                    break;
                }
                Err(error) => {
                    let _ = sender.send(StreamEvent::Error(error.to_string())).await;
                    break;
                }
            }
        }
    });
    streams.insert(
        id.clone(),
        StreamEntry {
            owner: plugin.to_string(),
            receiver,
            task,
        },
    );
    Ok(json!({"streamId":id,"status":status.as_u16()}))
}

async fn http_stream_poll(
    state: &PluginGatewayState,
    plugin: &str,
    args: &Value,
) -> Result<Value, String> {
    let id = args
        .get("streamId")
        .and_then(Value::as_str)
        .ok_or("缺少 streamId")?;
    let mut streams = state.streams.lock().await;
    let entry = streams.get_mut(id).ok_or("流式连接不存在")?;
    if entry.owner != plugin {
        return Err("流式连接所有者不匹配".to_string());
    }
    let event = match tokio::time::timeout(Duration::from_millis(500), entry.receiver.recv()).await
    {
        Ok(Some(event)) => event,
        Ok(None) => StreamEvent::End,
        Err(_) => return Ok(json!({"chunkBase64":"","done":false})),
    };
    match event {
        StreamEvent::Chunk(bytes) => Ok(
            json!({"chunkBase64":base64::engine::general_purpose::STANDARD.encode(bytes),"done":false}),
        ),
        StreamEvent::End => {
            streams.remove(id);
            Ok(json!({"chunkBase64":"","done":true}))
        }
        StreamEvent::Error(error) => {
            streams.remove(id);
            Err(error)
        }
    }
}

async fn http_stream_close(
    state: &PluginGatewayState,
    plugin: &str,
    args: &Value,
) -> Result<Value, String> {
    let id = args
        .get("streamId")
        .and_then(Value::as_str)
        .ok_or("缺少 streamId")?;
    let mut streams = state.streams.lock().await;
    if streams.get(id).is_some_and(|entry| entry.owner != plugin) {
        return Err("流式连接所有者不匹配".to_string());
    }
    if let Some(entry) = streams.remove(id) {
        entry.task.abort();
    }
    Ok(json!({"closed":true}))
}

fn runtime_args(request: &PluginGatewayRequest, method: &str) -> Value {
    if method == "session.current" {
        return Value::Null;
    }
    let mut args = request.args.clone();
    if matches!(method, "session.read" | "terminal.read") {
        if let Value::Object(ref mut map) = args {
            map.entry("afterSequence".to_string())
                .or_insert(Value::from(0));
            map.entry("maxEvents".to_string())
                .or_insert(Value::from(64));
            map.entry("maxBytes".to_string())
                .or_insert(Value::from(12288));
        }
    }
    if matches!(method, "terminal.write" | "session.write") {
        if let Value::Object(ref mut map) = args {
            if let Some(Value::String(data)) = map.get("data").cloned() {
                map.insert(
                    "data".to_string(),
                    Value::Array(data.bytes().map(Value::from).collect()),
                );
            }
        }
    }
    if matches!(method, "ssh.exec" | "ssh.execReadonly") {
        if let Value::Object(ref mut map) = args {
            map.entry("timeoutMs".to_string())
                .or_insert(Value::from(60000));
        }
    }
    args
}

pub async fn handle_request(
    manager: &RuntimeManager,
    state: &PluginGatewayState,
    request: PluginGatewayRequest,
) -> PluginGatewayResponse {
    let request_id = request.request_id.clone();
    let request_size = serde_json::to_vec(&request)
        .map(|bytes| bytes.len())
        .unwrap_or(MAX_REQUEST_BYTES + 1);
    if request_size > MAX_REQUEST_BYTES {
        state.audit(&request, false, Some("REQUEST_TOO_LARGE"));
        return response_error(
            &request_id,
            "REQUEST_TOO_LARGE",
            "网关请求超过大小限制",
            false,
        );
    }
    if request.plugin_id.is_empty()
        || request.plugin_id.len() > 128
        || !request
            .plugin_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
    {
        state.audit(&request, false, Some("INVALID_PLUGIN"));
        return response_error(&request_id, "INVALID_PLUGIN", "插件 ID 无效", false);
    }
    if static_plugin_capabilities(&request.plugin_id).is_none() {
        state.audit(&request, false, Some("PLUGIN_NOT_REGISTERED"));
        return response_error(
            &request_id,
            "PLUGIN_NOT_REGISTERED",
            "插件未在宿主网关能力表中注册",
            false,
        );
    }
    if !api_version_supported(&request.api_version) {
        state.audit(&request, false, Some("API_VERSION_UNSUPPORTED"));
        return response_error(
            &request_id,
            "API_VERSION_UNSUPPORTED",
            format!("不支持的网关 API 版本：{}", request.api_version),
            false,
        );
    }
    if let Err(error) = state.claim_request(&request.request_id) {
        state.audit(&request, false, Some("DUPLICATE_REQUEST"));
        return response_error(&request_id, "DUPLICATE_REQUEST", error, false);
    }
    if let Some(required) = required_permission(&request.method) {
        if !permission_allowed(&request, required) {
            state.audit(&request, false, Some("PERMISSION_DENIED"));
            return response_error(
                &request_id,
                "PERMISSION_DENIED",
                format!("未声明权限：{required}"),
                false,
            );
        }
    }
    if request.method == "mcp.connect"
        && request
            .args
            .get("transport")
            .and_then(Value::as_str)
            .is_some_and(|transport| transport != "stdio")
        && !permission_allowed(&request, "mcp.remote")
    {
        state.audit(&request, false, Some("PERMISSION_DENIED"));
        return response_error(
            &request_id,
            "PERMISSION_DENIED",
            "未声明权限：mcp.remote".to_string(),
            false,
        );
    }
    let result = if request.method == "network.fetch" {
        network_fetch(&request.args).await
    } else if request.method == "profiles.read" {
        manager
            .hosts
            .read()
            .and_then(|profiles| serde_json::to_value(profiles).map_err(|error| error.to_string()))
    } else if request.method == "profiles.mutate" {
        let mutation = request
            .args
            .get("mutation")
            .cloned()
            .unwrap_or_else(|| request.args.clone());
        match serde_json::from_value::<HostProfileMutation>(mutation) {
            Ok(mutation) => manager.hosts.mutate(mutation).and_then(|profiles| {
                serde_json::to_value(profiles).map_err(|error| error.to_string())
            }),
            Err(error) => Err(format!("profiles.mutate 参数无效：{error}")),
        }
    } else if request.method == "vault.unlock" {
        let passphrase = request
            .args
            .get("passphrase")
            .and_then(Value::as_str)
            .ok_or_else(|| "vault.unlock 需要 passphrase".to_string());
        passphrase.and_then(|value| {
            manager.hosts.unlock(value).and_then(|profiles| {
                serde_json::to_value(profiles).map_err(|error| error.to_string())
            })
        })
    } else if request.method == "fs.userPaths" {
        Ok(user_paths_value())
    } else if request.method == "fs.readLocalText" {
        match request.args.get("path").and_then(Value::as_str) {
            Some(path) => match read_shell_history_file(path, None) {
                Ok(Some(content)) => Ok(Value::String(content)),
                Ok(None) => Ok(Value::Null),
                Err(error) => Err(error),
            },
            None => Err("fs.readLocalText 需要 path".to_string()),
        }
    } else if request.method == "http.postJson" {
        http_post_json(&request.args).await
    } else if request.method == "http.streamOpen" {
        http_stream_open(
            state,
            &request.plugin_id,
            &request.request_id,
            &request.args,
        )
        .await
    } else if request.method == "http.streamPoll" {
        http_stream_poll(state, &request.plugin_id, &request.args).await
    } else if request.method == "http.streamClose" {
        http_stream_close(state, &request.plugin_id, &request.args).await
    } else if request.method == "mcp.connect" {
        state.mcp.connect(&request.plugin_id, &request.args).await
    } else if request.method == "mcp.listTools" {
        state
            .mcp
            .list_tools(&request.plugin_id, &request.args)
            .await
    } else if request.method == "mcp.callTool" {
        state.mcp.call_tool(&request.plugin_id, &request.args).await
    } else if request.method == "mcp.disconnect" {
        state
            .mcp
            .disconnect(&request.plugin_id, &request.args)
            .await
    } else if let Some((runtime_method, _method_permission)) = runtime_method(&request.method) {
        let params = runtime_args(&request, &request.method);
        let mut runtime_request =
            json!({ "jsonrpc": "2.0", "id": request.request_id, "method": runtime_method });
        if !params.is_null() {
            runtime_request["params"] = params;
        }
        let timeout =
            Duration::from_millis(request.deadline_ms.unwrap_or(10000).clamp(100, 120000));
        let response = match tokio::time::timeout(timeout, manager.request(runtime_request)).await {
            Ok(Ok(response)) => response,
            Ok(Err(error)) => return response_error(&request_id, "RUNTIME_ERROR", error, true),
            Err(_) => return response_error(&request_id, "TIMEOUT", "网关 Runtime 请求超时", true),
        };
        if let Some(error) = response.get("error") {
            return response_error(
                &request_id,
                "RUNTIME_ERROR",
                error
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("Runtime 请求失败"),
                true,
            );
        }
        Ok(response.get("result").cloned().unwrap_or(Value::Null))
    } else {
        Err(format!("未知网关 method：{}", request.method))
    };
    match result {
        Ok(data) => {
            if request.method != "http.streamPoll" {
                state.audit(&request, true, None);
            }
            response_ok(&request_id, data)
        }
        Err(error) => {
            state.audit(&request, false, Some("CALL_FAILED"));
            response_error(&request_id, "CALL_FAILED", error, true)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(method: &str, permissions: &[&str]) -> PluginGatewayRequest {
        PluginGatewayRequest {
            request_id: "request-1".to_string(),
            plugin_id: "issh-plugin-config-sync".to_string(),
            api_version: API_VERSION.to_string(),
            method: method.to_string(),
            args: Value::Null,
            permissions: permissions.iter().map(|value| value.to_string()).collect(),
            deadline_ms: None,
            trace_id: None,
        }
    }

    #[test]
    fn permissions_are_derived_from_registered_plugin_capabilities() {
        let request = request("profiles.read", &["profiles:read"]);
        assert!(permission_allowed(&request, "profiles.read"));
        assert!(!permission_allowed(&request, "ssh.exec"));
    }

    #[test]
    fn gateway_accepts_existing_and_new_plugin_api_versions() {
        assert!(api_version_supported("1"));
        assert!(api_version_supported("2"));
        assert!(api_version_supported("3"));
        assert!(!api_version_supported("4"));
    }

    #[test]
    fn replay_protection_rejects_duplicate_request_ids() {
        let state = PluginGatewayState::default();
        assert!(state.claim_request("same-id").is_ok());
        assert!(state.claim_request("same-id").is_err());
    }

    #[test]
    fn network_allowlist_requires_https_and_known_hosts() {
        assert!(network_host_allowed("https://api.github.com/gists").is_ok());
        assert!(network_host_allowed("http://api.github.com/gists").is_err());
        assert!(network_host_allowed("https://example.com").is_err());
    }

    #[test]
    fn session_list_is_a_read_only_gateway_method() {
        assert_eq!(
            required_permission("session.probeAgents"),
            Some("session.read")
        );
        assert_eq!(
            runtime_method("session.probeAgents"),
            Some(("session.probeAgents", Some("session.read")))
        );
        assert_eq!(required_permission("session.list"), Some("session.read"));
        assert_eq!(
            runtime_method("session.list"),
            Some(("session.list", Some("session.read")))
        );
        assert_eq!(
            runtime_method("session.current"),
            Some(("session.list", Some("session.read")))
        );
        let mut forged = request("profiles.read", &["forged.permission"]);
        forged.plugin_id = "issh-plugin-serial".to_string();
        assert!(!permission_allowed(&forged, "profiles.read"));
    }

    #[test]
    fn agent_unregister_is_a_write_gateway_method() {
        assert_eq!(required_permission("agent.unregister"), Some("agent.write"));
        assert_eq!(
            runtime_method("agent.unregister"),
            Some(("agent.unregister", Some("agent.write")))
        );
        let mut request = request("agent.unregister", &[]);
        request.plugin_id = "issh-plugin-agent-bridge".to_string();
        assert!(static_plugin_capabilities(&request.plugin_id).is_none());
        assert!(!permission_allowed(&request, "agent.write"));
    }

    #[test]
    fn unknown_plugins_have_no_host_capability_entry() {
        assert!(static_plugin_capabilities("marketplace.unknown").is_none());
    }

    #[test]
    fn ai_assistant_has_only_required_host_capabilities() {
        let capabilities = static_plugin_capabilities("issh-plugin-ai-assistant").unwrap();
        assert_eq!(
            capabilities,
            &[
                "ui.panel.register",
                "terminal.read",
                "terminal.write",
                "network.postJson",
                "mcp.stdio",
                "mcp.remote"
            ]
        );
        assert!(!capabilities.contains(&"ssh.exec"));
    }

    #[tokio::test]
    async fn ai_assistant_can_send_anthropic_headers_through_json_gateway() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/v1/messages", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = [0_u8; 4096];
            let read = stream.read(&mut request).await.unwrap();
            let headers = String::from_utf8_lossy(&request[..read]).to_ascii_lowercase();
            assert!(headers.contains("x-api-key: test-key"));
            assert!(headers.contains("anthropic-version: 2023-06-01"));
            stream
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}")
                .await
                .unwrap();
        });
        let response = http_post_json(&json!({
            "url": url,
            "body": "{}",
            "headers": {
                "content-type": "application/json",
                "x-api-key": "test-key",
                "anthropic-version": "2023-06-01"
            }
        }))
        .await
        .unwrap();
        assert_eq!(response["status"], 200);
        server.await.unwrap();
    }

    #[tokio::test]
    async fn ai_assistant_receives_streamed_http_chunks() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!(
            "http://{}/v1/chat/completions",
            listener.local_addr().unwrap()
        );
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut buffer = [0_u8; 4096];
            let _ = socket.read(&mut buffer).await.unwrap();
            socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n").await.unwrap();
            for part in [
                "data: {\"choices\":[{\"delta\":",
                "{\"content\":\"hi\"}}]}\n\n",
            ] {
                socket
                    .write_all(format!("{:X}\r\n{}\r\n", part.len(), part).as_bytes())
                    .await
                    .unwrap();
            }
            socket.write_all(b"0\r\n\r\n").await.unwrap();
        });
        let state = PluginGatewayState::default();
        let opened = http_stream_open(
            &state,
            "issh-plugin-ai-assistant",
            "stream-test",
            &json!({"url":url,"body":"{}"}),
        )
        .await
        .unwrap();
        let id = opened["streamId"].as_str().unwrap();
        let mut received = Vec::new();
        loop {
            let chunk =
                http_stream_poll(&state, "issh-plugin-ai-assistant", &json!({"streamId":id}))
                    .await
                    .unwrap();
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(chunk["chunkBase64"].as_str().unwrap())
                .unwrap();
            received.extend(bytes);
            if chunk["done"] == true {
                break;
            }
        }
        assert_eq!(
            String::from_utf8(received).unwrap(),
            "data: {\"choices\":[{\"delta\":{\"content\":\"hi\"}}]}\n\n"
        );
        server.await.unwrap();
    }

    #[test]
    fn gateway_permissions_cover_llm_sftp_and_fs_methods() {
        assert_eq!(required_permission("fs.userPaths"), Some("fs.read"));
        assert_eq!(required_permission("fs.readLocalText"), Some("fs.read"));
        assert_eq!(
            required_permission("ssh.execReadonly"),
            Some("ssh.execReadonly")
        );
        assert_eq!(
            required_permission("http.postJson"),
            Some("network.postJson")
        );
        assert_eq!(required_permission("sftp.open"), Some("sftp.read"));
        assert_eq!(required_permission("sftp.list"), Some("sftp.read"));
        assert_eq!(required_permission("sftp.stat"), Some("sftp.read"));
        assert_eq!(required_permission("sftp.close"), Some("sftp.read"));
        assert_eq!(required_permission("sftp.mkdir"), Some("sftp.write"));
        assert_eq!(required_permission("sftp.rename"), Some("sftp.write"));
        assert_eq!(required_permission("sftp.chmod"), Some("sftp.write"));
        assert_eq!(
            runtime_method("ssh.execReadonly"),
            Some(("ssh.execReadonly", Some("ssh.execReadonly")))
        );
    }

    #[test]
    fn llm_plugin_host_capabilities_cover_gateway_usage() {
        let capabilities = static_plugin_capabilities("issh-plugin-llm").unwrap();
        for required in ["fs.read", "ssh.exec", "network.postJson"] {
            assert!(
                capabilities.contains(&required),
                "llm 插件缺少能力：{required}"
            );
        }
    }

    #[test]
    fn config_sync_host_capabilities_cover_vault_unlock() {
        let capabilities = static_plugin_capabilities("issh-plugin-config-sync").unwrap();
        assert!(
            capabilities.contains(&"vault.read"),
            "config-sync 插件缺少能力：vault.read"
        );
        assert_eq!(required_permission("vault.unlock"), Some("vault.read"));
    }

    #[test]
    fn shell_history_path_allowlist_rejects_arbitrary_files() {
        if let Some(home) = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")) {
            let home = home.to_string_lossy().into_owned();
            assert!(is_shell_history_path(&format!("{home}\\.bash_history")));
            assert!(is_shell_history_path(&format!("{home}/.zsh_history")));
            assert!(!is_shell_history_path(&format!(
                "{home}\\Documents\\secrets.txt"
            )));
        }
        if let Some(app_data) = std::env::var_os("APPDATA") {
            let app_data = app_data.to_string_lossy().into_owned();
            assert!(is_shell_history_path(&format!(
                "{app_data}\\Microsoft\\Windows\\PowerShell\\PSReadLine\\ConsoleHost_history.txt"
            )));
        }
        assert!(!is_shell_history_path("C:\\Windows\\win.ini"));
        assert!(!is_shell_history_path("..\\.bash_history"));
    }
}
