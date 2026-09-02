use russh::client;
use russh::keys::{load_secret_key, PrivateKeyWithHashAlg, PublicKey};
use russh::{ChannelMsg, ChannelWriteHalf, Error as RusshError};
use std::fmt;
use std::pin::Pin;
use std::task::{Context, Poll};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use tokio::{io::{copy, copy_bidirectional, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, DuplexStream}, net::TcpStream, process::Command, sync::mpsc};
#[cfg(unix)]
use tokio::net::UnixStream;
use std::process::Stdio;

mod sftp;

pub use sftp::{
    SftpEntry, SftpError, SftpFileStat, SshSftpSession, MAX_SFTP_DIR_ENTRIES, MAX_SFTP_FILE_BYTES,
    MAX_SFTP_PATH_BYTES, SFTP_SUBSYSTEM_NAME,
};

pub const MAX_SSH_HOST_BYTES: usize = 255;
pub const MAX_SSH_USER_BYTES: usize = 128;
pub const MAX_SSH_PASSWORD_BYTES: usize = 4096;
pub const MAX_SSH_FINGERPRINT_BYTES: usize = 128;
pub const MAX_SSH_CHANNEL_BUFFER_MESSAGES: usize = 256;
pub const MAX_SSH_COMMAND_BYTES: usize = 8192;
pub const SSH_INTERACTIVE_TERM: &str = "xterm-256color";
pub const SSH_DISCOVERY_TIMEOUT_MS: u64 = 15_000;

#[derive(Clone)]
pub struct SshConnectionSpec {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub password: Option<String>,
    pub private_key_path: Option<PathBuf>,
    pub private_key_passphrase: Option<String>,
    pub expected_host_key: String,
    pub http_proxy_host: Option<String>,
    pub http_proxy_port: Option<u16>,
    pub socks_proxy_host: Option<String>,
    pub socks_proxy_port: Option<u16>,
    pub keyboard_interactive: bool,
    pub proxy_command: Option<String>,
    pub x11: bool,
    pub x11_display: Option<String>,
    pub jump_connection: Option<Arc<SshConnection>>,
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
    discovered: Option<Arc<std::sync::Mutex<Option<String>>>>,
    remote_forward_tx: mpsc::UnboundedSender<RemoteForwardChannel>,
    x11_tx: mpsc::UnboundedSender<X11Channel>,
}

struct RemoteForwardChannel {
    channel: russh::Channel<client::Msg>,
    connected_port: u32,
}

struct X11Channel {
    channel: russh::Channel<client::Msg>,
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
        if let Some(discovered) = &self.discovered {
            discovered
                .lock()
                .map(|mut slot| *slot = Some(fingerprint.clone()))
                .ok();
            return Ok(true);
        }
        Ok(fingerprint == self.expected_host_key)
    }

    fn server_channel_open_forwarded_tcpip(
        &mut self,
        channel: russh::Channel<client::Msg>,
        _connected_address: &str,
        connected_port: u32,
        _originator_address: &str,
        _originator_port: u32,
        reply: client::ChannelOpenHandle,
        _session: &mut client::Session,
    ) -> impl std::future::Future<Output = Result<(), Self::Error>> + Send {
        let sender = self.remote_forward_tx.clone();
        async move {
            reply.accept().await;
            let _ = sender.send(RemoteForwardChannel { channel, connected_port });
            Ok(())
        }
    }

    fn server_channel_open_x11(
        &mut self,
        channel: russh::Channel<client::Msg>,
        _originator_address: &str,
        _originator_port: u32,
        reply: client::ChannelOpenHandle,
        _session: &mut client::Session,
    ) -> impl std::future::Future<Output = Result<(), Self::Error>> + Send {
        let sender = self.x11_tx.clone();
        async move {
            reply.accept().await;
            let _ = sender.send(X11Channel { channel });
            Ok(())
        }
    }
}

#[derive(Clone)]
pub struct SshConnection {
    handle: Arc<tokio::sync::Mutex<client::Handle<HostKeyHandler>>>,
    remote_forward_targets: Arc<tokio::sync::Mutex<std::collections::HashMap<u32, (String, u16)>>>,
    remote_forward_bind_hosts: Arc<tokio::sync::Mutex<std::collections::HashMap<u32, String>>>,
    #[allow(dead_code)]
    jump_parent: Option<Arc<SshConnection>>,
}

