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
    pub columns: u16,
    pub rows: u16,
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
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

pub struct SessionStore {
    sessions: HashMap<String, LocalSession>,
    next_id: u64,
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
            next_id: 1,
        }
    }

    pub fn list(&mut self) -> Result<Vec<SessionSnapshot>, SessionError> {
        let mut snapshots = self
            .sessions
            .values_mut()
            .map(LocalSession::snapshot)
            .collect::<Result<Vec<_>, _>>()?;
        snapshots.sort_by(|left, right| left.id.cmp(&right.id));
        Ok(snapshots)
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
            let mut command = CommandBuilder::new("cmd.exe");
            command.arg("/d");
            command
        };
        #[cfg(not(windows))]
        let mut command = CommandBuilder::new_default_prog();
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

        let id = format!("local-{}", self.next_id);
        self.next_id = self.next_id.saturating_add(1);
        let mut session = LocalSession {
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
        self.sessions.insert(id, session);
        Ok(snapshot)
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
        let session = self.session_mut(session_id)?;
        if session.snapshot()?.state != "running" {
            return Err(SessionError::SessionClosed(session_id.to_string()));
        }
        session
            .writer
            .write_all(&data)
            .and_then(|_| session.writer.flush())
            .map_err(|error| SessionError::Pty(error.to_string()))?;
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
        let session = self.session_mut(session_id)?;
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
        let session = self.session_mut(session_id)?;
        let snapshot = session.snapshot()?;
        let output = session
            .output
            .lock()
            .map_err(|_| SessionError::Pty("output state is unavailable".to_string()))?;
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
        Ok(SessionSubscription {
            session: snapshot,
            events,
            next_after_sequence,
            dropped_bytes: output.dropped_bytes,
        })
    }

    pub fn close(&mut self, session_id: &str) -> Result<SessionSnapshot, SessionError> {
        let mut session = self
            .sessions
            .remove(session_id)
            .ok_or_else(|| SessionError::SessionNotFound(session_id.to_string()))?;
        session.stop();
        session.snapshot()
    }

    fn session_mut(&mut self, session_id: &str) -> Result<&mut LocalSession, SessionError> {
        self.sessions
            .get_mut(session_id)
            .ok_or_else(|| SessionError::SessionNotFound(session_id.to_string()))
    }
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
}
