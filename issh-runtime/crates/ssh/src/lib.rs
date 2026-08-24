use russh::client;
use russh::keys::{load_secret_key, PrivateKeyWithHashAlg, PublicKey};
use russh::{Channel, Error as RusshError};
use std::fmt;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

pub const MAX_SSH_HOST_BYTES: usize = 255;
pub const MAX_SSH_USER_BYTES: usize = 128;
pub const MAX_SSH_PASSWORD_BYTES: usize = 4096;
pub const MAX_SSH_FINGERPRINT_BYTES: usize = 128;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SshConnectionSpec {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub password: Option<String>,
    pub private_key_path: Option<PathBuf>,
    pub private_key_passphrase: Option<String>,
    pub expected_host_key: String,
}

#[derive(Debug)]
pub enum SshError {
    InvalidHost,
    InvalidPort,
    InvalidUsername,
    MissingHostKey,
    InvalidHostKey,
    MissingAuthentication,
    HostKeyRejected(String),
    AuthenticationFailed,
    Key(String),
    Transport(String),
    Channel(String),
}

impl fmt::Display for SshError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidHost => {
                formatter.write_str("SSH host is required and must be <= 255 bytes")
            }
            Self::InvalidPort => formatter.write_str("SSH port must be between 1 and 65535"),
            Self::InvalidUsername => {
                formatter.write_str("SSH username is required and must be <= 128 bytes")
            }
            Self::MissingHostKey => formatter.write_str("SSH host-key fingerprint is required"),
            Self::InvalidHostKey => formatter.write_str("SSH host-key fingerprint is invalid"),
            Self::MissingAuthentication => {
                formatter.write_str("SSH password or private key is required")
            }
            Self::HostKeyRejected(fingerprint) => {
                write!(formatter, "SSH host key rejected: {fingerprint}")
            }
            Self::AuthenticationFailed => formatter.write_str("SSH authentication failed"),
            Self::Key(message) => write!(formatter, "SSH private key error: {message}"),
            Self::Transport(message) => write!(formatter, "SSH transport error: {message}"),
            Self::Channel(message) => write!(formatter, "SSH channel error: {message}"),
        }
    }
}

impl std::error::Error for SshError {}

impl From<RusshError> for SshError {
    fn from(error: RusshError) -> Self {
        Self::Transport(error.to_string())
    }
}

#[derive(Clone)]
struct HostKeyHandler {
    expected_host_key: String,
}

impl client::Handler for HostKeyHandler {
    type Error = RusshError;

    async fn check_server_key(
        &mut self,
        server_public_key: &PublicKey,
    ) -> Result<bool, Self::Error> {
        let fingerprint = server_public_key
            .fingerprint(Default::default())
            .to_string();
        Ok(fingerprint == self.expected_host_key)
    }
}

pub struct SshConnection {
    handle: client::Handle<HostKeyHandler>,
}

impl SshConnection {
    pub async fn connect(spec: SshConnectionSpec) -> Result<Self, SshError> {
        validate_spec(&spec)?;
        let handler = HostKeyHandler {
            expected_host_key: spec.expected_host_key.trim().to_string(),
        };
        let config = client::Config {
            inactivity_timeout: Some(Duration::from_secs(60)),
            ..Default::default()
        };
        let mut handle =
            client::connect(Arc::new(config), (spec.host.as_str(), spec.port), handler)
                .await
                .map_err(|error| match error {
                    RusshError::UnknownKey => SshError::HostKeyRejected(spec.expected_host_key),
                    other => SshError::Transport(other.to_string()),
                })?;

        let mut authenticated = false;
        if let Some(path) = spec.private_key_path {
            let key = load_secret_key(path, spec.private_key_passphrase.as_deref())
                .map_err(|error| SshError::Key(error.to_string()))?;
            let hash = handle
                .best_supported_rsa_hash()
                .await
                .map_err(|error| SshError::Transport(error.to_string()))?
                .flatten();
            let result = handle
                .authenticate_publickey(
                    spec.username.clone(),
                    PrivateKeyWithHashAlg::new(Arc::new(key), hash),
                )
                .await
                .map_err(|error| SshError::Transport(error.to_string()))?;
            authenticated = result.success();
        }
        if !authenticated {
            if let Some(password) = spec.password {
                let result = handle
                    .authenticate_password(spec.username, password)
                    .await
                    .map_err(|error| SshError::Transport(error.to_string()))?;
                authenticated = result.success();
            }
        }
        if !authenticated {
            return Err(SshError::AuthenticationFailed);
        }
        Ok(Self { handle })
    }

