# issh-runtime Agent Instructions

## Scope

`issh-runtime` is the Rust migration boundary for issh. It persists Workspace, Session Binding, scoped Agent, Task, and ordered audit/event state behind the versioned local RPC boundary, and provides the producer-agnostic pane stream used by the optional Herdr adapter while Cordis remains an isolated Node orchestration adapter.

## Rules

- Keep the runtime independent of Angular, Electron, Cordis, and Herdr implementation details.
- isshd manages SSH, PTY, SFTP and session lifecycle through the corresponding crates. Keep provider-specific orchestration, Cordis and Herdr implementation details outside the generic runtime schema.
- SQLite stores runtime state and event metadata only; secrets remain outside this database.
- Tauri/Svelte owns the UI; runtime owns domain state and terminal transports. Historical Electron migration constraints are background only.
- Pane output is in-memory and capped at 2 MiB per pane. It is never persisted to SQLite or audit logs. Producers identify themselves with a stable `producerId`; `pane.pushOutput` is an adapter-side operation and is not exposed as a general Agent Bridge write tool.
- A pane write is accepted only for the current input owner and is capped at 64 KiB. A producer or current input owner may resize within the 1-1000 row/column limit. Herdr-specific attach/detach stays in its adapter; generic byte transport and input ownership remain runtime responsibilities.
- Reconnect bindings by stable profile identity when the desktop client recreates a terminal tab. Do not silently resume interrupted LLM work after Runtime restart.
- The Phase 3 LLM adapter is advisory only and must not execute shell commands or claim host-side changes.
- A terminal profile may be bound to only one Workspace. Agents may access only capabilities listed in their persisted scopes.
- Record scope authorization/denial and cross-Workspace binding denial as ordered security events.
- `command.execute` never bypasses command normalization or the issh dangerous-command confirmation dialog.
- Use JSON-RPC 2.0 control messages terminated by a newline.
- Reject messages larger than 64 KiB.
- Windows transport must reject remote clients and must not expose a TCP port.
- Preserve existing `issh_*` behavior; new runtime capabilities are exposed through additive adapter methods.
- New public protocol fields require protocol tests.
- Verify by impact: documentation checks for docs; formatting, relevant crate tests and Clippy for Rust changes; contract tests for protocol changes. Add live smoke when affected behavior requires it; full workspace/release checks apply to cross-cutting or requested release work. Report missing tools and unverified behavior separately.
