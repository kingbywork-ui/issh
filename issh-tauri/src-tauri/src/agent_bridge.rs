//! CLI / MCP Agent Bridge：把 issh 终端会话暴露给外部 agent（Codex / Cursor / Claude Desktop）。
//!
//! 对齐 issh 分支 issh-llm AgentBridgeService 的能力面：
//! - localhost-only HTTP + Bearer token 认证，端口固定 59688（R-045）
//! - 工具面：session list/select、context/buffer read、command preview/insert/run、
//!   SSH exec、SFTP read/write、批量 exec、audit log
//! - 危险命令确认、SFTP root 限制、单次写入上限、审计日志（JSONL）
//!
//! 安全开关语义（R-045）：enabled 不持久化，由 Tauri 端每次手动开启；
//! 完全退出进程时自动停止；最小化到托盘时保持运行。

use base64::Engine;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpListener;

use crate::agent_bridge_config::PermissionMode;
use crate::RuntimeManager;

/// Agent Bridge 固定监听端口（R-045：不再自动选择）。
pub const AGENT_BRIDGE_PORT: u16 = 59688;

const MAX_BODY_BYTES: usize = 16 * 1024 * 1024;
const MAX_RESPONSE_BYTES: usize = 16 * 1024 * 1024;
const MAX_SFTP_WRITE_BYTES: u64 = 1024 * 1024;
const MAX_BUFFER_LINES: usize = 500;
const MAX_OUTPUT_CACHE_ENTRIES: usize = 32;
const DEFAULT_EXEC_TIMEOUT_MS: u64 = 60_000;
const MAX_EXEC_TIMEOUT_MS: u64 = 3_600_000;
const AUDIT_LOG_MAX_BYTES: u64 = 4 * 1024 * 1024;
/// session.subscribe 的 maxBytes 上限（isshd MAX_SESSION_BATCH_BYTES = 12 KiB）。
const MAX_SUBSCRIBE_BYTES: u64 = 12 * 1024;

/// 当前选中（active）会话 id，由 Tauri 前端通过 set_active_session 上报。
static ACTIVE_SESSION_ID: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);

/// 前端上报当前 active 会话（tab 切换时调用）。
pub fn set_active_session_id(id: Option<&str>) {
    if let Ok(mut guard) = ACTIVE_SESSION_ID.lock() {
        *guard = id.map(str::to_string);
    }
}

fn active_session_id() -> Value {
    match ACTIVE_SESSION_ID.lock() {
        Ok(guard) => guard
            .as_ref()
            .map(|id| Value::String(id.clone()))
            .unwrap_or(Value::Null),
        Err(_) => Value::Null,
    }
}

