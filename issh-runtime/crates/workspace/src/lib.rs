use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::fmt;
use std::path::Path;

const MAX_PROMPT_CHARS: usize = 16_000;
const MAX_RESULT_CHARS: usize = 48_000;
pub const DEFAULT_AGENT_SCOPES: &[&str] = &["context.read", "llm.prompt", "command.propose"];
pub const SUPPORTED_AGENT_SCOPES: &[&str] = &[
    "context.read",
    "llm.prompt",
    "command.propose",
    "command.execute",
];

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
    pub session_id: Option<String>,
    pub profile_id: Option<String>,
    pub host: Option<String>,
    pub user: Option<String>,
    pub status: String,
    pub bound_at_unix_ms: i64,
    pub last_seen_at_unix_ms: i64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    pub id: String,
    pub name: String,
    pub created_at_unix_ms: i64,
    pub bindings: Vec<SessionBinding>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Agent {
    pub id: String,
    pub workspace_id: String,
    pub name: String,
    pub adapter: String,
    pub profile_id: Option<String>,
    pub session_id: Option<String>,
    pub scopes: Vec<String>,
    pub status: String,
    pub created_at_unix_ms: i64,
    pub updated_at_unix_ms: i64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    pub id: String,
    pub workspace_id: String,
    pub agent_id: String,
    pub prompt: String,
    pub status: String,
    pub output: Option<String>,
    pub error: Option<String>,
    pub created_at_unix_ms: i64,
    pub started_at_unix_ms: Option<i64>,
    pub completed_at_unix_ms: Option<i64>,
    pub cancel_requested: bool,
}

impl Task {
    pub fn terminal(&self) -> bool {
        matches!(
            self.status.as_str(),
            "completed" | "failed" | "cancelled" | "interrupted"
        )
    }
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeEvent {
    pub sequence: i64,
    pub workspace_id: String,
    pub entity_type: String,
    pub entity_id: String,
    pub kind: String,
    pub payload: Value,
    pub created_at_unix_ms: i64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSyncResult {
    pub session_count: usize,
    pub reconnected_bindings: usize,
    pub disconnected_bindings: usize,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskWaitResult {
    pub task: Task,
    pub terminal: bool,
    pub retry_after_ms: i64,
}

#[derive(Debug, PartialEq, Eq)]
pub enum WorkspaceError {
    InvalidSession(String),
    DuplicateSession(String),
    InvalidWorkspaceName,
    InvalidAgentName,
    InvalidAdapter(String),
    InvalidAgentScope(String),
    AgentScopeDenied { agent_id: String, scope: String },
    InvalidPrompt,
    ResultTooLarge,
    WorkspaceNotFound(String),
    SessionNotFound(String),
    AgentNotFound(String),
    TaskNotFound(String),
    InvalidTaskTransition(String),
    Storage(String),
}

impl fmt::Display for WorkspaceError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidSession(id) => write!(formatter, "Invalid session id: {id}"),
            Self::DuplicateSession(id) => write!(formatter, "Duplicate session id: {id}"),
            Self::InvalidWorkspaceName => {
                formatter.write_str("Workspace name must contain 1-120 characters")
            }
            Self::InvalidAgentName => {
                formatter.write_str("Agent name must contain 1-120 characters")
            }
            Self::InvalidAdapter(adapter) => {
                write!(formatter, "Unsupported agent adapter: {adapter}")
            }
            Self::InvalidAgentScope(scope) => {
                write!(formatter, "Unsupported agent scope: {scope}")
            }
            Self::AgentScopeDenied { agent_id, scope } => {
                write!(
                    formatter,
                    "Agent {agent_id} is not allowed to use scope {scope}"
                )
            }
            Self::InvalidPrompt => formatter.write_str("Prompt must contain 1-16000 characters"),
            Self::ResultTooLarge => formatter.write_str("Task result exceeds 48000 characters"),
            Self::WorkspaceNotFound(id) => write!(formatter, "Workspace not found: {id}"),
            Self::SessionNotFound(id) => write!(formatter, "Session not found: {id}"),
            Self::AgentNotFound(id) => write!(formatter, "Agent not found: {id}"),
            Self::TaskNotFound(id) => write!(formatter, "Task not found: {id}"),
            Self::InvalidTaskTransition(message) => formatter.write_str(message),
            Self::Storage(message) => write!(formatter, "SQLite state error: {message}"),
        }
    }
}

impl std::error::Error for WorkspaceError {}

impl From<rusqlite::Error> for WorkspaceError {
    fn from(error: rusqlite::Error) -> Self {
        Self::Storage(error.to_string())
    }
}

pub struct WorkspaceStore {
    connection: Connection,
    sessions: BTreeMap<String, SessionSnapshot>,
}

impl WorkspaceStore {
    pub fn open(path: &Path, now_unix_ms: i64) -> Result<Self, WorkspaceError> {
        let connection = Connection::open(path)?;
        Self::initialize(connection, now_unix_ms)
    }

    pub fn open_in_memory(now_unix_ms: i64) -> Result<Self, WorkspaceError> {
        let connection = Connection::open_in_memory()?;
        Self::initialize(connection, now_unix_ms)
    }