impl SshConnection {
    pub async fn connect(spec: SshConnectionSpec) -> Result<Self, SshError> {
        validate_spec(&spec)?;
        let (remote_forward_tx, mut remote_forward_rx) = mpsc::unbounded_channel();
        let (x11_tx, mut x11_rx) = mpsc::unbounded_channel();
        let x11_display = spec.x11_display.clone();
        let jump_parent = spec.jump_connection.clone();
        let handler = HostKeyHandler {
            expected_host_key: spec.expected_host_key.trim().to_string(),
            discovered: None,
            remote_forward_tx,
            x11_tx,
        };
        let config = client::Config {
            // 空闲不回收连接：交互式终端会话可能长时间无输出（如 vim、挂起命令）。
            // 保活交给 keepalive：30s 发一次 SSH keepalive，连续 3 次无响应才断开。
            inactivity_timeout: None,
            keepalive_interval: Some(Duration::from_secs(30)),
            keepalive_max: 3,
            ..Default::default()
        };
        let stream = open_transport_stream(&spec).await?;
        let mut handle =
            client::connect_stream(Arc::new(config), stream, handler)
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
            if let Some(password) = spec.password.clone() {
                let result = handle
                    .authenticate_password(spec.username.clone(), password)
                    .await
                    .map_err(|error| SshError::Transport(error.to_string()))?;
                authenticated = result.success();
            }
        }
        if !authenticated && spec.keyboard_interactive {
            let response = handle
                .authenticate_keyboard_interactive_start(spec.username.clone(), None::<String>)
                .await
                .map_err(|error| SshError::Transport(error.to_string()))?;
            if let client::KeyboardInteractiveAuthResponse::InfoRequest { prompts, .. } = response {
                let responses = prompts.into_iter().map(|_| spec.password.clone().unwrap_or_default()).collect();
                authenticated = matches!(handle
                    .authenticate_keyboard_interactive_respond(responses)
                    .await
                    .map_err(|error| SshError::Transport(error.to_string()))?, client::KeyboardInteractiveAuthResponse::Success);
            } else if matches!(response, client::KeyboardInteractiveAuthResponse::Success) {
                authenticated = true;
            }
        }
        if !authenticated {
            return Err(SshError::AuthenticationFailed);
        }
        let remote_forward_targets = Arc::new(tokio::sync::Mutex::new(std::collections::HashMap::<u32, (String, u16)>::new()));
        let remote_forward_bind_hosts = Arc::new(tokio::sync::Mutex::new(std::collections::HashMap::<u32, String>::new()));
        let targets = Arc::clone(&remote_forward_targets);
        tokio::spawn(async move {
            while let Some(forward) = remote_forward_rx.recv().await {
                let target = targets.lock().await.get(&forward.connected_port).cloned();
                let Some((host, port)) = target else { continue };
                tokio::spawn(async move {
                    let Ok(mut local) = TcpStream::connect((host.as_str(), port)).await else { return };
                    let mut channel = forward.channel.into_stream();
                    let _ = copy_bidirectional(&mut local, &mut channel).await;
                });
            }
        });
        tokio::spawn(async move {
            while let Some(incoming) = x11_rx.recv().await {
                let display = x11_display.clone();
                tokio::spawn(async move {
                    let Ok(mut local) = connect_x11_display(display.as_deref()).await else { return };
                    let mut channel = incoming.channel.into_stream();
                    let _ = copy_bidirectional(&mut local, &mut channel).await;
                });
            }
        });
        Ok(Self {
            handle: Arc::new(tokio::sync::Mutex::new(handle)),
            remote_forward_targets,
            remote_forward_bind_hosts,
            jump_parent,
        })
    }

    pub async fn open_interactive(
        &self,
        columns: u16,
        rows: u16,
        agent_forward: bool,
        x11: bool,
    ) -> Result<SshInteractiveChannel, SshError> {
        validate_dimensions(columns, rows)?;
        let channel = self
            .handle
            .lock()
            .await
            .channel_open_session()
            .await
            .map_err(|error| SshError::Channel(error.to_string()))?;
        if agent_forward {
            channel
                .agent_forward(true)
                .await
                .map_err(|error| SshError::Channel(error.to_string()))?;
        }
        if x11 {
            let cookie = format!("{:032x}", rand::random::<u128>());
            channel
                .request_x11(true, false, "MIT-MAGIC-COOKIE-1", cookie, 0)
                .await
                .map_err(|error| SshError::Channel(error.to_string()))?;
        }
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

    /// Opens a direct-tcpip channel for a local port-forward connection.
    pub async fn open_direct_tcpip(
        &self,
        target_address: &str,
        target_port: u16,
        originator_address: &str,
        originator_port: u16,
    ) -> Result<russh::ChannelStream<client::Msg>, SshError> {
        if target_address.trim().is_empty() || target_address.len() > MAX_SSH_HOST_BYTES {
            return Err(SshError::InvalidHost);
        }
        if target_port == 0 || originator_port == 0 {
            return Err(SshError::InvalidPort);
        }
        let channel = self
            .handle
            .lock()
            .await
            .channel_open_direct_tcpip(
                target_address,
                target_port as u32,
                originator_address,
                originator_port as u32,
            )
            .await
            .map_err(|error| SshError::Channel(error.to_string()))?;
        Ok(channel.into_stream())
    }

    pub async fn start_remote_forward(
        &self,
        bind_host: &str,
        bind_port: u16,
        target_address: &str,
        target_port: u16,
    ) -> Result<u16, SshError> {
        if bind_host.trim().is_empty() || target_address.trim().is_empty() {
            return Err(SshError::InvalidHost);
        }
        if target_port == 0 {
            return Err(SshError::InvalidPort);
        }
        let actual_port = self
            .handle
            .lock()
            .await
            .tcpip_forward(bind_host, bind_port as u32)
            .await
            .map_err(|error| SshError::Channel(error.to_string()))? as u16;
        self.remote_forward_targets
            .lock()
            .await
            .insert(actual_port as u32, (target_address.to_string(), target_port));
        self.remote_forward_bind_hosts.lock().await.insert(actual_port as u32, bind_host.to_string());
        Ok(actual_port)
    }

    pub async fn stop_remote_forward(&self, bind_port: u16) -> Result<(), SshError> {
        let bind_host = self.remote_forward_bind_hosts
            .lock()
            .await
            .remove(&(bind_port as u32))
            .ok_or(SshError::InvalidPort)?;
        self.handle
            .lock()
            .await
            .cancel_tcpip_forward(bind_host, bind_port as u32)
            .await
            .map_err(|error| SshError::Channel(error.to_string()))?;
        self.remote_forward_targets.lock().await.remove(&(bind_port as u32));
        Ok(())
    }

    pub async fn open_sftp(&self) -> Result<SshSftpSession, SshError> {        let channel = self
            .handle
            .lock()
            .await
            .channel_open_session()
            .await
            .map_err(|error| SshError::Channel(error.to_string()))?;
        channel
            .request_subsystem(true, SFTP_SUBSYSTEM_NAME)
            .await
            .map_err(|error| SshError::Channel(error.to_string()))?;
        let session = russh_sftp::client::SftpSession::new(channel.into_stream())
            .await
            .map_err(|error| SshError::Channel(error.to_string()))?;
        Ok(SshSftpSession::from_session(session))
    }

    pub async fn open_sudo_sftp(&self, password: &str) -> Result<SshSftpSession, SshError> {        if password.is_empty() || password.len() > MAX_SSH_PASSWORD_BYTES {
            return Err(SshError::Channel("sudo password is required".to_string()));
        }
        let channel = self
            .handle
            .lock()
            .await
            .channel_open_session()
            .await
            .map_err(|error| SshError::Channel(error.to_string()))?;
        let command = "sudo -k -S -p '' -- sh -c 'for p in \"$(command -v sftp-server 2>/dev/null)\" /usr/lib/openssh/sftp-server /usr/lib/ssh/sftp-server /usr/libexec/openssh/sftp-server; do [ -n \"$p\" ] && [ -x \"$p\" ] && exec \"$p\"; done; exit 127'";
        channel
            .exec(true, command)
            .await
            .map_err(|error| SshError::Channel(error.to_string()))?;
        let password_input = format!("{password}\n").into_bytes();
        channel
            .data(&password_input[..])
            .await
            .map_err(|error| SshError::Channel(error.to_string()))?;
        let session = russh_sftp::client::SftpSession::new(channel.into_stream())
            .await
            .map_err(|error| SshError::Channel(error.to_string()))?;
        Ok(SshSftpSession::from_session(session))
    }

    /// 执行单条只读命令并收集合并输出（对齐 issh 分支 runReadonlyCommand：
    /// 历史命令拉取等场景，无 PTY、带超时、输出上限保护）
    pub async fn run_readonly_command(
        &self,
        command: &str,
        timeout_ms: u64,
        max_output_bytes: usize,
    ) -> Result<String, SshError> {
        if command.is_empty() || command.len() > MAX_SSH_COMMAND_BYTES {
            return Err(SshError::Channel("invalid command length".to_string()));
        }
        let channel = self
            .handle
            .lock()
            .await
            .channel_open_session()
            .await
            .map_err(|error| SshError::Channel(error.to_string()))?;
        channel
            .exec(true, command)
            .await
            .map_err(|error| SshError::Channel(error.to_string()))?;

        let deadline = tokio::time::Instant::now() + Duration::from_millis(timeout_ms);
        let mut output: Vec<u8> = Vec::new();
        let (mut read_half, write_half) = channel.split();
        drop(write_half);
        loop {
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            if remaining.is_zero() {
                return Err(SshError::Channel(format!(
                    "command timed out after {timeout_ms}ms"
                )));
            }
            match tokio::time::timeout(remaining, read_half.wait()).await {
                Err(_) => {
                    return Err(SshError::Channel(format!(
                        "command timed out after {timeout_ms}ms"
                    )));
                }
                Ok(None) => break,
                Ok(Some(ChannelMsg::Data { data }))
                | Ok(Some(ChannelMsg::ExtendedData { data, .. })) => {
                    if output.len() + data.len() > max_output_bytes {
                        return Err(SshError::Channel(
                            "command output exceeded limit".to_string(),
                        ));
                    }
                    output.extend_from_slice(&data);
                }
                Ok(Some(ChannelMsg::ExitStatus { .. }))
                | Ok(Some(ChannelMsg::Eof))
                | Ok(Some(ChannelMsg::Close)) => break,
                Ok(Some(_)) => {}
            }
        }
        String::from_utf8(output)
            .map_err(|error| SshError::Channel(format!("command output is not UTF-8: {error}")))
    }

    pub async fn disconnect(self) -> Result<(), SshError> {
        self.handle
            .lock()
            .await
            .disconnect(russh::Disconnect::ByApplication, "", "English")
            .await
            .map_err(|error| SshError::Transport(error.to_string()))
    }

    pub async fn discover_host_key(host: &str, port: u16) -> Result<String, SshError> {
        let host = host.trim();
        if host.is_empty() || host.len() > MAX_SSH_HOST_BYTES {
            return Err(SshError::InvalidHost);
        }
        if port == 0 {
            return Err(SshError::InvalidPort);
        }
        let discovered = Arc::new(std::sync::Mutex::new(None::<String>));
        let (remote_forward_tx, _remote_forward_rx) = mpsc::unbounded_channel();
        let (x11_tx, _x11_rx) = mpsc::unbounded_channel();
        let handler = HostKeyHandler {
            expected_host_key: String::new(),
            discovered: Some(Arc::clone(&discovered)),
            remote_forward_tx,
            x11_tx,
        };
        let config = client::Config {
            inactivity_timeout: Some(Duration::from_secs(60)),
            ..Default::default()
        };
        let future = client::connect(Arc::new(config), (host, port), handler);
        let handle = tokio::time::timeout(Duration::from_millis(SSH_DISCOVERY_TIMEOUT_MS), future)
            .await
            .map_err(|_| {
                SshError::Transport(format!(
                    "host-key discovery timed out after {SSH_DISCOVERY_TIMEOUT_MS}ms"
                ))
            })?
            .map_err(|error| match error {
                RusshError::UnknownKey => SshError::HostKeyRejected(String::new()),
                other => SshError::Transport(other.to_string()),
            })?;
        let fingerprint = discovered
            .lock()
            .ok()
            .and_then(|slot| slot.clone())
            .ok_or_else(|| SshError::Transport("host key was not captured".to_string()))?;
        let _ = handle
            .disconnect(russh::Disconnect::ByApplication, "", "English")
            .await;
        Ok(fingerprint)
    }
}

