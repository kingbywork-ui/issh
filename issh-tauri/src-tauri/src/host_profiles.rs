use issh_runtime_vault::{decrypt_stored_to_json, StoredVault};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

const VAULT_SECRET_TYPE_PASSWORD: &str = "ssh:password";
const VAULT_SECRET_TYPE_PASSPHRASE: &str = "ssh:key-passphrase";

/// A host entry mirrored from the issh (Electron) config.yaml / cache files.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshHostProfile {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub group: String,
    #[serde(default)]
    pub host: String,
    #[serde(default)]
    pub port: u16,
    #[serde(default)]
    pub user: String,
    #[serde(default)]
    pub environment: Option<String>,
    #[serde(default)]
    pub remark: Option<String>,
    #[serde(default)]
    pub favorite: bool,
    #[serde(default)]
    pub tags: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshHostGroup {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub parent_group_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostProfilesResult {
    pub encrypted: bool,
    pub unlocked: bool,
    pub profiles: Vec<SshHostProfile>,
    pub groups: Vec<SshHostGroup>,
}

pub struct HostProfileStore {
    config_path: PathBuf,
    cache_path: PathBuf,
    unlocked: Mutex<Option<UnlockedConfig>>,
}

struct UnlockedConfig {
    profiles: Vec<SshHostProfile>,
    groups: Vec<SshHostGroup>,
    secrets: Vec<Value>,
}

impl HostProfileStore {
    pub fn new(user_data: &Path) -> Self {
        Self {
            config_path: user_data.join("config.yaml"),
            cache_path: user_data.join("ssh-profiles-cache.json"),
            unlocked: Mutex::new(None),
        }
    }

    pub fn read(&self) -> Result<HostProfilesResult, String> {
        let raw = match std::fs::read_to_string(&self.config_path) {
            Ok(raw) => raw,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return self.read_cache_only();
            }
            Err(error) => return Err(format!("无法读取 config.yaml：{error}")),
        };
        let parsed: serde_yaml::Value =
            serde_yaml::from_str(&raw).map_err(|error| format!("config.yaml 解析失败：{error}"))?;

        let encrypted = parsed
            .get("encrypted")
            .and_then(|value| value.as_bool())
            .unwrap_or(false);

        if !encrypted {
            let profiles = profiles_from_config(&parsed);
            let groups = groups_from_config(&parsed);
            let mut cache_profiles = self.read_cache_profiles().unwrap_or_default();
            merge_profiles(&mut cache_profiles, &profiles);
            return Ok(HostProfilesResult {
                encrypted: false,
                unlocked: true,
                profiles: cache_profiles,
                groups,
            });
        }

        let guard = self
            .unlocked
            .lock()
            .map_err(|_| "主机配置状态不可用".to_string())?;
        if let Some(unlocked) = guard.as_ref() {
            return Ok(HostProfilesResult {
                encrypted: true,
                unlocked: true,
                profiles: unlocked.profiles.clone(),
                groups: unlocked.groups.clone(),
            });
        }
        Ok(HostProfilesResult {
            encrypted: true,
            unlocked: false,
            profiles: Vec::new(),
            groups: Vec::new(),
        })
    }

    pub fn unlock(&self, passphrase: &str) -> Result<HostProfilesResult, String> {
        let raw = std::fs::read_to_string(&self.config_path)
            .map_err(|error| format!("无法读取 config.yaml：{error}"))?;
        let parsed: serde_yaml::Value =
            serde_yaml::from_str(&raw).map_err(|error| format!("config.yaml 解析失败：{error}"))?;
        let vault_section = parsed
            .get("vault")
            .ok_or_else(|| "config.yaml 缺少 vault 段".to_string())?;
        let stored: StoredVault = serde_yaml::from_value(vault_section.clone())
            .map_err(|error| format!("vault 段格式无效：{error}"))?;
        let plaintext = decrypt_stored_to_json(&stored, passphrase)
            .map_err(|error| format!("解锁失败：{error}"))?;
        let vault: Value = serde_json::from_str(&plaintext)
            .map_err(|error| format!("解密后的配置无效：{error}"))?;

        let config = vault.get("config").cloned().unwrap_or(Value::Null);
        let mut profiles = profiles_from_json(&config);
        let groups = groups_from_json(&config);
        let mut cache_profiles = self.read_cache_profiles().unwrap_or_default();
        merge_profiles(&mut cache_profiles, &profiles);
        profiles = cache_profiles;

        let secrets = vault
            .get("secrets")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();

        let mut guard = self
            .unlocked
            .lock()
            .map_err(|_| "主机配置状态不可用".to_string())?;
        *guard = Some(UnlockedConfig {
            profiles: profiles.clone(),
            groups: groups.clone(),
            secrets,
        });
        Ok(HostProfilesResult {
            encrypted: true,
            unlocked: true,
            profiles,
            groups,
        })
    }

    pub fn lock(&self) {
        if let Ok(mut guard) = self.unlocked.lock() {
            *guard = None;
        }
    }

    #[allow(dead_code)]
    pub fn is_unlocked(&self) -> bool {
        self.unlocked
            .lock()
            .map(|guard| guard.is_some())
            .unwrap_or(false)
    }

    /// Resolves the stored SSH password for a connection, mirroring the
    /// Electron PasswordStorageService vault lookup including the host-less
    /// fallback entry.
    pub fn resolve_ssh_password(
        &self,
        user: &str,
        host: &str,
        port: u16,
    ) -> Result<Option<String>, String> {
        let guard = self
            .unlocked
            .lock()
            .map_err(|_| "主机配置状态不可用".to_string())?;
        let Some(unlocked) = guard.as_ref() else {
            return Ok(None);
        };
        Ok(find_connection_secret(
            &unlocked.secrets,
            VAULT_SECRET_TYPE_PASSWORD,
            user,
            host,
            port,
        ))
    }

    pub fn resolve_key_passphrase(
        &self,
        user: &str,
        host: &str,
        port: u16,
    ) -> Result<Option<String>, String> {
        let guard = self
            .unlocked
            .lock()
            .map_err(|_| "主机配置状态不可用".to_string())?;
        let Some(unlocked) = guard.as_ref() else {
            return Ok(None);
        };
        Ok(find_connection_secret(
            &unlocked.secrets,
            VAULT_SECRET_TYPE_PASSPHRASE,
            user,
            host,
            port,
        ))
    }

    fn read_cache_only(&self) -> Result<HostProfilesResult, String> {
        let profiles = self.read_cache_profiles().unwrap_or_default();
        Ok(HostProfilesResult {
            encrypted: false,
            unlocked: true,
            profiles,
            groups: Vec::new(),
        })
    }

    fn read_cache_profiles(&self) -> Result<Vec<SshHostProfile>, String> {
        let raw = match std::fs::read_to_string(&self.cache_path) {
            Ok(raw) => raw,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(error) => return Err(format!("无法读取 ssh-profiles-cache.json：{error}")),
        };
        let parsed: Value =
            serde_json::from_str(&raw).map_err(|error| format!("缓存文件无效：{error}"))?;
        let Some(entries) = parsed.get("profiles").and_then(Value::as_array) else {
            return Ok(Vec::new());
        };
        Ok(entries.iter().filter_map(profile_from_json).collect())
    }
}

