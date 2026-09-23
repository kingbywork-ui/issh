use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::collections::{HashMap, VecDeque};
use std::fmt;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::thread;
pub const MAX_SESSION_BUFFER_BYTES: usize = 2 * 1024 * 1024;
pub const MAX_SESSION_EVENT_BYTES: usize = 4 * 1024;
pub const MAX_SESSION_BATCH_BYTES: usize = 12 * 1024;
pub const MAX_SESSION_WRITE_BYTES: usize = 12 * 1024;
pub const MAX_SESSION_DIMENSION: u16 = 1_000;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSnapshot {
    pub id: String,
    pub title: String,
    pub kind: String,
    pub state: String,
    pub columns: u16,
    pub rows: u16,
    pub pid: Option<u32>,
    pub next_sequence: u64,
    pub buffered_bytes: usize,
    pub dropped_bytes: usize,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionEvent {
    pub sequence: u64,
    pub kind: String,
    pub data: Vec<u8>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSubscription {
    pub session: SessionSnapshot,
    pub events: Vec<SessionEvent>,
    pub next_after_sequence: u64,
    pub dropped_bytes: usize,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionWriteResult {
    pub session_id: String,
    pub accepted_bytes: usize,
}

pub struct LocalSessionSpec {
    pub title: String,
    pub cwd: Option<PathBuf>,
    pub shell: Option<String>,
    pub columns: u16,
    pub rows: u16,
}

#[derive(Debug, PartialEq, Eq)]
pub enum RemoteShellError {
    Closed,
    WriteTooLarge,
    Transport(String),
}

impl fmt::Display for RemoteShellError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Closed => formatter.write_str("Remote shell is not running"),
            Self::WriteTooLarge => {
                write!(
                    formatter,
                    "Remote shell write must contain 1-{MAX_SESSION_WRITE_BYTES} bytes"
                )
            }
            Self::Transport(message) => write!(formatter, "Remote shell failure: {message}"),
        }
    }
}

impl std::error::Error for RemoteShellError {}

pub trait RemoteShellIo: Send {
    fn try_write(&mut self, data: &[u8]) -> Result<(), RemoteShellError>;
    fn try_resize(&mut self, columns: u16, rows: u16) -> Result<(), RemoteShellError>;
    fn request_close(&mut self);
}

pub struct SshSessionSpec<S> {
    pub title: String,
    pub columns: u16,
    pub rows: u16,
    pub shell: S,
}

#[derive(Debug, PartialEq, Eq)]
pub enum SessionError {
    InvalidTitle,
    InvalidDimensions,
    InvalidWorkingDirectory,
    SessionNotFound(String),
    SessionClosed(String),
    WriteTooLarge,
    InvalidBatch,
    Pty(String),
}

impl fmt::Display for SessionError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidTitle => {
                formatter.write_str("Session title must contain 1-120 characters")
            }
            Self::InvalidDimensions => formatter.write_str("Session dimensions must be 1-1000"),
            Self::InvalidWorkingDirectory => formatter
                .write_str("Session working directory does not exist or is not a directory"),
            Self::SessionNotFound(id) => write!(formatter, "Session not found: {id}"),
            Self::SessionClosed(id) => write!(formatter, "Session is not running: {id}"),
            Self::WriteTooLarge => {
                write!(
                    formatter,
                    "Session write must contain 1-{MAX_SESSION_WRITE_BYTES} bytes"
                )
            }
            Self::InvalidBatch => write!(
                formatter,
                "Session batch must contain 1-256 events and 4096-{MAX_SESSION_BATCH_BYTES} bytes"
            ),
            Self::Pty(message) => write!(formatter, "PTY operation failed: {message}"),
        }
    }
}

impl std::error::Error for SessionError {}

struct OutputState {
    state: String,
    next_sequence: u64,
    events: VecDeque<SessionEvent>,
    buffered_bytes: usize,
    dropped_bytes: usize,
}