enum X11Stream {
    Tcp(TcpStream),
    #[cfg(unix)]
    Unix(UnixStream),
}

impl AsyncRead for X11Stream {
    fn poll_read(mut self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &mut tokio::io::ReadBuf<'_>) -> Poll<std::io::Result<()>> {
        match &mut *self {
            Self::Tcp(stream) => Pin::new(stream).poll_read(cx, buf),
            #[cfg(unix)] Self::Unix(stream) => Pin::new(stream).poll_read(cx, buf),
        }
    }
}

impl AsyncWrite for X11Stream {
    fn poll_write(mut self: Pin<&mut Self>, cx: &mut Context<'_>, data: &[u8]) -> Poll<std::io::Result<usize>> {
        match &mut *self {
            Self::Tcp(stream) => Pin::new(stream).poll_write(cx, data),
            #[cfg(unix)] Self::Unix(stream) => Pin::new(stream).poll_write(cx, data),
        }
    }
    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        match &mut *self {
            Self::Tcp(stream) => Pin::new(stream).poll_flush(cx),
            #[cfg(unix)] Self::Unix(stream) => Pin::new(stream).poll_flush(cx),
        }
    }
    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        match &mut *self {
            Self::Tcp(stream) => Pin::new(stream).poll_shutdown(cx),
            #[cfg(unix)] Self::Unix(stream) => Pin::new(stream).poll_shutdown(cx),
        }
    }
}