    fn initialize(connection: Connection, now_unix_ms: i64) -> Result<Self, WorkspaceError> {
        connection.execute_batch(
            r#"PRAGMA foreign_keys = ON;
             PRAGMA journal_mode = WAL;
             CREATE TABLE IF NOT EXISTS workspaces (
                 row_id INTEGER PRIMARY KEY AUTOINCREMENT,
                 public_id TEXT NOT NULL UNIQUE,
                 name TEXT NOT NULL,
                 created_at_unix_ms INTEGER NOT NULL
             );
             CREATE TABLE IF NOT EXISTS bindings (
                 workspace_id TEXT NOT NULL,
                 binding_key TEXT NOT NULL,
                 session_id TEXT,
                 profile_id TEXT,
                 host TEXT,
                 user TEXT,
                 status TEXT NOT NULL,
                 bound_at_unix_ms INTEGER NOT NULL,
                 last_seen_at_unix_ms INTEGER NOT NULL,
                 PRIMARY KEY (workspace_id, binding_key),
                 FOREIGN KEY (workspace_id) REFERENCES workspaces(public_id) ON DELETE CASCADE
             );
             CREATE TABLE IF NOT EXISTS agents (
                 row_id INTEGER PRIMARY KEY AUTOINCREMENT,
                 public_id TEXT NOT NULL UNIQUE,
                 workspace_id TEXT NOT NULL,
                 name TEXT NOT NULL,
                 adapter TEXT NOT NULL,
                 profile_id TEXT,
                 session_id TEXT,
                 scopes_json TEXT NOT NULL DEFAULT '["context.read","llm.prompt","command.propose"]',
                 status TEXT NOT NULL,
                 created_at_unix_ms INTEGER NOT NULL,
                 updated_at_unix_ms INTEGER NOT NULL,
                 FOREIGN KEY (workspace_id) REFERENCES workspaces(public_id) ON DELETE CASCADE
             );
             CREATE TABLE IF NOT EXISTS tasks (
                 row_id INTEGER PRIMARY KEY AUTOINCREMENT,
                 public_id TEXT NOT NULL UNIQUE,
                 workspace_id TEXT NOT NULL,
                 agent_id TEXT NOT NULL,
                 prompt TEXT NOT NULL,
                 status TEXT NOT NULL,
                 output TEXT,
                 error TEXT,
                 created_at_unix_ms INTEGER NOT NULL,
                 started_at_unix_ms INTEGER,
                 completed_at_unix_ms INTEGER,
                 cancel_requested INTEGER NOT NULL DEFAULT 0,
                 FOREIGN KEY (workspace_id) REFERENCES workspaces(public_id) ON DELETE CASCADE,
                 FOREIGN KEY (agent_id) REFERENCES agents(public_id) ON DELETE CASCADE
             );
             CREATE TABLE IF NOT EXISTS events (
                 sequence INTEGER PRIMARY KEY AUTOINCREMENT,
                 workspace_id TEXT NOT NULL,
                 entity_type TEXT NOT NULL,
                 entity_id TEXT NOT NULL,
                 kind TEXT NOT NULL,
                 payload_json TEXT NOT NULL,
                 created_at_unix_ms INTEGER NOT NULL,
                 FOREIGN KEY (workspace_id) REFERENCES workspaces(public_id) ON DELETE CASCADE
             );
             CREATE INDEX IF NOT EXISTS idx_agents_workspace ON agents(workspace_id);
             CREATE INDEX IF NOT EXISTS idx_tasks_workspace ON tasks(workspace_id);
             CREATE INDEX IF NOT EXISTS idx_events_workspace_sequence ON events(workspace_id, sequence);"#,
        )?;
        if !table_has_column(&connection, "agents", "scopes_json")? {
            connection.execute(
                "ALTER TABLE agents ADD COLUMN scopes_json TEXT NOT NULL
                 DEFAULT '[\"context.read\",\"llm.prompt\",\"command.propose\"]'",
                [],
            )?;
        }
        if !table_has_column(&connection, "agents", "profile_id")? {
            connection.execute("ALTER TABLE agents ADD COLUMN profile_id TEXT", [])?;
        }
        backfill_agent_profile_ids(&connection)?;

        let interrupted = {
            let mut statement = connection.prepare(
                "SELECT public_id, workspace_id FROM tasks WHERE status IN ('queued', 'running')",
            )?;
            let rows = statement.query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?;
            rows.collect::<Result<Vec<_>, _>>()?
        };
        connection.execute(
            "UPDATE tasks
             SET status = 'interrupted', error = 'Runtime restarted before task completion',
                 completed_at_unix_ms = ?1
             WHERE status IN ('queued', 'running')",
            params![now_unix_ms],
        )?;
        connection.execute(
            "UPDATE agents SET status = 'idle', updated_at_unix_ms = ?1 WHERE status = 'busy'",
            params![now_unix_ms],
        )?;
        for (task_id, workspace_id) in interrupted {
            insert_event(
                &connection,
                &workspace_id,
                "task",
                &task_id,
                "task.interrupted",
                &json!({ "reason": "runtime_restart" }),
                now_unix_ms,
            )?;
        }

        Ok(Self {
            connection,
            sessions: BTreeMap::new(),
        })
    }

    pub fn sync_sessions(
        &mut self,
        sessions: Vec<SessionSnapshot>,
        now_unix_ms: i64,
    ) -> Result<SessionSyncResult, WorkspaceError> {
        backfill_agent_profile_ids(&self.connection)?;
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

        let bindings = self.load_all_binding_rows()?;
        let mut reconnected_bindings = 0;
        let mut disconnected_bindings = 0;
        let mut used_session_ids = BTreeSet::new();
        let mut matched_bindings = Vec::new();
        for binding in bindings.iter().cloned() {
            // SSH session ids are process-local and are reused after a runtime restart.
            // A stable profile id must therefore win over an old id that may now belong
            // to another tab. Bindings without a profile id (legacy/local) can still use
            // their exact session id.
            let matched = if let Some(profile_id) = binding.profile_id.as_ref() {
                synchronized.values().find(|session| {
                    !used_session_ids.contains(&session.id)
                        && session.profile_id.as_ref() == Some(profile_id)
                })
            } else {
                binding.session_id.as_ref().and_then(|id| {
                    synchronized
                        .get(id)
                        .filter(|session| !used_session_ids.contains(&session.id))
                })
            };
            if let Some(session) = matched.cloned() {
                used_session_ids.insert(session.id.clone());
                if binding.session_id.as_deref() != Some(session.id.as_str()) {
                    reconnected_bindings += 1;
                }
                matched_bindings.push(MatchedBinding { binding, session });
            } else if binding.status != "disconnected" {
                disconnected_bindings += 1;
            }
        }

        let transaction = self.connection.transaction()?;
        update_agent_sessions(&transaction, &matched_bindings, now_unix_ms)?;
        for matched in &matched_bindings {
            let status = if matched.session.connected {
                "connected"
            } else {
                "disconnected"
            };
            transaction.execute(
                "UPDATE bindings
                 SET session_id = ?1, profile_id = ?2, host = ?3, user = ?4,
                     status = ?5, last_seen_at_unix_ms = ?6
                 WHERE workspace_id = ?7 AND binding_key = ?8",
                params![
                    matched.session.id,
                    matched.session.profile_id,
                    matched.session.host,
                    matched.session.user,
                    status,
                    now_unix_ms,
                    matched.binding.workspace_id,
                    matched.binding.binding_key,
                ],
            )?;
        }
        for binding in &bindings {
            if !matched_bindings.iter().any(|matched| {
                matched.binding.workspace_id == binding.workspace_id
                    && matched.binding.binding_key == binding.binding_key
            }) {
                transaction.execute(
                    "UPDATE bindings SET status = 'disconnected'
                     WHERE workspace_id = ?1 AND binding_key = ?2",
                    params![binding.workspace_id, binding.binding_key],
                )?;
            }
        }
        transaction.commit()?;
        self.sessions = synchronized;

        Ok(SessionSyncResult {
            session_count: self.sessions.len(),
            reconnected_bindings,
            disconnected_bindings,
        })
    }

    pub fn list_sessions(&self) -> Vec<SessionSnapshot> {
        self.sessions.values().cloned().collect()
    }

    pub fn create_workspace(
        &mut self,
        name: String,
        now_unix_ms: i64,
    ) -> Result<Workspace, WorkspaceError> {
        let name = name.trim();
        if name.is_empty() || name.chars().count() > 120 {
            return Err(WorkspaceError::InvalidWorkspaceName);
        }
        let transaction = self.connection.transaction()?;
        transaction.execute(
            "INSERT INTO workspaces(public_id, name, created_at_unix_ms) VALUES('', ?1, ?2)",
            params![name, now_unix_ms],
        )?;
        let id = format!("workspace-{}", transaction.last_insert_rowid());
        transaction.execute(
            "UPDATE workspaces SET public_id = ?1 WHERE row_id = last_insert_rowid()",
            params![id],
        )?;
        insert_event(
            &transaction,
            &id,
            "workspace",
            &id,
            "workspace.created",
            &json!({ "name": name }),
            now_unix_ms,
        )?;
        transaction.commit()?;
        self.get_workspace(&id)
    }