fn profiles_from_config(parsed: &serde_yaml::Value) -> Vec<SshHostProfile> {
    parsed
        .get("profiles")
        .and_then(|value| value.as_sequence())
        .map(|entries| {
            entries
                .iter()
                .filter_map(|entry| serde_yaml::from_value::<SshHostProfile>(entry.clone()).ok())
                .collect()
        })
        .unwrap_or_default()
}

fn groups_from_config(parsed: &serde_yaml::Value) -> Vec<SshHostGroup> {
    parsed
        .get("groups")
        .and_then(|value| value.as_sequence())
        .map(|entries| {
            entries
                .iter()
                .filter_map(|entry| serde_yaml::from_value::<SshHostGroup>(entry.clone()).ok())
                .collect()
        })
        .unwrap_or_default()
}

fn profiles_from_json(config: &Value) -> Vec<SshHostProfile> {
    config
        .get("profiles")
        .and_then(Value::as_array)
        .map(|entries| entries.iter().filter_map(profile_from_json).collect())
        .unwrap_or_default()
}

fn groups_from_json(config: &Value) -> Vec<SshHostGroup> {
    config
        .get("groups")
        .and_then(Value::as_array)
        .map(|entries| {
            entries
                .iter()
                .filter_map(|entry| serde_json::from_value::<SshHostGroup>(entry.clone()).ok())
                .collect()
        })
        .unwrap_or_default()
}

fn profile_from_json(entry: &Value) -> Option<SshHostProfile> {
    let options = entry.get("options").cloned().unwrap_or(Value::Null);
    Some(SshHostProfile {
        id: entry.get("id")?.as_str()?.to_string(),
        name: entry
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        group: entry
            .get("group")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        host: options
            .get("host")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        port: options
            .get("port")
            .and_then(Value::as_u64)
            .and_then(|port| u16::try_from(port).ok())
            .unwrap_or(22),
        user: options
            .get("user")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        environment: entry
            .get("environment")
            .and_then(Value::as_str)
            .map(str::to_string),
        remark: entry
            .get("remark")
            .and_then(Value::as_str)
            .map(str::to_string),
        favorite: entry
            .get("favorite")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        tags: entry
            .get("tags")
            .and_then(Value::as_array)
            .map(|tags| {
                tags.iter()
                    .filter_map(|tag| tag.as_str().map(str::to_string))
                    .collect()
            })
            .unwrap_or_default(),
    })
}