impl OutputState {
    fn new() -> Self {
        Self {
            state: "running".to_string(),
            next_sequence: 1,
            events: VecDeque::new(),
            buffered_bytes: 0,
            dropped_bytes: 0,
        }
    }

    fn push(&mut self, kind: &str, data: Vec<u8>) {
        if data.is_empty() {
            return;
        }
        let event = SessionEvent {
            sequence: self.next_sequence,
            kind: kind.to_string(),
            data,
        };
        self.next_sequence = self.next_sequence.saturating_add(1);
        self.buffered_bytes = self.buffered_bytes.saturating_add(event.data.len());
        self.events.push_back(event);
        while self.buffered_bytes > MAX_SESSION_BUFFER_BYTES {
            let Some(dropped) = self.events.pop_front() else {
                break;
            };
            self.buffered_bytes = self.buffered_bytes.saturating_sub(dropped.data.len());
            self.dropped_bytes = self.dropped_bytes.saturating_add(dropped.data.len());
        }
    }
}

struct LocalSession {
    shell: Option<String>,
    id: String,
    title: String,
    columns: u16,
    rows: u16,
    pid: Option<u32>,
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send>,
    output: Arc<Mutex<OutputState>>,
}

impl LocalSession {
    fn snapshot(&mut self) -> Result<SessionSnapshot, SessionError> {
        if self
            .child
            .try_wait()
            .map_err(|error| SessionError::Pty(error.to_string()))?
            .is_some()
        {
            if let Ok(mut output) = self.output.lock() {
                if output.state == "running" {
                    output.state = "exited".to_string();
                }
            }
        }
        let output = self
            .output
            .lock()
            .map_err(|_| SessionError::Pty("output state is unavailable".to_string()))?;
        Ok(SessionSnapshot {
            id: self.id.clone(),
            title: self.title.clone(),
            kind: "local".to_string(),
            state: output.state.clone(),
            columns: self.columns,
            rows: self.rows,
            pid: self.pid,
            next_sequence: output.next_sequence,
            buffered_bytes: output.buffered_bytes,
            dropped_bytes: output.dropped_bytes,
        })
    }

    fn stop(&mut self) {
        if let Ok(mut output) = self.output.lock() {
            output.state = "closed".to_string();
        }
        // shell 进程树的终止与 ConPTY 句柄清理统一由 SessionStore::close
        // 的后台清理线程执行（先杀 shell 及其真实子进程，再析构 entry 触发
        // ClosePseudoConsole）。这里绝不做
        // 任何可能阻塞的系统调用：stop() 运行在持 sessions 锁的 RPC
        // dispatch 线程上，一旦阻塞会使 isshd 的所有会话请求全部堵死。
    }
}

struct SshSession {
    id: String,
    title: String,
    columns: u16,
    rows: u16,
    output: Arc<Mutex<OutputState>>,
    shell: Box<dyn RemoteShellIo>,
}

impl SshSession {
    fn snapshot(&self) -> Result<SessionSnapshot, SessionError> {
        let output = self
            .output
            .lock()
            .map_err(|_| SessionError::Pty("output state is unavailable".to_string()))?;
        Ok(SessionSnapshot {
            id: self.id.clone(),
            title: self.title.clone(),
            kind: "ssh".to_string(),
            state: output.state.clone(),
            columns: self.columns,
            rows: self.rows,
            pid: None,
            next_sequence: output.next_sequence,
            buffered_bytes: output.buffered_bytes,
            dropped_bytes: output.dropped_bytes,
        })
    }

    fn stop(&mut self) {
        if let Ok(mut output) = self.output.lock() {
            if output.state == "running" {
                output.state = "closed".to_string();
            }
        }
        self.shell.request_close();
    }
}

enum SessionEntry {
    Local(LocalSession),
    Ssh(SshSession),
}

impl SessionEntry {
    fn snapshot(&mut self) -> Result<SessionSnapshot, SessionError> {
        match self {
            Self::Local(session) => session.snapshot(),
            Self::Ssh(session) => session.snapshot(),
        }
    }

    fn stop(&mut self) {
        match self {
            Self::Local(session) => session.stop(),
            Self::Ssh(session) => session.stop(),
        }
    }
}