    pub fn get_workspace(&self, workspace_id: &str) -> Result<Workspace, WorkspaceError> {
        let row = self
            .connection
            .query_row(
                "SELECT public_id, name, created_at_unix_ms FROM workspaces WHERE public_id = ?1",
                params![workspace_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, i64>(2)?,
                    ))
                },
            )
            .optional()?;
        let (id, name, created_at_unix_ms) =
            row.ok_or_else(|| WorkspaceError::WorkspaceNotFound(workspace_id.to_string()))?;
        Ok(Workspace {
            bindings: self.load_bindings(&id)?,
            id,
            name,
            created_at_unix_ms,
        })
    }

    pub fn list_workspaces(&self) -> Result<Vec<Workspace>, WorkspaceError> {
        let rows = {
            let mut statement = self.connection.prepare(
                "SELECT public_id, name, created_at_unix_ms FROM workspaces ORDER BY row_id",
            )?;
            let rows = statement.query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                ))
            })?;
            rows.collect::<Result<Vec<_>, _>>()?
        };
        rows.into_iter()
            .map(|(id, name, created_at_unix_ms)| {
                Ok(Workspace {
                    bindings: self.load_bindings(&id)?,
                    id,
                    name,
                    created_at_unix_ms,
                })
            })
            .collect()
    }

    pub fn bind(
        &mut self,
        workspace_id: &str,
        session_id: &str,
        now_unix_ms: i64,
    ) -> Result<Workspace, WorkspaceError> {
        self.ensure_workspace(workspace_id)?;
        let session = self
            .sessions
            .get(session_id)
            .cloned()
            .ok_or_else(|| WorkspaceError::SessionNotFound(session_id.to_string()))?;
        let binding_key = session
            .profile_id
            .as_ref()
            .map(|id| format!("profile:{id}"))
            .unwrap_or_else(|| format!("session:{}", session.id));
        let bound_elsewhere = self
            .connection
            .query_row(
                "SELECT workspace_id FROM bindings
             WHERE workspace_id <> ?1 AND (binding_key = ?2 OR session_id = ?3)
             LIMIT 1",
                params![workspace_id, binding_key, session.id],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        if let Some(other_workspace_id) = bound_elsewhere {
            insert_event(
                &self.connection,
                workspace_id,
                "security",
                session_id,
                "security.binding_denied",
                &json!({ "reason": "bound_to_other_workspace", "otherWorkspaceId": other_workspace_id }),
                now_unix_ms,
            )?;
            return Err(WorkspaceError::InvalidSession(format!(
                "{session_id} is already bound to workspace {other_workspace_id}"
            )));
        }
        let status = if session.connected {
            "connected"
        } else {
            "disconnected"
        };
        let transaction = self.connection.transaction()?;
        transaction.execute(
            "INSERT INTO bindings(
                 workspace_id, binding_key, session_id, profile_id, host, user, status,
                 bound_at_unix_ms, last_seen_at_unix_ms
             ) VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)
             ON CONFLICT(workspace_id, binding_key) DO UPDATE SET
                 session_id = excluded.session_id, profile_id = excluded.profile_id,
                 host = excluded.host, user = excluded.user, status = excluded.status,
                 last_seen_at_unix_ms = excluded.last_seen_at_unix_ms",
            params![
                workspace_id,
                binding_key,
                session.id,
                session.profile_id,
                session.host,
                session.user,
                status,
                now_unix_ms,
            ],
        )?;
        insert_event(
            &transaction,
            workspace_id,
            "binding",
            session_id,
            "binding.connected",
            &json!({ "sessionId": session_id, "profileId": session.profile_id }),
            now_unix_ms,
        )?;
        transaction.commit()?;
        self.get_workspace(workspace_id)
    }

    pub fn unbind(
        &mut self,
        workspace_id: &str,
        session_id: &str,
        now_unix_ms: i64,
    ) -> Result<Workspace, WorkspaceError> {
        self.ensure_workspace(workspace_id)?;
        let transaction = self.connection.transaction()?;
        transaction.execute(
            "DELETE FROM bindings WHERE workspace_id = ?1 AND session_id = ?2",
            params![workspace_id, session_id],
        )?;
        insert_event(
            &transaction,
            workspace_id,
            "binding",
            session_id,
            "binding.removed",
            &json!({ "sessionId": session_id }),
            now_unix_ms,
        )?;
        transaction.commit()?;
        self.get_workspace(workspace_id)
    }

    pub fn register_agent(
        &mut self,
        workspace_id: &str,
        name: String,
        adapter: String,
        session_id: Option<String>,
        scopes: Option<Vec<String>>,
        now_unix_ms: i64,
    ) -> Result<Agent, WorkspaceError> {
        self.ensure_workspace(workspace_id)?;
        let name = name.trim();
        if name.is_empty() || name.chars().count() > 120 {
            return Err(WorkspaceError::InvalidAgentName);
        }
        let adapter = adapter.trim();
        if adapter != "llm" {
            return Err(WorkspaceError::InvalidAdapter(adapter.to_string()));
        }
        let scopes = normalize_agent_scopes(scopes)?;
        let profile_id = session_id
            .as_ref()
            .and_then(|id| self.sessions.get(id))
            .and_then(|session| session.profile_id.clone());
        if let Some(session_id) = session_id.as_ref() {
            if !self.sessions.contains_key(session_id) {
                return Err(WorkspaceError::SessionNotFound(session_id.clone()));
            }
            let is_bound = self.connection.query_row(
                "SELECT EXISTS(
                    SELECT 1 FROM bindings WHERE workspace_id = ?1 AND session_id = ?2
                 )",
                params![workspace_id, session_id],
                |row| row.get::<_, bool>(0),
            )?;
            if !is_bound {
                insert_event(
                    &self.connection,
                    workspace_id,
                    "security",
                    session_id,
                    "security.agent_registration_denied",
                    &json!({ "reason": "session_not_bound" }),
                    now_unix_ms,
                )?;
                return Err(WorkspaceError::InvalidSession(format!(
                    "{session_id} is not bound to workspace {workspace_id}"
                )));
            }
        }
        let scopes_json = serde_json::to_string(&scopes)
            .map_err(|error| WorkspaceError::Storage(error.to_string()))?;
        let transaction = self.connection.transaction()?;
        transaction.execute(
            "INSERT INTO agents(
                 public_id, workspace_id, name, adapter, profile_id, session_id, scopes_json, status,
                 created_at_unix_ms, updated_at_unix_ms
             ) VALUES('', ?1, ?2, ?3, ?4, ?5, ?6, 'idle', ?7, ?7)",
            params![
                workspace_id,
                name,
                adapter,
                profile_id,
                session_id,
                scopes_json,
                now_unix_ms
            ],
        )?;
        let id = format!("agent-{}", transaction.last_insert_rowid());
        transaction.execute(
            "UPDATE agents SET public_id = ?1 WHERE row_id = last_insert_rowid()",
            params![id],
        )?;
        insert_event(
            &transaction,
            workspace_id,
            "agent",
            &id,
            "agent.registered",
            &json!({
                "name": name,
                "adapter": adapter,
                "profileId": profile_id,
                "sessionId": session_id,
                "scopes": scopes,
            }),
            now_unix_ms,
        )?;
        transaction.commit()?;
        self.get_agent(&id)
    }

    pub fn unregister_agent(
        &mut self,
        workspace_id: &str,
        agent_id: &str,
        now_unix_ms: i64,
    ) -> Result<(), WorkspaceError> {
        self.ensure_workspace(workspace_id)?;
        let agent = self.get_agent(agent_id)?;
        if agent.workspace_id != workspace_id {
            return Err(WorkspaceError::AgentNotFound(agent_id.to_string()));
        }
        let transaction = self.connection.transaction()?;
        let deleted = transaction.execute(
            "DELETE FROM agents WHERE public_id = ?1 AND workspace_id = ?2",
            params![agent_id, workspace_id],
        )?;
        if deleted == 0 {
            return Err(WorkspaceError::AgentNotFound(agent_id.to_string()));
        }
        insert_event(
            &transaction,
            workspace_id,
            "agent",
            agent_id,
            "agent.unregistered",
            &json!({
                "name": agent.name,
                "adapter": agent.adapter,
                "profileId": agent.profile_id,
                "sessionId": agent.session_id,
            }),
            now_unix_ms,
        )?;
        transaction.commit()?;
        Ok(())
    }

    pub fn list_agents(&self, workspace_id: &str) -> Result<Vec<Agent>, WorkspaceError> {
        self.ensure_workspace(workspace_id)?;
        let mut statement = self.connection.prepare(
            "SELECT public_id, workspace_id, name, adapter, profile_id, session_id, scopes_json,
                    status, created_at_unix_ms, updated_at_unix_ms
             FROM agents WHERE workspace_id = ?1 ORDER BY row_id",
        )?;
        let rows = statement.query_map(params![workspace_id], map_agent)?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    pub fn get_agent(&self, agent_id: &str) -> Result<Agent, WorkspaceError> {
        self.connection
            .query_row(
                "SELECT public_id, workspace_id, name, adapter, profile_id, session_id, scopes_json,
                        status, created_at_unix_ms, updated_at_unix_ms
                 FROM agents WHERE public_id = ?1",
                params![agent_id],
                map_agent,
            )
            .optional()?
            .ok_or_else(|| WorkspaceError::AgentNotFound(agent_id.to_string()))
    }

    pub fn authorize_agent(
        &self,
        agent_id: &str,
        scope: &str,
        now_unix_ms: i64,
    ) -> Result<Agent, WorkspaceError> {
        if !SUPPORTED_AGENT_SCOPES.contains(&scope) {
            return Err(WorkspaceError::InvalidAgentScope(scope.to_string()));
        }
        let agent = self.get_agent(agent_id)?;
        if agent.scopes.iter().any(|candidate| candidate == scope) {
            insert_event(
                &self.connection,
                &agent.workspace_id,
                "security",
                agent_id,
                "security.scope_authorized",
                &json!({ "scope": scope }),
                now_unix_ms,
            )?;
            Ok(agent)
        } else {
            insert_event(
                &self.connection,
                &agent.workspace_id,
                "security",
                agent_id,
                "security.scope_denied",
                &json!({ "scope": scope }),
                now_unix_ms,
            )?;
            Err(WorkspaceError::AgentScopeDenied {
                agent_id: agent_id.to_string(),
                scope: scope.to_string(),
            })
        }
    }

    pub fn create_task(
        &mut self,
        agent_id: &str,
        prompt: String,
        now_unix_ms: i64,
    ) -> Result<Task, WorkspaceError> {
        let agent = self.get_agent(agent_id)?;
        self.authorize_agent(agent_id, "llm.prompt", now_unix_ms)?;
        let prompt = prompt.trim();
        if prompt.is_empty() || prompt.chars().count() > MAX_PROMPT_CHARS {
            return Err(WorkspaceError::InvalidPrompt);
        }
        let transaction = self.connection.transaction()?;
        transaction.execute(
            "INSERT INTO tasks(
                 public_id, workspace_id, agent_id, prompt, status, created_at_unix_ms
             ) VALUES('', ?1, ?2, ?3, 'queued', ?4)",
            params![agent.workspace_id, agent_id, prompt, now_unix_ms],
        )?;
        let id = format!("task-{}", transaction.last_insert_rowid());
        transaction.execute(
            "UPDATE tasks SET public_id = ?1 WHERE row_id = last_insert_rowid()",
            params![id],
        )?;
        transaction.execute(
            "UPDATE agents SET status = 'busy', updated_at_unix_ms = ?1 WHERE public_id = ?2",
            params![now_unix_ms, agent_id],
        )?;
        insert_event(
            &transaction,
            &agent.workspace_id,
            "task",
            &id,
            "task.queued",
            &json!({ "agentId": agent_id }),
            now_unix_ms,
        )?;
        transaction.commit()?;
        self.get_task(&id)
    }

    pub fn start_task(&mut self, task_id: &str, now_unix_ms: i64) -> Result<Task, WorkspaceError> {
        let task = self.get_task(task_id)?;
        if task.status != "queued" {
            return Err(WorkspaceError::InvalidTaskTransition(format!(
                "Task {task_id} cannot start from {}",
                task.status
            )));
        }
        let transaction = self.connection.transaction()?;
        transaction.execute(
            "UPDATE tasks SET status = 'running', started_at_unix_ms = ?1 WHERE public_id = ?2",
            params![now_unix_ms, task_id],
        )?;
        insert_event(
            &transaction,
            &task.workspace_id,
            "task",
            task_id,
            "task.started",
            &json!({}),
            now_unix_ms,
        )?;
        transaction.commit()?;
        self.get_task(task_id)
    }

    pub fn complete_task(
        &mut self,
        task_id: &str,
        output: String,
        now_unix_ms: i64,
    ) -> Result<Task, WorkspaceError> {
        if output.chars().count() > MAX_RESULT_CHARS {
            return Err(WorkspaceError::ResultTooLarge);
        }
        self.finish_task(task_id, "completed", Some(output), None, now_unix_ms)
    }

    pub fn fail_task(
        &mut self,
        task_id: &str,
        error: String,
        now_unix_ms: i64,
    ) -> Result<Task, WorkspaceError> {
        let error = truncate_chars(error.trim(), MAX_RESULT_CHARS);
        self.finish_task(task_id, "failed", None, Some(error), now_unix_ms)
    }

    fn finish_task(
        &mut self,
        task_id: &str,
        status: &str,
        output: Option<String>,
        error: Option<String>,
        now_unix_ms: i64,
    ) -> Result<Task, WorkspaceError> {
        let task = self.get_task(task_id)?;
        if task.status == "cancelled" {
            return Ok(task);
        }
        if task.terminal() {
            return Err(WorkspaceError::InvalidTaskTransition(format!(
                "Task {task_id} is already {}",
                task.status
            )));
        }
        let transaction = self.connection.transaction()?;
        transaction.execute(
            "UPDATE tasks SET status = ?1, output = ?2, error = ?3,
                 completed_at_unix_ms = ?4 WHERE public_id = ?5",
            params![status, output, error, now_unix_ms, task_id],
        )?;
        transaction.execute(
            "UPDATE agents SET status = 'idle', updated_at_unix_ms = ?1 WHERE public_id = ?2",
            params![now_unix_ms, task.agent_id],
        )?;
        insert_event(
            &transaction,
            &task.workspace_id,
            "task",
            task_id,
            &format!("task.{status}"),
            &json!({}),
            now_unix_ms,
        )?;
        transaction.commit()?;
        self.get_task(task_id)
    }

    pub fn cancel_task(&mut self, task_id: &str, now_unix_ms: i64) -> Result<Task, WorkspaceError> {
        let task = self.get_task(task_id)?;
        if task.terminal() {
            return Ok(task);
        }
        let transaction = self.connection.transaction()?;
        transaction.execute(
            "UPDATE tasks SET status = 'cancelled', cancel_requested = 1,
                 completed_at_unix_ms = ?1 WHERE public_id = ?2",
            params![now_unix_ms, task_id],
        )?;
        transaction.execute(
            "UPDATE agents SET status = 'idle', updated_at_unix_ms = ?1 WHERE public_id = ?2",
            params![now_unix_ms, task.agent_id],
        )?;
        insert_event(
            &transaction,
            &task.workspace_id,
            "task",
            task_id,
            "task.cancelled",
            &json!({}),
            now_unix_ms,
        )?;
        transaction.commit()?;
        self.get_task(task_id)
    }

    pub fn get_task(&self, task_id: &str) -> Result<Task, WorkspaceError> {
        self.connection
            .query_row(
                "SELECT public_id, workspace_id, agent_id, prompt, status, output, error,
                        created_at_unix_ms, started_at_unix_ms, completed_at_unix_ms,
                        cancel_requested
                 FROM tasks WHERE public_id = ?1",
                params![task_id],
                map_task,
            )
            .optional()?
            .ok_or_else(|| WorkspaceError::TaskNotFound(task_id.to_string()))
    }

    pub fn wait_task(&self, task_id: &str) -> Result<TaskWaitResult, WorkspaceError> {
        let task = self.get_task(task_id)?;
        Ok(TaskWaitResult {
            terminal: task.terminal(),
            retry_after_ms: if task.terminal() { 0 } else { 250 },
            task,
        })
    }

    pub fn list_tasks(&self, workspace_id: &str) -> Result<Vec<Task>, WorkspaceError> {
        self.ensure_workspace(workspace_id)?;
        let mut statement = self.connection.prepare(
            "SELECT public_id, workspace_id, agent_id, prompt, status, output, error,
                    created_at_unix_ms, started_at_unix_ms, completed_at_unix_ms,
                    cancel_requested
             FROM tasks WHERE workspace_id = ?1 ORDER BY row_id DESC",
        )?;
        let rows = statement.query_map(params![workspace_id], map_task)?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    pub fn list_events(
        &self,
        workspace_id: &str,
        after_sequence: i64,
        limit: usize,
    ) -> Result<Vec<RuntimeEvent>, WorkspaceError> {
        self.ensure_workspace(workspace_id)?;
        let limit = limit.clamp(1, 500) as i64;
        let mut statement = self.connection.prepare(
            "SELECT sequence, workspace_id, entity_type, entity_id, kind, payload_json,
                    created_at_unix_ms
             FROM events WHERE workspace_id = ?1 AND sequence > ?2
             ORDER BY sequence LIMIT ?3",
        )?;
        let rows = statement.query_map(params![workspace_id, after_sequence, limit], |row| {
            let payload_json: String = row.get(5)?;
            Ok(RuntimeEvent {
                sequence: row.get(0)?,
                workspace_id: row.get(1)?,
                entity_type: row.get(2)?,
                entity_id: row.get(3)?,
                kind: row.get(4)?,
                payload: serde_json::from_str(&payload_json).unwrap_or(Value::Null),
                created_at_unix_ms: row.get(6)?,
            })
        })?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    fn ensure_workspace(&self, workspace_id: &str) -> Result<(), WorkspaceError> {
        let exists = self.connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM workspaces WHERE public_id = ?1)",
            params![workspace_id],
            |row| row.get::<_, bool>(0),
        )?;
        if exists {
            Ok(())
        } else {
            Err(WorkspaceError::WorkspaceNotFound(workspace_id.to_string()))
        }
    }

    fn load_bindings(&self, workspace_id: &str) -> Result<Vec<SessionBinding>, WorkspaceError> {
        let mut statement = self.connection.prepare(
            "SELECT session_id, profile_id, host, user, status, bound_at_unix_ms,
                    last_seen_at_unix_ms
             FROM bindings WHERE workspace_id = ?1 ORDER BY bound_at_unix_ms",
        )?;
        let rows = statement.query_map(params![workspace_id], |row| {
            Ok(SessionBinding {
                session_id: row.get(0)?,
                profile_id: row.get(1)?,
                host: row.get(2)?,
                user: row.get(3)?,
                status: row.get(4)?,
                bound_at_unix_ms: row.get(5)?,
                last_seen_at_unix_ms: row.get(6)?,
            })
        })?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    fn load_all_binding_rows(&self) -> Result<Vec<BindingRow>, WorkspaceError> {
        let mut statement = self.connection.prepare(
            "SELECT workspace_id, binding_key, session_id, profile_id, status FROM bindings",
        )?;
        let rows = statement.query_map([], |row| {
            Ok(BindingRow {
                workspace_id: row.get(0)?,
                binding_key: row.get(1)?,
                session_id: row.get(2)?,
                profile_id: row.get(3)?,
                status: row.get(4)?,
            })
        })?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }
}

