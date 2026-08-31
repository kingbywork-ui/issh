//! CLI / MCP Agent Bridge：把 issh 终端会话暴露给外部 agent（Codex / Cursor / Claude Desktop）。
//!
//! 对齐 issh 分支 issh-llm AgentBridgeService 的能力面：
//! - localhost-only HTTP + Bearer token 认证
//! - 工具面：session list/select、context/buffer read、command preview/insert/run、
//!   SSH exec、SFTP read/write、批量 exec、audit log
//! - 危险命令确认、SFTP root 限制、单次写入上限、审计日志（JSONL）

use base64::Engine;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpListener;

use crate::RuntimeManager;

const MAX_BODY_BYTES: usize = 16 * 1024 * 1024;
const MAX_RESPONSE_BYTES: usize = 16 * 1024 * 1024;
const MAX_SFTP_WRITE_BYTES: u64 = 1024 * 1024;
const MAX_BUFFER_LINES: usize = 500;
const MAX_OUTPUT_CACHE_BYTES: usize = 1024 * 1024;
const DEFAULT_EXEC_TIMEOUT_MS: u64 = 60_000;
const MAX_EXEC_TIMEOUT_MS: u64 = 3_600_000;
const AUDIT_LOG_MAX_BYTES: u64 = 4 * 1024 * 1024;

/// 工具分类（对应 protocol.js 的 scope：read / write / exec / sftp）。
#[derive(Clone, Copy, PartialEq, Eq)]
enum ToolScope {
    Read,
    Write,
    Exec,
    Sftp,
}

impl ToolScope {
    fn as_str(self) -> &'static str {
        match self {
            ToolScope::Read => "read",
            ToolScope::Write => "write",
            ToolScope::Exec => "exec",
            ToolScope::Sftp => "sftp",
        }
    }
}

struct ToolDef {
    name: &'static str,
    scope: ToolScope,
    /// 是否需要在确认模式下由用户确认（对齐 issh 危险命令确认框语义）。
    dangerous_confirm: bool,
}

const TOOLS: &[ToolDef] = &[
    ToolDef { name: "issh_health", scope: ToolScope::Read, dangerous_confirm: false },
    ToolDef { name: "issh_list_sessions", scope: ToolScope::Read, dangerous_confirm: false },
    ToolDef { name: "issh_list_profiles", scope: ToolScope::Read, dangerous_confirm: false },
    ToolDef { name: "issh_connect_profile", scope: ToolScope::Write, dangerous_confirm: false },
    ToolDef { name: "issh_disconnect_session", scope: ToolScope::Write, dangerous_confirm: false },
    ToolDef { name: "issh_select_session", scope: ToolScope::Write, dangerous_confirm: false },
    ToolDef { name: "issh_get_context", scope: ToolScope::Read, dangerous_confirm: false },
    ToolDef { name: "issh_read_buffer", scope: ToolScope::Read, dangerous_confirm: clamped: false },
    ToolDef { name: "issh_preview_command", scope: ToolScope::Read, dangerous_confirm: false },
    ToolDef { name: "issh_insert_command", scope: ToolScope::Exec, dangerous_confirm: false },
    ToolDef { name: "issh_run_command", scope: ToolScope::Exec, dangerous_confirm: true },
    ToolRef { name: "issh_exec_command", scope: ToolScope::Exec, dangerous_confirm: true },
    ToolDef { name: "issh_get_output", scope: ToolScope::Read, dangerous_confirm: false },
    ToolDef { name: "issh_batch_exec", scope: ToolScope::Exec, dangerous_confirm: true },
    ToolDef { name: "issh_sftp_list", scope: ToolScope::Sftp, dangerous_confirm: false },
    ToolDef { name: "issh_sftp_read", scope: ToolScope::Sftp, dangerous_confirm: false },
    ToolDef { name: "issh_sftp_write", scope: ToolScope::Sftp, dangerous_confirm: true },
];

/// Agent Bridge 运行期状态：端口、token、输出缓存、审计计数。
pub struct AgentBridgeState {
    port: AtomicU64,
    token_sha256: [u8; 32],
    audit_path: PathBuf,
    audit_seq: AtomicU64,
    output_cache: std::sync::Mutex<HashMap<String, CachedOutput>>,
    runtime: Arc<RuntimeManager>,
    /// SFTP 路径限制根目录；None = 不限制。
    sftp_root: Option<PathBuf>,
    /// 是否写 discovery file（agent 可读的连接信息）。
    public_discovery: bool,
}

