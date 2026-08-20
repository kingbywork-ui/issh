use serde::Serialize;
use std::collections::{HashMap, VecDeque};
use std::fmt;

pub const MAX_PANE_BUFFER_BYTES: usize = 2 * 1024 * 1024;
pub const MAX_PANE_BATCH_BYTES: usize = 48 * 1024;
pub const MAX_PANE_WRITE_BYTES: usize = 64 * 1024;
pub const MAX_PANE_OUTPUT_CHUNK_BYTES: usize = 32 * 1024;
pub const MAX_PANE_DIMENSION: u16 = 1_000;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PaneSnapshot {
    pub id: String,
    pub workspace_id: String,
    pub session_id: String,
    pub title: String,
    pub columns: u16,
    pub rows: u16,
    pub state: String,
    pub producer_id: String,
    pub input_owner: Option<String>,
    pub next_sequence: u64,
    pub buffered_bytes: usize,
    pub dropped_bytes: usize,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PaneEvent {
    pub sequence: u64,
    pub kind: String,
    pub data: Vec<u8>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PaneSubscription {
    pub pane: PaneSnapshot,
    pub events: Vec<PaneEvent>,
    pub next_after_sequence: u64,
    pub dropped_bytes: usize,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PaneWriteResult {
    pub pane_id: String,
    pub accepted_bytes: usize,
    pub input_owner: String,
}

pub struct PaneOpenSpec {
    pub id: String,
    pub workspace_id: String,
    pub session_id: String,
    pub title: String,
    pub columns: u16,
    pub rows: u16,
    pub producer_id: String,
}

#[derive(Debug, PartialEq, Eq)]
pub enum PaneError {
    InvalidId(String),
    InvalidTitle,
    InvalidDimensions,
    DuplicatePane(String),
    PaneNotFound(String),
    ProducerDenied,
    InputOwnerRequired,
    InputOwnerConflict { current: String },
    InputOwnerDenied,
    WriteTooLarge,
    OutputChunkTooLarge,
    InvalidBatch,
}

impl fmt::Display for PaneError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidId(name) => write!(formatter, "Invalid pane identifier: {name}"),
            Self::InvalidTitle => formatter.write_str("Pane title must contain 1-120 characters"),
            Self::InvalidDimensions => formatter.write_str("Pane dimensions must be 1-1000"),
            Self::DuplicatePane(id) => write!(formatter, "Pane already exists: {id}"),
            Self::PaneNotFound(id) => write!(formatter, "Pane not found: {id}"),
            Self::ProducerDenied => formatter.write_str("Pane producer is not authorized"),
            Self::InputOwnerRequired => formatter.write_str("Pane input ownership is required"),
            Self::InputOwnerConflict { current } => {
                write!(formatter, "Pane input is owned by {current}")
            }
            Self::InputOwnerDenied => formatter.write_str("Pane input owner is not authorized"),
            Self::WriteTooLarge => {
                write!(formatter, "Pane write exceeds {MAX_PANE_WRITE_BYTES} bytes")
            }
            Self::OutputChunkTooLarge => write!(
                formatter,
                "Pane output chunk exceeds {MAX_PANE_OUTPUT_CHUNK_BYTES} bytes"
            ),
            Self::InvalidBatch => formatter.write_str("Pane subscription batch is invalid"),
        }
    }
}

impl std::error::Error for PaneError {}

struct Pane {
    snapshot: PaneSnapshot,
    events: VecDeque<PaneEvent>,
}

pub struct PaneStore {
    panes: HashMap<String, Pane>,
}

impl Default for PaneStore {
    fn default() -> Self {
        Self::new()
    }
}

impl PaneStore {
    pub fn new() -> Self {
        Self {
            panes: HashMap::new(),
        }
    }

    pub fn list(&self) -> Vec<PaneSnapshot> {
        let mut panes: Vec<_> = self.panes.values().map(|pane| pane.snapshot()).collect();
        panes.sort_by(|left, right| left.id.cmp(&right.id));
        panes
    }