pub struct SessionStore {
    sessions: HashMap<String, SessionEntry>,
    next_local_id: u64,
    next_ssh_id: u64,
}

impl Default for SessionStore {
    fn default() -> Self {
        Self::new()
    }
}

impl SessionStore {
    pub fn new() -> Self {
        Self {
            sessions: HashMap::new(),
            next_local_id: 1,
            next_ssh_id: 1,
        }
    }

    pub fn list(&mut self) -> Result<Vec<SessionSnapshot>, SessionError> {
        let mut snapshots = self
            .sessions
            .values_mut()
            .map(SessionEntry::snapshot)
            .collect::<Result<Vec<_>, _>>()?;
        snapshots.sort_by(|left, right| left.id.cmp(&right.id));
        Ok(snapshots)
    }

    pub fn local_shell(&mut self, session_id: &str) -> Result<Option<String>, SessionError> {
        match self.session_mut(session_id)? {
            SessionEntry::Local(session) => {
                if session.snapshot()?.state != "running" {
                    return Err(SessionError::SessionNotFound(session_id.to_string()));
                }
                Ok(session.shell.clone())
            }
            _ => Err(SessionError::SessionNotFound(session_id.to_string())),
        }
    }

    pub fn open_local(&mut self, spec: LocalSessionSpec) -> Result<SessionSnapshot, SessionError> {
        validate_title(&spec.title)?;
        validate_dimensions(spec.columns, spec.rows)?;
        if spec.cwd.as_deref().is_some_and(|cwd| !cwd.is_dir()) {
            return Err(SessionError::InvalidWorkingDirectory);
        }

        let pair = native_pty_system()
            .openpty(pty_size(spec.columns, spec.rows))
            .map_err(|error| SessionError::Pty(error.to_string()))?;
        #[cfg(windows)]
        let mut command = {
            let shell = match spec.shell.as_deref() {
                Some("powershell") => "powershell.exe",
                Some("pwsh") => "pwsh.exe",
                Some("wsl") => "wsl.exe",
                Some("git-bash") => {
                    let candidates = [
                        "C:\\Program Files\\Git\\bin\\bash.exe",
                        "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
                    ];
                    candidates
                        .into_iter()
                        .find(|path| std::path::Path::new(path).is_file())
                        .unwrap_or("bash.exe")
                }
                _ => "cmd.exe",
            };
            let mut command = CommandBuilder::new(shell);
            if shell == "cmd.exe" {
                command.arg("/d");
            }
            command
        };
        #[cfg(not(windows))]
        let mut command = {
            let shell = match spec.shell.as_deref() {
                Some("bash") | Some("git-bash") => "bash",
                Some("zsh") => "zsh",
                Some("fish") => "fish",
                _ => "sh",
            };
            CommandBuilder::new(shell)
        };
        if let Some(cwd) = &spec.cwd {
            command.cwd(cwd);
        }
        let mut child = pair
            .slave
            .spawn_command(command)
            .map_err(|error| SessionError::Pty(error.to_string()))?;
        drop(pair.slave);

        let mut reader = match pair.master.try_clone_reader() {
            Ok(reader) => reader,
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(SessionError::Pty(error.to_string()));
            }
        };
        let writer = match pair.master.take_writer() {
            Ok(writer) => writer,
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(SessionError::Pty(error.to_string()));
            }
        };
        let output = Arc::new(Mutex::new(OutputState::new()));
        let reader_output = Arc::clone(&output);
        if thread::Builder::new()
            .name("issh-local-pty-reader".to_string())
            .spawn(move || read_output(&mut reader, &reader_output))
            .is_err()
        {
            let _ = child.kill();
            let _ = child.wait();
            return Err(SessionError::Pty("unable to start PTY reader".to_string()));
        }

        let id = format!("local-{}", self.next_local_id);
        self.next_local_id = self.next_local_id.saturating_add(1);
        let mut session = LocalSession {
            shell: spec.shell,
            id: id.clone(),
            title: spec.title.trim().to_string(),
            columns: spec.columns,
            rows: spec.rows,
            pid: child.process_id(),
            master: pair.master,
            writer,
            child,
            output,
        };
        let snapshot = session.snapshot()?;
        self.sessions.insert(id, SessionEntry::Local(session));
        Ok(snapshot)
    }

    pub fn open_ssh<S>(&mut self, spec: SshSessionSpec<S>) -> Result<SessionSnapshot, SessionError>
    where
        S: RemoteShellIo + 'static,
    {
        validate_title(&spec.title)?;
        validate_dimensions(spec.columns, spec.rows)?;
        let id = format!("ssh-{}", self.next_ssh_id);
        self.next_ssh_id = self.next_ssh_id.saturating_add(1);
        let session = SshSession {
            id: id.clone(),
            title: spec.title.trim().to_string(),
            columns: spec.columns,
            rows: spec.rows,
            output: Arc::new(Mutex::new(OutputState::new())),
            shell: Box::new(spec.shell),
        };
        let snapshot = session.snapshot()?;
        self.sessions.insert(id, SessionEntry::Ssh(session));
        Ok(snapshot)
    }

    pub fn push_ssh_output(
        &mut self,
        session_id: &str,
        kind: &str,
        data: Vec<u8>,
    ) -> Result<SessionSnapshot, SessionError> {
        if data.is_empty() || data.len() > MAX_SESSION_BATCH_BYTES {
            return Err(SessionError::InvalidBatch);
        }
        let entry = self.session_mut(session_id)?;
        let SessionEntry::Ssh(session) = entry else {
            return Err(SessionError::SessionNotFound(session_id.to_string()));
        };
        let mut remaining = data.as_slice();
        while !remaining.is_empty() {
            let take = remaining.len().min(MAX_SESSION_EVENT_BYTES);
            let (chunk, rest) = remaining.split_at(take);
            remaining = rest;
            let mut output = session
                .output
                .lock()
                .map_err(|_| SessionError::Pty("output state is unavailable".to_string()))?;
            output.push(kind, chunk.to_vec());
        }
        session.snapshot()
    }

    pub fn mark_ssh_exited(&mut self, session_id: &str) -> Result<SessionSnapshot, SessionError> {
        let entry = self.session_mut(session_id)?;
        let SessionEntry::Ssh(session) = entry else {
            return Err(SessionError::SessionNotFound(session_id.to_string()));
        };
        if let Ok(mut output) = session.output.lock() {
            if output.state == "running" {
                output.state = "exited".to_string();
            }
        }
        session.snapshot()
    }

    pub fn snapshot(&mut self, session_id: &str) -> Result<SessionSnapshot, SessionError> {
        self.session_mut(session_id)?.snapshot()
    }

    pub fn write(
        &mut self,
        session_id: &str,
        data: Vec<u8>,
    ) -> Result<SessionWriteResult, SessionError> {
        if data.is_empty() || data.len() > MAX_SESSION_WRITE_BYTES {
            return Err(SessionError::WriteTooLarge);
        }
        let entry = self.session_mut(session_id)?;
        match entry {
            SessionEntry::Local(session) => {
                if session.snapshot()?.state != "running" {
                    return Err(SessionError::SessionClosed(session_id.to_string()));
                }
                session
                    .writer
                    .write_all(&data)
                    .and_then(|_| session.writer.flush())
                    .map_err(|error| SessionError::Pty(error.to_string()))?;
            }
            SessionEntry::Ssh(session) => {
                if session.snapshot()?.state != "running" {
                    return Err(SessionError::SessionClosed(session_id.to_string()));
                }
                session
                    .shell
                    .try_write(&data)
                    .map_err(|error| SessionError::Pty(error.to_string()))?;
            }
        }
        Ok(SessionWriteResult {
            session_id: session_id.to_string(),
            accepted_bytes: data.len(),
        })
    }

    pub fn resize(
        &mut self,
        session_id: &str,
        columns: u16,
        rows: u16,
    ) -> Result<SessionSnapshot, SessionError> {
        validate_dimensions(columns, rows)?;
        let entry = self.session_mut(session_id)?;
        match entry {
            SessionEntry::Local(session) => {
                if session.snapshot()?.state != "running" {
                    return Err(SessionError::SessionClosed(session_id.to_string()));
                }
                session
                    .master
                    .resize(pty_size(columns, rows))
                    .map_err(|error| SessionError::Pty(error.to_string()))?;
                session.columns = columns;
                session.rows = rows;
                session.snapshot()
            }
            SessionEntry::Ssh(session) => {
                if session.snapshot()?.state != "running" {
                    return Err(SessionError::SessionClosed(session_id.to_string()));
                }
                session
                    .shell
                    .try_resize(columns, rows)
                    .map_err(|error| SessionError::Pty(error.to_string()))?;
                session.columns = columns;
                session.rows = rows;
                session.snapshot()
            }
        }
    }

    pub fn subscribe(
        &mut self,
        session_id: &str,
        after_sequence: u64,
        max_events: usize,
        max_bytes: usize,
    ) -> Result<SessionSubscription, SessionError> {
        if !(1..=256).contains(&max_events)
            || !(MAX_SESSION_EVENT_BYTES..=MAX_SESSION_BATCH_BYTES).contains(&max_bytes)
        {
            return Err(SessionError::InvalidBatch);
        }
        let entry = self.session_mut(session_id)?;
        let (snapshot, output) =
            match entry {
                SessionEntry::Local(session) => {
                    let snapshot = session.snapshot()?;
                    let output = session.output.lock().map_err(|_| {
                        SessionError::Pty("output state is unavailable".to_string())
                    })?;
                    (snapshot, output)
                }
                SessionEntry::Ssh(session) => {
                    let snapshot = session.snapshot()?;
                    let output = session.output.lock().map_err(|_| {
                        SessionError::Pty("output state is unavailable".to_string())
                    })?;
                    (snapshot, output)
                }
            };
        let (events, next_after_sequence) =
            collect_events(&output, after_sequence, max_events, max_bytes);
        Ok(SessionSubscription {
            session: snapshot,
            events,
            next_after_sequence,
            dropped_bytes: output.dropped_bytes,
        })
    }

    pub fn close(&mut self, session_id: &str) -> Result<SessionSnapshot, SessionError> {
        let mut entry = self
            .sessions
            .remove(session_id)
            .ok_or_else(|| SessionError::SessionNotFound(session_id.to_string()))?;
        entry.stop();
        let snap = entry.snapshot();
        // Windows ConPTY：SessionEntry 析构时 ClosePseudoConsole 可能同步等待
        // conhost 退出。close() 运行在 RPC dispatch 线程且持有 sessions 锁，
        // 因此把 shell 进程树和 ConPTY 句柄清理移到独立线程。只终止 root_pid
        // 的真实后代；conhost 不属于该树，由 ClosePseudoConsole 负责关闭。
        let cleanup_pid = snap.as_ref().ok().and_then(|snapshot| snapshot.pid);
        std::thread::spawn(move || {
            if let Some(pid) = cleanup_pid {
                #[cfg(windows)]
                terminate_windows_process_tree(pid);
            }
            drop(entry);
        });
        snap
    }

    fn session_mut(&mut self, session_id: &str) -> Result<&mut SessionEntry, SessionError> {
        self.sessions
            .get_mut(session_id)
            .ok_or_else(|| SessionError::SessionNotFound(session_id.to_string()))
    }
}