#[derive(Clone)]
struct BindingRow {
    workspace_id: String,
    binding_key: String,
    session_id: Option<String>,
    profile_id: Option<String>,
    status: String,
}

struct MatchedBinding {
    binding: BindingRow,
    session: SessionSnapshot,
}

fn map_agent(row: &rusqlite::Row<'_>) -> rusqlite::Result<Agent> {
    let scopes_json: String = row.get(6)?;
    Ok(Agent {
        id: row.get(0)?,
        workspace_id: row.get(1)?,
        name: row.get(2)?,
        adapter: row.get(3)?,
        profile_id: row.get(4)?,
        session_id: row.get(5)?,
        scopes: serde_json::from_str(&scopes_json).unwrap_or_else(|_| {
            DEFAULT_AGENT_SCOPES
                .iter()
                .map(|scope| (*scope).to_string())
                .collect()
        }),
        status: row.get(7)?,
        created_at_unix_ms: row.get(8)?,
        updated_at_unix_ms: row.get(9)?,
    })
}

fn backfill_agent_profile_ids(connection: &Connection) -> Result<(), WorkspaceError> {
    let candidates = {
        let mut statement = connection.prepare(
            "SELECT public_id, workspace_id, session_id, created_at_unix_ms
             FROM agents WHERE profile_id IS NULL AND session_id IS NOT NULL",
        )?;
        let rows = statement.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, i64>(3)?,
            ))
        })?;
        rows.collect::<Result<Vec<_>, _>>()?
    };

    for (agent_id, workspace_id, session_id, created_at_unix_ms) in candidates {
        if let Some(profile_id) = find_legacy_agent_profile_id(
            connection,
            &agent_id,
            &workspace_id,
            &session_id,
            created_at_unix_ms,
        )? {
            connection.execute(
                "UPDATE agents SET profile_id = ?1
                 WHERE public_id = ?2 AND profile_id IS NULL",
                params![profile_id, agent_id],
            )?;
        }
    }
    Ok(())
}

