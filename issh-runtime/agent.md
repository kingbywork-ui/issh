# issh-runtime Agent Instructions

## Scope

`issh-runtime` is the Rust migration boundary for issh. The current phase adds an in-memory Workspace and Session Binding model behind the versioned local RPC boundary.

## Rules

- Keep the runtime independent of Angular, Electron, Cordis, and Herdr implementation details.
- Keep SSH, PTY, SFTP, SQLite, Cordis, and Herdr outside the runtime until their scheduled phases.
- Session snapshots mirror Electron-owned tabs; the Rust runtime must not take terminal input ownership in this phase.
- Use JSON-RPC 2.0 control messages terminated by a newline.
- Reject messages larger than 64 KiB.
- Windows transport must reject remote clients and must not expose a TCP port.
- Preserve existing `issh_*` behavior; new runtime capabilities are exposed through additive adapter methods.
- New public protocol fields require protocol tests.
- Run formatting, Clippy, workspace tests, the Node smoke client, and `git diff --check` before handoff.