    pub async fn open_shell(
        &mut self,
        columns: u16,
        rows: u16,
    ) -> Result<Channel<russh::client::Msg>, SshError> {
        validate_dimensions(columns, rows)?;
        let channel = self
            .handle
            .channel_open_session()
            .await
            .map_err(|error| SshError::Channel(error.to_string()))?;
        channel
            .request_pty(
                true,
                "xterm-256color",
                columns as u32,
                rows as u32,
                0,
                0,
                &[],
            )
            .await
            .map_err(|error| SshError::Channel(error.to_string()))?;
        channel
            .request_shell(true)
            .await
            .map_err(|error| SshError::Channel(error.to_string()))?;
        Ok(channel)
    }

    pub async fn disconnect(self) -> Result<(), SshError> {
        self.handle
            .disconnect(russh::Disconnect::ByApplication, "", "English")
            .await
            .map_err(|error| SshError::Transport(error.to_string()))
    }
}

fn validate_spec(spec: &SshConnectionSpec) -> Result<(), SshError> {
    if spec.host.trim().is_empty() || spec.host.len() > MAX_SSH_HOST_BYTES {
        return Err(SshError::InvalidHost);
    }
    if spec.port == 0 {
        return Err(SshError::InvalidPort);
    }
    if spec.username.trim().is_empty() || spec.username.len() > MAX_SSH_USER_BYTES {
        return Err(SshError::InvalidUsername);
    }
    if spec.expected_host_key.trim().is_empty()
        || spec.expected_host_key.len() > MAX_SSH_FINGERPRINT_BYTES
        || !spec.expected_host_key.starts_with("SHA256:")
    {
        return if spec.expected_host_key.trim().is_empty() {
            Err(SshError::MissingHostKey)
        } else {
            Err(SshError::InvalidHostKey)
        };
    }
    if spec.password.is_none() && spec.private_key_path.is_none() {
        return Err(SshError::MissingAuthentication);
    }
    if spec
        .password
        .as_ref()
        .is_some_and(|password| password.len() > MAX_SSH_PASSWORD_BYTES)
    {
        return Err(SshError::MissingAuthentication);
    }
    Ok(())
}

fn validate_dimensions(columns: u16, rows: u16) -> Result<(), SshError> {
    if columns == 0 || rows == 0 || columns > 1_000 || rows > 1_000 {
        Err(SshError::Channel(
            "SSH PTY dimensions must be 1-1000".to_string(),
        ))
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec() -> SshConnectionSpec {
        SshConnectionSpec {
            host: "example.test".to_string(),
            port: 22,
            username: "developer".to_string(),
            password: Some("secret".to_string()),
            private_key_path: None,
            private_key_passphrase: None,
            expected_host_key: "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA".to_string(),
        }
    }

    #[test]
    fn rejects_missing_host_key_and_authentication() {
        let mut value = spec();
        value.expected_host_key.clear();
        assert!(matches!(
            validate_spec(&value),
            Err(SshError::MissingHostKey)
        ));
        let mut value = spec();
        value.password = None;
        assert!(!matches!(validate_spec(&value), Ok(())));
    }

    #[test]
    fn validates_host_key_shape_and_dimensions() {
        let mut value = spec();
        value.expected_host_key = "ssh-ed25519 AAAA".to_string();
        assert!(matches!(
            validate_spec(&value),
            Err(SshError::InvalidHostKey)
        ));
        assert!(validate_dimensions(120, 36).is_ok());
        assert!(validate_dimensions(0, 36).is_err());
    }
}