    pub fn open(&mut self, spec: PaneOpenSpec) -> Result<PaneSnapshot, PaneError> {
        validate_id(&spec.id, "id")?;
        validate_id(&spec.workspace_id, "workspaceId")?;
        validate_id(&spec.session_id, "sessionId")?;
        validate_id(&spec.producer_id, "producerId")?;
        if spec.title.trim().is_empty() || spec.title.chars().count() > 120 {
            return Err(PaneError::InvalidTitle);
        }
        validate_dimensions(spec.columns, spec.rows)?;
        if self.panes.contains_key(&spec.id) {
            return Err(PaneError::DuplicatePane(spec.id));
        }
        let pane = Pane {
            snapshot: PaneSnapshot {
                id: spec.id.clone(),
                workspace_id: spec.workspace_id,
                session_id: spec.session_id,
                title: spec.title.trim().to_string(),
                columns: spec.columns,
                rows: spec.rows,
                state: "attached".to_string(),
                producer_id: spec.producer_id,
                input_owner: None,
                next_sequence: 1,
                buffered_bytes: 0,
                dropped_bytes: 0,
            },
            events: VecDeque::new(),
        };
        let snapshot = pane.snapshot();
        self.panes.insert(spec.id, pane);
        Ok(snapshot)
    }

    pub fn close(&mut self, pane_id: &str, producer_id: &str) -> Result<PaneSnapshot, PaneError> {
        let pane = self.pane_mut(pane_id)?;
        pane.assert_producer(producer_id)?;
        pane.snapshot.state = "closed".to_string();
        pane.snapshot.input_owner = None;
        pane.events.clear();
        pane.snapshot.buffered_bytes = 0;
        Ok(pane.snapshot())
    }

    pub fn snapshot(&self, pane_id: &str) -> Result<PaneSnapshot, PaneError> {
        Ok(self.pane(pane_id)?.snapshot())
    }

    pub fn claim_input(
        &mut self,
        pane_id: &str,
        owner_id: String,
    ) -> Result<PaneSnapshot, PaneError> {
        validate_id(&owner_id, "ownerId")?;
        let pane = self.pane_mut(pane_id)?;
        if pane.snapshot.state != "attached" {
            return Err(PaneError::PaneNotFound(pane_id.to_string()));
        }
        match &pane.snapshot.input_owner {
            None => pane.snapshot.input_owner = Some(owner_id),
            Some(current) if current == &owner_id => {}
            Some(current) => {
                return Err(PaneError::InputOwnerConflict {
                    current: current.clone(),
                })
            }
        }
        Ok(pane.snapshot())
    }

    pub fn release_input(
        &mut self,
        pane_id: &str,
        owner_id: &str,
    ) -> Result<PaneSnapshot, PaneError> {
        let pane = self.pane_mut(pane_id)?;
        if pane.snapshot.input_owner.as_deref() != Some(owner_id) {
            return Err(PaneError::InputOwnerDenied);
        }
        pane.snapshot.input_owner = None;
        Ok(pane.snapshot())
    }

    pub fn write(
        &self,
        pane_id: &str,
        owner_id: &str,
        data: Vec<u8>,
    ) -> Result<PaneWriteResult, PaneError> {
        if data.is_empty() {
            return Err(PaneError::WriteTooLarge);
        }
        if data.len() > MAX_PANE_WRITE_BYTES {
            return Err(PaneError::WriteTooLarge);
        }
        let pane = self.pane(pane_id)?;
        if pane.snapshot.state != "attached" {
            return Err(PaneError::PaneNotFound(pane_id.to_string()));
        }
        if pane.snapshot.input_owner.as_deref() != Some(owner_id) {
            return Err(PaneError::InputOwnerDenied);
        }
        Ok(PaneWriteResult {
            pane_id: pane_id.to_string(),
            accepted_bytes: data.len(),
            input_owner: owner_id.to_string(),
        })
    }

    pub fn resize(
        &mut self,
        pane_id: &str,
        actor_id: &str,
        columns: u16,
        rows: u16,
    ) -> Result<PaneSnapshot, PaneError> {
        validate_dimensions(columns, rows)?;
        let pane = self.pane_mut(pane_id)?;
        if pane.snapshot.state != "attached" {
            return Err(PaneError::PaneNotFound(pane_id.to_string()));
        }
        if pane.snapshot.input_owner.as_deref() != Some(actor_id)
            && pane.snapshot.producer_id != actor_id
        {
            return Err(PaneError::InputOwnerDenied);
        }
        pane.snapshot.columns = columns;
        pane.snapshot.rows = rows;
        Ok(pane.snapshot())
    }

