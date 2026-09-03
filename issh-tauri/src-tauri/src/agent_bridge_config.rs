//! Agent Bridge 持久化配置（R-045 安全语义：enabled 与端口永不持久化）。
//!
//! - 持久化：token / allowedScopes / sftpRoot / auditLogEnabled / publicDiscovery
//! - 不持久化：enabled（每次必须手动开启）、端口（固定 59688）

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AgentBridgeConfig {
    /// Bearer token；首次启动自动生成 256 位 hex，轮换时持久化。
    pub token: String,
    /// 已授权工具 scope 列表：read / write / exec / sftp。
    pub allowed_scopes: Vec<String>,
    /// SFTP 路径限制根目录；None = 不限制。
    pub sftp_root: Option<String>,
    /// 是否写审计日志（agent-bridge-audit.jsonl）。
    pub audit_log_enabled: bool,
    /// 是否写 agent 可读 discovery file（issh-agent-bridge.json）。
    pub public_discovery: bool,
}

impl Default for AgentBridgeConfig {
    fn default() -> Self {
        Self {
            token: generate_token(),
            allowed_scopes: vec![
                "read".to_string(),
                "write".to_string(),
                "exec".to_string(),
                "sftp".to_string(),
            ],
            sftp_root: None,
            audit_log_enabled: true,
            public_discovery: false,
        }
    }
}

pub fn load(user_data: &Path) -> Result<AgentBridgeConfig, String> {
    let path = config_path(user_data);
    match std::fs::read_to_string(&path) {
        Ok(raw) => serde_json::from_str(&raw)
            .map_err(|error| format!("agent-bridge.json 解析失败：{error}")),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            Ok(AgentBridgeConfig::default())
        }
        Err(error) => Err(format!("无法读取 agent-bridge.json：{error}")),
    }
}

pub fn save(user_data: &Path, config: &AgentBridgeConfig) -> Result<(), String> {
    let path = config_path(user_data);
    let raw = serde_json::to_vec_pretty(config).map_err(|error| error.to_string())?;
    std::fs::write(&path, raw)
        .map_err(|error| format!("无法写入 agent-bridge.json：{error}"))
}

/// 生成 256 位随机 hex token。
pub fn generate_token() -> String {
    use rand::RngCore;
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

pub fn audit_log_path(user_data: &Path) -> PathBuf {
    user_data.join("agent-bridge-audit.jsonl")
}

fn config_path(user_data: &Path) -> PathBuf {
    user_data.join("agent-bridge.json")
}
