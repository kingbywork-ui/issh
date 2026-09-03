use crate::host_profiles::HostProfileMutation;
use crate::RuntimeManager;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashSet, VecDeque};
use std::sync::Mutex;
use std::time::Duration;

const API_VERSION: &str = "1";
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
}

impl PluginGatewayState {
    fn claim_request(&self, id: &str) -> Result<(), String> {
        let mut seen = self.seen.lock().map_err(|_| "网关请求状态不可用".to_string())?;
        if seen.contains(id) {
            return Err("请求 ID 重复，已拒绝重放请求".to_string());
        }
        seen.insert(id.to_string());
        let mut order = self.seen_order.lock().map_err(|_| "网关请求状态不可用".to_string())?;
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
    PluginGatewayResponse { request_id: request_id.to_string(), ok: true, data: Some(data), error: None }
}

fn response_error(request_id: &str, code: &str, message: impl Into<String>, retryable: bool) -> PluginGatewayResponse {
    PluginGatewayResponse {
        request_id: request_id.to_string(),
        ok: false,
        data: None,
        error: Some(PluginGatewayError { code: code.to_string(), message: message.into(), retryable }),
    }
}

fn required_permission(method: &str) -> Option<&'static str> {
    match method {
        "runtime.health" => None,
        "session.list" | "session.current" | "session.read" => Some("session.read"),
        "session.write" | "terminal.write" => Some("terminal.write"),
        "terminal.read" => Some("terminal.read"),
        "profiles.read" => Some("profiles.read"),
        "profiles.mutate" => Some("profiles.write"),
        "vault.status" | "vault.unlock" | "vault.getSecret" => Some("vault.read"),
        "ssh.exec" => Some("ssh.exec"),
        "network.fetch" => Some("network.fetch"),
        "workspace.list" => Some("workspace.read"),
        "workspace.create" | "workspace.bind" | "workspace.unbind" => Some("workspace.write"),
        "agent.list" => Some("agent.read"),
        "agent.register" | "agent.authorize" => Some("agent.write"),
        "sftp.open" | "sftp.list" | "sftp.read" | "sftp.stat" | "sftp.close" => Some("sftp.read"),
        "sftp.write" | "sftp.mkdir" | "sftp.remove" | "sftp.removeDir" | "sftp.rename" | "sftp.chmod" => Some("sftp.write"),
        _ => None,
    }
}

fn permission_allowed(request: &PluginGatewayRequest, required: &str) -> bool {
    static_plugin_capabilities(&request.plugin_id)
        .map(|capabilities| capabilities.iter().any(|permission| *permission == required))
        .unwrap_or(false)
}

fn static_plugin_capabilities(plugin_id: &str) -> Option<&'static [&'static str]> {
    match plugin_id {
        "issh-plugin-agent-bridge" => Some(&[
            "ui.settings.register", "workspace.read", "workspace.write", "session.read", "agent.read", "agent.write",
        ]),
        "issh-plugin-config-sync" => Some(&["ui.settings.register", "profiles.read", "profiles.write", "network.fetch"]),
        "issh-plugin-herdr" => Some(&["ui.settings.register", "workspace.read", "workspace.write", "session.read"]),
        "issh-plugin-linkifier" => Some(&["terminal.decorate"]),
        "issh-plugin-llm" => Some(&["ui.settings.register", "terminal.decorate"]),
        "issh-plugin-sandbox-demo" => Some(&["ui.panel.register", "terminal.decorate", "profiles.write"]),
        "issh-plugin-serial" => Some(&["ui.panel.register"]),
        _ => None,
    }
}

