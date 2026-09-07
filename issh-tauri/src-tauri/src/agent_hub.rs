use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::PathBuf;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentHubDiscovery {
    rpc_url: String,
    token: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentHubStatus {
    pub installed: bool,
    pub running: bool,
    pub compatible: bool,
    pub url: String,
    pub version: Option<String>,
    pub provider_status: Option<String>,
    pub last_error: Option<String>,
}

#[derive(Default)]
pub struct AgentHubRuntime;

impl AgentHubRuntime {
    pub fn new() -> Self {
        Self
    }

    pub async fn status(&self) -> AgentHubStatus {
        let path = discovery_path();
        let installed = path.is_file();
        let discovery = match read_discovery() {
            Ok(value) => value,
            Err(error) => {
                return AgentHubStatus {
                    installed,
                    running: false,
                    compatible: false,
                    url: "http://127.0.0.1:33555".into(),
                    version: None,
                    provider_status: None,
                    last_error: Some(error),
                }
            }
        };
        match request(&discovery, "hub.health", json!({})).await {
            Ok(health) => {
                let version = health
                    .get("version")
                    .and_then(Value::as_str)
                    .map(str::to_string);
                let compatible = health
                    .get("protocolVersion")
                    .and_then(Value::as_str)
                    .map(|v| v.split('.').next() == Some("1"))
                    .unwrap_or(false);
                let provider_status = request(&discovery, "provider.list", json!({}))
                    .await
                    .ok()
                    .and_then(|v| v.as_array().cloned())
                    .and_then(|items| {
                        items
                            .into_iter()
                            .find(|v| v.get("kind").and_then(Value::as_str) == Some("issh"))
                    })
                    .and_then(|v| v.get("status").and_then(Value::as_str).map(str::to_string));
                AgentHubStatus {
                    installed: true,
                    running: true,
                    compatible,
                    url: "http://127.0.0.1:33555".into(),
                    version,
                    provider_status,
                    last_error: None,
                }
            }
            Err(error) => AgentHubStatus {
                installed: true,
                running: false,
                compatible: false,
                url: "http://127.0.0.1:33555".into(),
                version: None,
                provider_status: None,
                last_error: Some(error),
            },
        }
    }

    pub async fn open_url(&self) -> Result<String, String> {
        let discovery = read_discovery()?;
        let result = request(&discovery, "hub.bootstrap", json!({})).await?;
        result
            .get("url")
            .and_then(Value::as_str)
            .map(str::to_string)
            .ok_or_else(|| "Agent Hub did not return an open URL".into())
    }
}

fn discovery_path() -> PathBuf {
    if let Some(path) = std::env::var_os("AGENT_HUB_DISCOVERY_FILE") {
        return PathBuf::from(path);
    }
    std::env::var_os("APPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
        .join("agent-hub")
        .join("agent-hub.json")
}

/// 内置管理服务器启动时写入发现文件，使本模块（及 Agent Hub Connector 插件）
/// 将内置服务视为本地 Agent Hub。
pub fn write_discovery(token: &str) -> Result<(), String> {
    let path = discovery_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("无法创建 Agent Hub 发现目录：{error}"))?;
    }
    let payload = serde_json::json!({
        "rpcUrl": "http://127.0.0.1:33555",
        "token": token,
    });
    std::fs::write(&path, serde_json::to_string_pretty(&payload).unwrap_or_default())
        .map_err(|error| format!("无法写入 Agent Hub 发现文件：{error}"))
}

fn read_discovery() -> Result<AgentHubDiscovery, String> {
    let path = discovery_path();
    let raw = std::fs::read_to_string(&path)
        .map_err(|e| format!("Agent Hub 未安装或发现文件不可读：{e}"))?;
    let value: AgentHubDiscovery =
        serde_json::from_str(&raw).map_err(|e| format!("Agent Hub 发现文件无效：{e}"))?;
    let url = url::Url::parse(&value.rpc_url).map_err(|e| format!("Agent Hub 地址无效：{e}"))?;
    if url.scheme() != "http" || !matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "::1"))
    {
        return Err("Agent Hub 必须使用本机回环 HTTP".into());
    }
    if url.port_or_known_default() != Some(33555) {
        return Err("Agent Hub 必须监听固定端口 33555".into());
    }
    if value.token.len() < 32 {
        return Err("Agent Hub 令牌无效".into());
    }
    Ok(value)
}

async fn request(
    discovery: &AgentHubDiscovery,
    method: &str,
    params: Value,
) -> Result<Value, String> {
    let response = reqwest::Client::new()
        .post(&discovery.rpc_url)
        .bearer_auth(&discovery.token)
        .json(&json!({"jsonrpc":"2.0","id":1,"method":method,"params":params}))
        .send()
        .await
        .map_err(|e| format!("无法连接 Agent Hub：{e}"))?;
    let status = response.status();
    let body: Value = response
        .json()
        .await
        .map_err(|e| format!("Agent Hub 响应无效：{e}"))?;
    if !status.is_success() {
        return Err(format!("Agent Hub HTTP {status}"));
    }
    if let Some(error) = body.get("error") {
        return Err(error
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("Agent Hub RPC 错误")
            .to_string());
    }
    Ok(body.get("result").cloned().unwrap_or(Value::Null))
}