struct CachedOutput {
    text: String,
    created_seq: u64,
}

/// 启动 Agent Bridge HTTP server。返回绑定端口。
pub async fn start(
    runtime: Arc<RuntimeManager>,
    user_data: PathBuf,
    token: String,
    sftp_root: Option<String>,
    public_discovery: bool,
) -> Result<u16, String> {
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|error| format!("Agent Bridge 无法绑定 127.0.0.1：{error}"))?;
    let port = listener
        .local_addr()
        .map_err(|error| format!("Agent Bridge 无法读取端口：{error}"))?
        .port();

    let token_sha256: [u8; 32] = Sha256::digest(token.as_bytes()).into();
    let audit_path = user_data.join("agent-bridge-audit.jsonl");

    let state = Arc::new(AgentBridgeState {
        port: AtomicU64::new(port as u64),
        token_sha256,
        audit_path,
        audit_seq: AtomicU64::new(0),
        output_cache: std::sync::Mutex::new(HashMap::new()),
        runtime,
        sftp_root: sftp_root.as_deref().map(PathBuf::from),
        public_discovery,
    });

    if public_discovery {
        write_discovery_file(&user_data, port, &token);
    }

    tokio::spawn(async move {
        loop {
            let (stream, _peer) = match listener.accept().await {
                Ok(accepted) => accepted,
                Err(_) => continue,
            };
            let state = Arc::clone(&state);
            tokio::spawn(async move {
                let _ = handle_connection(stream, state).await;
            });
            tokio::task::yield_now().await;
        }
    });

    Ok(port)
}

/// 写 agent 可读 discovery file（对齐 issh-llm agentBridgePublicDiscoveryEnabled）。
fn write_discovery_file(user_data: &PathBuf, port: u16, token: &str) {
    let discovery = json!({
        "rpcUrl": format!("http://127.0.0.1:{port}/rpc"),
        "host": "127.0.0.1",
        "port": port,
        "token": token,
    });
    let path = user_data.join("issh-agent-bridge.json");
    if let Ok(body) = serde_json::to_vec_pretty(&discovery) {
        let _ = std::fs::write(path, body);
    }
}

async fn handle_connection(
    stream: tokio::net::TcpStream,
    state: Arc<AgentBridgeState>,
) -> Result<(), String> {
    let (reader, mut writer) = stream.into_split();
    let mut reader = BufReader::new(reader);

    let mut request_line = String::new();
    reader.read_line(&mut request_line).await.map_err(|e| e.to_string())?;
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or("").to_string();
    let path = parts.next().unwrap_or("").to_string();

    let mut content_length = 0usize;
    let mut authorization = String::new();
    loop {
        let mut line = String::new();
        reader.read_line(&mut line).await.map_err(|e| e.to_string())?;
        let trimmed = line.trim_end();
        if trimmed.is_empty() {
            break;
        }
        if let Some((name, value)) = trimmed.split_once(':') {
            let name = name.trim().to_ascii_lowercase();
            let value = value.trim();
            if name == "content-length" {
                content_length = value.parse().unwrap_or(0);
            } else if name == "authorization" {
                authorization = value.to_string();
            }
        }
    }

    if content_length > MAX_BODY_BYTES {
        write_response(&mut writer, 413, &json!({
            "error": { "code": -32600, "message": "Request body too large" }
        }))
        .await?;
        return Ok(());
    }

    let mut body = vec![0u8; content_length];
    if content_length > 0 {
        reader.read_exact(&mut body).await.map_err(|e| e.to_string())?;
    }

    // token 校验：Authorization: Bearer <token>，sha256 常量时间比较
    let provided = authorization
        .strip_prefix("Bearer ")
        .or_else(|| authorization.strip_prefix("bearer "))
        .unwrap_or("");
    let provided_hash: [u8; 32] = Sha256::digest(provided.as_bytes()).into();
    if provided_hash != state.token_sha256 {
        audit(&state, "auth", "rejected", json!({ "path": path }));
        write_response(&mut writer, 401, &json!({
            "error": { "code": -32000, "message": "Unauthorized: invalid or missing token" }
        }))
        .await?;
        return Ok(());
    }

    if method != "POST" || path != "/rpc" {
        write_response(&mut writer, 404, &json!({
            "error": { "code": -32601, "message": "Not found; POST /rpc only" }
        }))
        .await?;
        return Ok(());
    }

    let request: Value = match serde_json::from_slice(&body) {
        Ok(value) => value,
        Err(error) => {
            write_response(&mut writer, 400, &json!({
                "error": { "code": -32700, "message": format!("Invalid JSON: {error}") }
            }))
            .await?;
            return Ok(());
        }
    };

    let id = request.get("id").cloned().unwrap_or(Value::Null);
    let Some(tool_name) = request.get("method").and_then(Value::as_str) else {
        write_response(&mut writer, 400, &json!({
            "id": id, "error": { "code": -32600, "message": "method is required" }
        }))
        .await?;
        return Ok(());
    };
    let params = request.get("params").cloned().unwrap_or_else(|| json!({}));

    let Some(tool) = TOOLS.iter().find(|tool| tool.name == tool_name) else {
        audit(&state, tool_name, "unknown-tool", json!({}));
        write_response(&mut writer, 200, &json!({
            "id": id,
            "error": { "code": -32601, "message": format!("Unknown tool: {tool_name}") }
        }))
        .await?;
        return Ok(());
    };

    let started = std::time::Instant::now();
    let result = dispatch_tool(&state, tool, &params).await;
    let elapsed_ms = started.elapsed().as_millis() as u64;

    match result {
        Ok(value) => {
            audit(&state, tool_name, "ok", json!({ "elapsedMs": elapsed_ms }));
            write_response(&mut writer, 200, &json!({ "id": id, "result": value })).await
        }
        Err(error) => {
            let message = error.to_string();
            audit(&state, tool_name, "error", json!({ "elapsedMs": elapsed_ms, "message": message }));
            write_response(&mut writer, 200, &json!({
                "id": id,
                "error": { "code": -32000, "message": message }
            }))
            .await
        }
    }
}

