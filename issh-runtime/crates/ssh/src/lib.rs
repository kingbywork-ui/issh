use russh::client;
use russh::keys::{load_secret_key, PrivateKeyWithHashAlg, PublicKey};
use russh::{ChannelMsg, ChannelWriteHalf, Error as RusshError};
use std::fmt;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::mpsc;

pub const MAX_SSH_HOST_BYTES: usize = 255;
pub const MAX_SSH_USER_BYTES: usize = 128;
pub const MAX_SSH_PASSWORD_BYTES: usize = 4096;
pub const MAX_SSH_FINGERPRINT_BYTES: usize = 128;
pub const MAX_SSH_CHANNEL_BUFFER_MESSAGES: usize = 256;
pub const SSH_INTERACTIVE_TERM: &str = "xterm-256color";

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

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SshOutputKind {
    Stdout,
    Stderr,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SshOutputChunk {
    pub kind: SshOutputKind,
    pub data: Vec<u8>,
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
    handle: Arc<tokio::sync::Mutex<client::Handle<HostKeyHandler>>>,
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
        Ok(Self {
            handle: Arc::new(tokio::sync::Mutex::new(handle)),
        })
    }

    pub async fn open_interactive(
        &self,
        columns: u16,
        rows: u16,
    ) -> Result<SshInteractiveChannel, SshError> {
        validate_dimensions(columns, rows)?;
        let channel = self
            .handle
            .lock()
            .await
            .channel_open_session()
            .await
            .map_err(|error| SshError::Channel(error.to_string()))?;
        channel
            .request_pty(
                true,
                SSH_INTERACTIVE_TERM,
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
        let (read_half, write_half) = channel.split();
        let writer = SshChannelWriter {
            write_half: Arc::new(tokio::sync::Mutex::new(write_half)),
        };
        let (output_tx, output_rx) = mpsc::channel(MAX_SSH_CHANNEL_BUFFER_MESSAGES);
        tokio::spawn(async move {
            let mut read_half = read_half;
            while let Some(message) = read_half.wait().await {
                match message {
                    ChannelMsg::Data { data } => {
                        if output_tx
                            .send(SshOutputChunk {
                                kind: SshOutputKind::Stdout,
                                data: data.to_vec(),
                            })
                            .await
                            .is_err()
                        {
                            break;
                        }
                    }
                    ChannelMsg::ExtendedData { data, .. } => {
                        if output_tx
                            .send(SshOutputChunk {
                                kind: SshOutputKind::Stderr,
                                data: data.to_vec(),
                            })
                            .await
                            .is_err()
                        {
                            break;
                        }
                    }
                    ChannelMsg::ExitStatus { .. } | ChannelMsg::Eof | ChannelMsg::Close => break,
                    _ => {}
                }
            }
        });
        Ok(SshInteractiveChannel {
            handle: Arc::clone(&self.handle),
            writer,
            output: output_rx,
        })
    }

    pub async fn disconnect(self) -> Result<(), SshError> {
        self.handle
            .lock()
            .await
            .disconnect(russh::Disconnect::ByApplication, "", "English")
            .await
            .map_err(|error| SshError::Transport(error.to_string()))
    }
}

pub struct SshChannelWriter {
    write_half: Arc<tokio::sync::Mutex<ChannelWriteHalf<russh::client::Msg>>>,
}

impl Clone for SshChannelWriter {
    fn clone(&self) -> Self {
        Self {
            write_half: Arc::clone(&self.write_half),
        }
    }
}

impl SshChannelWriter {
    pub async fn write(&self, data: &[u8]) -> Result<(), SshError> {
        if data.is_empty() {
            return Ok(());
        }
        self.write_half
            .lock()
            .await
            .data_bytes(data.to_vec())
            .await
            .map_err(|error| SshError::Channel(error.to_string()))
    }

    pub async fn resize(&self, columns: u16, rows: u16) -> Result<(), SshError> {
        validate_dimensions(columns, rows)?;
        self.write_half
            .lock()
            .await
            .window_change(columns as u32, rows as u32, 0, 0)
            .await
            .map_err(|error| SshError::Channel(error.to_string()))
    }

    pub async fn eof(&self) -> Result<(), SshError> {
        self.write_half
            .lock()
            .await
            .eof()
            .await
            .map_err(|error| SshError::Channel(error.to_string()))
    }

    pub async fn close(&self) -> Result<(), SshError> {
        self.write_half
            .lock()
            .await
            .close()
            .await
            .map_err(|error| SshError::Channel(error.to_string()))
    }
}

pub struct SshInteractiveChannel {
    handle: Arc<tokio::sync::Mutex<client::Handle<HostKeyHandler>>>,
    writer: SshChannelWriter,
    output: mpsc::Receiver<SshOutputChunk>,
}

impl SshInteractiveChannel {
    pub fn writer(&self) -> SshChannelWriter {
        self.writer.clone()
    }

    pub async fn write(&self, data: &[u8]) -> Result<(), SshError> {
        self.writer.write(data).await
    }

    pub async fn resize(&self, columns: u16, rows: u16) -> Result<(), SshError> {
        self.writer.resize(columns, rows).await
    }

    pub async fn read_output(&mut self) -> Option<SshOutputChunk> {
        self.output.recv().await
    }

    pub async fn close(&self) -> Result<(), SshError> {
        let writer = &self.writer;
        let eof = writer.eof().await;
        let close = writer.close().await;
        let _ = self
            .handle
            .lock()
            .await
            .disconnect(russh::Disconnect::ByApplication, "", "English")
            .await;
        eof?;
        close
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

    #[cfg(any(target_os = "windows", target_os = "linux", target_os = "macos"))]
    mod interactive {
        use super::*;
        use russh::server::{self, Auth, Session};
        use std::sync::atomic::{AtomicBool, Ordering};
        use tokio::time::{timeout, Duration};

        #[derive(Clone)]
        struct TestServer {
            pty_requested: Arc<AtomicBool>,
            shell_requested: Arc<AtomicBool>,
        }

        impl server::Handler for TestServer {
            type Error = RusshError;

            async fn auth_password(
                &mut self,
                _user: &str,
                password: &str,
            ) -> Result<Auth, Self::Error> {
                if password == "secret" {
                    Ok(Auth::Accept)
                } else {
                    Ok(Auth::reject())
                }
            }

            async fn channel_open_session(
                &mut self,
                _channel: russh::Channel<russh::server::Msg>,
                reply: russh::server::ChannelOpenHandle,
                _session: &mut Session,
            ) -> Result<(), Self::Error> {
                reply.accept().await;
                Ok(())
            }

            async fn pty_request(
                &mut self,
                channel_id: russh::ChannelId,
                _term: &str,
                _col_width: u32,
                _row_height: u32,
                _pix_width: u32,
                _pix_height: u32,
                _modes: &[(russh::Pty, u32)],
                session: &mut Session,
            ) -> Result<(), Self::Error> {
                self.pty_requested.store(true, Ordering::SeqCst);
                session.channel_success(channel_id)?;
                Ok(())
            }

            async fn shell_request(
                &mut self,
                channel_id: russh::ChannelId,
                session: &mut Session,
            ) -> Result<(), Self::Error> {
                self.shell_requested.store(true, Ordering::SeqCst);
                session.channel_success(channel_id)?;
                session.data(channel_id, b"interactive-ready\r\n".to_vec())?;
                Ok(())
            }
        }

        async fn spawn_test_server(
            port: u16,
        ) -> (
            Arc<russh::keys::PrivateKey>,
            Arc<AtomicBool>,
            Arc<AtomicBool>,
        ) {
            let key = Arc::new(
                russh::keys::PrivateKey::random(&mut rand::rng(), russh::keys::Algorithm::Ed25519)
                    .expect("test key should generate"),
            );
            let pty_requested = Arc::new(AtomicBool::new(false));
            let shell_requested = Arc::new(AtomicBool::new(false));
            let config = Arc::new(server::Config {
                keys: vec![(*key).clone()],
                ..Default::default()
            });
            let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, port))
                .await
                .expect("test server should bind");
            let pty_flag = Arc::clone(&pty_requested);
            let shell_flag = Arc::clone(&shell_requested);
            tokio::spawn(async move {
                loop {
                    let Ok((socket, _)) = listener.accept().await else {
                        break;
                    };
                    let config = Arc::clone(&config);
                    let pty_requested = Arc::clone(&pty_flag);
                    let shell_requested = Arc::clone(&shell_flag);
                    tokio::spawn(async move {
                        let handler = TestServer {
                            pty_requested,
                            shell_requested,
                        };
                        let Ok(session) = server::run_stream(config, socket, handler).await else {
                            return;
                        };
                        let _ = session.await;
                    });
                }
            });
            (key, pty_requested, shell_requested)
        }

        #[tokio::test]
        async fn opens_interactive_channel_with_pty_and_shell() {
            let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0u16))
                .await
                .unwrap();
            let port = listener.local_addr().unwrap().port();
            drop(listener);

            let (key, pty_requested, shell_requested) = spawn_test_server(port).await;
            let fingerprint = key.public_key().fingerprint(Default::default()).to_string();

            let connection = SshConnection::connect(SshConnectionSpec {
                host: "127.0.0.1".to_string(),
                port,
                username: "developer".to_string(),
                password: Some("secret".to_string()),
                private_key_path: None,
                private_key_passphrase: None,
                expected_host_key: fingerprint,
            })
            .await
            .expect("connection should succeed");

            let mut interactive = connection
                .open_interactive(120, 36)
                .await
                .expect("interactive channel should open");

            let chunk = timeout(Duration::from_secs(5), interactive.read_output())
                .await
                .expect("output should arrive")
                .expect("channel should stay open");
            assert_eq!(chunk.kind, SshOutputKind::Stdout);
            assert_eq!(chunk.data, b"interactive-ready\r\n".to_vec());
            assert!(pty_requested.load(Ordering::SeqCst));
            assert!(shell_requested.load(Ordering::SeqCst));

            interactive
                .write(b"echo ok\r\n")
                .await
                .expect("write should succeed");
            interactive.close().await.expect("close should succeed");
        }
    }
}
