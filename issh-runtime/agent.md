# issh-runtime Agent Instructions

## Scope

`issh-runtime` is the Rust migration boundary for issh. It persists Workspace, Session Binding, scoped Agent, Task, and ordered audit/event state behind the versioned local RPC boundary, and provides the producer-agnostic pane stream used by the optional Herdr adapter while Cordis remains an isolated Node orchestration adapter.

## Rules

- Keep the runtime independent of Angular, Electron, Cordis, and Herdr implementation details.
- Keep SSH, PTY, SFTP, Cordis implementation details, and Herdr outside the runtime. Rust exposes generic Agent/Task operations plus the producer-agnostic pane stream contract. The Herdr adapter lives at the Electron/Agent Bridge edge and must not add Herdr-specific state, credentials, or transport details to the Rust schema.
- SQLite stores runtime state and event metadata only; secrets remain outside this database.
- Session snapshots mirror Electron-owned tabs. For the Phase 8 pane proxy, Rust owns only bounded raw-byte buffering, cursor subscriptions, resize authorization, and exclusive input ownership; the Electron-edge Herdr adapter owns the external terminal controller and Rust still does not own a PTY or terminal transport.
- Pane output is in-memory and capped at 2 MiB per pane. It is never persisted to SQLite or audit logs. Producers identify themselves with a stable `producerId`; `pane.pushOutput` is an adapter-side operation and is not exposed as a general Agent Bridge write tool.
- A pane write is accepted only for the current input owner and is capped at 64 KiB. A producer or current input owner may resize within the 1-1000 row/column limit. Herdr attach/detach and full-screen byte transport live outside Rust at the Electron edge; Tauri embedding remains a later gate.
- Reconnect bindings by stable profile identity when Electron recreates a terminal tab. Do not silently resume interrupted LLM work after Runtime restart.
- The Phase 3 LLM adapter is advisory only and must not execute shell commands or claim host-side changes.
- A terminal profile may be bound to only one Workspace. Agents may access only capabilities listed in their persisted scopes.
- Record scope authorization/denial and cross-Workspace binding denial as ordered security events.
- `command.execute` never bypasses command normalization or the issh dangerous-command confirmation dialog.
- Use JSON-RPC 2.0 control messages terminated by a newline.
- Reject messages larger than 64 KiB.
- Windows transport must reject remote clients and must not expose a TCP port.
- Preserve existing `issh_*` behavior; new runtime capabilities are exposed through additive adapter methods.
- New public protocol fields require protocol tests.
- Run formatting, Clippy, workspace tests, the Node smoke client, and `git diff --check` before handoff.