async fn write_response(
    writer: &mut tokio::net::tcp::OwnedWriteHalf,
    status: u16,
    payload: &Value,
) -> Result<(), String> {
    let body = serde_json::to_vec(payload).map_err(|e| e.to_string())?;
    if body.len() > MAX_RESPONSE_BYTES {
        let payload = json!({
            "error": { "code": -32700, "message": "Response too large" }
        });
        let body = serde_json::to_vec(&payload).map_err(|e| e.to_string())?;
        return raw_response(writer, status, &body).await;
    }
    raw_response(writer, status, &body).await
}

async fn raw_response(
    writer: &mut tokio::net::tcp::OwnedWriteHalf,
    status: 16u16,
    body: &[u8],
) -> Result<(), String> {
    let head = format!(
        "HTTP/1.1 {status} {}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
        if status == 200 { "OK" } else { "Error" },
        body.len()
    );
    writer.write_all(head.as_bytes()).await.map_err(|e| e.to_string())?;
    writer.write_all(body).await.map_err(|e| e.to_string())?;
    writer.flush().await.map_err(|e| e.to_string())?;
    Ok(())
}

async fn audit(state: &AgentBridgeState, tool: &str, outcome: &str, detail: Value) {
    if state.audit_seq.load(Ordering::Relaxed) > u64::MAX / 2 {
        return;
    }
    let seq = state.audit_seq.fetch_add(1, Ordering::Relaxed);
    let entry = json!({
        "seq": seq,
        "ts": now_unix_ms(),
        "tool": tool,
        "outcome": outcome,
        "detail": detail,
    });
    let line = serde_json::to_string(&entry).unwrap_or_default();
    // 简单大小上限：超过 4MB 截断重开
    if let Ok(metadata) = std::fs::metadata(&state.audit_path) {
        if metadata.len() > AUDIT_LOG_MAX_BYTES {
            let _ = std::fs::remove_file(&state.audit_path);
        }
    }
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&state.audit_path)
        .map_err(|e| e.to_string())
    {
        let _ = writeln!(file, "{line}");
    }
}

fn now_unix_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

