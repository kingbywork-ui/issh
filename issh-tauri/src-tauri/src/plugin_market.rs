use base64::Engine as _;
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::io::Read;
use std::path::{Component, Path, PathBuf};

const MAX_SINGLE_FILE_BYTES: u64 = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES: u64 = 64 * 1024 * 1024;
const MAX_ENTRIES: usize = 512;
const REGISTRY_TIMEOUT_SECS: u64 = 20;
const DOWNLOAD_TIMEOUT_SECS: u64 = 120;

/// issh 官方插件签名公钥（ed25519 SPKI base64）。索引条目带 signature 时强制验签。
const SIGNING_PUBLIC_KEY: &str = "MCowBQYDK2VwAyEAC3mDW1rXlnlqWTx9u9aqnIS6nsY69tIDot4heKZYvyA=";

#[derive(Debug, Serialize)]
pub struct PluginRegistryEntry {
    pub id: String,
    pub name: String,
    pub version: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub permissions: Vec<String>,
    #[serde(default)]
    pub min_app_version: Option<String>,
    #[serde(default)]
    pub download_url: String,
    #[serde(default)]
    pub sha256: String,
    #[serde(default)]
    pub homepage: Option<String>,
    #[serde(default)]
    pub repository: Option<String>,
    #[serde(default)]
    pub signature: Option<String>,
    #[serde(default)]
    pub downloads: Option<u64>,
}

/// 验证索引条目签名：对 `id\nversion\nsha256` 的 UTF-8 字节做 ed25519 验签。
/// 签名 base64 编码。返回 Ok(()) 表示通过或条目未签名。
pub fn verify_entry_signature(entry: &PluginRegistryEntry) -> Result<(), String> {
    let Some(signature_b64) = entry.signature.as_deref() else {
        return Ok(());
    };
    let signature_bytes = base64::engine::general_purpose::STANDARD
        .decode(signature_b64)
        .map_err(|error| format!("插件签名解码失败：{error}"))?;
    let signature = Signature::from_slice(&signature_bytes)
        .map_err(|_| "插件签名格式无效".to_string())?;
    let public_key_bytes = base64::engine::general_purpose::STANDARD
        .decode(SIGNING_PUBLIC_KEY)
        .map_err(|error| format!("内置公钥无效：{error}"))?;
    let verifying_key = VerifyingKey::from_bytes(
        public_key_bytes
            .get(public_key_bytes.len().saturating_sub(32)..)
            .and_then(|slice| slice.try_into().ok())
            .ok_or_else(|| "内置公钥长度无效".to_string())?,
    )
    .map_err(|_| "内置公钥无效".to_string())?;
    let message = format!("{}\n{}\n{}", entry.id, entry.version, entry.sha256);
    verifying_key
        .verify(message.as_bytes(), &signature)
        .map_err(|_| "插件签名校验失败，可能被篡改".to_string())
}

#[derive(Debug, Serialize)]
pub struct PluginRegistry {
    pub schema: i64,
    #[serde(default)]
    pub updated: Option<String>,
    pub plugins: Vec<PluginRegistryEntry>,
}

#[derive(Debug, Serialize)]
pub struct InstalledPlugin {
    pub id: String,
    pub name: String,
    pub version: String,
    pub description: String,
    pub kind: String,
    pub permissions: Vec<String>,
    pub entry: String,
    pub directory: String,
}

pub fn plugins_root(app_data: &Path) -> PathBuf {
    app_data.join("plugins")
}

pub async fn fetch_registry(url: &str) -> Result<PluginRegistry, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(REGISTRY_TIMEOUT_SECS))
        .build()
        .map_err(|error| format!("无法创建网络客户端：{error}"))?;
    let response = client
        .get(url)
        .header("User-Agent", "issh-plugin-market/0.1")
        .send()
        .await
        .map_err(|error| format!("无法访问插件索引：{error}"))?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("插件索引返回 {status}"));
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|error| format!("读取插件索引失败：{error}"))?;
    if bytes.len() > MAX_SINGLE_FILE_BYTES as usize {
        return Err("插件索引超过大小限制".to_string());
    }
    let registry: PluginRegistryRaw =
        serde_json::from_slice(&bytes).map_err(|error| format!("插件索引格式无效：{error}"))?;
    if registry.schema != 1 {
        return Err(format!("不支持的插件索引版本：{}", registry.schema));
    }
    let registry = PluginRegistry {
        schema: registry.schema,
        updated: registry.updated,
        plugins: registry
            .plugins
            .into_iter()
            .map(|entry| PluginRegistryEntry {
                id: entry.id,
                name: entry.name,
                version: entry.version,
                description: entry.description.unwrap_or_default(),
                kind: entry.kind.unwrap_or_else(|| "feature".to_string()),
                permissions: entry.permissions.unwrap_or_default(),
                min_app_version: entry.min_app_version,
                download_url: entry.download_url,
                sha256: entry.sha256,
                homepage: entry.homepage,
                repository: entry.repository,
                signature: entry.signature,
                downloads: entry.downloads,
            })
            .collect(),
    };
    for entry in &registry.plugins {
        verify_entry_signature(entry)?;
    }
    Ok(registry)
}