fn find_legacy_agent_profile_id(
    connection: &Connection,
    agent_id: &str,
    workspace_id: &str,
    session_id: &str,
    created_at_unix_ms: i64,
) -> Result<Option<String>, WorkspaceError> {
    let mut registered_session_id = session_id.to_string();
    let registration_payload = connection
        .query_row(
            "SELECT payload_json FROM events
             WHERE workspace_id = ?1 AND entity_type = 'agent' AND entity_id = ?2
               AND kind = 'agent.registered'
             ORDER BY sequence DESC LIMIT 1",
            params![workspace_id, agent_id],
            |row| row.get::<_, String>(0),
        )
        .optional()?;
    if let Some(payload) = registration_payload {
        if let Ok(payload) = serde_json::from_str::<Value>(&payload) {
            if let Some(profile_id) = payload.get("profileId").and_then(Value::as_str) {
                return Ok(Some(profile_id.to_string()));
            }
            if let Some(session_id) = payload.get("sessionId").and_then(Value::as_str) {
                registered_session_id = session_id.to_string();
            }
        }
    }

    let mut statement = connection.prepare(
        "SELECT payload_json, created_at_unix_ms FROM events
         WHERE workspace_id = ?1 AND entity_type = 'binding' AND kind = 'binding.connected'
         ORDER BY sequence",
    )?;
    let rows = statement.query_map(params![workspace_id], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
    })?;
    let mut profile_id = None;
    for row in rows {
        let (payload, event_time) = row?;
        if event_time <= created_at_unix_ms {
            if let Some(candidate) = profile_id_from_payload(&payload, &registered_session_id) {
                profile_id = Some(candidate);
            }
        }
    }
    Ok(profile_id)
}