/// 工具分类（对应 protocol.js 的 scope：read / write / exec / sftp）。
#[derive(Clone, Copy, PartialEq, Eq, Hash)]
pub enum ToolScope {
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

/// 把配置中的 scope 字符串列表解析为授权集合（未知项忽略）。
pub fn parse_scopes(items: &[String]) -> HashSet<ToolScope> {
    let mut set = HashSet::new();
    for item in items {
        match item.as_str() {
            "read" => {
                set.insert(ToolScope::Read);
            }
            "write" => {
                set.insert(ToolScope::Write);
            }
            "exec" => {
                set.insert(ToolScope::Exec);
            }
            "sftp" => {
                set.insert(ToolScope::Sftp);
            }
            _ => {}
        }
    }
    set
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
    ToolDef { name: "issh_read_buffer", scope: ToolScope::Read, dangerous_confirm: false },
    ToolDef { name: "issh_preview_command", scope: ToolScope::Read, dangerous_confirm: false },
    ToolDef { name: "issh_insert_command", scope: ToolScope::Exec, dangerous_confirm: false },
    ToolDef { name: "issh_run_command", scope: ToolScope::Exec, dangerous_confirm: true },
    ToolDef { name: "issh_exec_command", scope: ToolScope::Exec, dangerous_confirm: true },
    ToolDef { name: "issh_get_output", scope: ToolScope::Read, dangerous_confirm: false },
    ToolDef { name: "issh_batch_exec", scope: ToolScope::Exec, dangerous_confirm: true },
    ToolDef { name: "issh_sftp_list", scope: ToolScope::Sftp, dangerous_confirm: false },
    ToolDef { name: "issh_sftp_read", scope: ToolScope::Sftp, dangerous_confirm: false },
    ToolDef { name: "issh_sftp_write", scope: ToolScope::Sftp, dangerous_confirm: true },
    ToolDef { name: "issh_list_jobs", scope: ToolScope::Read, dangerous_confirm: false },
    ToolDef { name: "issh_get_job", scope: ToolScope::Read, dangerous_confirm: false },
    // Wave 3（C1/C2/C3/C4/C5）：isshd 已接线的 workspace/agent/task/event/pane 服务端能力。
    ToolDef { name: "issh_pane_list", scope: ToolScope::Read, dangerous_confirm: false },
    ToolDef { name: "issh_pane_snapshot", scope: ToolScope::Read, dangerous_confirm: false },
    ToolDef { name: "issh_pane_subscribe", scope: ToolScope::Read, dangerous_confirm: false },
    ToolDef { name: "issh_pane_claim_input", scope: ToolScope::Write, dangerous_confirm: false },
    ToolDef { name: "issh_pane_release_input", scope: ToolScope::Write, dangerous_confirm: false },
    ToolDef { name: "issh_pane_write", scope: ToolScope::Exec, dangerous_confirm: false },
    ToolDef { name: "issh_pane_resize", scope: ToolScope::Write, dangerous_confirm: false },
    ToolDef { name: "issh_workspace_list", scope: ToolScope::Read, dangerous_confirm: false },
    ToolDef { name: "issh_workspace_create", scope: ToolScope::Write, dangerous_confirm: false },
    ToolDef { name: "issh_workspace_bind", scope: ToolScope::Write, dangerous_confirm: false },
    ToolDef { name: "issh_workspace_unbind", scope: ToolScope::Write, dangerous_confirm: false },
    ToolDef { name: "issh_agent_register", scope: ToolScope::Write, dangerous_confirm: false },
    ToolDef { name: "issh_agent_list", scope: ToolScope::Read, dangerous_confirm: false },
    ToolDef { name: "issh_agent_prompt", scope: ToolScope::Exec, dangerous_confirm: false },
    ToolDef { name: "issh_task_wait", scope: ToolScope::Read, dangerous_confirm: false },
    ToolDef { name: "issh_task_read", scope: ToolScope::Read, dangerous_confirm: false },
    ToolDef { name: "issh_task_list", scope: ToolScope::Read, dangerous_confirm: false },
    ToolDef { name: "issh_task_cancel", scope: ToolScope::Exec, dangerous_confirm: false },
    ToolDef { name: "issh_workspace_events", scope: ToolScope::Read, dangerous_confirm: false },
];

/// Agent Bridge 运行期状态：token、审计、输出缓存、scope 授权。
pub struct AgentBridgeState {
    token_sha256: [u8; 32],
    audit_path: PathBuf,
    audit_seq: AtomicU64,
    output_cache: std::sync::Mutex<HashMap<String, CachedOutput>>,
    runtime: Arc<RuntimeManager>,
    /// SFTP 路径限制根目录；None = 不限制。
    sftp_root: Option<PathBuf>,
    /// 是否写 discovery file（agent 可读的连接信息）。
    public_discovery: bool,
    /// 已授权的工具 scope（对齐 issh-llm assertMethodScope）。
    allowed_scopes: HashSet<ToolScope>,
    /// 是否写审计日志（agent-bridge-audit.jsonl）。
    audit_enabled: bool,
    /// 权限档位（R-055）：observer / confirm / auto。
    permission_mode: PermissionMode,
    /// 长命令异步 job 表（R-054）：exec 超时后转 job，可按 id 查询。
    jobs: std::sync::Mutex<Vec<JobRecord>>,
    /// SSE 事件广播（R-055）：job 状态变化等推送给已连接客户端。
    sse_tx: tokio::sync::broadcast::Sender<String>,
}

/// 长命令异步 job（R-054）：状态机 running -> done/failed。
#[derive(Debug, Clone)]
struct JobRecord {
    id: String,
    status: String,
    session: String,
    command: String,
    result: Option<Value>,
    created_at: u64,
    finished_at: Option<u64>,
}

const MAX_JOB_ENTRIES: usize = 64;

struct CachedOutput {
    text: String,
    created_seq: u64,
}

/// 已启动的 Agent Bridge server 句柄：stop() 关闭 accept loop。
pub struct AgentBridgeHandle {
    shutdown: Arc<AtomicBool>,
}

impl AgentBridgeHandle {
    pub fn stop(&self) {
        self.shutdown.store(true, Ordering::SeqCst);
    }
}

/// 启动 Agent Bridge HTTP server（固定端口 59688）。
pub async fn start(
    runtime: Arc<RuntimeManager>,
    user_data: PathBuf,
    token: String,
    allowed_scopes: HashSet<ToolScope>,
    sftp_root: Option<String>,
    public_discovery: bool,
    audit_enabled: bool,
    permission_mode: PermissionMode,
) -> Result<AgentBridgeHandle, String> {
    let listener = TcpListener::bind(("127.0.0.1", AGENT_BRIDGE_PORT))
        .await
        .map_err(|error| {
            format!("Agent Bridge 无法绑定 127.0.0.1:{AGENT_BRIDGE_PORT}：{error}（端口可能已被占用）")
        })?;

    let token_sha256: [u8; 32] = Sha256::digest(token.as_bytes()).into();
    let audit_path = user_data.join("agent-bridge-audit.jsonl");
    let (sse_tx, _) = tokio::sync::broadcast::channel::<String>(64);

    let state = Arc::new(AgentBridgeState {
        token_sha256,
        audit_path,
        audit_seq: AtomicU64::new(0),
        output_cache: std::sync::Mutex::new(HashMap::new()),
        runtime,
        sftp_root: sftp_root.as_deref().map(PathBuf::from),
        public_discovery,
        allowed_scopes,
        audit_enabled,
        permission_mode,
        jobs: std::sync::Mutex::new(Vec::new()),
        sse_tx,
    });

    if public_discovery {
        write_discovery_file(&user_data, &token);
    }

    let shutdown = Arc::new(AtomicBool::new(false));
    {
        let state = Arc::clone(&state);
        let shutdown = Arc::clone(&shutdown);
        tokio::spawn(async move {
            loop {
                if shutdown.load(Ordering::SeqCst) {
                    break;
                }
                // 轮询式 accept：每 200ms 检查一次 shutdown 标志（避免额外 tokio features）
                match tokio::time::timeout(
                    std::time::Duration::from_millis(200),
                    listener.accept(),
                )
                .await
                {
                    Ok(Ok((stream, _peer))) => {
                        let state = Arc::clone(&state);
                        tokio::spawn(async move {
                            let _ = handle_connection(stream, state).await;
                        });
                        tokio::task::yield_now().await;
                    }
                    Ok(Err(_)) => continue,
                    Err(_elapsed) => continue,
                }
            }
        });
    }

    Ok(AgentBridgeHandle { shutdown })
}

/// 写 agent 可读 discovery file（对齐 issh-llm agentBridgePublicDiscoveryEnabled）。
fn write_discovery_file(user_data: &PathBuf, token: &str) {
    let discovery = json!({
        "rpcUrl": format!("http://127.0.0.1:{AGENT_BRIDGE_PORT}/rpc"),
        "host": "127.0.0.1",
        "port": AGENT_BRIDGE_PORT,
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

    // R-055 SSE MCP transport：GET /sse 建立事件流；POST /messages 与 /rpc 走同一 JSON-RPC 处理
    if method == "GET" && path == "/sse" {
        return handle_sse(writer, state).await;
    }
    if method != "POST" || (path != "/rpc" && path != "/messages") {
        write_response(&mut writer, 404, &json!({
            "error": { "code": -32601, "message": "Not found; POST /rpc or /messages, GET /sse" }
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

/// R-055 SSE MCP transport：GET /sse 建立事件流。
/// 首个事件告知 POST 消息端点（/messages）；随后转发 job 等状态事件，15s 心跳保活。
async fn handle_sse(
    mut writer: tokio::net::tcp::OwnedWriteHalf,
    state: Arc<AgentBridgeState>,
) -> Result<(), String> {
    use tokio::io::AsyncWriteExt;
    let headers = concat!(
        "HTTP/1.1 200 OK\r\n",
        "Content-Type: text/event-stream\r\n",
        "Cache-Control: no-cache\r\n",
        "Connection: keep-alive\r\n",
        "Access-Control-Allow-Origin: *\r\n\r\n",
    );
    writer
        .write_all(headers.as_bytes())
        .await
        .map_err(|e| e.to_string())?;
    writer
        .write_all(b"event: endpoint\ndata: /messages\n\n")
        .await
        .map_err(|e| e.to_string())?;
    writer.flush().await.map_err(|e| e.to_string())?;

    let mut rx = state.sse_tx.subscribe();
    let mut heartbeat = tokio::time::interval(std::time::Duration::from_secs(15));
    heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        tokio::select! {
            event = rx.recv() => {
                match event {
                    Ok(payload) => {
                        if writer.write_all(payload.as_bytes()).await.is_err()
                            || writer.flush().await.is_err()
                        {
                            return Ok(()); // 客户端断开
                        }
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                        // 慢消费者：标记丢帧，继续
                        if writer.write_all(b": dropped\n\n").await.is_err() {
                            return Ok(());
                        }
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => return Ok(()),
                }
            }
            _ = heartbeat.tick() => {
                if writer.write_all(b": ping\n\n").await.is_err()
                    || writer.flush().await.is_err()
                {
                    return Ok(()); // 客户端断开
                }
            }
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
    status: u16,
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

fn audit(state: &AgentBridgeState, tool: &str, outcome: &str, detail: Value) {
    if !state.audit_enabled {
        return;
    }
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
    state: &Arc<AgentBridgeState>,
    tool: &ToolDef,
    params: &Value,
) -> Result<Value, String> {
    // scope 校验（对齐 issh-llm assertMethodScope）
    if !state.allowed_scopes.contains(&tool.scope) {
        return Err(format!(
            "工具 {} 需要 scope \"{}\" 授权，当前 Agent Bridge 的 scope 未包含该权限",
            tool.name,
            tool.scope.as_str()
        ));
    }
    // R-055 权限档位：Observer 下所有会改变状态的工具只返回计划、不执行。
    if state.permission_mode == PermissionMode::Observer && tool.scope != ToolScope::Read {
        audit(
            state,
            tool.name,
            "observer-blocked",
            json!({
                "permissionMode": "observer",
                "scope": tool.scope.as_str(),
            }),
        );
        return Ok(json!({
            "permissionMode": "observer",
            "blocked": true,
            "planned": true,
            "tool": tool.name,
            "params": params,
            "reason": "Agent Bridge 权限档位为 observer（只读），该操作未执行，仅返回执行计划",
        }));
    }
    match tool.name {
        "issh_health" => Ok(json!({
            "ok": true,
            "port": AGENT_BRIDGE_PORT,
            "protocolVersion": "1.5.0",
            "publicDiscovery": state.public_discovery,
            "permissionMode": state.permission_mode.as_str(),
            "tools": TOOLS.iter().map(|tool| json!({
                "name": tool.name,
                "scope": tool.scope.as_str(),
                "dangerousConfirm": tool.dangerous_confirm,
            })).collect::<Vec<_>>(),
        })),
        "issh_list_sessions" => list_sessions(state).await,
        "issh_list_profiles" => list_profiles(state).await,
        "issh_connect_profile" => connect_profile(state, params).await,
        "issh_disconnect_session" => disconnect_session(state, params).await,
        "issh_select_session" => select_session(params).await,
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
        "issh_list_jobs" => list_jobs(state),
        "issh_get_job" => get_job(state, params),
        // Wave 3：workspace/agent/task/event/pane 直接透传 isshd Runtime RPC
        "issh_pane_list" => rpc(state, "pane.list", json!({})).await,
        "issh_pane_snapshot" => rpc(state, "pane.snapshot", params.clone()).await,
        "issh_pane_subscribe" => rpc(state, "pane.subscribe", params.clone()).await,
        "issh_pane_claim_input" => rpc(state, "pane.claimInput", params.clone()).await,
        "issh_pane_release_input" => rpc(state, "pane.releaseInput", params.clone()).await,
        "issh_pane_write" => rpc(state, "pane.write", params.clone()).await,
        "issh_pane_resize" => rpc(state, "pane.resize", params.clone()).await,
        "issh_workspace_list" => rpc(state, "workspace.list", json!({})).await,
        "issh_workspace_create" => rpc(state, "workspace.create", params.clone()).await,
        "issh_workspace_bind" => rpc(state, "workspace.bind", params.clone()).await,
        "issh_workspace_unbind" => rpc(state, "workspace.unbind", params.clone()).await,
        "issh_agent_register" => rpc(state, "agent.register", params.clone()).await,
        "issh_agent_list" => rpc(state, "agent.list", params.clone()).await,
        "issh_agent_prompt" => rpc(state, "task.prompt", params.clone()).await,
        "issh_task_wait" => rpc(state, "task.wait", params.clone()).await,
        "issh_task_read" => rpc(state, "task.read", params.clone()).await,
        "issh_task_list" => rpc(state, "task.list", params.clone()).await,
        "issh_task_cancel" => rpc(state, "task.cancel", params.clone()).await,
        "issh_workspace_events" => rpc(state, "event.list", params.clone()).await,
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

/// 独立于 AgentBridgeState 的 Runtime RPC（R-054：exec job 后台任务使用，
/// 不借用 state 引用，可安全 spawn）。
async fn rpc_runtime(
    runtime: &Arc<RuntimeManager>,
    method: &str,
    params: Value,
) -> Result<Value, String> {
    let request = json!({
        "jsonrpc": "2.0",
        "id": format!("bridge-job-{}", now_unix_ms()),
        "method": method,
        "params": params,
    });
    let response = runtime.request(request).await?;
    if let Some(error) = response.get("error") {
        return Err(error
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("Runtime RPC failed")
            .to_string());
    }
    Ok(response.get("result").cloned().unwrap_or(Value::Null))
}

// ---------- long-running job（R-054）----------

fn register_job(state: &Arc<AgentBridgeState>, id: &str, session: &str, command: &str) {
    let mut jobs = state
        .jobs
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if jobs.len() >= MAX_JOB_ENTRIES {
        jobs.remove(0);
    }
    jobs.push(JobRecord {
        id: id.to_string(),
        status: "running".to_string(),
        session: session.to_string(),
        command: command.to_string(),
        result: None,
        created_at: now_unix_ms(),
        finished_at: None,
    });
}

fn finish_job(state: &Arc<AgentBridgeState>, id: &str, status: &str, result: Option<Value>) -> Value {
    let record = {
        let mut jobs = state
            .jobs
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut record_json = json!({ "jobId": id, "status": status });
        if let Some(record) = jobs.iter_mut().find(|job| job.id == id) {
            record.status = status.to_string();
            record.result = result.clone();
            record.finished_at = Some(now_unix_ms());
            record_json = job_to_json(record);
        }
        record_json
    };
    // SSE 广播（R-055）：job 状态变化推送给已连接客户端
    let _ = state.sse_tx.send(format!("event: job\ndata: {record}\n\n"));
    record
}

fn job_to_json(job: &JobRecord) -> Value {
    json!({
        "jobId": job.id,
        "status": job.status,
        "session": job.session,
        "command": job.command,
        "result": job.result,
        "createdAt": job.created_at,
        "finishedAt": job.finished_at,
    })
}

fn list_jobs(state: &Arc<AgentBridgeState>) -> Result<Value, String> {
    let jobs = state
        .jobs
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let entries: Vec<Value> = jobs.iter().rev().map(job_to_json).collect();
    Ok(json!({ "jobs": entries, "count": jobs.len(), "maxEntries": MAX_JOB_ENTRIES }))
}

fn get_job(state: &Arc<AgentBridgeState>, params: &Value) -> Result<Value, String> {
    let job_id = params_str(params, "jobId").ok_or("jobId is required")?;
    let jobs = state
        .jobs
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let job = jobs
        .iter()
        .find(|job| job.id == job_id)
        .ok_or_else(|| format!("Job not found: {job_id}（job 表上限 {MAX_JOB_ENTRIES} 条，最旧记录会被淘汰）"))?;
    Ok(job_to_json(job))
}

fn params_str<'a>(params: &'a Value, key: &str) -> Option<&'a str> {
    params.get(key).and_then(Value::as_str)
}

fn params_u64(params: &Value, key: &str) -> Option<u64> {
    params.get(key).and_then(Value::as_u64)
}

// ---------- session tools ----------

async fn list_sessions(state: &AgentBridgeState) -> Result<Value, String> {
    let workspace_items = rpc(state, "session.list", json!({}))
        .await?
        .as_array()
        .cloned()
        .unwrap_or_default();
    let runtime_items = rpc(state, "session.runtimeList", json!({}))
        .await?
        .as_array()
        .cloned()
        .unwrap_or_default();
    let sessions = runtime_items
        .into_iter()
        .map(|item| {
            let id = item.get("id").and_then(Value::as_str).unwrap_or("");
            let metadata = workspace_items
                .iter()
                .find(|candidate| candidate.get("id").and_then(Value::as_str) == Some(id));
            let metadata_value = |key: &str| {
                metadata
                    .and_then(|candidate| candidate.get(key))
                    .cloned()
                    .unwrap_or(Value::Null)
            };
            let title = metadata
                .and_then(|candidate| candidate.get("customTitle"))
                .filter(|value| !value.is_null())
                .cloned()
                .or_else(|| metadata.and_then(|candidate| candidate.get("title")).cloned())
                .or_else(|| item.get("title").cloned())
                .unwrap_or(Value::Null);
            let kind = item.get("kind").cloned().unwrap_or(Value::Null);
            let profile_type = metadata
                .and_then(|candidate| candidate.get("profileType"))
                .filter(|value| !value.is_null())
                .cloned()
                .unwrap_or_else(|| kind.clone());
            let state_name = item.get("state").cloned().unwrap_or(Value::Null);
            let connected = state_name.as_str() == Some("running");
            json!({
                "id": item.get("id").cloned().unwrap_or(Value::Null),
                "title": title,
                "profileType": profile_type,
                "host": metadata_value("host"),
                "user": metadata_value("user"),
                "port": metadata_value("port"),
                "connected": connected,
                "kind": kind,
                "state": state_name,
                "columns": item.get("columns").cloned().unwrap_or(Value::Null),
                "rows": item.get("rows").cloned().unwrap_or(Value::Null),
            })
        })
        .collect::<Vec<_>>();
    Ok(json!({ "sessions": sessions, "active": active_session_id() }))
}

async fn list_profiles(state: &AgentBridgeState) -> Result<Value, String> {
    // 主机档案不在 isshd RPC 面，而是 Tauri command host_profiles（config.yaml 镜像）。
    // Agent Bridge 直接读 HostProfileStore（与 UI 同一份数据源）。
    let hosts = state.runtime.hosts.read()?;
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
        set_active_session_id(Some(id));
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
    let session_id = resolve_tab(params).await?;
    let result = rpc(state, "session.close", json!({ "sessionId": session_id })).await?;
    Ok(json!({ "closed": true, "session": result }))
}

async fn select_session(params: &Value) -> Result<Value, String> {
    let session_id = resolve_tab(params).await?;
    set_active_session_id(Some(&session_id));
    Ok(json!({ "selected": session_id }))
}

async fn get_context(state: &AgentBridgeState, params: &Value) -> Result<Value, String> {
    let session_id = resolve_tab(params).await?;
    let snapshot = rpc(state, "session.snapshot", json!({ "sessionId": session_id })).await?;
    let buffer = read_buffer_text(state, &session_id, 20).await?;
    Ok(json!({
        "session": snapshot,
        "recentOutput": buffer,
        "partialCommand": "",
    }))
}

async fn read_buffer(state: &AgentBridgeState, params: &Value) -> Result<Value, String> {
    let session_id = resolve_tab(params).await?;
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
        json!({ "sessionId": session_id, "afterSequence": 0, "maxEvents": 256, "maxBytes": MAX_SUBSCRIBE_BYTES }),
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
    }))
}

fn normalize_command(command: &str) -> String {
    let mut normalized = command.trim().to_string();
    // 剥离 inline comment（对齐 commandValidation.normalizeCommand 的简化版）
    if let Some(pos) = normalized.find(" #") {
        normalized.truncate(pos);
    }
    normalized
}

/// R-055 权限档位下的危险命令确认门：
/// - Auto：跳过 confirm 校验（自动放行，桌面端确认框仍生效）
/// - Confirm/Observer：危险命令需要 confirmDangerous=true（Observer 已在 dispatch 层拦截，不会到这里）
fn require_confirm_flag(
    mode: PermissionMode,
    params: &Value,
    dangerous: bool,
) -> Result<(), String> {
    if !dangerous {
        return Ok(());
    }
    if mode == PermissionMode::Auto {
        return Ok(());
    }
    let confirmed = params
        .get("confirmDangerous")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if !confirmed {
        return Err(
            "危险命令需要 confirmDangerous=true 才能执行；issh 桌面端仍会弹出用户确认框"
                .to_string(),
        );
    }
    Ok(())
}

async fn insert_command(state: &AgentBridgeState, params: &Value) -> Result<Value, String> {
    let session_id = resolve_tab(params).await?;
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
    let session_id = resolve_tab(params).await?;
    let command = params_str(params, "command").ok_or("command is required")?;
    let normalized = normalize_command(command);
    require_confirm_flag(state.permission_mode, params, is_dangerous_command(&normalized))?;
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

async fn exec_command(state: &Arc<AgentBridgeState>, params: &Value) -> Result<Value, String> {
    let session_id = resolve_tab(params).await?;
    let command = params_str(params, "command").ok_or("command is required")?;
    let normalized = normalize_command(command);
    require_confirm_flag(state.permission_mode, params, is_dangerous_command(&normalized))?;
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

    // R-054 长命令 job 化：执行放到后台任务，主路径等 timeout；
    // 超时后不判失败，而是返回 jobId（running），后台完成后更新 job 记录并推送 SSE 事件。
    let job_id = format!("job-{}", now_unix_ms());
    register_job(state, &job_id, &session_id, &normalized);

    let (tx, rx) = tokio::sync::oneshot::channel::<Value>();
    let runtime = Arc::clone(&state.runtime);
    let job_state = Arc::clone(state);
    let spawn_job_id = job_id.clone();
    let job_session = session_id.clone();
    let job_command = normalized.clone();
    let job_timeout_ms = (timeout_ms.saturating_mul(10)).clamp(60_000, MAX_EXEC_TIMEOUT_MS);
    tokio::spawn(async move {
        let outcome = match rpc_runtime(
            &runtime,
            "ssh.execReadonly",
            json!({
                "sessionId": job_session.clone(),
                "command": job_command.clone(),
                "timeoutMs": job_timeout_ms,
                "maxOutputBytes": max_output_bytes,
            }),
        )
        .await
        {
            Ok(result) => {
                let output = result
                    .get("output")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                let output_id = cache_output(&job_state, &output).unwrap_or_default();
                let truncated = output.len() > 64 * 1024;
                let visible = if truncated { &output[..64 * 1024] } else { output.as_str() };
                finish_job(
                    &job_state,
                    &spawn_job_id,
                    "done",
                    Some(json!({
                        "stdout": visible,
                        "outputBytes": output.len(),
                        "truncated": truncated,
                        "outputId": output_id,
                    })),
                );
                json!({
                    "session": job_session,
                    "command": job_command,
                    "stdout": visible,
                    "stderr": "",
                    "exitCode": Value::Null,
                    "timedOut": false,
                    "truncated": truncated,
                    "outputId": output_id,
                    "outputBytes": output.len(),
                    "jobId": spawn_job_id,
                })
            }
            Err(error) => {
                let message = error.to_lowercase();
                let timed_out = message.contains("timed out") || message.contains("timeout");
                finish_job(
                    &job_state,
                    &spawn_job_id,
                    "failed",
                    Some(json!({ "error": error, "timedOut": timed_out })),
                );
                json!({
                    "session": job_session,
                    "command": job_command,
                    "stdout": "",
                    "stderr": "",
                    "exitCode": Value::Null,
                    "timedOut": timed_out,
                    "error": error,
                    "jobId": spawn_job_id,
                })
            }
        };
        let _ = tx.send(outcome);
    });

    match tokio::time::timeout(std::time::Duration::from_millis(timeout_ms), rx).await {
        Ok(Ok(outcome)) => Ok(outcome),
        Ok(Err(_recv_error)) => Err("exec job 内部错误：后台任务通道断开".to_string()),
        Err(_elapsed) => {
            // 超时转 job：返回 running 状态，后台继续执行
            audit(
                state,
                "issh_exec_command",
                "job-started",
                json!({ "jobId": job_id, "session": session_id, "command": normalized, "timeoutMs": timeout_ms }),
            );
            Ok(json!({
                "jobId": job_id,
                "status": "running",
                "session": session_id,
                "command": normalized,
                "timeoutMs": timeout_ms,
                "hint": "命令仍在后台执行：使用 issh_get_job 查询进度；SSE 客户端会收到 job 完成事件",
            }))
        }
    }
}

fn cache_output(state: &AgentBridgeState, text: &str) -> Result<String, String> {
    let seq = state.audit_seq.fetch_add(1, Ordering::Relaxed);
    let output_id = format!("out-{seq}");
    let mut cache = state
        .output_cache
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if cache.len() >= MAX_OUTPUT_CACHE_ENTRIES {
        // 按创建序号淘汰最旧条目
        if let Some(oldest) = cache
            .iter()
            .min_by_key(|(_, cached)| cached.created_seq)
            .map(|(key, _)| key.clone())
        {
            cache.remove(&oldest);
        }
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
    let cache = state
        .output_cache
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let Some(cached) = cache.get(output_id) else {
        return Err(format!(
            "Output not found: {output_id}（缓存上限 {MAX_OUTPUT_CACHE_ENTRIES} 条，过期后需重新 exec）"
        ));
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

async fn batch_exec(state: &Arc<AgentBridgeState>, params: &Value) -> Result<Value, String> {
    let command = params_str(params, "command").ok_or("command is required")?;
    let normalized = normalize_command(command);
    require_confirm_flag(state.permission_mode, params, is_dangerous_command(&normalized))?;
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
    if parallel {
        let mut handles = Vec::new();
        for session_id in &targets {
            let state = Arc::clone(state);
            let session_id = session_id.clone();
            let normalized = normalized.clone();
            handles.push(tokio::spawn(async move {
                exec_on_session(&state, &session_id, &normalized, timeout_ms).await
            }));
        }
        for handle in handles {
            results.push(handle.await.map_err(|error| error.to_string())??);
        }
    } else {
        for session_id in &targets {
            results.push(exec_on_session(state, session_id, &normalized, timeout_ms).await?);
        }
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
    let session_id = resolve_tab(params).await?;
    let path = params_str(params, "path").ok_or("path is required")?;
    ensure_sftp_root(state, path)?;
    let _ = ensure_sftp_open(state, &session_id).await?;
    let result = rpc(
        state,
        "sftp.list",
        json!({ "sessionId": session_id, "path": path, "offset": 0, "limit": 256 }),
    )
    .await?;
    Ok(result)
}

async fn sftp_read(state: &AgentBridgeState, params: &Value) -> Result<Value, String> {
    let session_id = resolve_tab(params).await?;
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
    let session_id = resolve_tab(params).await?;
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
            "单次 SFTP 写入超过上限 {MAX_SFTP_WRITE_BYTES} 字节（1MB）；请分块写入"
        ));
    }
    require_confirm_flag(state.permission_mode, params, true)?; // SFTP 写入始终需要确认标志
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

async fn resolve_tab(params: &Value) -> Result<String, String> {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_scopes_handles_full_and_partial_lists() {
        let full = parse_scopes(&[
            "read".to_string(),
            "write".to_string(),
            "exec".to_string(),
            "sftp".to_string(),
        ]);
        assert!(full.contains(&ToolScope::Read));
        assert!(full.contains(&ToolScope::Write));
        assert!(full.contains(&ToolScope::Exec));
        assert!(full.contains(&ToolScope::Sftp));

        let readonly = parse_scopes(&["read".to_string()]);
        assert!(readonly.contains(&ToolScope::Read));
        assert!(!readonly.contains(&ToolScope::Exec));
        assert!(!readonly.contains(&ToolScope::Sftp));

        // 未知项忽略，不 panic
        let mixed = parse_scopes(&["read".to_string(), "bogus".to_string()]);
        assert_eq!(mixed.len(), 1);
    }

    #[test]
    fn normalize_command_strips_inline_comments() {
        assert_eq!(normalize_command("echo hi # hello"), "echo hi");
        assert_eq!(normalize_command("  ls -la  "), "ls -la");
        assert_eq!(normalize_command("echo '#not a comment'"), "echo '#not a comment'");
    }

    #[test]
    fn dangerous_command_detection_matches_core_patterns() {
        assert!(is_dangerous_command("rm -rf /"));
        assert!(is_dangerous_command("rm -rf ~"));
        assert!(is_dangerous_command("mkfs.ext4 /dev/sda1"));
        assert!(is_dangerous_command("shutdown -h now"));
        assert!(is_dangerous_command("dd if=/dev/zero of=/dev/sda"));
        assert!(!is_dangerous_command("ls -la"));
        assert!(!is_dangerous_command("cat /etc/hosts"));
        assert!(!is_dangerous_command("rm file.txt"));
    }

    #[test]
    fn preview_command_flags_danger_and_confirm() {
        let preview = preview_command(&json!({ "command": "ls -la" })).expect("preview");
        assert_eq!(preview.get("dangerous"), Some(&Value::Bool(false)));
        assert_eq!(preview.get("confirmRequired"), Some(&Value::Bool(false)));

        let preview = preview_command(&json!({ "command": "rm -rf /" })).expect("preview");
        assert_eq!(preview.get("dangerous"), Some(&Value::Bool(true)));
        assert_eq!(preview.get("confirmRequired"), Some(&Value::Bool(true)));

        assert!(preview_command(&json!({})).is_err());
    }

    #[test]
    fn require_confirm_flag_gates_dangerous_commands() {
        let confirm = PermissionMode::Confirm;
        let auto = PermissionMode::Auto;
        assert!(require_confirm_flag(confirm, &json!({}), false).is_ok());
        assert!(require_confirm_flag(confirm, &json!({}), true).is_err());
        assert!(require_confirm_flag(confirm, &json!({ "confirmDangerous": true }), true).is_ok());
        // Auto 档位跳过 confirm 校验（R-055）
        assert!(require_confirm_flag(auto, &json!({}), true).is_ok());
    }

    #[test]
    fn set_active_session_id_roundtrip() {
        set_active_session_id(Some("ssh-1"));
        assert_eq!(active_session_id(), Value::String("ssh-1".to_string()));
        set_active_session_id(Some("ssh-2"));
        assert_eq!(active_session_id(), Value::String("ssh-2".to_string()));
        set_active_session_id(None);
        assert_eq!(active_session_id(), Value::Null);
    }
}