#[derive(Debug, Deserialize)]
struct PluginRegistryRaw {
    schema: i64,
    #[serde(default)]
    updated: Option<String>,
    #[serde(default)]
    plugins: Vec<PluginRegistryEntryRaw>,
}

#[derive(Debug, Deserialize)]
struct PluginRegistryEntryRaw {
    id: String,
    name: String,
    version: String,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    kind: Option<String>,
    #[serde(default)]
    permissions: Option<Vec<String>>,
    #[serde(default)]
    min_app_version: Option<String>,
    download_url: String,
    sha256: String,
    #[serde(default)]
    homepage: Option<String>,
    #[serde(default)]
    repository: Option<String>,
    #[serde(default)]
    signature: Option<String>,
    #[serde(default)]
    downloads: Option<u64>,
}

pub async fn download_plugin(
    app_data: &Path,
    id: &str,
    url: &str,
    expected_sha256: &str,
    signature: Option<&str>,
) -> Result<InstalledPlugin, String> {
    if !is_valid_plugin_id(id) {
        return Err(format!("非法插件 id：{id}"));
    }
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(DOWNLOAD_TIMEOUT_SECS))
        .build()
        .map_err(|error| format!("无法创建网络客户端：{error}"))?;
    let response = client
        .get(url)
        .header("User-Agent", "issh-plugin-market/0.1")
        .send()
        .await
        .map_err(|error| format!("无法下载插件包：{error}"))?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("插件包下载返回 {status}"));
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|error| format!("读取插件包失败：{error}"))?;
    if bytes.len() as u64 > MAX_TOTAL_BYTES {
        return Err("插件包超过大小限制".to_string());
    }
    let digest = Sha256::digest(&bytes);
    let actual = digest
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    let expected = expected_sha256.to_ascii_lowercase();
    if actual != expected {
        return Err(format!(
            "插件包校验失败：期望 sha256 {expected}，实际 {actual}"
        ));
    }
    if let Some(signature_b64) = signature {
        let entry = PluginRegistryEntry {
            id: id.to_string(),
            name: String::new(),
            version: String::new(),
            description: String::new(),
            kind: String::new(),
            permissions: Vec::new(),
            min_app_version: None,
            download_url: String::new(),
            sha256: actual.clone(),
            homepage: None,
            repository: None,
            signature: Some(signature_b64.to_string()),
            downloads: None,
        };
        verify_entry_signature(&entry)?;
    }
    extract_plugin(app_data, id, &bytes)
}

fn extract_plugin(app_data: &Path, id: &str, bytes: &[u8]) -> Result<InstalledPlugin, String> {
    let root = plugins_root(app_data);
    let staging = root.join(format!(".staging-{id}"));
    let target = root.join(id);
    std::fs::create_dir_all(&staging).map_err(|error| format!("无法创建安装目录：{error}"))?;
    let install_result = install_tarball(&staging, bytes);
    let manifest = match install_result {
        Ok(manifest) => manifest,
        Err(error) => {
            let _ = std::fs::remove_dir_all(&staging);
            return Err(error);
        }
    };
    if manifest.id != id {
        let _ = std::fs::remove_dir_all(&staging);
        return Err(format!(
            "插件包 manifest id（{}）与请求的 id（{id}）不一致",
            manifest.id
        ));
    }
    if target.exists() {
        std::fs::remove_dir_all(&target).map_err(|error| format!("无法替换旧版本插件：{error}"))?;
    }
    std::fs::rename(&staging, &target).map_err(|error| format!("无法完成插件安装：{error}"))?;
    Ok(InstalledPlugin {
        id: manifest.id,
        name: manifest.name,
        version: manifest.version,
        description: manifest.description,
        kind: manifest.kind,
        permissions: manifest.permissions,
        entry: manifest.entry,
        directory: target.to_string_lossy().to_string(),
    })
}