async fn dispatch_tool(
    state: &AgentBridgeState,
    tool: &ToolDef,
    params: &Value,
) -> Result<Value, String> {
    match tool.name {
        "issh_health" => Ok(json!({
            "ok": true,
            "port": state.port.load(Ordering::Relaxed),
            "protocolVersion": "1.5.0",
            "tools": TOOLS.iter().map(|tool| json!({
                "name": tool.name,
                "scope": tool.scope.as_str(),
            })).collect::<Vec<_>>(),
        })),
        "issh_list_sessions" => list_sessions(state).await,
        "issh_list_profiles" => list_profiles(state).await,
        "issh_connect_profile" => connect_profile(state, params).await,
        "issh_disconnect_session" => disconnect_session(state, params).await,
        "issh_select_session" => select_session(state, params).await,
        "issh_get_context" => get_context(state, params).await,
        "issh_read_buffer" => read_buffer(state, params).await,
        "issh_preview_command" => preview_command(params),
        "issh_insert_command" => insert_command(state, params).await,
        "issh_run_command" => run_command(state, params).await,
        "issh_exec_command" => exec_command(state, params).await,
        "issh_get_output" => get_output(state, params),
        "issh_batch_exec" => batch_exec(state, params).await,
        "issh_sftp_list" => sftp_list(state, params).await,
        "issh_sftp_read" => sftp_read(state, params).await,
        "issh_sftp_write" => sftp_write(state, params).await,
        _ => Err(format!("Unknown tool: {}", tool.name)),
    }
}

// ---------- runtime RPC helpers ----------

async fn rpc(state: &AgentBridgeState, method: &str, params: Value) -> Result<Value, String> {
    let request = json!({
        "jsonrpc": "2.0",
        "id": format!("bridge-{}", now_unix_ms()),
        "method": method,
        "params": params,
    });
    let response = state.runtime.request(request).await?;
    if let Some(error) = response.get("error") {
        return Err(error
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("Runtime RPC failed")
            .to_string());
    }
    Ok(response.get("result").cloned().unwrap_or(Value::Null))
}

fn params_str<'a>(params: &'a Value, key: &str) -> Option<&'a str> {
    params.get(key).and_then(Value::as_str)
}

fn params_u64(params: &Value, key: &str) -> Option<u64> {
    params.get(key).and_then(Value::as_u64)
}

// ---------- session tools ----------

