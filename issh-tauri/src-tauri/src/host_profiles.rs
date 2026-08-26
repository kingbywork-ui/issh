use issh_runtime_vault::{decrypt_stored_to_json, encrypt_json_to_stored, StoredVault};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha512};
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
    pub auth: Option<String>,
    #[serde(default)]
    pub private_keys: Vec<String>,
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
    vault: Value,
    root: serde_yaml::Value,
    passphrase: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostProfileMutation {
    pub action: String,
    pub profile: Option<SshHostProfile>,
    pub profile_id: Option<String>,
    pub group: Option<SshHostGroup>,
    pub group_id: Option<String>,
    pub profile_ids: Option<Vec<String>>,
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
            vault,
            root: parsed,
            passphrase: passphrase.to_string(),
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
        key_path: Option<&str>,
    ) -> Result<Option<String>, String> {
        let guard = self
            .unlocked
            .lock()
            .map_err(|_| "主机配置状态不可用".to_string())?;
        let Some(unlocked) = guard.as_ref() else {
            return Ok(None);
        };
        // Electron 存储密钥口令的 key 是 sha512(密钥文件内容)；按连接 key 查不到
        if let Some(path) = key_path {
            let expanded = expand_key_path(path, user, host);
            if let Ok(contents) = std::fs::read_to_string(&expanded) {
                let digest = Sha512::digest(contents.as_bytes());
                let hash = hex_encode(&digest);
                if let Some(passphrase) =
                    find_secret_by_hash(&unlocked.secrets, VAULT_SECRET_TYPE_PASSPHRASE, &hash)
                {
                    return Ok(Some(passphrase));
                }
            }
        }
        Ok(find_connection_secret(
            &unlocked.secrets,
            VAULT_SECRET_TYPE_PASSPHRASE,
            user,
            host,
            port,
        ))
    }

    pub fn mutate(&self, mutation: HostProfileMutation) -> Result<HostProfilesResult, String> {
        let action = mutation.action.trim();
        if action.is_empty() {
            return Err("缺少配置变更动作".to_string());
        }
        let raw = std::fs::read_to_string(&self.config_path).ok();
        let encrypted = raw
            .as_deref()
            .and_then(|value| serde_yaml::from_str::<serde_yaml::Value>(value).ok())
            .and_then(|value| value.get("encrypted").and_then(|v| v.as_bool()))
            .unwrap_or(false);

        if encrypted {
            let mut guard = self.unlocked.lock().map_err(|_| "主机配置状态不可用".to_string())?;
            let unlocked = guard.as_mut().ok_or_else(|| "请先解锁主机配置".to_string())?;
            apply_mutation(&mut unlocked.profiles, &mut unlocked.groups, &mutation)?;
            let config = unlocked.vault.get_mut("config").ok_or_else(|| "Vault 配置缺少 config".to_string())?;
            write_model_to_json(config, &unlocked.profiles, &unlocked.groups);
            let plaintext = serde_json::to_string(&unlocked.vault).map_err(|e| format!("Vault 序列化失败：{e}"))?;
            let stored = encrypt_json_to_stored(&plaintext, &unlocked.passphrase);
            if let serde_yaml::Value::Mapping(map) = &mut unlocked.root {
                map.insert(serde_yaml::Value::String("vault".into()), serde_yaml::to_value(stored).map_err(|e| format!("Vault 序列化失败：{e}"))?);
            }
            persist_yaml(&self.config_path, &unlocked.root)?;
            return Ok(result_from_unlocked(unlocked));
        }

        let mut parsed = raw
            .ok_or_else(|| "无法读取 config.yaml".to_string())
            .and_then(|value| serde_yaml::from_str::<serde_yaml::Value>(&value).map_err(|e| format!("config.yaml 解析失败：{e}")))?;
        let mut profiles = profiles_from_config(&parsed);
        let mut groups = groups_from_config(&parsed);
        apply_mutation(&mut profiles, &mut groups, &mutation)?;
        write_model_to_yaml(&mut parsed, &profiles, &groups);
        persist_yaml(&self.config_path, &parsed)?;
        Ok(HostProfilesResult { encrypted: false, unlocked: true, profiles, groups })
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

fn result_from_unlocked(unlocked: &UnlockedConfig) -> HostProfilesResult {
    HostProfilesResult { encrypted: true, unlocked: true, profiles: unlocked.profiles.clone(), groups: unlocked.groups.clone() }
}

fn apply_mutation(profiles: &mut Vec<SshHostProfile>, groups: &mut Vec<SshHostGroup>, mutation: &HostProfileMutation) -> Result<(), String> {
    match mutation.action.as_str() {
        "createProfile" => {
            let profile = mutation.profile.clone().ok_or_else(|| "缺少主机数据".to_string())?;
            validate_profile(&profile, profiles, groups, None)?;
            profiles.push(profile);
        }
        "updateProfile" => {
            let profile = mutation.profile.clone().ok_or_else(|| "缺少主机数据".to_string())?;
            validate_profile(&profile, profiles, groups, Some(&profile.id))?;
            let target = profiles.iter_mut().find(|item| item.id == profile.id).ok_or_else(|| "主机不存在".to_string())?;
            *target = profile;
        }
        "deleteProfile" => {
            let id = mutation.profile_id.as_deref().ok_or_else(|| "缺少主机 ID".to_string())?;
            profiles.retain(|item| item.id != id);
        }
        "createGroup" => {
            let group = mutation.group.clone().ok_or_else(|| "缺少分组数据".to_string())?;
            validate_group(&group, groups, None)?;
            groups.push(group);
        }
        "updateGroup" => {
            let group = mutation.group.clone().ok_or_else(|| "缺少分组数据".to_string())?;
            validate_group(&group, groups, Some(&group.id))?;
            let target = groups.iter_mut().find(|item| item.id == group.id).ok_or_else(|| "分组不存在".to_string())?;
            *target = group;
        }
        "deleteGroup" => {
            let id = mutation.group_id.as_deref().ok_or_else(|| "缺少分组 ID".to_string())?;
            if groups.iter().any(|item| item.parent_group_id.as_deref() == Some(id)) {
                return Err("请先处理子分组后再删除".to_string());
            }
            if profiles.iter().any(|item| item.group == id) {
                return Err("请先移动或删除分组中的主机".to_string());
            }
            groups.retain(|item| item.id != id);
        }
        "moveProfiles" => {
            let ids = mutation.profile_ids.as_deref().unwrap_or_default();
            let target = mutation.group_id.as_deref().unwrap_or("");
            if !target.is_empty() && !groups.iter().any(|item| item.id == target) { return Err("目标分组不存在".to_string()); }
            for profile in profiles.iter_mut().filter(|item| ids.contains(&item.id)) { profile.group = target.to_string(); }
        }
        "toggleFavorite" => {
            let id = mutation.profile_id.as_deref().ok_or_else(|| "缺少主机 ID".to_string())?;
            let profile = profiles.iter_mut().find(|item| item.id == id).ok_or_else(|| "主机不存在".to_string())?;
            profile.favorite = !profile.favorite;
        }
        _ => return Err(format!("不支持的配置变更动作：{action}", action = mutation.action)),
    }
    Ok(())
}

fn validate_profile(profile: &SshHostProfile, profiles: &[SshHostProfile], groups: &[SshHostGroup], current: Option<&str>) -> Result<(), String> {
    if profile.id.trim().is_empty() || profile.name.trim().is_empty() || profile.host.trim().is_empty() || profile.user.trim().is_empty() { return Err("主机名称、地址、用户名和 ID 不能为空".to_string()); }
    if profiles.iter().any(|item| Some(item.id.as_str()) != current && item.id == profile.id) { return Err("主机 ID 已存在".to_string()); }
    if !profile.group.is_empty() && !groups.iter().any(|item| item.id == profile.group) { return Err("主机所属分组不存在".to_string()); }
    Ok(())
}

fn validate_group(group: &SshHostGroup, groups: &[SshHostGroup], current: Option<&str>) -> Result<(), String> {
    if group.id.trim().is_empty() || group.name.trim().is_empty() { return Err("分组名称和 ID 不能为空".to_string()); }
    if groups.iter().any(|item| Some(item.id.as_str()) != current && item.id == group.id) { return Err("分组 ID 已存在".to_string()); }
    if group.parent_group_id.as_deref() == Some(&group.id) { return Err("分组不能成为自己的父分组".to_string()); }
    if let Some(parent) = group.parent_group_id.as_deref() { if !groups.iter().any(|item| item.id == parent) { return Err("父分组不存在".to_string()); } }
    if let Some(current_id) = current {
        let mut cursor = group.parent_group_id.as_deref();
        let mut seen = std::collections::HashSet::new();
        while let Some(id) = cursor {
            if id == current_id || !seen.insert(id) { return Err("分组层级不能形成循环".to_string()); }
            cursor = groups.iter().find(|item| item.id == id).and_then(|item| item.parent_group_id.as_deref());
        }
    }
    Ok(())
}

fn write_model_to_yaml(config: &mut serde_yaml::Value, profiles: &[SshHostProfile], groups: &[SshHostGroup]) {
    if let serde_yaml::Value::Mapping(map) = config {
        map.insert(serde_yaml::Value::String("profiles".into()), serde_yaml::to_value(profiles).unwrap_or_default());
        map.insert(serde_yaml::Value::String("groups".into()), serde_yaml::to_value(groups).unwrap_or_default());
    }
}

fn write_model_to_json(config: &mut Value, profiles: &[SshHostProfile], groups: &[SshHostGroup]) {
    if let Value::Object(map) = config {
        let entries = profiles.iter().map(|profile| serde_json::json!({
            "id": profile.id,
            "name": profile.name,
            "type": "ssh",
            "group": profile.group,
            "favorite": profile.favorite,
            "environment": profile.environment,
            "remark": profile.remark,
            "tags": profile.tags,
            "options": {
                "host": profile.host,
                "port": profile.port,
                "user": profile.user,
                "auth": profile.auth,
                "privateKeys": profile.private_keys,
            },
        })).collect::<Vec<_>>();
        map.insert("profiles".into(), Value::Array(entries));
        map.insert("groups".into(), serde_json::to_value(groups).unwrap_or(Value::Array(Vec::new())));
    }
}

fn persist_yaml(path: &Path, value: &serde_yaml::Value) -> Result<(), String> {
    let payload = serde_yaml::to_string(value).map_err(|e| format!("配置序列化失败：{e}"))?;
    let tmp = path.with_extension("yaml.tmp");
    std::fs::write(&tmp, payload).map_err(|e| format!("配置写入失败：{e}"))?;
    std::fs::rename(&tmp, path).map_err(|e| format!("配置替换失败：{e}"))
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
        auth: options
            .get("auth")
            .and_then(Value::as_str)
            .map(str::to_string),
        private_keys: options
            .get("privateKeys")
            .and_then(Value::as_array)
            .map(|keys| {
                keys.iter()
                    .filter_map(|key| {
                        if let Some(path) = key.as_str() {
                            Some(path.to_string())
                        } else {
                            key.get("name")
                                .and_then(Value::as_str)
                                .map(str::to_string)
                        }
                    })
                    .collect()
            })
            .unwrap_or_default(),
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

/// Electron 存密钥口令用 key = { hash: sha512(key contents) }。
fn find_secret_by_hash(
    secrets: &[Value],
    secret_type: &str,
    hash: &str,
) -> Option<String> {
    secrets
        .iter()
        .find(|secret| {
            secret.get("type").and_then(Value::as_str) == Some(secret_type)
                && secret
                    .get("key")
                    .and_then(|key| key.get("hash"))
                    .and_then(Value::as_str)
                    == Some(hash)
        })
        .and_then(|secret| secret.get("value").and_then(Value::as_str))
        .map(str::to_string)
}

/// Electron 存的私钥路径可能是 file:// URI（file://c:\... 或 file:///c:/...），
/// 且支持 %h（host）/%r（user）模板；连接时归一化为纯文件路径。
fn expand_key_path(path: &str, user: &str, host: &str) -> String {
    let mut p = path.trim().to_string();
    if let Some(stripped) = p.strip_prefix("file://").or_else(|| p.strip_prefix("FILE://")) {
        p = stripped.to_string();
        // file:///c:/... → c:/...（剥掉盘符前的多余斜杠）；Linux 绝对路径保留
        let bytes = p.as_bytes();
        if bytes.len() >= 3 && bytes[0] == b'/' && bytes[1].is_ascii_alphabetic() && bytes[2] == b':' {
            p = p[1..].to_string();
        }
    }
    p.replace("%h", host).replace("%r", user)
}

fn hex_encode(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
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
            "options": { "host": "10.0.0.5", "port": 22, "user": "root", "auth": "publicKey", "privateKeys": ["C:/Users/me/.ssh/id_ed25519"] },
            "favorite": true,
            "tags": ["prod"],
        });
        let profile = profile_from_json(&entry).expect("profile should parse");
        assert_eq!(profile.host, "10.0.0.5");
        assert_eq!(profile.user, "root");
        assert_eq!(profile.port, 22);
        assert_eq!(profile.auth.as_deref(), Some("publicKey"));
        assert_eq!(
            profile.private_keys,
            vec!["C:/Users/me/.ssh/id_ed25519".to_string()]
        );
        assert!(profile.favorite);
        assert_eq!(profile.tags, vec!["prod".to_string()]);
    }

    #[test]
    fn finds_passphrase_by_key_content_hash() {
        let contents = "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----";
        let digest = Sha512::digest(contents.as_bytes());
        let hash = hex_encode(&digest);
        let secrets = vec![serde_json::json!({
            "type": VAULT_SECRET_TYPE_PASSPHRASE,
            "key": { "hash": hash },
            "value": "secret-passphrase",
        })];
        assert_eq!(
            find_secret_by_hash(&secrets, VAULT_SECRET_TYPE_PASSPHRASE, &hash),
            Some("secret-passphrase".to_string())
        );
    }

    #[test]
    fn expands_key_path_templates() {
        assert_eq!(
            expand_key_path("C:/keys/%h/user_%r_key", "root", "10.0.0.1"),
            "C:/keys/10.0.0.1/user_root_key"
        );
    }

    #[test]
    fn expands_file_uri_key_path() {
        // Electron 常见格式：file://c:\Users\me\.ssh\id_rsa（无三斜杠、小写盘符）
        assert_eq!(
            expand_key_path("file://c:\\Users\\me\\.ssh\\gccb", "root", "10.0.0.1"),
            "c:\\Users\\me\\.ssh\\gccb"
        );
        // 标准 file URI：file:///c:/Users/me/.ssh/id_rsa
        assert_eq!(
            expand_key_path("file:///c:/Users/me/.ssh/id_rsa", "root", "10.0.0.1"),
            "c:/Users/me/.ssh/id_rsa"
        );
        // Linux 绝对路径 file URI 不受影响
        assert_eq!(
            expand_key_path("file:///home/me/.ssh/id_ed25519", "root", "10.0.0.1"),
            "/home/me/.ssh/id_ed25519"
        );
        // 纯路径不受影响
        assert_eq!(
            expand_key_path("C:\\Users\\me\\.ssh\\id_rsa", "root", "10.0.0.1"),
            "C:\\Users\\me\\.ssh\\id_rsa"
        );
    }
}