fn profile_id_from_payload(payload_json: &str, session_id: &str) -> Option<String> {
    let payload: Value = serde_json::from_str(payload_json).ok()?;
    if payload.get("sessionId").and_then(Value::as_str) != Some(session_id) {
        return None;
    }
    payload
        .get("profileId")
        .and_then(Value::as_str)
        .map(str::to_string)
}

fn update_agent_sessions(
    transaction: &Transaction<'_>,
    matched_bindings: &[MatchedBinding],
    now_unix_ms: i64,
) -> Result<(), WorkspaceError> {
    let mut legacy_migrations = BTreeMap::new();
    for matched in matched_bindings {
        let old_session_id = matched.binding.session_id.as_deref();
        let new_session_id = matched.session.id.as_str();
        if old_session_id == Some(new_session_id) {
            continue;
        }
        if let Some(profile_id) = matched.binding.profile_id.as_ref() {
            transaction.execute(
                "UPDATE agents SET session_id = ?1, profile_id = ?2, updated_at_unix_ms = ?3
                 WHERE workspace_id = ?4 AND profile_id = ?2",
                params![
                    new_session_id,
                    profile_id,
                    now_unix_ms,
                    matched.binding.workspace_id
                ],
            )?;
        } else if let Some(old_session_id) = old_session_id {
            let key = (
                matched.binding.workspace_id.clone(),
                old_session_id.to_string(),
            );
            match legacy_migrations.get(&key) {
                Some(existing) if existing != new_session_id => continue,
                _ => {
                    legacy_migrations.insert(key, new_session_id.to_string());
                }
            }
        }
    }

    if legacy_migrations.is_empty() {
        return Ok(());
    }
    transaction.execute_batch(
        "CREATE TEMP TABLE IF NOT EXISTS issh_session_migrations (
             workspace_id TEXT NOT NULL,
             old_session_id TEXT NOT NULL,
             new_session_id TEXT NOT NULL,
             PRIMARY KEY(workspace_id, old_session_id)
         )",
    )?;
    transaction.execute("DELETE FROM issh_session_migrations", [])?;
    for ((workspace_id, old_session_id), new_session_id) in legacy_migrations {
        transaction.execute(
            "INSERT INTO issh_session_migrations(workspace_id, old_session_id, new_session_id)
             VALUES(?1, ?2, ?3)",
            params![workspace_id, old_session_id, new_session_id],
        )?;
    }
    transaction.execute(
        "UPDATE agents
         SET session_id = (
             SELECT new_session_id FROM issh_session_migrations
             WHERE workspace_id = agents.workspace_id AND old_session_id = agents.session_id
         ), updated_at_unix_ms = ?1
         WHERE profile_id IS NULL AND EXISTS (
             SELECT 1 FROM issh_session_migrations
             WHERE workspace_id = agents.workspace_id AND old_session_id = agents.session_id
         )",
        params![now_unix_ms],
    )?;
    transaction.execute("DELETE FROM issh_session_migrations", [])?;
    Ok(())
}

fn normalize_agent_scopes(scopes: Option<Vec<String>>) -> Result<Vec<String>, WorkspaceError> {
    let candidates = scopes.unwrap_or_else(|| {
        DEFAULT_AGENT_SCOPES
            .iter()
            .map(|scope| (*scope).to_string())
            .collect()
    });
    let mut normalized = Vec::new();
    for scope in candidates {
        let scope = scope.trim();
        if !SUPPORTED_AGENT_SCOPES.contains(&scope) {
            return Err(WorkspaceError::InvalidAgentScope(scope.to_string()));
        }
        if !normalized.iter().any(|candidate| candidate == scope) {
            normalized.push(scope.to_string());
        }
    }
    if !normalized.iter().any(|scope| scope == "llm.prompt") {
        return Err(WorkspaceError::AgentScopeDenied {
            agent_id: "new agent".to_string(),
            scope: "llm.prompt".to_string(),
        });
    }
    Ok(normalized)
}

