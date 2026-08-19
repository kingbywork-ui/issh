# issh-runtime Handoff

## Phase 0 - Complete

- Implemented the `protocol` and `isshd` crates in a Cargo workspace.
- Added JSON-RPC 2.0 `runtime.health` with protocol/runtime versions, PID, start time, and capabilities.
- Added a Windows Named Pipe transport with first-instance enforcement, remote-client rejection, and an explicit current-user plus SYSTEM ACL.
- Added a 64 KiB message limit and structured parse, invalid-request, unknown-method, and oversized-message errors.
- Added a Node smoke client covering health, invalid JSON, unknown methods, oversized input, duplicate runtime rejection, process stop, and pipe reuse.
- Non-goals remained unchanged: no SSH, PTY, SFTP, persistence, Cordis, Herdr, UI, or existing Agent Bridge behavior was added or modified.
- Verified with `cargo fmt --check`, Clippy with warnings denied, 7 Rust tests, a Windows binary build, and the Node runtime smoke test.
