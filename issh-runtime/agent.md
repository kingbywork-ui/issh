# issh-runtime Agent Instructions

## Scope

`issh-runtime` is the Rust migration boundary for issh. The current phase persists Workspace, Session Binding, Agent, Task, and ordered event state behind the versioned local RPC boundary.

## Rules

- Keep the runtime independent of Angular, Electron, Cordis, and Herdr implementation details.
- Keep SSH, PTY, SFTP, Cordis, and Herdr outside the runtime until their scheduled phases.
- SQLite stores runtime state and event metadata only; secrets remain outside this database.
- Session snapshots mirror Electron-owned tabs; the Rust runtime must not take terminal input ownership in this phase.
- Reconnect bindings by stable profile identity when Electron recreates a terminal tab. Do not silently resume interrupted LLM work after Runtime restart.
- The Phase 3 LLM adapter is advisory only and must not execute shell commands or claim host-side changes.
- Use JSON-RPC 2.0 control messages terminated by a newline.
- Reject messages larger than 64 KiB.
- Windows transport must reject remote clients and must not expose a TCP port.
- Preserve existing `issh_*` behavior; new runtime capabilities are exposed through additive adapter methods.
- New public protocol fields require protocol tests.
- Run formatting, Clippy, workspace tests, the Node smoke client, and `git diff --check` before handoff.