    pub fn push_output(
        &mut self,
        pane_id: &str,
        producer_id: &str,
        data: Vec<u8>,
    ) -> Result<PaneEvent, PaneError> {
        if data.is_empty() {
            return Err(PaneError::OutputChunkTooLarge);
        }
        if data.len() > MAX_PANE_OUTPUT_CHUNK_BYTES {
            return Err(PaneError::OutputChunkTooLarge);
        }
        let pane = self.pane_mut(pane_id)?;
        pane.assert_producer(producer_id)?;
        if pane.snapshot.state != "attached" {
            return Err(PaneError::PaneNotFound(pane_id.to_string()));
        }
        let event = PaneEvent {
            sequence: pane.snapshot.next_sequence,
            kind: "output".to_string(),
            data,
        };
        pane.snapshot.next_sequence += 1;
        pane.snapshot.buffered_bytes += event.data.len();
        pane.events.push_back(event.clone());
        while pane.snapshot.buffered_bytes > MAX_PANE_BUFFER_BYTES {
            if let Some(removed) = pane.events.pop_front() {
                pane.snapshot.buffered_bytes -= removed.data.len();
                pane.snapshot.dropped_bytes += removed.data.len();
            } else {
                break;
            }
        }
        Ok(event)
    }

    pub fn subscribe(
        &self,
        pane_id: &str,
        after_sequence: u64,
        max_events: usize,
        max_bytes: usize,
    ) -> Result<PaneSubscription, PaneError> {
        if max_events == 0 || max_events > 256 || max_bytes == 0 {
            return Err(PaneError::InvalidBatch);
        }
        let pane = self.pane(pane_id)?;
        let max_bytes = max_bytes.min(MAX_PANE_BATCH_BYTES);
        let first_sequence = pane.events.front().map(|event| event.sequence);
        let mut events = Vec::new();
        let mut bytes = 0;
        for event in pane
            .events
            .iter()
            .filter(|event| event.sequence > after_sequence)
        {
            if events.len() >= max_events || bytes + event.data.len() > max_bytes {
                break;
            }
            bytes += event.data.len();
            events.push(event.clone());
        }
        let next_after_sequence = events
            .last()
            .map(|event| event.sequence)
            .unwrap_or(after_sequence);
        let dropped_bytes = first_sequence
            .filter(|first| after_sequence.saturating_add(1) < *first)
            .map(|_| pane.snapshot.dropped_bytes)
            .unwrap_or(0);
        Ok(PaneSubscription {
            pane: pane.snapshot(),
            events,
            next_after_sequence,
            dropped_bytes,
        })
    }

    fn pane(&self, pane_id: &str) -> Result<&Pane, PaneError> {
        self.panes
            .get(pane_id)
            .ok_or_else(|| PaneError::PaneNotFound(pane_id.to_string()))
    }

    fn pane_mut(&mut self, pane_id: &str) -> Result<&mut Pane, PaneError> {
        self.panes
            .get_mut(pane_id)
            .ok_or_else(|| PaneError::PaneNotFound(pane_id.to_string()))
    }
}

impl Pane {
    fn snapshot(&self) -> PaneSnapshot {
        self.snapshot.clone()
    }

    fn assert_producer(&self, producer_id: &str) -> Result<(), PaneError> {
        if self.snapshot.producer_id == producer_id {
            Ok(())
        } else {
            Err(PaneError::ProducerDenied)
        }
    }
}

fn validate_id(value: &str, name: &str) -> Result<(), PaneError> {
    if value.is_empty()
        || value.len() > 128
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b":._-".contains(&byte))
    {
        return Err(PaneError::InvalidId(name.to_string()));
    }
    Ok(())
}