#[derive(Debug, Deserialize)]
struct PluginManifestRaw {
    id: String,
    name: String,
    version: String,
    #[serde(default)]
    description: String,
    #[serde(default = "default_kind")]
    kind: String,
    #[serde(default)]
    permissions: Vec<String>,
    entry: String,
}

fn default_kind() -> String {
    "feature".to_string()
}

fn install_tarball(staging: &Path, bytes: &[u8]) -> Result<PluginManifestRaw, String> {
    let decoder = flate2::read::GzDecoder::new(bytes);
    let mut archive = tar::Archive::new(decoder);
    let mut entries = 0usize;
    let mut total: u64 = 0;
    let mut manifest: Option<PluginManifestRaw> = None;
    for entry in archive
        .entries()
        .map_err(|error| format!("插件包无法读取：{error}"))?
    {
        let mut entry = entry.map_err(|error| format!("插件包条目无效：{error}"))?;
        entries += 1;
        if entries > MAX_ENTRIES {
            return Err("插件包条目过多".to_string());
        }
        let header = entry.header().clone();
        let entry_type = header.entry_type();
        if entry_type.is_symlink() || entry_type.is_hard_link() {
            return Err("插件包含有链接条目，已拒绝".to_string());
        }
        let relative = entry
            .path()
            .map_err(|error| format!("插件包路径无效：{error}"))?
            .to_path_buf();
        let normalized = normalize_relative_path(&relative)?;
        if normalized.as_os_str().is_empty() {
            continue;
        }
        let size = header.size().map_err(|error| error.to_string())?;
        if size > MAX_SINGLE_FILE_BYTES {
            return Err(format!("插件包含超过 {} 字节的文件", MAX_SINGLE_FILE_BYTES));
        }
        total += size;
        if total > MAX_TOTAL_BYTES {
            return Err("插件包解压总量超过限制".to_string());
        }
        let destination = staging.join(&normalized);
        if entry_type.is_dir() {
            std::fs::create_dir_all(&destination)
                .map_err(|error| format!("无法创建插件目录：{error}"))?;
            continue;
        }
        if !entry_type.is_file() {
            continue;
        }
        if let Some(parent) = destination.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|error| format!("无法创建插件目录：{error}"))?;
        }
        let mut content = Vec::new();
        entry
            .read_to_end(&mut content)
            .map_err(|error| format!("读取插件文件失败：{error}"))?;
        std::fs::write(&destination, &content)
            .map_err(|error| format!("写入插件文件失败：{error}"))?;
        if normalized == Path::new("plugin.json") {
            let text = String::from_utf8(content)
                .map_err(|error| format!("plugin.json 不是 UTF-8：{error}"))?;
            manifest = Some(
                serde_json::from_str(&text)
                    .map_err(|error| format!("plugin.json 无效：{error}"))?,
            );
        }
    }
    manifest.ok_or_else(|| "插件包缺少 plugin.json".to_string())
}

fn normalize_relative_path(path: &Path) -> Result<PathBuf, String> {
    let mut result = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Normal(part) => {
                let text = part.to_string_lossy();
                if text.contains(':') || text.contains('\\') {
                    return Err("插件包含有非法路径".to_string());
                }
                result.push(part);
            }
            Component::CurDir => continue,
            _ => return Err("插件包含有非法路径".to_string()),
        }
    }
    Ok(result)
}

pub fn list_installed(app_data: &Path) -> Result<Vec<InstalledPlugin>, String> {
    let root = plugins_root(app_data);
    let mut result = Vec::new();
    let entries = match std::fs::read_dir(&root) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(result),
        Err(error) => return Err(format!("无法读取插件目录：{error}")),
    };
    for entry in entries {
        let entry = entry.map_err(|error| format!("无法读取插件目录项：{error}"))?;
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let manifest_path = path.join("plugin.json");
        if !manifest_path.is_file() {
            continue;
        }
        let content = std::fs::read_to_string(&manifest_path)
            .map_err(|error| format!("读取 plugin.json 失败：{error}"))?;
        let manifest: PluginManifestRaw =
            serde_json::from_str(&content).map_err(|error| format!("plugin.json 无效：{error}"))?;
        result.push(InstalledPlugin {
            id: manifest.id,
            name: manifest.name,
            version: manifest.version,
            description: manifest.description,
            kind: manifest.kind,
            permissions: manifest.permissions,
            entry: manifest.entry,
            directory: path.to_string_lossy().to_string(),
        });
    }
    result.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(result)
}