/// Merges cache-imported profiles with config profiles; config entries win on
/// id conflicts, cache-only entries are kept (mirrors the Electron behavior of
/// showing imported .ssh/config hosts).
fn merge_profiles(target: &mut Vec<SshHostProfile>, source: &[SshHostProfile]) {
    for profile in source {
        match target
            .iter()
            .position(|candidate| candidate.id == profile.id)
        {
            Some(index) => target[index] = profile.clone(),
            None => target.push(profile.clone()),
        }
    }
}

/// Mirrors VaultService.getSecret key matching: every provided key field must
/// match, then falls back to a host-less entry (default credentials shared
/// across servers).
fn find_connection_secret(
    secrets: &[Value],
    secret_type: &str,
    user: &str,
    host: &str,
    port: u16,
) -> Option<String> {
    let matches = |secret: &Value, host: Option<&str>| -> bool {
        let Some(key) = secret.get("key") else {
            return false;
        };
        if secret.get("type").and_then(Value::as_str) != Some(secret_type) {
            return false;
        }
        if key.get("user").and_then(Value::as_str) != Some(user) {
            return false;
        }
        let secret_port = key
            .get("port")
            .and_then(Value::as_u64)
            .and_then(|port| u16::try_from(port).ok())
            .unwrap_or(22);
        if secret_port != port {
            return false;
        }
        match host {
            Some(expected) => key.get("host").and_then(Value::as_str) == Some(expected),
            None => key.get("host").map(Value::is_null).unwrap_or(true),
        }
    };

    for secret in secrets {
        if matches(secret, Some(host)) {
            return secret
                .get("value")
                .and_then(Value::as_str)
                .map(str::to_string);
        }
    }
    for secret in secrets {
        if matches(secret, None) {
            return secret
                .get("value")
                .and_then(Value::as_str)
                .map(str::to_string);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn secret_json(user: &str, host: Option<&str>, port: u16, value: &str) -> Value {
        serde_json::json!({
            "type": VAULT_SECRET_TYPE_PASSWORD,
            "key": {
                "user": user,
                "host": host,
                "port": port,
            },
            "value": value,
        })
    }

    #[test]
    fn finds_exact_connection_password() {
        let secrets = vec![
            secret_json("root", Some("10.0.0.1"), 22, "exact"),
            secret_json("root", None, 22, "fallback"),
        ];
        assert_eq!(
            find_connection_secret(&secrets, VAULT_SECRET_TYPE_PASSWORD, "root", "10.0.0.1", 22),
            Some("exact".to_string())
        );
    }

    #[test]
    fn falls_back_to_hostless_password() {
        let secrets = vec![secret_json("root", None, 22, "fallback")];
        assert_eq!(
            find_connection_secret(&secrets, VAULT_SECRET_TYPE_PASSWORD, "root", "10.9.9.9", 22),
            Some("fallback".to_string())
        );
    }

    #[test]
    fn rejects_other_user_or_port() {
        let secrets = vec![secret_json("root", Some("10.0.0.1"), 2222, "wrong-port")];
        assert_eq!(
            find_connection_secret(&secrets, VAULT_SECRET_TYPE_PASSWORD, "root", "10.0.0.1", 22),
            None
        );
        assert_eq!(
            find_connection_secret(
                &secrets,
                VAULT_SECRET_TYPE_PASSWORD,
                "admin",
                "10.0.0.1",
                2222
            ),
            None
        );
    }

    #[test]
    fn profile_from_json_parses_electron_shape() {
        let entry = serde_json::json!({
            "id": "openssh-config:abc",
            "name": "web (.ssh/config)",
            "type": "ssh",
            "group": "Imported from .ssh/config",
            "options": { "host": "10.0.0.5", "port": 22, "user": "root" },
            "favorite": true,
            "tags": ["prod"],
        });
        let profile = profile_from_json(&entry).expect("profile should parse");
        assert_eq!(profile.host, "10.0.0.5");
        assert_eq!(profile.user, "root");
        assert_eq!(profile.port, 22);
        assert!(profile.favorite);
        assert_eq!(profile.tags, vec!["prod".to_string()]);
    }
}
