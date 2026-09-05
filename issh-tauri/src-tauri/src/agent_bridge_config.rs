//! Agent Bridge 持久化配置（R-073：端口可配置；enabled 永不持久化）。
//!
//! - 持久化：port / token / allowedScopes / sftpRoot / auditLogEnabled / publicDiscovery
//! - 不持久化：enabled（每次必须手动开启）

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// Agent Bridge 权限档位（R-055）：
/// - Observer：只读，写/执行/SFTP 工具只返回执行计划、不实际执行
/// - Confirm：默认，危险操作需 confirmDangerous=true + 桌面端确认
/// - Auto：自动放行（跳过 Agent Bridge 层 confirm 校验，桌面端确认框仍生效）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PermissionMode {
    Observer,
    Confirm,
    Auto,
}

impl PermissionMode {
    pub fn as_str(self) -> &'static str {
        match self {
            PermissionMode::Observer => "observer",
            PermissionMode::Confirm => "confirm",
            PermissionMode::Auto => "auto",
        }
    }

    pub fn parse(value: &str) -> PermissionMode {
        match value {
            "observer" => PermissionMode::Observer,
            "auto" => PermissionMode::Auto,
            _ => PermissionMode::Confirm,
        }
    }
}

impl Default for PermissionMode {
    fn default() -> Self {
        PermissionMode::Confirm
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AgentBridgeConfig {
    /// Bearer token；首次启动自动生成 256 位 hex，轮换时持久化。
    pub token: String,
    /// 默认 59688；用户可在关闭 Bridge 时指定其它非零端口。
    #[serde(deserialize_with = "deserialize_port")]
    pub port: u16,
    /// 已授权工具 scope 列表：read / write / exec / sftp。
    pub allowed_scopes: Vec<String>,
    /// SFTP 路径限制根目录；None = 不限制。
    pub sftp_root: Option<String>,
    /// 是否写审计日志（agent-bridge-audit.jsonl）。
    pub audit_log_enabled: bool,
    /// 是否写 agent 可读 discovery file（issh-agent-bridge.json）。
    pub public_discovery: bool,
    /// 权限档位（R-055）：observer / confirm / auto。
    pub permission_mode: PermissionMode,
}

impl Default for AgentBridgeConfig {
    fn default() -> Self {
        Self {
            token: generate_token(),
            port: crate::agent_bridge::AGENT_BRIDGE_PORT,
            allowed_scopes: vec![
                "read".to_string(),
                "write".to_string(),
                "exec".to_string(),
                "sftp".to_string(),
            ],
            sftp_root: None,
            audit_log_enabled: true,
            public_discovery: false,
            permission_mode: PermissionMode::Confirm,
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

fn deserialize_port<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<u16, D::Error> {
    let port = u16::deserialize(deserializer)?;
    if port == 0 {
        return Err(serde::de::Error::custom("端口必须为 1–65535 的整数"));
    }
    Ok(port)
}

pub fn parse_port(value: &serde_json::Value) -> Result<u16, String> {
    value.as_u64().filter(|port| (1..=65535).contains(port))
        .map(|port| port as u16)
        .ok_or_else(|| "端口必须为 1–65535 的整数".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn old_config_defaults_to_original_port_and_does_not_persist_enabled() {
        let config: AgentBridgeConfig = serde_json::from_str(r#"{"token":"test","enabled":true}"#).unwrap();
        assert_eq!(config.port, 59688);
        let value = serde_json::to_value(config).unwrap();
        assert!(value.get("enabled").is_none());
    }

    #[test]
    fn custom_port_roundtrips_and_invalid_ports_are_rejected() {
        let config = AgentBridgeConfig { port: 39688, ..Default::default() };
        let raw = serde_json::to_string(&config).unwrap();
        assert_eq!(serde_json::from_str::<AgentBridgeConfig>(&raw).unwrap().port, 39688);
        for value in [serde_json::json!(0), serde_json::json!(65536), serde_json::json!(-1), serde_json::json!(1.5), serde_json::json!("39688"), serde_json::Value::Null] {
            assert!(parse_port(&value).is_err());
            assert!(serde_json::from_value::<AgentBridgeConfig>(serde_json::json!({"port": value})).is_err());
        }
        assert_eq!(parse_port(&serde_json::json!(39688)).unwrap(), 39688);
    }
}