fn table_has_column(
    connection: &Connection,
    table: &str,
    column: &str,
) -> Result<bool, WorkspaceError> {
    let mut statement = connection.prepare(&format!("PRAGMA table_info({table})"))?;
    let names = statement.query_map([], |row| row.get::<_, String>(1))?;
    for name in names {
        if name? == column {
            return Ok(true);
        }
    }
    Ok(false)
}

fn map_task(row: &rusqlite::Row<'_>) -> rusqlite::Result<Task> {
    Ok(Task {
        id: row.get(0)?,
        workspace_id: row.get(1)?,
        agent_id: row.get(2)?,
        prompt: row.get(3)?,
        status: row.get(4)?,
        output: row.get(5)?,
        error: row.get(6)?,
        created_at_unix_ms: row.get(7)?,
        started_at_unix_ms: row.get(8)?,
        completed_at_unix_ms: row.get(9)?,
        cancel_requested: row.get(10)?,
    })
}

fn insert_event(
    connection: &Connection,
    workspace_id: &str,
    entity_type: &str,
    entity_id: &str,
    kind: &str,
    payload: &Value,
    now_unix_ms: i64,
) -> Result<(), WorkspaceError> {
    connection.execute(
        "INSERT INTO events(
             workspace_id, entity_type, entity_id, kind, payload_json, created_at_unix_ms
         ) VALUES(?1, ?2, ?3, ?4, ?5, ?6)",
        params![
            workspace_id,
            entity_type,
            entity_id,
            kind,
            serde_json::to_string(payload)
                .map_err(|error| WorkspaceError::Storage(error.to_string()))?,
            now_unix_ms,
        ],
    )?;
    Ok(())
}