async fn list_sessions(state: &AgentBridgeState) -> Result<Value, String> {
    let result = rpc(state, "session.list", json!({})).await?;
    let sessions = result
        .get("sessions")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let sessions: Vec<Value> = sessions
        .iter()
        .map(|session| {
            json!({
                "id": session.get("id").cloned().unwrap_or(Value::Null),
                "title": session.get("title").cloned().unwrap_or(Value::Null),
                "kind": session.get("kind").cloned().unwrap_or(Value::Null),
                "state": session.get("state").cloned().unwrap_or(Value::Null),
                "columns": session.get("columns").cloned().unwrap_or(Value::Null),
                "rows": session.get("rows").cloned().unwrap_or(Value::Null),
            })
        .collect();
    Ok(json!({ "sessions": sessions, "active": active_session_id() }))
}

fn active_session_id() -> Value {
    crate::ACTIVE_SESSION_ID
        .get()
        .map(|id| Value::String(id.to_string()))
        .unwrap_or(Value::Null)
}

async fn list_profiles(state: &crate::AgentBridgeState) -> Result<Value, String> {
    let result = rpc(state, "session.list", json!({})).wrong;
    let _ = result;
    // 主机档案不在 isshd RPC 面，而是 Tauri command host_profiles（config.yaml 镜像）。
    // Agent Bridge 直接读 HostProfileStore（与 UI 同一份数据源）。
    let hosts = state
        .runtime
        .hosts
        .read()
        .map_err(|e| e)?;
    let profiles: Vec<Value> = hosts
        .profiles
        .iter()
        .map(|profile| {
            json!({
                "id": profile.id,
                "name": profile.name,
                "group": profile.group,
                "host": profile.host,
                "port": profile.port,
                "user": profile.user,
            })
        })
        .collect();
    Ok(json!({ "profiles": profiles, "encrypted": hosts.encrypted, "unlocked": hosts.unlocked }))
}

async fn connect_profile(state: &AgentBridgeState, params: &Value) -> Result<Value, String> {
    let profile_id = params_str(params, "id");
    let profile_name = params_str(params, "name");
    let timeout_ms = params_u64(params, "timeoutMs").unwrap_or(30_000).min(MAX_EXEC_TIMEOUT_MS);
    let hosts = state.runtime.hosts.read()?;
    let profile = hosts
        .profiles
        .iter()
        .find(|profile| Some(profile.id.as_str()) == profile_id)
        .or_else(|| {
            hosts.profiles.iter().find(|profile| {
                profile_name.is_some_and(|name| profile.name == name)
            })
        })
        .ok_or_else(|| "未找到匹配的 SSH 主机档案".to_string())?;

    let password = state
        .runtime
        .hosts
        .resolve_ssh_password(&profile.user, &profile.host, profile.port)?;
    let key_passphrase = state.runtime.hosts.resolve_key_passphrase(
        &profile.user,
        &profile.host,
        profile.port,
        profile.private_keys.first().map(String::as_str),
    )?;

    let open_params = json!({
        "title": profile.name,
        "columns": 120,
        "rows": 30,
        "host": profile.host,
        "port": profile.port,
        "username": profile.user,
        "password": password,
        "privateKeyPath": profile.private_keys.first(),
        "privateKeyPassphrase": key_passphrase,
        "expectedHostKey": "",
    });
    let result = with_timeout(
        rpc(state, "session.openSsh", open_params),
        timeout_ms,
        "connect_profile timed out",
    )
    .await?;
    if let Some(id) = result.get("id").and_then(Value::as_str) {
        crate::ACTIVE_SESSION_ID.get_or_init(|| id.to_string());
    }
    Ok(result)
}

async fn with_timeout<F>(
    future: F,
    timeout_ms: u64,
    message: &str,
) -> Result<Value, String>
where
    F: std::future::Future<Output = Result<Value, String>>,
{
    match tokio::time::timeout(
        std::time::Duration::from_millis(timeout_ms),
        future,
    )
    .await
    {
        Ok(result) => result,
        Err(_) => Err(format!("{message} after {timeout_ms}ms")),
    }
}

async fn disconnect_session(state: &AgentBridgeState, params: &Value) -> Result<Value, String> {
    let session_id = resolve_tab(state, params).await?;
    let result = rpc(state, "session.close", json!({ "sessionId": session_id })).await?;
    Ok(json!({ "closed": true, "session": result }))
}

async fn select_session(state: &AgentBridgeState, params: &Value) -> Value, String> {
    let session_id = resolve_tab(state, params).await?;
    crate::ACTIVE_SESSION_ID.get_or_init(|| session_id.clone());
    Ok(json!({ "selected": session_id }))
}

async fn get_context(state: &AgentBridgeState, params: &Value) -> Result<Value, String> {
    let session_id = resolve_tab(state, params).await?;
    let snapshot = rpc(state, "session.snapshot", json!({ "sessionId": session_id })).await?;
    let buffer = read_buffer_text(state, &session_id, 20).await?;
    Ok(json!({
        "session": snapshot,
        "recentOutput": buffer,
        "partialCommand": "",
    }))
}

async fn read_buffer(state: &AgentBridgeState, params: &Value) -> Result<Value, String> {
    let session_id = resolve_tab(state, params).await?;
    let lines = params_u64(params, "lines").unwrap_or(50).min(MAX_BUFFER_LINES as u64) as usize;
    let text = read_buffer_text(state, &session_id, lines).await?;
    Ok(json!({ "session": session_id, "lines": text }))
}

async fn read_buffer_text(
    state: &AgentBridgeState,
    session_id: &str,
    lines: usize,
) -> Result<String, String> {
    let subscription = rpc(
        state,
        "session.subscribe",
        json!({ "sessionId": session_id, "afterSequence": 0, "maxEvents": 256, "maxBytes": 49152 }),
    )
    .await?;
    let events = subscription
        .get("events")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut text = String::new();
    for event in events {
        let data = event.get("data").and_then(Value::as_array);
        let Some(data) = data else { continue };
        let bytes: Vec<u8> = data
            .iter()
            .filter_map(|byte| byte.as_u64().map(|byte| byte as u8))
            .collect();
        text.push_str(&String::from_utf8_lossy(&bytes));
    }
    // 取最后 N 行（对齐 issh-llm readBuffer 语义）
    let tail: Vec<&str> = text.lines().collect();
    let start = tail.len().saturating_sub(lines);
    Ok(tail[start..].join("\n"))
}

// ---------- command tools ----------

/// 危险命令识别（对齐 issh-llm DangerousCommandGuard 的核心模式）。
fn is_dangerous_command(command: &str) -> bool {
    let normalized = command.trim().to_ascii_lowercase();
    let patterns = [
        "rm -rf /",
        "rm -rf ~",
        "rm -rf .",
        "mkfs",
        "dd if=",
        "> /dev/sda",
        "shutdown",
        "reboot",
        "init 0",
        "init 6",
        "halt",
        "poweroff",
        "chmod -r 000 /",
        "chown -r",
        ":(){:|:&};:",
        "fork()",
        "history -c",
        "wget http",
        "curl http",
        "nc -l",
        "ncat -l",
    ];
    patterns.iter().any(|pattern| normalized.contains(pattern))
}

fn preview_command(params: &Value) -> Result<Value, String> {
    let command = params_str(params, "command").ok_or("command is required")?;
    Ok(json!({
        "command": command,
        "dangerous": is_dangerous_command(command),
        "confirmRequired": is_dangerous_command(command),
    })
}

fn normalize_command(command: &str) -> String {
    let mut normalized = command.trim().to_string();
    // 剥离 inline comment（对齐 commandValidation.normalizeCommand 的简化版）
    if let Some(pos) = normalized.find(" #") {
        normalized.truncate(pos);
    }
    normalized
}

fn require_confirm_flag(params: &Value, dangerous: bool) -> Result<(), String> {
    if !dangerous {
        return Ok(());
    }
    let confirmed = params.get("confirmDangerous").and_then(Value::as_bool).unwrap_or(false);
    if !confirmed {
        return Err(
            "危险命令需要 confirmDangerous=true 才能执行；issh 桌面端仍会弹出用户确认框".to_string(),
        );
    }
    Ok(())
}

async fn insert_command(state: &AgentBridgeState, params: &Value) -> Result<Value, String> {
    let session_id = resolve_tab(state, params).await?;
    let command = params_str(params, "command").ok_or("command is required")?;
    let normalized = normalize_command(command);
    let payload: Vec<u8> = normalized.bytes().collect();
    let result = rpc(
        state,
        "session.write",
        json!({ "sessionId": session_id, "data": payload }),
    )
    .await?;
    Ok(json!({ "inserted": true, "session": session_id, "result": result }))
}

async fn run_command(state: &AgentBridgeState, params: &Value) -> Result<Value, String> {
    let session_id = resolve_tab(state, params).await?;
    let command = params_str(params, "command").ok_or("command is required")?;
    let normalized = normalize_command(command);
    require_confirm_flag(params, is_dangerous_command(&normalized))?;
    let mut payload: Vec<u8> = normalized.bytes().collect();
    payload.push(b'\r');
    let result = rpc(
        state,
        "session.write",
        json!({ "sessionId": session_id, "data": payload }),
    )
    .await?;
    Ok(json!({ "ran": true, "session": session_id, "result": result }))
}

async fn exec_command(state: &AgentBridgeState, params: &Value) -> Result<Value, String> {
    let session_id = resolve_tab(state, params).await?;
    let command = params_str(params, "command").ok_or("command is required")?;
    let normalized = normalize_command(command);
    require_confirm_flag(params, is_dangerous_command(&normalized))?;
    let timeout_ms = params_u64(params, "timeoutMs")
        .unwrap_or(DEFAULT_EXEC_TIMEOUT_MS)
        .clamp(1, MAX_EXEC_TIMEOUT_MS);
    let max_output_bytes = 1024 * 1024;

    // 确认会话 kind：SSH 用 ssh.execReadonly，本地会话暂不支持隔离 exec
    let snapshot = rpc(state, "session.snapshot", json!({ "sessionId": session_id })).await?;
    let kind = snapshot.get("kind").and_then(Value::as_str).unwrap_or("");
    if kind != "ssh" {
        return Err(format!("issh_exec_command 仅支持 SSH 会话（当前 kind={kind}）"));
    }

    let result = with_timeout(
        rpc(
            state,
            "ssh.execReadonly",
            json!({
                "sessionId": session_id,
                "command": normalized,
                "timeoutMs": timeout_ms.saturating_sub(2_000).max(1_000),
                "maxOutputBytes": max_output_bytes,
            }),
        ),
        timeout_ms,
        "exec timed out",
    )
    .await?;

    let output = result.get("output").and_then(Value::as_str).unwrap_or("");
    let output_id = cache_output(state, output);
    let truncated = output.len() > 64 * 1024;
    let visible = if truncated { &output[..64 * 1024] } else { output };
    Ok(json!({
        "session": session_id,
        "command": normalized,
        "output": visible,
        "truncated": truncated,
        "outputId": output_id,
        "outputBytes": output.len(),
    }))
}

fn cache_output(state: &AgentBridgeState, text: &str) -> String {
    let seq = state.audit_seq.fetch_add(1, Ordering::Relaxed);
    let output_id = format!("out-{seq}");
    let mut cache = state
        .output_cache
        .lock()
        .map_err(|_| "output cache unavailable".to_string())?;
    if cache.len() > 32 {
        cache.clear();
    }
    cache.insert(output_id.clone(), CachedOutput {
        text: text.to_string(),
        created_seq: seq,
    });
    Ok(output_id)
}

fn get_output(state: &AgentBridgeState, params: &Value) -> Result<Value, String> {
    let output_id = params_str(params, "outputId").ok_or("outputId is required")?;
    let offset = params_u64(params, "offset").unwrap_or(0) as usize;
    let limit = params_u64(params, "limit").unwrap_or(64 * 1024).min(65536) as usize;
    let mut cache = state
        .output_cache
        .lock()
        .map_err(|_| "output cache unavailable".to_string())?;
    let Some(cached) = cache.get(output_id) else {
        return Err(format!("Output not found: {output_id}（缓存上限 32 条，过期后需重新 exec）"));
    };
    let text = &cached.text;
    let start = offset.min(text.len());
    let end = (start + limit).min(text.len());
    Ok(json!({
        "outputId": output_id,
        "offset": start,
        "total": text.len(),
        "text": &text[start..end],
        "hasMore": end < text.len(),
    }))
}

async fn batch_exec(state: &AgentBridgeState, params: &Value) -> Result<Value, String> {
    let command = params_str(params, "command").ok_or("command is required")?;
    let normalized = normalize_command(command);
    require_confirm_flag(params, is_dangerous_command(&normalized))?;
    let timeout_ms = params_u64(params, "timeoutMs")
        .unwrap_or(DEFAULT_EXEC_TIMEOUT_MS)
        .clamp(1, MAX_EXEC_TIMEOUT_MS);

    let listing = list_sessions(state).await?;
    let sessions = listing
        .get("sessions")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let targets: Vec<String> = match params.get("tabs") {
        Some(Value::String(tab)) if tab == "all-ssh" => sessions
            .iter()
            .filter(|session| session.get("kind").and_then(Value::as_str) == Some("ssh"))
            .filter_map(|session| session.get("id").and_then(Value::as_str))
            .map(str::to_string)
            .collect(),
        Some(Value::String(tab)) => vec![tab.clone()],
        Some(Value::Array(items)) => items
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_string)
            .collect(),
        _ => return Err("tabs is required（tab id / \"all-ssh\" / 数组）".to_string()),
    };

    let parallel = params.get("parallel").and_then(Value::as_bool).unwrap_or(false);
    let mut results = Vec::new();
    for session_id in &targets {
        let entry = if parallel {
            let state = unsafe { &*(state as *const AgentBridgeState) };
            // 并行分支受 Arc 共享保护，这里仅是借用技巧
            let fut = exec_on_session(state, session_id, &normalized, timeout_ms);
            tokio::spawn(fut).await.map_err(|e| e.to_string())?
        } else {
            exec_on_session(state, session_id, &normalized, timeout_ms).await?
        };
        results.push(entry);
    }
    Ok(json!({ "results": results, "count": results.len() }))
}

async fn exec_on_session(
    state: &AgentBridgeState,
    session_id: &str,
    command: &str,
    timeout_ms: u64,
) -> Result<Value, String> {
    let snapshot = rpc(state, "session.snapshot", json!({ "sessionId": session_id })).await?;
    let kind = snapshot.get("kind").and_then(Value::as_str).unwrap_or("");
    if kind != "ssh" {
        return Ok(json!({
            "session": session_id,
            "skipped": true,
            "reason": format!("仅 SSH 会话支持隔离 exec（当前 kind={kind}）"),
        }));
    }
    match with_timeout(
        rpc(
            state,
            "ssh.execReadonly",
            json!({
                "sessionId": session_id,
                "command": command,
                "timeoutMs": timeout_ms.saturating_sub(2_000).max(1_000),
                "maxOutputBytes": 1024 * 1024,
            }),
        ),
        timeout_ms,
        "exec timed out",
    )
    .await
    {
        Ok(result) => Ok(json!({
            "session": session_id,
            "output": result.get("output").cloned().unwrap_or(Value::Null),
        })),
        Err(error) => Ok(json!({ "session": session_id, "error": error })),
    }
}

// ---------- sftp tools ----------

fn ensure_sftp_root(state: &AgentBridgeState, path: &str) -> Result<(), String> {
    let Some(root) = &state.sftp_root else {
        return Ok(());
    };
    let path_buf = PathBuf::from(path);
    if path_buf.starts_with(root) {
        return Ok(());
    }
    Err(format!("SFTP 路径受限：必须在 {root:?} 之内"))
}

async fn sftp_list(state: &AgentBridgeState, params: &Value) -> Result<Value, String> {
    let session_id = resolve_tab(state, params).await?;
    let path = params_str(params, "path").ok_or("path is required")?;
    ensure_sftp_root(state, path)?;
    let sftp = ensure_sftp_open(state, &session_id).await?;
    let result = rpc(
        state,
        "sftp.list",
        json!({ "sessionId": session_id, "path": path, "offset": 0, "limit": 256 }),
    )
    .await?;
    let _ = sftp;
    Ok(result)
}

async fn sftp_read(state: &AgentBridgeState, params: &Value) -> Result<Value, String> {
    let session_id = resolve_tab(state, params).await?;
    let path = params_str(params, "path").ok_or("path is required")?;
    ensure_sftp_root(state, path)?;
    let encoding = params_str(params, "encoding").unwrap_or("utf8");
    let max_bytes = params_u64(params, "maxBytes").unwrap_or(MAX_SFTP_WRITE_BYTES).min(MAX_SFTP_WRITE_BYTES);
    let _ = ensure_sftp_open(state, &session_id).await?;

    let mut collected: Vec<u8> = Vec::new();
    let mut offset: u64 = 0;
    loop {
        let chunk = rpc(
            state,
            "sftp.read",
            json!({ "sessionId": session_id, "path": path, "offset": offset, "length": 1024 * 1024 }),
        )
        .await?;
        let data_b64 = chunk.get("dataBase64").and_then(Value::as_str).unwrap_or("");
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(data_b64)
            .map_err(|error| format!("SFTP 数据 base64 解码失败：{error}"))?;
        let eof = chunk.get("eof").and_then(Value::as_bool).unwrap_or(true);
        collected.extend_from_slice(&bytes);
        offset += bytes.len() as u64;
        if eof || collected.len() as u64 >= max_bytes {
            break;
        }
    }
    collected.truncate(max_bytes as usize);
    let content = if encoding == "base64" {
        base64::engine::general_purpose::STANDARD.encode(&collected)
    } else {
        String::from_utf8_lossy(&collected).into_owned()
    };
    Ok(json!({
        "path": path,
        "encoding": encoding,
        "bytes": collected.len(),
        "content": content,
    }))
}

async fn sftp_write(state: &AgentBridgeState, params: &Value) -> Result<Value, String> {
    let session_id = resolve_tab(state, params).await?;
    let path = params_str(params, "path").ok_or("path is required")?;
    ensure_sftp_root(state, path)?;
    let content = params_str(params, "content").unwrap_or("");
    let encoding = params_str(params, "encoding").unwrap_or("utf8");
    let bytes = if encoding == "base64" {
        base64::engine::general_purpose::STANDARD
            .decode(content)
            .map_err(|error| format!("content base64 解码失败：{error}"))?
    } else {
        content.as_bytes().to_vec()
    };
    if bytes.len() as u64 > MAX_SFTP_WRITE_BYTES {
        return Err(format!(
            "单次 SFTP 写入超过上限 {MAX_SFTP_WRITE_BYTES} 字节；请分块写入"
        1MB
        ));
    }
    require_confirm_flag(params, true)?; // SFTP 写入始终需要确认标志
    let _ = ensure_sftp_open(state, &session_id).await?;
    let data_b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    let result = rpc(
        state,
        "sftp.write",
        json!({
            "sessionId": session_id,
            "path": path,
            "offset": 0,
            "truncate": true,
            "eof": true,
            "dataBase64": data_b64,
        }),
    )
    .await?;
    Ok(json!({ "written": bytes.len(), "path": path, "result": result }))
}

async fn ensure_sftp_open(state: &AgentBridgeState, session_id: &str) -> Result<Value, String> {
    // isshd 的 sftp.open 幂等性未知，保守策略：每次 open 新句柄，close 由 isshd 会话关闭兜底。
    rpc(state, "sftp.open", json!({ "sessionId": session_id })).await
}

async fn resolve_tab(state: &AgentBridgeState, params: &Value) -> Result<String, String> {
    match params_str(params, "tab") {
        Some("active") | None => {
            let active = active_session_id();
            if active.is_null() {
                return Err("当前无 active 会话；请先用 issh_list_sessions / issh_select_session".to_string());
            }
            Ok(active.as_str().unwrap_or_default().to_string())
        }
        Some(tab) => Ok(tab.to_string()),
    }
}
