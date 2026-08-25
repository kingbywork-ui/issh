//! Vault crate: passphrase-encrypted secret storage compatible with the
//! issh Electron `StoredVault` format (v1 AES-256-CBC, v2 AES-256-GCM, both
//! keyed by PBKDF2-SHA512).

use aes::cipher::{BlockDecryptMut, KeyIvInit};
use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::Engine;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use thiserror::Error;
use zeroize::Zeroizing;

type Aes256CbcDec = cbc::Decryptor<aes::Aes256>;

const PBKDF_ITERATIONS_V1: u32 = 100_000;
const PBKDF_ITERATIONS_V2: u32 = 310_000;
const CRYPT_KEY_LENGTH: usize = 32;
const CRYPT_IV_LENGTH_V2: usize = 12;
const PBKDF_SALT_LENGTH: usize = 8;
const MAX_VAULT_FILE_BYTES: u64 = 4 * 1024 * 1024;
const MAX_VAULT_SECRET_BYTES: usize = 64 * 1024;
const MAX_VAULT_SECRETS: usize = 10_000;

const VAULT_SECRET_TYPE_FILE: &str = "file";

#[derive(Debug, Error)]
pub enum VaultError {
    #[error("vault is locked")]
    Locked,
    #[error("vault is already unlocked")]
    AlreadyUnlocked,
    #[error("incorrect passphrase or corrupted vault")]
    BadPassphrase,
    #[error("unsupported vault format version {0}")]
    UnsupportedVersion(u32),
    #[error("vault file is malformed: {0}")]
    Malformed(String),
    #[error("vault file exceeds {MAX_VAULT_FILE_BYTES} bytes")]
    FileTooLarge,
    #[error("secret {0:?} not found")]
    NotFound(String),
    #[error("secret payload exceeds {MAX_VAULT_SECRET_BYTES} bytes")]
    SecretTooLarge,
    #[error("vault holds too many secrets")]
    TooManySecrets,
    #[error("vault I/O error: {0}")]
    Io(#[from] std::io::Error),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredVault {
    pub version: u32,
    pub contents: String,
    pub key_salt: String,
    pub iv: String,
    pub auth_tag: Option<String>,
    pub key_iterations: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct VaultSecretFileKey {
    pub id: String,
    pub description: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct VaultSecret {
    #[serde(rename = "type")]
    pub secret_type: String,
    pub key: VaultSecretFileKey,
    pub value: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct Vault {
    #[serde(default)]
    pub config: serde_json::Value,
    #[serde(default)]
    pub secrets: Vec<VaultSecret>,
}

fn derive_key(passphrase: &str, salt: &[u8], iterations: u32) -> Zeroizing<[u8; CRYPT_KEY_LENGTH]> {
    let mut key = Zeroizing::new([0u8; CRYPT_KEY_LENGTH]);
    pbkdf2::pbkdf2_hmac::<sha2::Sha512>(passphrase.as_bytes(), salt, iterations, key.as_mut());
    key
}

fn encrypt_vault(vault: &Vault, passphrase: &str) -> StoredVault {
    let mut salt = [0u8; PBKDF_SALT_LENGTH];
    rand::thread_rng().fill_bytes(&mut salt);
    let mut iv = [0u8; CRYPT_IV_LENGTH_V2];
    rand::thread_rng().fill_bytes(&mut iv);
    let key = derive_key(passphrase, &salt, PBKDF_ITERATIONS_V2);

    let plaintext = serde_json::to_vec(vault).expect("vault serialization cannot fail");
    let cipher = Aes256Gcm::new((&*key).into());
    let ciphertext = cipher
        .encrypt(Nonce::from_slice(&iv), Payload::from(plaintext.as_slice()))
        .expect("AES-GCM encryption cannot fail");
    let (encrypted, tag) = ciphertext.split_at(ciphertext.len() - 16);

    StoredVault {
        version: 2,
        contents: base64::engine::general_purpose::STANDARD.encode(encrypted),
        key_salt: hex::encode(salt),
        iv: hex::encode(iv),
        auth_tag: Some(hex::encode(tag)),
        key_iterations: Some(PBKDF_ITERATIONS_V2),
    }
}

fn decrypt_vault(stored: &StoredVault, passphrase: &str) -> Result<Vault, VaultError> {
    let salt = hex::decode(&stored.key_salt)
        .map_err(|error| VaultError::Malformed(format!("keySalt: {error}")))?;
    let iv =
        hex::decode(&stored.iv).map_err(|error| VaultError::Malformed(format!("iv: {error}")))?;
    let encrypted = base64::engine::general_purpose::STANDARD
        .decode(&stored.contents)
        .map_err(|error| VaultError::Malformed(format!("contents: {error}")))?;

    let plaintext = match stored.version {
        1 => {
            let key = derive_key(passphrase, &salt, PBKDF_ITERATIONS_V1);
            if iv.len() != 16 {
                return Err(VaultError::Malformed("v1 iv must be 16 bytes".into()));
            }
            let mut decryptor = Aes256CbcDec::new((&*key).into(), iv.as_slice().into());
            let mut buffer = encrypted;
            if buffer.len() % 16 != 0 || buffer.is_empty() {
                return Err(VaultError::Malformed(
                    "v1 ciphertext length must be a multiple of 16".into(),
                ));
            }
            for chunk in buffer.chunks_mut(16) {
                decryptor.decrypt_block_mut(chunk.into());
            }
            strip_pkcs7(&mut buffer)?;
            buffer
        }
        2 => {
            let auth_tag = stored
                .auth_tag
                .as_ref()
                .ok_or(VaultError::UnsupportedVersion(2))?;
            let tag = hex::decode(auth_tag)
                .map_err(|error| VaultError::Malformed(format!("authTag: {error}")))?;
            if iv.len() != CRYPT_IV_LENGTH_V2 {
                return Err(VaultError::Malformed("v2 iv must be 12 bytes".into()));
            }
            let iterations = stored.key_iterations.unwrap_or(PBKDF_ITERATIONS_V2);
            let key = derive_key(passphrase, &salt, iterations);
            let mut ciphertext = encrypted;
            ciphertext.extend_from_slice(&tag);
            let cipher = Aes256Gcm::new((&*key).into());
            cipher
                .decrypt(Nonce::from_slice(&iv), ciphertext.as_slice())
                .map_err(|_| VaultError::BadPassphrase)?
        }
        version => return Err(VaultError::UnsupportedVersion(version)),
    };

    serde_json::from_slice(&plaintext)
        .map_err(|error| VaultError::Malformed(format!("vault JSON: {error}")))
}

fn strip_pkcs7(buffer: &mut Vec<u8>) -> Result<(), VaultError> {
    let Some(&padding) = buffer.last() else {
        return Err(VaultError::Malformed("v1 ciphertext is empty".into()));
    };
    if padding == 0 || padding as usize > 16 || buffer.len() < padding as usize {
        return Err(VaultError::BadPassphrase);
    }
    let new_len = buffer.len() - padding as usize;
    buffer.truncate(new_len);
    Ok(())
}

/// Encrypts a fresh vault payload with PKCS7 padding for v1 compatibility tests.
#[cfg(test)]
fn encrypt_vault_v1(vault: &Vault, passphrase: &str) -> StoredVault {
    use aes::cipher::BlockEncryptMut;

    type Aes256CbcEnc = cbc::Encryptor<aes::Aes256>;
    let mut salt = [0u8; PBKDF_SALT_LENGTH];
    rand::thread_rng().fill_bytes(&mut salt);
    let mut iv = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut iv);
    let key = derive_key(passphrase, &salt, PBKDF_ITERATIONS_V1);

    let mut plaintext = serde_json::to_vec(vault).expect("vault serialization cannot fail");
    let padding = 16 - (plaintext.len() % 16);
    plaintext.extend(std::iter::repeat_n(padding as u8, padding));

    let mut buffer = plaintext;
    let mut encryptor = Aes256CbcEnc::new((&*key).into(), iv.as_slice().into());
    for chunk in buffer.chunks_mut(16) {
        encryptor.encrypt_block_mut(chunk.into());
    }

    StoredVault {
        version: 1,
        contents: base64::engine::general_purpose::STANDARD.encode(&buffer),
        key_salt: hex::encode(salt),
        iv: hex::encode(iv),
        auth_tag: None,
        key_iterations: None,
    }
}

pub struct VaultStore {
    path: PathBuf,
    stored: Option<StoredVault>,
    passphrase: Option<Zeroizing<String>>,
    cached: Option<Vault>,
}

impl VaultStore {
    pub fn open(path: impl AsRef<Path>) -> Result<Self, VaultError> {
        let path = path.as_ref().to_path_buf();
        if !path.exists() {
            return Ok(Self {
                path,
                stored: None,
                passphrase: None,
                cached: None,
            });
        }
        let metadata = std::fs::metadata(&path)?;
        if metadata.len() > MAX_VAULT_FILE_BYTES {
            return Err(VaultError::FileTooLarge);
        }
        let raw = std::fs::read_to_string(&path)?;
        let stored: StoredVault = serde_json::from_str(&raw)
            .map_err(|error| VaultError::Malformed(format!("vault file: {error}")))?;
        Ok(Self {
            path,
            stored: Some(stored),
            passphrase: None,
            cached: None,
        })
    }

    pub fn is_enabled(&self) -> bool {
        self.stored.is_some()
    }

    pub fn is_unlocked(&self) -> bool {
        self.passphrase.is_some() && self.cached.is_some()
    }

    pub fn unlock(&mut self, passphrase: &str) -> Result<Vault, VaultError> {
        let stored = self.stored.as_ref().ok_or(VaultError::Locked)?;
        let vault = decrypt_vault(stored, passphrase)?;
        self.passphrase = Some(Zeroizing::new(passphrase.to_string()));
        self.cached = Some(vault.clone());
        Ok(vault)
    }

    pub fn lock(&mut self) {
        self.passphrase = None;
        self.cached = None;
    }

    pub fn create(&mut self, passphrase: &str) -> Result<Vault, VaultError> {
        if self.stored.is_some() {
            return Err(VaultError::Malformed("vault already exists".into()));
        }
        let vault = Vault::default();
        self.passphrase = Some(Zeroizing::new(passphrase.to_string()));
        self.cached = Some(vault.clone());
        self.stored = Some(encrypt_vault(&vault, passphrase));
        self.persist()?;
        Ok(vault)
    }

    pub fn set_enabled(
        &mut self,
        enabled: bool,
        passphrase: Option<&str>,
    ) -> Result<(), VaultError> {
        if enabled {
            if self.stored.is_none() {
                match passphrase {
                    Some(passphrase) => {
                        self.create(passphrase)?;
                    }
                    None => return Err(VaultError::Locked),
                }
            }
        } else {
            self.stored = None;
            self.lock();
            let _ = std::fs::remove_file(&self.path);
        }
        Ok(())
    }

    pub fn vault(&self) -> Result<&Vault, VaultError> {
        self.cached.as_ref().ok_or(VaultError::Locked)
    }

    pub fn list_secrets(&self) -> Result<Vec<VaultSecretFileKey>, VaultError> {
        let vault = self.vault()?;
        Ok(vault
            .secrets
            .iter()
            .filter(|secret| secret.secret_type == VAULT_SECRET_TYPE_FILE)
            .map(|secret| secret.key.clone())
            .collect())
    }

    pub fn get_secret(&self, id: &str) -> Result<VaultSecret, VaultError> {
        let vault = self.vault()?;
        vault
            .secrets
            .iter()
            .find(|secret| secret.secret_type == VAULT_SECRET_TYPE_FILE && secret.key.id == id)
            .cloned()
            .ok_or_else(|| VaultError::NotFound(id.to_string()))
    }

    pub fn put_secret(
        &mut self,
        id: &str,
        description: &str,
        value: &str,
    ) -> Result<(), VaultError> {
        if value.len() > MAX_VAULT_SECRET_BYTES {
            return Err(VaultError::SecretTooLarge);
        }
        let passphrase = self.passphrase.as_ref().ok_or(VaultError::Locked)?.clone();
        {
            let vault = self.cached.as_mut().ok_or(VaultError::Locked)?;
            if vault.secrets.len() >= MAX_VAULT_SECRETS {
                return Err(VaultError::TooManySecrets);
            }
            let secret = VaultSecret {
                secret_type: VAULT_SECRET_TYPE_FILE.to_string(),
                key: VaultSecretFileKey {
                    id: id.to_string(),
                    description: description.to_string(),
                },
                value: value.to_string(),
            };
            match vault
                .secrets
                .iter()
                .position(|existing| existing.key.id == id)
            {
                Some(index) => vault.secrets[index] = secret,
                None => vault.secrets.push(secret),
            }
        }
        self.stored = Some(encrypt_vault(self.cached.as_ref().unwrap(), &passphrase));
        self.persist()
    }

    pub fn delete_secret(&mut self, id: &str) -> Result<(), VaultError> {
        let passphrase = self.passphrase.as_ref().ok_or(VaultError::Locked)?.clone();
        {
            let vault = self.cached.as_mut().ok_or(VaultError::Locked)?;
            let before = vault.secrets.len();
            vault.secrets.retain(|secret| secret.key.id != id);
            if vault.secrets.len() == before {
                return Err(VaultError::NotFound(id.to_string()));
            }
        }
        self.stored = Some(encrypt_vault(self.cached.as_ref().unwrap(), &passphrase));
        self.persist()
    }

    fn persist(&self) -> Result<(), VaultError> {
        let stored = self.stored.as_ref().ok_or(VaultError::Locked)?;
        let payload = serde_json::to_vec_pretty(stored).expect("vault serialization cannot fail");
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(&self.path, payload)?;
        Ok(())
    }
}

/// Resolves SSH credentials for a host by checking the vault first, then
/// falling back to inline values. Returns `(username, password)`.
pub fn resolve_ssh_credentials(
    vault: &VaultStore,
    vault_secret_id: Option<&str>,
    inline_username: Option<String>,
    inline_password: Option<String>,
) -> Result<(Option<String>, Option<String>), VaultError> {
    if let Some(id) = vault_secret_id {
        if vault.is_unlocked() {
            let secret = vault.get_secret(id)?;
            return Ok((Some(secret.key.id), Some(secret.value)));
        }
    }
    Ok((inline_username, inline_password))
}

/// In-memory snapshot of vault secret descriptors safe to send over RPC.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct VaultStatus {
    pub enabled: bool,
    pub unlocked: bool,
    pub secret_count: usize,
}

impl VaultStore {
    pub fn status(&self) -> VaultStatus {
        VaultStatus {
            enabled: self.stored.is_some(),
            unlocked: self.is_unlocked(),
            secret_count: self.vault().map(|vault| vault.secrets.len()).unwrap_or(0),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_vault() -> Vault {
        Vault {
            config: serde_json::json!({ "autofill": true }),
            secrets: vec![VaultSecret {
                secret_type: "file".to_string(),
                key: VaultSecretFileKey {
                    id: "ssh:prod-host".to_string(),
                    description: "Production host".to_string(),
                },
                value: "hunter2".to_string(),
            }],
        }
    }

    #[test]
    fn roundtrip_v2() {
        let vault = sample_vault();
        let stored = encrypt_vault(&vault, "correct horse");
        assert_eq!(stored.version, 2);
        assert!(stored.auth_tag.is_some());
        let decrypted = decrypt_vault(&stored, "correct horse").expect("decrypt should succeed");
        assert_eq!(decrypted, vault);
    }

    #[test]
    fn roundtrip_v1() {
        let vault = sample_vault();
        let stored = encrypt_vault_v1(&vault, "correct horse");
        assert_eq!(stored.version, 1);
        let decrypted = decrypt_vault(&stored, "correct horse").expect("decrypt should succeed");
        assert_eq!(decrypted, vault);
    }

    #[test]
    fn wrong_passphrase_rejected() {
        let stored = encrypt_vault(&sample_vault(), "right");
        assert!(matches!(
            decrypt_vault(&stored, "wrong"),
            Err(VaultError::BadPassphrase)
        ));
    }

    #[test]
    fn unsupported_version_rejected() {
        let mut stored = encrypt_vault(&sample_vault(), "right");
        stored.version = 9;
        assert!(matches!(
            decrypt_vault(&stored, "right"),
            Err(VaultError::UnsupportedVersion(9))
        ));
    }

    #[test]
    fn store_lifecycle() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("vault.json");
        let mut store = VaultStore::open(&path).expect("open should succeed");
        assert!(!store.is_enabled());

        store.create("pass").expect("create should succeed");
        assert!(store.is_enabled());
        assert!(store.is_unlocked());

        store
            .put_secret("ssh:web", "Web server", "secret1")
            .expect("put should succeed");
        let secret = store.get_secret("ssh:web").expect("get should succeed");
        assert_eq!(secret.value, "secret1");

        store.lock();
        assert!(!store.is_unlocked());
        assert!(matches!(
            store.get_secret("ssh:web"),
            Err(VaultError::Locked)
        ));

        store.unlock("pass").expect("unlock should succeed");
        let secret = store
            .get_secret("ssh:web")
            .expect("get should survive reload");
        assert_eq!(secret.value, "secret1");

        let reopened = VaultStore::open(&path).expect("reopen should succeed");
        assert!(reopened.is_enabled());
        assert!(!reopened.is_unlocked());
    }

    #[test]
    fn delete_missing_secret_fails() {
        let dir = tempfile::tempdir().expect("tempdir");
        let mut store =
            VaultStore::open(dir.path().join("vault.json")).expect("open should succeed");
        store.create("pass").expect("create should succeed");
        assert!(matches!(
            store.delete_secret("nope"),
            Err(VaultError::NotFound(_))
        ));
    }

    #[test]
    fn resolve_credentials_prefers_vault() {
        let dir = tempfile::tempdir().expect("tempdir");
        let mut store =
            VaultStore::open(dir.path().join("vault.json")).expect("open should succeed");
        store.create("pass").expect("create should succeed");
        store
            .put_secret("ssh:prod", "Prod", "vault-pass")
            .expect("put should succeed");

        let (username, password) = resolve_ssh_credentials(
            &store,
            Some("ssh:prod"),
            Some("inline-user".to_string()),
            Some("inline-pass".to_string()),
        )
        .expect("resolve should succeed");
        assert_eq!(username.as_deref(), Some("ssh:prod"));
        assert_eq!(password.as_deref(), Some("vault-pass"));

        let (username, password) =
            resolve_ssh_credentials(&store, None, Some("u".to_string()), Some("p".to_string()))
                .expect("inline fallback should succeed");
        assert_eq!(username.as_deref(), Some("u"));
        assert_eq!(password.as_deref(), Some("p"));
    }
}