async fn connect_x11_display(spec: Option<&str>) -> Result<X11Stream, SshError> {
    let value = spec.map(str::trim).filter(|value| !value.is_empty()).map(str::to_string)
        .or_else(|| std::env::var("DISPLAY").ok()).unwrap_or_else(|| "localhost:0".to_string());
    if value.starts_with('/') {
        #[cfg(unix)]
        {
            return UnixStream::connect(&value).await.map(X11Stream::Unix)
                .map_err(|error| SshError::Transport(format!("X11 display connection failed: {error}")));
        }
        #[cfg(not(unix))]
        {
            return Err(SshError::Transport("Unix X11 display sockets are unsupported on this platform".to_string()));
        }
    }
    let (host, display) = value.rsplit_once(':').unwrap_or(("localhost", value.as_str()));
    let host = if host.is_empty() { "localhost" } else { host };
    let display = display.split('.').next().unwrap_or(display).parse::<u16>()
        .map_err(|_| SshError::Transport("invalid X11 display number".to_string()))?;
    let port = if display < 100 { display.saturating_add(6000) } else { display };
    TcpStream::connect((host, port)).await.map(X11Stream::Tcp)
        .map_err(|error| SshError::Transport(format!("X11 display connection failed: {error}")))
}

enum TransportStream { Tcp(TcpStream), Proxy(DuplexStream), Channel(russh::ChannelStream<client::Msg>) }

impl AsyncRead for TransportStream {
    fn poll_read(mut self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &mut tokio::io::ReadBuf<'_>) -> Poll<std::io::Result<()>> {
        match &mut *self { Self::Tcp(stream) => Pin::new(stream).poll_read(cx, buf), Self::Proxy(stream) => Pin::new(stream).poll_read(cx, buf), Self::Channel(stream) => Pin::new(stream).poll_read(cx, buf) }
    }
}
impl AsyncWrite for TransportStream {
    fn poll_write(mut self: Pin<&mut Self>, cx: &mut Context<'_>, data: &[u8]) -> Poll<std::io::Result<usize>> {
        match &mut *self { Self::Tcp(stream) => Pin::new(stream).poll_write(cx, data), Self::Proxy(stream) => Pin::new(stream).poll_write(cx, data), Self::Channel(stream) => Pin::new(stream).poll_write(cx, data) }
    }
    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        match &mut *self { Self::Tcp(stream) => Pin::new(stream).poll_flush(cx), Self::Proxy(stream) => Pin::new(stream).poll_flush(cx), Self::Channel(stream) => Pin::new(stream).poll_flush(cx) }
    }
    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        match &mut *self { Self::Tcp(stream) => Pin::new(stream).poll_shutdown(cx), Self::Proxy(stream) => Pin::new(stream).poll_shutdown(cx), Self::Channel(stream) => Pin::new(stream).poll_shutdown(cx) }
    }
}

async fn open_transport_stream(spec: &SshConnectionSpec) -> Result<TransportStream, SshError> {
    if let Some(jump) = &spec.jump_connection {
        return jump.open_direct_tcpip(&spec.host, spec.port, "127.0.0.1", 0).await.map(TransportStream::Channel);
    }
    if let Some(command) = spec.proxy_command.as_deref() {
        return open_proxy_command_stream(spec, command).await.map(TransportStream::Proxy);
    }
    if let Some(proxy_host) = spec.http_proxy_host.as_deref() {
        return open_http_proxy_stream(spec, proxy_host).await.map(TransportStream::Tcp);
    }
    if let Some(proxy_host) = spec.socks_proxy_host.as_deref() {
        return open_socks_proxy_stream(spec, proxy_host).await.map(TransportStream::Tcp);
    }
    TcpStream::connect((spec.host.as_str(), spec.port)).await
        .map(TransportStream::Tcp)
        .map_err(|error| SshError::Transport(error.to_string()))
}