fn validate_dimensions(columns: u16, rows: u16) -> Result<(), PaneError> {
    if columns == 0 || rows == 0 || columns > MAX_PANE_DIMENSION || rows > MAX_PANE_DIMENSION {
        return Err(PaneError::InvalidDimensions);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn open_store() -> PaneStore {
        let mut store = PaneStore::new();
        store
            .open(PaneOpenSpec {
                id: "pane-1".to_string(),
                workspace_id: "workspace-1".to_string(),
                session_id: "session-1".to_string(),
                title: "Operations".to_string(),
                columns: 120,
                rows: 40,
                producer_id: "herdr-session".to_string(),
            })
            .unwrap();
        store
    }

    #[test]
    fn claims_input_exclusively_and_requires_owner_for_writes() {
        let mut store = open_store();
        store.claim_input("pane-1", "agent-a".to_string()).unwrap();
        assert!(matches!(
            store.claim_input("pane-1", "agent-b".to_string()),
            Err(PaneError::InputOwnerConflict { .. })
        ));
        assert!(matches!(
            store.write("pane-1", "agent-b", vec![1]),
            Err(PaneError::InputOwnerDenied)
        ));
        assert_eq!(
            store
                .write("pane-1", "agent-a", vec![1, 2])
                .unwrap()
                .accepted_bytes,
            2
        );
        store.release_input("pane-1", "agent-a").unwrap();
        assert!(matches!(
            store.write("pane-1", "agent-a", vec![1]),
            Err(PaneError::InputOwnerDenied)
        ));
    }

    #[test]
    fn producer_controls_output_and_resize() {
        let mut store = open_store();
        let event = store
            .push_output("pane-1", "herdr-session", vec![0, 0xff, 0x1b])
            .unwrap();
        assert_eq!(event.sequence, 1);
        assert_eq!(
            store
                .resize("pane-1", "herdr-session", 160, 48)
                .unwrap()
                .columns,
            160
        );
        assert!(matches!(
            store.push_output("pane-1", "other", vec![1]),
            Err(PaneError::ProducerDenied)
        ));
    }

    #[test]
    fn subscriptions_are_cursor_based_and_preserve_raw_bytes() {
        let mut store = open_store();
        store
            .push_output("pane-1", "herdr-session", vec![0, 0xff])
            .unwrap();
        store
            .push_output("pane-1", "herdr-session", vec![0x1b, b'['])
            .unwrap();
        let subscription = store.subscribe("pane-1", 0, 10, 100).unwrap();
        assert_eq!(subscription.events.len(), 2);
        assert_eq!(subscription.events[0].data, vec![0, 0xff]);
        assert_eq!(subscription.next_after_sequence, 2);
        assert!(store.subscribe("pane-1", 2, 0, 100).is_err());
    }

    #[test]
    fn output_buffer_reports_dropped_bytes() {
        let mut store = open_store();
        for _ in 0..(MAX_PANE_BUFFER_BYTES / MAX_PANE_OUTPUT_CHUNK_BYTES + 2) {
            store
                .push_output(
                    "pane-1",
                    "herdr-session",
                    vec![b'x'; MAX_PANE_OUTPUT_CHUNK_BYTES],
                )
                .unwrap();
        }
        let subscription = store
            .subscribe("pane-1", 0, 256, MAX_PANE_BATCH_BYTES)
            .unwrap();
        assert!(subscription.dropped_bytes > 0);
        assert!(subscription.pane.buffered_bytes <= MAX_PANE_BUFFER_BYTES);
    }

    #[test]
    fn rejects_invalid_dimensions_and_oversized_writes() {
        let mut store = PaneStore::new();
        assert_eq!(
            store.open(PaneOpenSpec {
                id: "pane-1".to_string(),
                workspace_id: "workspace-1".to_string(),
                session_id: "session-1".to_string(),
                title: "Pane".to_string(),
                columns: 0,
                rows: 40,
                producer_id: "producer".to_string(),
            }),
            Err(PaneError::InvalidDimensions)
        );
        let mut store = open_store();
        store.claim_input("pane-1", "agent".to_string()).unwrap();
        assert_eq!(
            store.write("pane-1", "agent", vec![0; MAX_PANE_WRITE_BYTES + 1]),
            Err(PaneError::WriteTooLarge)
        );
    }
}