#[cfg(windows)]
#[derive(Clone, Debug, PartialEq, Eq)]
struct ProcessInfo {
    pid: u32,
    parent_pid: u32,
}

#[cfg(windows)]
fn process_tree_pids(processes: &[ProcessInfo], root_pid: u32) -> Vec<u32> {
    let mut to_kill = vec![root_pid];
    let mut index = 0;
    while index < to_kill.len() {
        let parent = to_kill[index];
        for child in processes.iter().filter(|info| info.parent_pid == parent) {
            if !to_kill.contains(&child.pid) {
                to_kill.push(child.pid);
            }
        }
        index += 1;
    }
    to_kill
}

#[cfg(windows)]
fn terminate_windows_process_tree(root_pid: u32) {
    use std::mem::size_of;
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };

    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
    if snapshot == INVALID_HANDLE_VALUE {
        return;
    }
    let mut processes = Vec::new();
    let mut entry = PROCESSENTRY32W {
        dwSize: size_of::<PROCESSENTRY32W>() as u32,
        ..Default::default()
    };
    let mut has_entry = unsafe { Process32FirstW(snapshot, &mut entry) } != 0;
    while has_entry {
        processes.push(ProcessInfo {
            pid: entry.th32ProcessID,
            parent_pid: entry.th32ParentProcessID,
        });
        has_entry = unsafe { Process32NextW(snapshot, &mut entry) } != 0;
    }
    unsafe { CloseHandle(snapshot) };

    for pid in process_tree_pids(&processes, root_pid).into_iter().rev() {
        terminate_windows_process(pid);
    }
}