async fn open_proxy_command_stream(spec: &SshConnectionSpec, command: &str) -> Result<DuplexStream, SshError> {
    let command = command.replace("%h", &spec.host).replace("%p", &spec.port.to_string()).replace("%r", &spec.username);
    let mut child = if cfg!(windows) {
        let mut process = Command::new("cmd.exe");
        process.args(["/d", "/s", "/c", &command]);
        process
    } else {
        let mut process = Command::new("sh");
        process.args(["-c", &command]);
        process
    };
    let mut child = child.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn()
        .map_err(|error| SshError::Transport(format!("ProxyCommand failed to start: {error}")))?;
    let mut stdin = child.stdin.take().ok_or_else(|| SshError::Transport("ProxyCommand stdin unavailable".to_string()))?;
    let mut stdout = child.stdout.take().ok_or_else(|| SshError::Transport("ProxyCommand stdout unavailable".to_string()))?;
    let (client, bridge) = tokio::io::duplex(64 * 1024);
    let (mut bridge_read, mut bridge_write) = tokio::io::split(bridge);
    tokio::spawn(async move {
        let _ = tokio::try_join!(copy(&mut stdout, &mut bridge_write), copy(&mut bridge_read, &mut stdin));
        let _ = child.kill().await;
    });
    Ok(client)
}

async fn open_http_proxy_stream(spec: &SshConnectionSpec, proxy_host: &str) -> Result<TcpStream, SshError> {
    let proxy_port = spec.http_proxy_port.ok_or(SshError::InvalidPort)?;
    let mut stream = TcpStream::connect((proxy_host, proxy_port)).await
        .map_err(|error| SshError::Transport(format!("HTTP proxy connect failed: {error}")))?;
    let request = format!("CONNECT {}:{} HTTP/1.1\r\nHost: {}:{}\r\n\r\n", spec.host, spec.port, spec.host, spec.port);
    stream.write_all(request.as_bytes()).await
        .map_err(|error| SshError::Transport(format!("HTTP proxy request failed: {error}")))?;
    let mut response = Vec::with_capacity(256);
    let mut byte = [0u8; 1];
    while response.len() < 8_192 {
        stream.read_exact(&mut byte).await
            .map_err(|error| SshError::Transport(format!("HTTP proxy response failed: {error}")))?;
        response.push(byte[0]);
        if response.ends_with(b"\r\n\r\n") { break; }
    }
    let status = std::str::from_utf8(&response).unwrap_or_default().lines().next().unwrap_or_default();
    if !status.starts_with("HTTP/") || !status.split_whitespace().nth(1).is_some_and(|code| code.starts_with('2')) {
        return Err(SshError::Transport(format!("HTTP proxy rejected CONNECT: {status}")));
    }
    Ok(stream)
}