fn runtime_method(method: &str) -> Option<(&str, Option<&'static str>)> {
    match method {
        "runtime.health" => Some(("runtime.health", None)),
        "session.list" => Some(("session.list", Some("session.read"))),
        "session.current" => Some(("session.list", Some("session.read"))),
        "session.read" | "terminal.read" => Some(("session.subscribe", Some("session.read"))),
        "session.write" | "terminal.write" => Some(("session.write", Some("terminal.write"))),
        "ssh.exec" => Some(("ssh.execReadonly", Some("ssh.exec"))),
        "sftp.open" | "sftp.list" | "sftp.read" | "sftp.stat" | "sftp.close" => Some((method, Some("sftp.read"))),
        "sftp.write" | "sftp.mkdir" | "sftp.remove" | "sftp.removeDir" | "sftp.rename" | "sftp.chmod" => Some((method, Some("sftp.write"))),
        "vault.status" | "vault.getSecret" => Some((method, Some("vault.read"))),
        "workspace.list" => Some((method, Some("workspace.read"))),
        "workspace.create" | "workspace.bind" | "workspace.unbind" => Some((method, Some("workspace.write"))),
        "agent.list" => Some((method, Some("agent.read"))),
        "agent.register" | "agent.authorize" => Some((method, Some("agent.write"))),
        _ => None,
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
        assert_eq!(required_permission("session.list"), Some("session.read"));
        assert_eq!(runtime_method("session.list"), Some(("session.list", Some("session.read"))));
        assert_eq!(runtime_method("session.current"), Some(("session.list", Some("session.read"))));
        let mut forged = request("profiles.read", &["forged.permission"]);
        forged.plugin_id = "issh-plugin-serial".to_string();
        assert!(!permission_allowed(&forged, "profiles.read"));
    }

    #[test]
    fn unknown_plugins_have_no_host_capability_entry() {
        assert!(static_plugin_capabilities("marketplace.unknown").is_none());
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
    let url = args.get("url").and_then(Value::as_str).ok_or_else(|| "network.fetch 需要 url".to_string())?;
    network_host_allowed(url)?;
    let method = args.get("method").and_then(Value::as_str).unwrap_or("GET");
    if !matches!(method, "GET" | "POST" | "PATCH") {
        return Err("network.fetch 仅允许 GET、POST 或 PATCH".to_string());
    }
    let body = args.get("body").and_then(Value::as_str);
    if body.map_or(false, |value| value.len() > 256 * 1024) {
        return Err("network.fetch 请求体超过 256 KiB 限制".to_string());
    }
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|error| error.to_string())?;
    let mut request = client.request(reqwest::Method::from_bytes(method.as_bytes()).map_err(|error| error.to_string())?, url).header("User-Agent", "issh-plugin-gateway/1");
    if let Some(headers) = args.get("headers").and_then(Value::as_object) {
        for (name, value) in headers {
            if !matches!(name.to_ascii_lowercase().as_str(), "authorization" | "content-type" | "accept") {
                return Err(format!("network.fetch 不允许请求头：{name}"));
            }
            let value = value.as_str().ok_or_else(|| format!("network.fetch 请求头无效：{name}"))?;
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
    Ok(json!({ "status": status.as_u16(), "ok": status.is_success(), "body": String::from_utf8_lossy(&bytes) }))
}

fn runtime_args(request: &PluginGatewayRequest, method: &str) -> Value {
    if method == "session.current" {
        return Value::Null;
    }
    let mut args = request.args.clone();
    if matches!(method, "session.read" | "terminal.read") {
        if let Value::Object(ref mut map) = args {
            map.entry("afterSequence".to_string()).or_insert(Value::from(0));
            map.entry("maxEvents".to_string()).or_insert(Value::from(64));
            map.entry("maxBytes".to_string()).or_insert(Value::from(12288));
        }
    }
    if matches!(method, "terminal.write" | "session.write") {
        if let Value::Object(ref mut map) = args {
            if let Some(Value::String(data)) = map.get("data").cloned() {
                map.insert("data".to_string(), Value::Array(data.bytes().map(Value::from).collect()));
            }
        }
    }
    if method == "ssh.exec" {
        if let Value::Object(ref mut map) = args {
            map.entry("timeoutMs".to_string()).or_insert(Value::from(60000));
        }
    }
    args
}

pub async fn handle_request(manager: &RuntimeManager, state: &PluginGatewayState, request: PluginGatewayRequest) -> PluginGatewayResponse {
    let request_id = request.request_id.clone();
    let request_size = serde_json::to_vec(&request).map(|bytes| bytes.len()).unwrap_or(MAX_REQUEST_BYTES + 1);
    if request_size > MAX_REQUEST_BYTES {
        state.audit(&request, false, Some("REQUEST_TOO_LARGE"));
        return response_error(&request_id, "REQUEST_TOO_LARGE", "网关请求超过大小限制", false);
    }
    if request.plugin_id.is_empty() || request.plugin_id.len() > 128 || !request.plugin_id.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.')) {
        state.audit(&request, false, Some("INVALID_PLUGIN"));
        return response_error(&request_id, "INVALID_PLUGIN", "插件 ID 无效", false);
    }
    if static_plugin_capabilities(&request.plugin_id).is_none() {
        state.audit(&request, false, Some("PLUGIN_NOT_REGISTERED"));
        return response_error(&request_id, "PLUGIN_NOT_REGISTERED", "插件未在宿主网关能力表中注册", false);
    }
    if request.api_version != API_VERSION {
        state.audit(&request, false, Some("API_VERSION_UNSUPPORTED"));
        return response_error(&request_id, "API_VERSION_UNSUPPORTED", format!("不支持的网关 API 版本：{}", request.api_version), false);
    }
    if let Err(error) = state.claim_request(&request.request_id) {
        state.audit(&request, false, Some("DUPLICATE_REQUEST"));
        return response_error(&request_id, "DUPLICATE_REQUEST", error, false);
    }
    if let Some(required) = required_permission(&request.method) {
        if !permission_allowed(&request, required) {
            state.audit(&request, false, Some("PERMISSION_DENIED"));
            return response_error(&request_id, "PERMISSION_DENIED", format!("未声明权限：{required}"), false);
        }
    }
    let result = if request.method == "network.fetch" {
        network_fetch(&request.args).await
    } else if request.method == "profiles.read" {
        manager.hosts.read().and_then(|profiles| serde_json::to_value(profiles).map_err(|error| error.to_string()))
    } else if request.method == "profiles.mutate" {
        let mutation = request.args.get("mutation").cloned().unwrap_or_else(|| request.args.clone());
        match serde_json::from_value::<HostProfileMutation>(mutation) {
            Ok(mutation) => manager.hosts.mutate(mutation).and_then(|profiles| serde_json::to_value(profiles).map_err(|error| error.to_string())),
            Err(error) => Err(format!("profiles.mutate 参数无效：{error}")),
        }
    } else if request.method == "vault.unlock" {
        let passphrase = request.args.get("passphrase").and_then(Value::as_str).ok_or_else(|| "vault.unlock 需要 passphrase".to_string());
        passphrase.and_then(|value| manager.hosts.unlock(value).and_then(|profiles| serde_json::to_value(profiles).map_err(|error| error.to_string())))
    } else if let Some((runtime_method, _method_permission)) = runtime_method(&request.method) {
        let params = runtime_args(&request, &request.method);
        let mut runtime_request = json!({ "jsonrpc": "2.0", "id": request.request_id, "method": runtime_method });
        if !params.is_null() {
            runtime_request["params"] = params;
        }
        let timeout = Duration::from_millis(request.deadline_ms.unwrap_or(10000).clamp(100, 120000));
        let response = match tokio::time::timeout(timeout, manager.request(runtime_request)).await {
            Ok(Ok(response)) => response,
            Ok(Err(error)) => return response_error(&request_id, "RUNTIME_ERROR", error, true),
            Err(_) => return response_error(&request_id, "TIMEOUT", "网关 Runtime 请求超时", true),
        };
        if let Some(error) = response.get("error") {
            return response_error(&request_id, "RUNTIME_ERROR", error.get("message").and_then(Value::as_str).unwrap_or("Runtime 请求失败"), true);
        }
        Ok(response.get("result").cloned().unwrap_or(Value::Null))
    } else {
        Err(format!("未知网关 method：{}", request.method))
    };
    match result {
        Ok(data) => {
            state.audit(&request, true, None);
            response_ok(&request_id, data)
        }
        Err(error) => {
            state.audit(&request, false, Some("CALL_FAILED"));
            response_error(&request_id, "CALL_FAILED", error, true)
        }
    }
}
