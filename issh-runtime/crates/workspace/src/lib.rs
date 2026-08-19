use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::fmt;

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSnapshot {
    pub id: String,
    pub title: String,
    pub custom_title: Option<String>,
    pub active: bool,
    pub focused: bool,
    pub profile_type: Option<String>,
    pub profile_name: Option<String>,
    pub profile_id: Option<String>,
    pub host: Option<String>,
    pub user: Option<String>,
    pub port: Option<u16>,
    pub connected: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionBinding {
    pub session_id: String,
    pub bound_at_unix_ms: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    pub id: String,
    pub name: String,
    pub created_at_unix_ms: u64,
    pub bindings: Vec<SessionBinding>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSyncResult {
    pub session_count: usize,
    pub removed_bindings: usize,
}

#[derive(Debug, PartialEq, Eq)]
pub enum WorkspaceError {
    InvalidSession(String),
    DuplicateSession(String),
    InvalidWorkspaceName,
    WorkspaceNotFound(String),
    SessionNotFound(String),
}

impl fmt::Display for WorkspaceError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidSession(id) => write!(formatter, "Invalid session id: {id}"),
            Self::DuplicateSession(id) => write!(formatter, "Duplicate session id: {id}"),
            Self::InvalidWorkspaceName => {
                formatter.write_str("Workspace name must contain 1-120 characters")
            }
            Self::WorkspaceNotFound(id) => write!(formatter, "Workspace not found: {id}"),
            Self::SessionNotFound(id) => write!(formatter, "Session not found: {id}"),
        }
    }
}

impl std::error::Error for WorkspaceError {}

pub struct WorkspaceStore {
    sessions: BTreeMap<String, SessionSnapshot>,
    workspaces: BTreeMap<String, Workspace>,
    next_workspace_id: u64,
}

impl Default for WorkspaceStore {
    fn default() -> Self {
        Self {
            sessions: BTreeMap::new(),
            workspaces: BTreeMap::new(),
            next_workspace_id: 1,
        }
    }
}

impl WorkspaceStore {
    pub fn sync_sessions(
        &mut self,
        sessions: Vec<SessionSnapshot>,
    ) -> Result<SessionSyncResult, WorkspaceError> {
        let mut synchronized = BTreeMap::new();
        for mut session in sessions {
            session.id = session.id.trim().to_string();
            if session.id.is_empty() {
                return Err(WorkspaceError::InvalidSession(session.id));
            }
            let id = session.id.clone();
            if synchronized.insert(id.clone(), session).is_some() {
                return Err(WorkspaceError::DuplicateSession(id));
            }
        }

        let valid_sessions: BTreeSet<_> = synchronized.keys().cloned().collect();
        let mut removed_bindings = 0;
        for workspace in self.workspaces.values_mut() {
            let before = workspace.bindings.len();
            workspace
                .bindings
                .retain(|binding| valid_sessions.contains(&binding.session_id));
            removed_bindings += before - workspace.bindings.len();
        }
        self.sessions = synchronized;

        Ok(SessionSyncResult {
            session_count: self.sessions.len(),
            removed_bindings,
        })
    }

    pub fn list_sessions(&self) -> Vec<SessionSnapshot> {
        self.sessions.values().cloned().collect()
    }

    pub fn create_workspace(
        &mut self,
        name: String,
        now_unix_ms: u64,
    ) -> Result<Workspace, WorkspaceError> {
        let name = name.trim();
        if name.is_empty() || name.chars().count() > 120 {
            return Err(WorkspaceError::InvalidWorkspaceName);
        }

        let id = format!("workspace-{}", self.next_workspace_id);
        self.next_workspace_id += 1;
        let workspace = Workspace {
            id: id.clone(),
            name: name.to_string(),
            created_at_unix_ms: now_unix_ms,
            bindings: Vec::new(),
        };
        self.workspaces.insert(id, workspace.clone());
        Ok(workspace)
    }

    pub fn list_workspaces(&self) -> Vec<Workspace> {
        self.workspaces.values().cloned().collect()
    }

    pub fn bind(
        &mut self,
        workspace_id: &str,
        session_id: &str,
        now_unix_ms: u64,
    ) -> Result<Workspace, WorkspaceError> {
        if !self.sessions.contains_key(session_id) {
            return Err(WorkspaceError::SessionNotFound(session_id.to_string()));
        }
        let workspace = self
            .workspaces
            .get_mut(workspace_id)
            .ok_or_else(|| WorkspaceError::WorkspaceNotFound(workspace_id.to_string()))?;
        if !workspace
            .bindings
            .iter()
            .any(|binding| binding.session_id == session_id)
        {
            workspace.bindings.push(SessionBinding {
                session_id: session_id.to_string(),
                bound_at_unix_ms: now_unix_ms,
            });
            workspace
                .bindings
                .sort_by(|left, right| left.session_id.cmp(&right.session_id));
        }
        Ok(workspace.clone())
    }

    pub fn unbind(
        &mut self,
        workspace_id: &str,
        session_id: &str,
    ) -> Result<Workspace, WorkspaceError> {
        let workspace = self
            .workspaces
            .get_mut(workspace_id)
            .ok_or_else(|| WorkspaceError::WorkspaceNotFound(workspace_id.to_string()))?;
        workspace
            .bindings
            .retain(|binding| binding.session_id != session_id);
        Ok(workspace.clone())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn session(id: &str) -> SessionSnapshot {
        SessionSnapshot {
            id: id.to_string(),
            title: id.to_string(),
            custom_title: None,
            active: false,
            focused: false,
            profile_type: Some("ssh".to_string()),
            profile_name: None,
            profile_id: None,
            host: Some("example.test".to_string()),
            user: Some("developer".to_string()),
            port: Some(22),
            connected: true,
        }
    }

    #[test]
    fn creates_and_binds_workspace() {
        let mut store = WorkspaceStore::default();
        store
            .sync_sessions(vec![session("tab-1")])
            .expect("sessions should sync");
        let workspace = store
            .create_workspace("Operations".to_string(), 10)
            .expect("workspace should be created");
        let workspace = store
            .bind(&workspace.id, "tab-1", 20)
            .expect("session should bind");

        assert_eq!(workspace.bindings.len(), 1);
        assert_eq!(workspace.bindings[0].session_id, "tab-1");
    }

    #[test]
    fn session_sync_removes_stale_bindings() {
        let mut store = WorkspaceStore::default();
        store
            .sync_sessions(vec![session("tab-1")])
            .expect("sessions should sync");
        let workspace = store
            .create_workspace("Operations".to_string(), 10)
            .expect("workspace should be created");
        store
            .bind(&workspace.id, "tab-1", 20)
            .expect("session should bind");

        let result = store
            .sync_sessions(Vec::new())
            .expect("sessions should sync");
        assert_eq!(result.removed_bindings, 1);
        assert!(store.list_workspaces()[0].bindings.is_empty());
    }
}