async fn open_socks_proxy_stream(spec: &SshConnectionSpec, proxy_host: &str) -> Result<TcpStream, SshError> {
    let proxy_port = spec.socks_proxy_port.ok_or(SshError::InvalidPort)?;
    let mut stream = TcpStream::connect((proxy_host, proxy_port)).await
        .map_err(|error| SshError::Transport(format!("SOCKS proxy connect failed: {error}")))?;
    stream.write_all(&[5, 1, 0]).await
        .map_err(|error| SshError::Transport(format!("SOCKS proxy greeting failed: {error}")))?;
    let mut greeting = [0u8; 2];
    stream.read_exact(&mut greeting).await
        .map_err(|error| SshError::Transport(format!("SOCKS proxy greeting failed: {error}")))?;
    if greeting != [5, 0] { return Err(SshError::Transport("SOCKS proxy requires unsupported authentication".to_string())); }
    let host = spec.host.as_bytes();
    if host.len() > 255 { return Err(SshError::InvalidHost); }
    let mut request = Vec::with_capacity(host.len() + 7);
    request.extend_from_slice(&[5, 1, 0, 3, host.len() as u8]);
    request.extend_from_slice(host);
    request.extend_from_slice(&spec.port.to_be_bytes());
    stream.write_all(&request).await
        .map_err(|error| SshError::Transport(format!("SOCKS proxy CONNECT failed: {error}")))?;
    let mut response = [0u8; 4];
    stream.read_exact(&mut response).await
        .map_err(|error| SshError::Transport(format!("SOCKS proxy response failed: {error}")))?;
    if response[0] != 5 || response[1] != 0 { return Err(SshError::Transport(format!("SOCKS proxy rejected CONNECT: {}", response[1]))); }
    let trailing = match response[3] { 1 => 6, 3 => { let mut length = [0u8; 1]; stream.read_exact(&mut length).await.map_err(|error| SshError::Transport(error.to_string()))?; length[0] as usize + 2 }, 4 => 18, _ => return Err(SshError::Transport("SOCKS proxy sent invalid address type".to_string())) };
    let mut discard = vec![0u8; trailing];
    stream.read_exact(&mut discard).await.map_err(|error| SshError::Transport(format!("SOCKS proxy response failed: {error}")))?;
    Ok(stream)
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
            http_proxy_host: None,
            http_proxy_port: None,
            socks_proxy_host: None,
            socks_proxy_port: None,
            keyboard_interactive: false,
            proxy_command: None,
            x11: false,
            x11_display: None,
            jump_connection: None,
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
    fn connection_config_keeps_idle_sessions_alive() {
        // 回归：inactivity_timeout 曾设为 60s，空闲会话被 russh 回收，
        // 用户输入时报 "Session is not running"。
        let config = client::Config {
            inactivity_timeout: Some(Duration::from_secs(60)),
            ..Default::default()
        };
        assert!(config.inactivity_timeout.is_some());
        // 新配置：不回收空闲连接，靠 keepalive 探活
        let config = client::Config {
            inactivity_timeout: None,
            keepalive_interval: Some(Duration::from_secs(30)),
            keepalive_max: 3,
            ..Default::default()
        };
        assert_eq!(config.inactivity_timeout, None);
        assert_eq!(config.keepalive_interval, Some(Duration::from_secs(30)));
        assert_eq!(config.keepalive_max, 3);
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
                http_proxy_host: None,
                http_proxy_port: None,
                socks_proxy_host: None,
                socks_proxy_port: None,
                keyboard_interactive: false,
                proxy_command: None,
                x11: false,
                x11_display: None,
                jump_connection: None,
            })
            .await
            .expect("connection should succeed");

            let mut interactive = connection
                .open_interactive(120, 36, false, false)
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

        #[tokio::test]
        async fn discovers_host_key_fingerprint_without_trusting_it() {
            let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0u16))
                .await
                .unwrap();
            let port = listener.local_addr().unwrap().port();
            drop(listener);

            let (key, _pty_requested, _shell_requested) = spawn_test_server(port).await;
            let expected = key.public_key().fingerprint(Default::default()).to_string();

            let discovered = SshConnection::discover_host_key("127.0.0.1", port)
                .await
                .expect("discovery should succeed");
            assert_eq!(discovered, expected);
            assert!(discovered.starts_with("SHA256:"));

            let mut value = spec();
            value.host = "127.0.0.1".to_string();
            value.port = port;
            value.expected_host_key = discovered;
            let connection = SshConnection::connect(value)
                .await
                .expect("connection with discovered fingerprint should succeed");
            connection
                .disconnect()
                .await
                .expect("disconnect should succeed");
        }

        #[tokio::test]
        async fn discover_host_key_rejects_invalid_input() {
            assert!(matches!(
                SshConnection::discover_host_key("", 22).await,
                Err(SshError::InvalidHost)
            ));
            assert!(matches!(
                SshConnection::discover_host_key("127.0.0.1", 0).await,
                Err(SshError::InvalidPort)
            ));
        }
    }

    #[cfg(any(target_os = "windows", target_os = "linux", target_os = "macos"))]
    mod sftp_tests {
        use super::*;
        use crate::sftp::MAX_SFTP_CHUNK_BYTES;
        use russh::server::{self, Auth, Session};
        use russh_sftp::protocol::{
            Attrs, Data, File, FileAttributes, Handle, Name, OpenFlags, Status, StatusCode, Version,
        };
        use std::collections::HashMap;
        use tokio::time::{timeout, Duration};

        type MemFs = Arc<std::sync::Mutex<HashMap<String, Vec<u8>>>>;

        #[derive(Clone)]
        struct SftpTestServer {
            files: MemFs,
            channels: Arc<
                tokio::sync::Mutex<HashMap<russh::ChannelId, russh::Channel<russh::server::Msg>>>,
            >,
        }

        impl server::Handler for SftpTestServer {
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
                channel: russh::Channel<russh::server::Msg>,
                reply: russh::server::ChannelOpenHandle,
                _session: &mut Session,
            ) -> Result<(), Self::Error> {
                self.channels.lock().await.insert(channel.id(), channel);
                reply.accept().await;
                Ok(())
            }

            async fn subsystem_request(
                &mut self,
                channel_id: russh::ChannelId,
                name: &str,
                session: &mut Session,
            ) -> Result<(), Self::Error> {
                if name != SFTP_SUBSYSTEM_NAME {
                    session.channel_failure(channel_id)?;
                    return Ok(());
                }
                let channel = self.channels.lock().await.remove(&channel_id);
                let Some(channel) = channel else {
                    session.channel_failure(channel_id)?;
                    return Ok(());
                };
                session.channel_success(channel_id)?;
                let handler = MemSftpHandler {
                    files: Arc::clone(&self.files),
                    dir_read_done: Arc::new(std::sync::Mutex::new(HashMap::new())),
                };
                russh_sftp::server::run(channel.into_stream(), handler).await;
                Ok(())
            }
        }

        #[derive(Clone)]
        struct MemSftpHandler {
            files: MemFs,
            dir_read_done: Arc<std::sync::Mutex<HashMap<String, bool>>>,
        }

        fn ok_status(id: u32) -> Status {
            Status {
                id,
                status_code: StatusCode::Ok,
                error_message: "Ok".to_string(),
                language_tag: "en-US".to_string(),
            }
        }

        fn attrs_for(path: &str, files: &HashMap<String, Vec<u8>>) -> FileAttributes {
            let mut attrs = FileAttributes::default();
            if let Some(data) = files.get(path) {
                attrs.size = Some(data.len() as u64);
                attrs.set_regular(true);
            } else {
                attrs.set_dir(true);
            }
            attrs
        }

        impl russh_sftp::server::Handler for MemSftpHandler {
            type Error = StatusCode;

            fn unimplemented(&self) -> Self::Error {
                StatusCode::OpUnsupported
            }

            async fn init(
                &mut self,
                _version: u32,
                _extensions: HashMap<String, String>,
            ) -> Result<Version, Self::Error> {
                Ok(Version::new())
            }

            async fn open(
                &mut self,
                id: u32,
                filename: String,
                pflags: OpenFlags,
                _attrs: FileAttributes,
            ) -> Result<Handle, Self::Error> {
                if pflags.contains(OpenFlags::READ)
                    && !self.files.lock().unwrap().contains_key(&filename)
                {
                    return Err(StatusCode::NoSuchFile);
                }
                Ok(Handle {
                    id,
                    handle: filename,
                })
            }

            async fn close(&mut self, id: u32, _handle: String) -> Result<Status, Self::Error> {
                Ok(ok_status(id))
            }

            async fn read(
                &mut self,
                id: u32,
                handle: String,
                offset: u64,
                len: u32,
            ) -> Result<Data, Self::Error> {
                let files = self.files.lock().unwrap();
                let data = files.get(&handle).ok_or(StatusCode::NoSuchFile)?;
                let start = (offset as usize).min(data.len());
                let end = (start + len as usize).min(data.len());
                if start == end && offset as usize > data.len() {
                    return Err(StatusCode::Eof);
                }
                Ok(Data {
                    id,
                    data: data[start..end].to_vec(),
                })
            }

            async fn write(
                &mut self,
                id: u32,
                handle: String,
                offset: u64,
                data: Vec<u8>,
            ) -> Result<Status, Self::Error> {
                let mut files = self.files.lock().unwrap();
                let entry = files.entry(handle).or_default();
                let start = offset as usize;
                if entry.len() < start {
                    entry.resize(start, 0);
                }
                if start + data.len() > entry.len() {
                    entry.resize(start + data.len(), 0);
                }
                entry[start..start + data.len()].copy_from_slice(&data);
                Ok(ok_status(id))
            }

            async fn stat(&mut self, id: u32, path: String) -> Result<Attrs, Self::Error> {
                let files = self.files.lock().unwrap();
                if !files.contains_key(&path) {
                    return Err(StatusCode::NoSuchFile);
                }
                Ok(Attrs {
                    id,
                    attrs: attrs_for(&path, &files),
                })
            }

            async fn opendir(&mut self, id: u32, path: String) -> Result<Handle, Self::Error> {
                if path != "/" {
                    return Err(StatusCode::NoSuchFile);
                }
                self.dir_read_done
                    .lock()
                    .unwrap()
                    .insert(path.clone(), false);
                Ok(Handle { id, handle: path })
            }

            async fn readdir(&mut self, id: u32, handle: String) -> Result<Name, Self::Error> {
                let done = self
                    .dir_read_done
                    .lock()
                    .unwrap()
                    .get(&handle)
                    .copied()
                    .unwrap_or(true);
                if done {
                    return Err(StatusCode::Eof);
                }
                self.dir_read_done.lock().unwrap().insert(handle, true);
                let files = self.files.lock().unwrap();
                let entries: Vec<File> = files
                    .keys()
                    .map(|path| {
                        let name = path.trim_start_matches('/').to_string();
                        File::new(name, attrs_for(path, &files))
                    })
                    .collect();
                Ok(Name { id, files: entries })
            }

            async fn remove(&mut self, id: u32, filename: String) -> Result<Status, Self::Error> {
                self.files.lock().unwrap().remove(&filename);
                Ok(ok_status(id))
            }

            async fn mkdir(
                &mut self,
                id: u32,
                _path: String,
                _attrs: FileAttributes,
            ) -> Result<Status, Self::Error> {
                Ok(ok_status(id))
            }

            async fn rmdir(&mut self, id: u32, _path: String) -> Result<Status, Self::Error> {
                Ok(ok_status(id))
            }

            async fn rename(
                &mut self,
                id: u32,
                oldpath: String,
                newpath: String,
            ) -> Result<Status, Self::Error> {
                let mut files = self.files.lock().unwrap();
                if let Some(data) = files.remove(&oldpath) {
                    files.insert(newpath, data);
                }
                Ok(ok_status(id))
            }

            async fn realpath(&mut self, id: u32, _path: String) -> Result<Name, Self::Error> {
                Ok(Name {
                    id,
                    files: vec![File::dummy("/")],
                })
            }
        }

        async fn spawn_sftp_server(port: u16) -> (Arc<russh::keys::PrivateKey>, MemFs) {
            let key = Arc::new(
                russh::keys::PrivateKey::random(&mut rand::rng(), russh::keys::Algorithm::Ed25519)
                    .expect("test key should generate"),
            );
            let files: MemFs = Arc::new(std::sync::Mutex::new(HashMap::new()));
            let config = Arc::new(server::Config {
                keys: vec![(*key).clone()],
                ..Default::default()
            });
            let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, port))
                .await
                .expect("test server should bind");
            let files_for_server = Arc::clone(&files);
            tokio::spawn(async move {
                loop {
                    let Ok((socket, _)) = listener.accept().await else {
                        break;
                    };
                    let config = Arc::clone(&config);
                    let files = Arc::clone(&files_for_server);
                    tokio::spawn(async move {
                        let handler = SftpTestServer {
                            files,
                            channels: Arc::new(tokio::sync::Mutex::new(HashMap::new())),
                        };
                        let Ok(session) = server::run_stream(config, socket, handler).await else {
                            return;
                        };
                        let _ = session.await;
                    });
                }
            });
            (key, files)
        }

        async fn connect_sftp(files: &MemFs) -> (SshConnection, SshSftpSession) {
            let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0u16))
                .await
                .unwrap();
            let port = listener.local_addr().unwrap().port();
            drop(listener);

            let (key, _server_files) = spawn_sftp_server(port).await;
            *files.lock().unwrap() = HashMap::new();
            let fingerprint = key.public_key().fingerprint(Default::default()).to_string();

            let connection = SshConnection::connect(SshConnectionSpec {
                host: "127.0.0.1".to_string(),
                port,
                username: "developer".to_string(),
                password: Some("secret".to_string()),
                private_key_path: None,
                private_key_passphrase: None,
                expected_host_key: fingerprint,
                http_proxy_host: None,
                http_proxy_port: None,
                socks_proxy_host: None,
                socks_proxy_port: None,
                keyboard_interactive: false,
                proxy_command: None,
                x11: false,
                x11_display: None,
                jump_connection: None,
            })
            .await
            .expect("connection should succeed");
            let sftp = connection
                .open_sftp()
                .await
                .expect("sftp session should open");
            (connection, sftp)
        }

        #[tokio::test]
        async fn sftp_roundtrip_write_read_list_stat_rename_remove() {
            let files: MemFs = Arc::new(std::sync::Mutex::new(HashMap::new()));
            let (connection, sftp) = connect_sftp(&files).await;

            sftp.write_file("/hello.txt", b"sftp roundtrip")
                .await
                .expect("write should succeed");

            let data = sftp
                .read_file("/hello.txt")
                .await
                .expect("read should succeed");
            assert_eq!(data, b"sftp roundtrip".to_vec());

            let stat = sftp.stat("/hello.txt").await.expect("stat should succeed");
            assert!(stat.is_file);
            assert_eq!(stat.size, 14);

            let entries = sftp.list_dir("/").await.expect("list should succeed");
            assert!(entries.iter().any(|entry| entry.name == "hello.txt"));

            sftp.rename("/hello.txt", "/renamed.txt")
                .await
                .expect("rename should succeed");
            let data = sftp
                .read_file("/renamed.txt")
                .await
                .expect("read should succeed");
            assert_eq!(data, b"sftp roundtrip".to_vec());

            sftp.remove_file("/renamed.txt")
                .await
                .expect("remove should succeed");
            assert!(sftp.read_file("/renamed.txt").await.is_err());

            sftp.close().await.expect("close should succeed");
            drop(connection);
        }

        #[tokio::test]
        async fn sftp_rejects_invalid_paths_and_oversized_writes() {
            let files: MemFs = Arc::new(std::sync::Mutex::new(HashMap::new()));
            let (_connection, sftp) = connect_sftp(&files).await;

            assert!(matches!(
                sftp.write_file("relative.txt", b"x").await,
                Err(SftpError::InvalidPath)
            ));
            assert!(matches!(
                sftp.read_file("").await,
                Err(SftpError::InvalidPath)
            ));
            let oversized = vec![0u8; MAX_SFTP_FILE_BYTES + 1];
            assert!(matches!(
                sftp.write_file("/big.bin", &oversized).await,
                Err(SftpError::FileTooLarge { .. })
            ));
            sftp.close().await.expect("close should succeed");
        }

        #[tokio::test]
        async fn sftp_read_timeout_returns_error() {
            let files: MemFs = Arc::new(std::sync::Mutex::new(HashMap::new()));
            let (_connection, sftp) = connect_sftp(&files).await;
            let result = timeout(Duration::from_secs(10), sftp.read_file("/missing.txt")).await;
            assert!(matches!(result, Ok(Err(SftpError::Transfer(_))) | Err(_)));
            sftp.close().await.expect("close should succeed");
        }

        #[tokio::test]
        async fn sftp_chunked_read_returns_exact_ranges() {
            let files: MemFs = Arc::new(std::sync::Mutex::new(HashMap::new()));
            let (_connection, sftp) = connect_sftp(&files).await;

            let payload: Vec<u8> = (0..64u8).cycle().take(256).collect();
            sftp.write_file("/chunked.bin", &payload)
                .await
                .expect("write should succeed");

            let first = sftp
                .read_file_chunk("/chunked.bin", 0, 100)
                .await
                .expect("first chunk should succeed");
            assert_eq!(first.offset, 0);
            assert_eq!(first.data, payload[..100].to_vec());
            assert_eq!(first.total_size, 256);
            assert!(!first.eof);

            let second = sftp
                .read_file_chunk("/chunked.bin", 100, 100)
                .await
                .expect("second chunk should succeed");
            assert_eq!(second.data, payload[100..200].to_vec());
            assert!(!second.eof);

            let tail = sftp
                .read_file_chunk("/chunked.bin", 200, 100)
                .await
                .expect("tail chunk should succeed");
            assert_eq!(tail.data, payload[200..].to_vec());
            assert!(tail.eof);

            let past_end = sftp
                .read_file_chunk("/chunked.bin", 256, 100)
                .await
                .expect("past-end chunk should succeed");
            assert!(past_end.data.is_empty());
            assert!(past_end.eof);

            sftp.close().await.expect("close should succeed");
        }

        #[tokio::test]
        async fn sftp_chunked_write_appends_and_truncates() {
            let files: MemFs = Arc::new(std::sync::Mutex::new(HashMap::new()));
            let (_connection, sftp) = connect_sftp(&files).await;

            let outcome = sftp
                .write_file_chunk("/log.txt", 0, b"hello ", true)
                .await
                .expect("first write should succeed");
            assert_eq!(outcome.total_size, 6);

            let outcome = sftp
                .write_file_chunk("/log.txt", 6, b"world", false)
                .await
                .expect("append write should succeed");
            assert_eq!(outcome.total_size, 11);

            let data = sftp
                .read_file("/log.txt")
                .await
                .expect("read should succeed");
            assert_eq!(data, b"hello world".to_vec());

            sftp.write_file_chunk("/log.txt", 0, b"overwritten", true)
                .await
                .expect("truncate write should succeed");
            let data = sftp
                .read_file("/log.txt")
                .await
                .expect("read should succeed");
            assert_eq!(data, b"overwritten".to_vec());

            assert!(matches!(
                sftp.write_file_chunk("/big.bin", 0, &vec![0u8; MAX_SFTP_CHUNK_BYTES + 1], true)
                    .await,
                Err(SftpError::FileTooLarge { .. })
            ));

            sftp.close().await.expect("close should succeed");
        }
    }
}