#[cfg(windows)]
fn terminate_windows_process(pid: u32) {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{OpenProcess, TerminateProcess, PROCESS_TERMINATE};
    let handle = unsafe { OpenProcess(PROCESS_TERMINATE, 0, pid) };
    if !handle.is_null() {
        let _ = unsafe { TerminateProcess(handle, 1) };
        unsafe { CloseHandle(handle) };
    }
}

fn collect_events(
    output: &OutputState,
    after_sequence: u64,
    max_events: usize,
    max_bytes: usize,
) -> (Vec<SessionEvent>, u64) {
    let mut events = Vec::new();
    let mut bytes = 0usize;
    for event in output
        .events
        .iter()
        .filter(|event| event.sequence > after_sequence)
    {
        if events.len() >= max_events || bytes.saturating_add(event.data.len()) > max_bytes {
            break;
        }
        bytes = bytes.saturating_add(event.data.len());
        events.push(event.clone());
    }
    let next_after_sequence = events.last().map_or(after_sequence, |event| event.sequence);
    (events, next_after_sequence)
}

impl Drop for SessionStore {
    fn drop(&mut self) {
        for session in self.sessions.values_mut() {
            session.stop();
        }
    }
}

fn read_output(reader: &mut dyn Read, output: &Arc<Mutex<OutputState>>) {
    let mut buffer = [0u8; MAX_SESSION_EVENT_BYTES];
    loop {
        match reader.read(&mut buffer) {
            Ok(0) => break,
            Ok(read) => {
                if let Ok(mut output) = output.lock() {
                    output.push("output", buffer[..read].to_vec());
                } else {
                    break;
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => break,
        }
    }
    if let Ok(mut output) = output.lock() {
        if output.state == "running" {
            output.state = "exited".to_string();
        }
    }
}

fn validate_title(title: &str) -> Result<(), SessionError> {
    if title.trim().is_empty() || title.chars().count() > 120 {
        Err(SessionError::InvalidTitle)
    } else {
        Ok(())
    }
}

fn validate_dimensions(columns: u16, rows: u16) -> Result<(), SessionError> {
    if columns == 0 || rows == 0 || columns > MAX_SESSION_DIMENSION || rows > MAX_SESSION_DIMENSION
    {
        Err(SessionError::InvalidDimensions)
    } else {
        Ok(())
    }
}

fn pty_size(columns: u16, rows: u16) -> PtySize {
    PtySize {
        rows,
        cols: columns,
        pixel_width: 0,
        pixel_height: 0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn validates_specs_and_batches() {
        assert_eq!(validate_title(""), Err(SessionError::InvalidTitle));
        assert_eq!(
            validate_dimensions(0, 24),
            Err(SessionError::InvalidDimensions)
        );
        assert_eq!(validate_dimensions(80, 24), Ok(()));
    }

    #[test]
    fn output_ring_preserves_order_and_bounds_memory() {
        let mut output = OutputState::new();
        output.push("output", vec![1, 2]);
        output.push("output", vec![3]);
        assert_eq!(output.events[0].sequence, 1);
        assert_eq!(output.events[1].sequence, 2);

        for _ in 0..=(MAX_SESSION_BUFFER_BYTES / MAX_SESSION_EVENT_BYTES) {
            output.push("output", vec![7; MAX_SESSION_EVENT_BYTES]);
        }
        assert!(output.buffered_bytes <= MAX_SESSION_BUFFER_BYTES);
        assert!(output.dropped_bytes > 0);
        assert!(output
            .events
            .front()
            .is_some_and(|event| event.sequence > 1));
    }

    #[test]
    fn rejects_missing_session_and_oversized_write() {
        let mut store = SessionStore::new();
        assert_eq!(
            store.snapshot("missing"),
            Err(SessionError::SessionNotFound("missing".to_string()))
        );
        assert_eq!(
            store.write("missing", vec![0; MAX_SESSION_WRITE_BYTES + 1]),
            Err(SessionError::WriteTooLarge)
        );
    }

    #[test]
    fn path_must_be_a_directory() {
        assert!(!Path::new("definitely-not-an-existing-directory").is_dir());
    }

    #[cfg(windows)]
    #[test]
    fn process_tree_excludes_unrelated_console_hosts() {
        let processes = vec![
            ProcessInfo {
                pid: 101,
                parent_pid: 100,
            },
            ProcessInfo {
                pid: 102,
                parent_pid: 101,
            },
            ProcessInfo {
                pid: 200,
                parent_pid: 999,
            },
        ];
        assert_eq!(process_tree_pids(&processes, 100), vec![100, 101, 102]);
        assert!(!process_tree_pids(&processes, 100).contains(&200));
    }

    struct FakeShell {
        closed: bool,
        writes: Vec<Vec<u8>>,
        resizes: Vec<(u16, u16)>,
    }

    impl RemoteShellIo for FakeShell {
        fn try_write(&mut self, data: &[u8]) -> Result<(), RemoteShellError> {
            if self.closed {
                return Err(RemoteShellError::Closed);
            }
            self.writes.push(data.to_vec());
            Ok(())
        }

        fn try_resize(&mut self, columns: u16, rows: u16) -> Result<(), RemoteShellError> {
            if self.closed {
                return Err(RemoteShellError::Closed);
            }
            self.resizes.push((columns, rows));
            Ok(())
        }

        fn request_close(&mut self) {
            self.closed = true;
        }
    }

    #[derive(Clone)]
    struct FakeShellHandle {
        state: Arc<Mutex<FakeShell>>,
    }

    impl FakeShellHandle {
        fn writes(&self) -> Vec<Vec<u8>> {
            self.state.lock().unwrap().writes.clone()
        }

        fn resizes(&self) -> Vec<(u16, u16)> {
            self.state.lock().unwrap().resizes.clone()
        }

        fn is_closed(&self) -> bool {
            self.state.lock().unwrap().closed
        }
    }

    fn fake_ssh_store() -> (SessionStore, FakeShellHandle) {
        struct Bridge {
            state: Arc<Mutex<FakeShell>>,
        }

        impl RemoteShellIo for Bridge {
            fn try_write(&mut self, data: &[u8]) -> Result<(), RemoteShellError> {
                self.state.lock().unwrap().try_write(data)
            }

            fn try_resize(&mut self, columns: u16, rows: u16) -> Result<(), RemoteShellError> {
                self.state.lock().unwrap().try_resize(columns, rows)
            }

            fn request_close(&mut self) {
                self.state.lock().unwrap().request_close()
            }
        }

        let state = Arc::new(Mutex::new(FakeShell {
            closed: false,
            writes: Vec::new(),
            resizes: Vec::new(),
        }));
        let handle = FakeShellHandle {
            state: Arc::clone(&state),
        };
        let mut store = SessionStore::new();
        let shell = Bridge {
            state: Arc::clone(&state),
        };
        store
            .open_ssh(SshSessionSpec {
                title: "remote".to_string(),
                columns: 100,
                rows: 30,
                shell,
            })
            .expect("ssh session should open");
        (store, handle)
    }

    #[test]
    fn ssh_session_lifecycle() {
        let (mut store, handle) = fake_ssh_store();
        let list = store.list().expect("list should succeed");
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].kind, "ssh");
        assert_eq!(list[0].state, "running");
        assert_eq!(list[0].pid, None);
        assert_eq!(list[0].columns, 100);
        assert_eq!(list[0].rows, 30);

        let write = store
            .write("ssh-1", b"ls -la\r".to_vec())
            .expect("write should succeed");
        assert_eq!(write.accepted_bytes, 7);
        assert_eq!(handle.writes(), vec![b"ls -la\r".to_vec()]);

        store
            .resize("ssh-1", 120, 40)
            .expect("resize should succeed");
        assert_eq!(handle.resizes(), vec![(120, 40)]);
        let snapshot = store.snapshot("ssh-1").expect("snapshot should succeed");
        assert_eq!(snapshot.columns, 120);
        assert_eq!(snapshot.rows, 40);
    }

    #[test]
    fn ssh_output_push_chunks_and_subscribe_progress() {
        let (mut store, _handle) = fake_ssh_store();
        let payload = vec![b'x'; MAX_SESSION_EVENT_BYTES * 2 + 16];
        store
            .push_ssh_output("ssh-1", "output", payload.clone())
            .expect("push should succeed");
        let subscription = store
            .subscribe("ssh-1", 0, 256, MAX_SESSION_BATCH_BYTES)
            .expect("subscribe should succeed");
        assert_eq!(subscription.events.len(), 3);
        assert_eq!(
            subscription.next_after_sequence, 3,
            "sequence must advance per chunk"
        );
        let total: usize = subscription
            .events
            .iter()
            .map(|event| event.data.len())
            .sum();
        assert_eq!(total, payload.len());

        let empty = store
            .subscribe("ssh-1", 3, 256, MAX_SESSION_BATCH_BYTES)
            .expect("subscribe after tail should succeed");
        assert!(empty.events.is_empty());
        assert_eq!(empty.next_after_sequence, 3);
    }

    #[test]
    fn ssh_exit_and_close_states() {
        let (mut store, handle) = fake_ssh_store();
        store
            .mark_ssh_exited("ssh-1")
            .expect("exit marking should succeed");
        let snapshot = store.snapshot("ssh-1").expect("snapshot should succeed");
        assert_eq!(snapshot.state, "exited");

        assert_eq!(
            store.write("ssh-1", b"nope".to_vec()),
            Err(SessionError::SessionClosed("ssh-1".to_string()))
        );

        let closed = store.close("ssh-1").expect("close should succeed");
        assert_eq!(closed.state, "exited");
        assert!(handle.is_closed());
        assert_eq!(
            store.snapshot("ssh-1"),
            Err(SessionError::SessionNotFound("ssh-1".to_string()))
        );
    }

    #[test]
    fn ssh_output_rejects_local_session_and_bad_batch() {
        let (mut store, _handle) = fake_ssh_store();
        assert_eq!(
            store.push_ssh_output("ssh-1", "output", Vec::new()),
            Err(SessionError::InvalidBatch)
        );
        assert_eq!(
            store.push_ssh_output("ssh-1", "output", vec![0; MAX_SESSION_BATCH_BYTES + 1]),
            Err(SessionError::InvalidBatch)
        );
        let mut local_store = SessionStore::new();
        local_store
            .open_local(LocalSessionSpec {
                title: "local".to_string(),
                cwd: None,
                shell: None,
                columns: 80,
                rows: 24,
            })
            .expect("local session should open");
        assert_eq!(
            local_store.push_ssh_output("local-1", "output", b"x".to_vec()),
            Err(SessionError::SessionNotFound("local-1".to_string()))
        );
        assert_eq!(
            local_store.mark_ssh_exited("local-1"),
            Err(SessionError::SessionNotFound("local-1".to_string()))
        );
    }
}