fn truncate_chars(value: &str, max_chars: usize) -> String {
    value.chars().take(max_chars).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn session(id: &str, profile_id: &str) -> SessionSnapshot {
        SessionSnapshot {
            id: id.to_string(),
            title: id.to_string(),
            custom_title: None,
            active: false,
            focused: false,
            profile_type: Some("ssh".to_string()),
            profile_name: None,
            profile_id: Some(profile_id.to_string()),
            host: Some("example.test".to_string()),
            user: Some("developer".to_string()),
            port: Some(22),
            connected: true,
        }
    }

    #[test]
    fn persists_workspace_agent_task_and_events() {
        let mut store = WorkspaceStore::open_in_memory(1).expect("store should open");
        store
            .sync_sessions(vec![session("tab-1", "profile-1")], 2)
            .expect("sessions should sync");
        let workspace = store
            .create_workspace("Operations".to_string(), 3)
            .expect("workspace should be created");
        store
            .bind(&workspace.id, "tab-1", 4)
            .expect("session should bind");
        let agent = store
            .register_agent(
                &workspace.id,
                "Operator".to_string(),
                "llm".to_string(),
                Some("tab-1".to_string()),
                None,
                5,
            )
            .expect("agent should register");
        let task = store
            .create_task(&agent.id, "Summarize status".to_string(), 6)
            .expect("task should queue");
        store.start_task(&task.id, 7).expect("task should start");
        let task = store
            .complete_task(&task.id, "All systems nominal".to_string(), 8)
            .expect("task should complete");

        assert_eq!(task.status, "completed");
        assert_eq!(store.list_agents(&workspace.id).unwrap()[0].status, "idle");
        let events = store.list_events(&workspace.id, 0, 100).unwrap();
        assert_eq!(events.last().unwrap().kind, "task.completed");
        assert!(events
            .windows(2)
            .all(|pair| pair[0].sequence < pair[1].sequence));
    }

    #[test]
    fn unregister_agent_removes_registration_and_records_event() {
        let mut store = WorkspaceStore::open_in_memory(1).expect("store should open");
        store
            .sync_sessions(vec![session("tab-1", "profile-1")], 2)
            .unwrap();
        let workspace = store.create_workspace("Ops".to_string(), 3).unwrap();
        store.bind(&workspace.id, "tab-1", 4).unwrap();
        let agent = store
            .register_agent(
                &workspace.id,
                "Operator".to_string(),
                "llm".to_string(),
                Some("tab-1".to_string()),
                None,
                5,
            )
            .unwrap();

        store.unregister_agent(&workspace.id, &agent.id, 6).unwrap();

        assert!(store.list_agents(&workspace.id).unwrap().is_empty());
        assert!(matches!(
            store.get_agent(&agent.id),
            Err(WorkspaceError::AgentNotFound(id)) if id == agent.id
        ));
        assert_eq!(
            store
                .list_events(&workspace.id, 0, 100)
                .unwrap()
                .last()
                .unwrap()
                .kind,
            "agent.unregistered"
        );
    }

    #[test]
    fn reconnects_binding_by_profile_identity() {
        let mut store = WorkspaceStore::open_in_memory(1).expect("store should open");
        store
            .sync_sessions(vec![session("tab-1", "profile-1")], 2)
            .unwrap();
        let workspace = store.create_workspace("Ops".to_string(), 3).unwrap();
        store.bind(&workspace.id, "tab-1", 4).unwrap();
        let agent = store
            .register_agent(
                &workspace.id,
                "Operator".to_string(),
                "llm".to_string(),
                Some("tab-1".to_string()),
                None,
                4,
            )
            .unwrap();

        let disconnected = store.sync_sessions(Vec::new(), 5).unwrap();
        assert_eq!(disconnected.disconnected_bindings, 1);
        assert_eq!(
            store.get_workspace(&workspace.id).unwrap().bindings[0].status,
            "disconnected"
        );

        let reconnected = store
            .sync_sessions(vec![session("tab-9", "profile-1")], 6)
            .unwrap();
        assert_eq!(reconnected.reconnected_bindings, 1);
        assert_eq!(
            store.get_workspace(&workspace.id).unwrap().bindings[0]
                .session_id
                .as_deref(),
            Some("tab-9")
        );
        assert_eq!(
            store.list_agents(&workspace.id).unwrap()[0]
                .session_id
                .as_deref(),
            Some("tab-9")
        );
        assert_eq!(agent.session_id.as_deref(), Some("tab-1"));
    }

    #[test]
    fn session_id_reuse_does_not_merge_agents_or_bindings() {
        let mut store = WorkspaceStore::open_in_memory(1).expect("store should open");
        store
            .sync_sessions(
                vec![
                    session("ssh-1", "profile-a"),
                    session("ssh-2", "profile-b"),
                    session("ssh-3", "profile-c"),
                ],
                2,
            )
            .unwrap();
        let workspace = store.create_workspace("Ops".to_string(), 3).unwrap();
        for id in ["ssh-1", "ssh-2", "ssh-3"] {
            store.bind(&workspace.id, id, 4).unwrap();
        }
        for (name, id) in [("A", "ssh-1"), ("B", "ssh-2"), ("C", "ssh-3")] {
            store
                .register_agent(
                    &workspace.id,
                    name.to_string(),
                    "llm".to_string(),
                    Some(id.to_string()),
                    None,
                    5,
                )
                .unwrap();
        }

        // Simulate rows written by the pre-profile-id schema after a corrupted sync.
        store
            .connection
            .execute(
                "UPDATE agents SET profile_id = NULL, session_id = 'ssh-1'",
                [],
            )
            .unwrap();
        let registrations = {
            let mut statement = store
                .connection
                .prepare(
                    "SELECT sequence, payload_json FROM events WHERE kind = 'agent.registered'",
                )
                .unwrap();
            let rows = statement
                .query_map([], |row| {
                    Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
                })
                .unwrap();
            rows.collect::<Result<Vec<_>, _>>().unwrap()
        };
        for (sequence, payload_json) in registrations {
            let mut payload: Value = serde_json::from_str(&payload_json).unwrap();
            payload.as_object_mut().unwrap().remove("profileId");
            store
                .connection
                .execute(
                    "UPDATE events SET payload_json = ?1 WHERE sequence = ?2",
                    params![serde_json::to_string(&payload).unwrap(), sequence],
                )
                .unwrap();
        }

        // Runtime restarted and reopened profiles in a different order. Session ids are reused.
        store
            .sync_sessions(
                vec![
                    session("ssh-2", "profile-a"),
                    session("ssh-3", "profile-b"),
                    session("ssh-4", "profile-c"),
                ],
                6,
            )
            .unwrap();

        let bindings = store.get_workspace(&workspace.id).unwrap().bindings;
        assert_eq!(
            bindings
                .iter()
                .map(|binding| (binding.profile_id.as_deref(), binding.session_id.as_deref()))
                .collect::<Vec<_>>(),
            vec![
                (Some("profile-a"), Some("ssh-2")),
                (Some("profile-b"), Some("ssh-3")),
                (Some("profile-c"), Some("ssh-4")),
            ]
        );
        let agents = store.list_agents(&workspace.id).unwrap();
        assert_eq!(
            agents
                .iter()
                .map(|agent| agent.session_id.as_deref())
                .collect::<Vec<_>>(),
            vec![Some("ssh-2"), Some("ssh-3"), Some("ssh-4")]
        );
    }

    #[test]
    fn cancelled_task_is_terminal_and_idempotent() {
        let mut store = WorkspaceStore::open_in_memory(1).expect("store should open");
        let workspace = store.create_workspace("Ops".to_string(), 2).unwrap();
        let agent = store
            .register_agent(
                &workspace.id,
                "Operator".to_string(),
                "llm".to_string(),
                None,
                None,
                3,
            )
            .unwrap();
        let task = store
            .create_task(&agent.id, "Check status".to_string(), 4)
            .unwrap();
        let cancelled = store.cancel_task(&task.id, 5).unwrap();
        assert_eq!(cancelled.status, "cancelled");
        assert!(store.wait_task(&task.id).unwrap().terminal);
        assert_eq!(store.cancel_task(&task.id, 6).unwrap().status, "cancelled");
    }

    #[test]
    fn enforces_agent_scopes_and_workspace_session_isolation() {
        let mut store = WorkspaceStore::open_in_memory(1).unwrap();
        store
            .sync_sessions(vec![session("tab-1", "profile-1")], 2)
            .unwrap();
        let first = store.create_workspace("First".to_string(), 3).unwrap();
        let second = store.create_workspace("Second".to_string(), 3).unwrap();
        store.bind(&first.id, "tab-1", 4).unwrap();

        assert!(matches!(
            store.bind(&second.id, "tab-1", 5),
            Err(WorkspaceError::InvalidSession(_))
        ));

        let cross_workspace = store.register_agent(
            &second.id,
            "Wrong workspace".to_string(),
            "llm".to_string(),
            Some("tab-1".to_string()),
            None,
            5,
        );
        assert!(matches!(
            cross_workspace,
            Err(WorkspaceError::InvalidSession(_))
        ));

        let agent = store
            .register_agent(
                &first.id,
                "Scoped".to_string(),
                "llm".to_string(),
                Some("tab-1".to_string()),
                Some(vec![
                    "llm.prompt".to_string(),
                    "command.propose".to_string(),
                ]),
                6,
            )
            .unwrap();
        assert!(matches!(
            store.authorize_agent(&agent.id, "command.execute", 7),
            Err(WorkspaceError::AgentScopeDenied { .. })
        ));
        assert!(store.authorize_agent(&agent.id, "llm.prompt", 8).is_ok());
    }

    #[test]
    fn supports_four_agents_across_two_ssh_hosts() {
        let mut store = WorkspaceStore::open_in_memory(1).unwrap();
        let first_session = session("tab-1", "profile-1");
        let mut second_session = session("tab-2", "profile-2");
        second_session.host = Some("second.example.test".to_string());
        store
            .sync_sessions(vec![first_session, second_session], 2)
            .unwrap();
        let workspace = store.create_workspace("Fleet".to_string(), 3).unwrap();
        store.bind(&workspace.id, "tab-1", 4).unwrap();
        store.bind(&workspace.id, "tab-2", 4).unwrap();

        for index in 0..4 {
            let session_id = if index % 2 == 0 { "tab-1" } else { "tab-2" };
            let agent = store
                .register_agent(
                    &workspace.id,
                    format!("Agent {}", index + 1),
                    "llm".to_string(),
                    Some(session_id.to_string()),
                    None,
                    5 + index,
                )
                .unwrap();
            store
                .create_task(&agent.id, "Check host".to_string(), 10 + index)
                .unwrap();
        }

        assert_eq!(store.list_agents(&workspace.id).unwrap().len(), 4);
        assert_eq!(store.list_tasks(&workspace.id).unwrap().len(), 4);
    }

    #[test]
    fn reopens_sqlite_and_marks_unfinished_task_interrupted() {
        let database_path = std::env::temp_dir().join(format!(
            "issh-runtime-workspace-{}-{}.sqlite3",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let (workspace_id, task_id) = {
            let mut store = WorkspaceStore::open(&database_path, 1).unwrap();
            let workspace = store.create_workspace("Persistent".to_string(), 2).unwrap();
            let agent = store
                .register_agent(
                    &workspace.id,
                    "Operator".to_string(),
                    "llm".to_string(),
                    None,
                    None,
                    3,
                )
                .unwrap();
            let task = store
                .create_task(&agent.id, "Keep state".to_string(), 4)
                .unwrap();
            store.start_task(&task.id, 5).unwrap();
            (workspace.id, task.id)
        };

        {
            let store = WorkspaceStore::open(&database_path, 6).unwrap();
            assert_eq!(store.list_workspaces().unwrap()[0].id, workspace_id);
            let recovered = store.get_task(&task_id).unwrap();
            assert_eq!(recovered.status, "interrupted");
            assert_eq!(
                store
                    .list_events(&workspace_id, 0, 100)
                    .unwrap()
                    .last()
                    .unwrap()
                    .kind,
                "task.interrupted"
            );
        }

        std::fs::remove_file(&database_path).unwrap();
    }
}