pub fn delete_plugin(app_data: &Path, id: &str) -> Result<bool, String> {
    if !is_valid_plugin_id(id) {
        return Err(format!("非法插件 id：{id}"));
    }
    let target = plugins_root(app_data).join(id);
    if !target.exists() {
        return Ok(false);
    }
    std::fs::remove_dir_all(&target).map_err(|error| format!("无法删除插件：{error}"))?;
    Ok(true)
}

fn is_valid_plugin_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn sample_tarball(manifest_json: &str) -> Vec<u8> {
        let mut tarball = tar::Builder::new(Vec::new());
        let mut header = tar::Header::new_gnu();
        let data = manifest_json.as_bytes();
        header.set_size(data.len() as u64);
        header.set_mode(0o644);
        header.set_cksum();
        tarball
            .append_data(&mut header, "plugin.json", data)
            .unwrap();
        let raw = tarball.into_inner().unwrap();
        let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        encoder.write_all(&raw).unwrap();
        encoder.finish().unwrap()
    }

    #[test]
    fn rejects_path_traversal() {
        let mut tarball = tar::Builder::new(Vec::new());
        let mut header = tar::Header::new_gnu();
        {
            let gnu = header.as_gnu_mut().unwrap();
            gnu.name[..11].copy_from_slice(b"../evil.txt");
        }
        header.set_size(3);
        header.set_mode(0o644);
        header.set_cksum();
        tarball.append(&mut header, b"abc".as_slice()).unwrap();
        let raw = tarball.into_inner().unwrap();
        let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        encoder.write_all(&raw).unwrap();
        let bytes = encoder.finish().unwrap();
        let temp = std::env::temp_dir().join("issh-plugin-test-traversal");
        let _ = std::fs::remove_dir_all(&temp);
        std::fs::create_dir_all(&temp).unwrap();
        assert!(install_tarball(&temp, &bytes).is_err());
        assert!(!temp.join("evil.txt").exists());
        let _ = std::fs::remove_dir_all(&temp);
    }

    #[test]
    fn installs_valid_manifest() {
        let manifest = r#"{
            "id": "issh-plugin-demo",
            "name": "Demo",
            "version": "0.1.0",
            "description": "demo plugin",
            "kind": "feature",
            "permissions": [],
            "entry": "index.js"
        }"#;
        let bytes = sample_tarball(manifest);
        let temp = std::env::temp_dir().join("issh-plugin-test-install");
        let _ = std::fs::remove_dir_all(&temp);
        std::fs::create_dir_all(&temp).unwrap();
        let staging = temp.join("staging");
        std::fs::create_dir_all(&staging).unwrap();
        let result = install_tarball(&staging, &bytes);
        assert!(result.is_ok());
        assert_eq!(result.unwrap().id, "issh-plugin-demo");
        let _ = std::fs::remove_dir_all(&temp);
    }

    #[test]
    fn validates_plugin_id() {
        assert!(is_valid_plugin_id("issh-plugin-vault"));
        assert!(!is_valid_plugin_id("../escape"));
        assert!(!is_valid_plugin_id(""));
        assert!(!is_valid_plugin_id("a/b"));
    }

    fn unsigned_entry() -> PluginRegistryEntry {
        PluginRegistryEntry {
            id: "issh-plugin-x".to_string(),
            name: "x".to_string(),
            version: "0.1.0".to_string(),
            description: String::new(),
            kind: "feature".to_string(),
            permissions: Vec::new(),
            min_app_version: None,
            download_url: String::new(),
            sha256: "abc".to_string(),
            homepage: None,
            repository: None,
            signature: None,
            downloads: None,
        }
    }

    #[test]
    fn unsigned_entry_passes_verification() {
        assert!(verify_entry_signature(&unsigned_entry()).is_ok());
    }

    #[test]
    fn tampered_signature_is_rejected() {
        let mut entry = unsigned_entry();
        // 64 字节全零签名（格式合法但必然验签失败）
        let bogus = [0u8; 64];
        entry.signature = Some(base64::engine::general_purpose::STANDARD.encode(bogus));
        let result = verify_entry_signature(&entry);
        assert!(result.is_err());
    }

    #[test]
    fn malformed_signature_is_rejected() {
        let mut entry = unsigned_entry();
        entry.signature = Some("!!!not-base64!!!".to_string());
        assert!(verify_entry_signature(&entry).is_err());
    }
}
