# issh-runtime Agent Instructions

## Scope

`issh-runtime` is the Rust migration boundary for issh. Phase 0 contains only a versioned RPC health check over local IPC.

## Rules

- Keep the runtime independent of Angular, Electron, Cordis, and Herdr implementation details.
- Do not add SSH, PTY, SFTP, SQLite, or UI behavior during Phase 0.
- Use JSON-RPC 2.0 control messages terminated by a newline.
- Reject messages larger than 64 KiB.
- Windows transport must reject remote clients and must not expose a TCP port.
- Preserve existing `issh_*` behavior; compatibility work belongs in a later adapter.
- New public protocol fields require protocol tests.
- Run formatting, Clippy, workspace tests, the Node smoke client, and `git diff --check` before handoff.
