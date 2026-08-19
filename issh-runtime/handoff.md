# issh-runtime Handoff

## Phase 4 - Optional Herdr adapter and resilience complete

- Added an optional Electron-main Herdr sidecar manager without changing the Rust Runtime schema or taking ownership of SSH, PTY, or SFTP.
- Contract is Herdr `>=0.8.1` with socket/API protocol `20`. Status reports missing, stopped, incompatible, externally managed, or issh-managed state and downgrades cleanly to the native Workspace.
- Sidecar execution is bounded to two concurrent CLI commands, a 32-request queue, 2 MiB command output, and 64 KiB recent logs. Owned crashes use at most five exponential restart attempts; stop never terminates an externally managed Herdr server.
- Workspace synchronization uses persisted issh-to-Herdr links, Herdr `session.snapshot`, and `workspace report-metadata`. Only Workspace identity/name and aggregate Agent/Task counts cross the adapter; terminal output, SSH credentials, secrets, and Agent Bridge tokens do not.
- Agent Bridge protocol is `1.4.0` with 43 MCP tools and matching CLI commands for Herdr status/start/stop/snapshot/link/unlink/sync. Full Herdr pane proxying remains a post-MVP gate.
- Verification: app-main and `issh-llm` TypeScript checks/builds, the full root build, dist markers, 27 Agent/Herdr tests, `git diff --check`, security audit policy, and the 12-check GUI smoke passed. Herdr is not installed on the reference machine, so real-binary UAT remains pending and no external installation was performed.

## Phase 3 - Cordis multi-agent and scoped execution complete

- Bumped Runtime/protocol to `0.4.0` and Agent Bridge protocol to `1.3.0` with 36 MCP tools.
- Added persisted Agent scopes: `context.read`, `llm.prompt`, `command.propose`, and opt-in `command.execute`. Existing databases migrate to the safe three-scope default.
- Enforced cross-Workspace isolation: one terminal profile cannot be bound to multiple Workspaces, and an Agent cannot attach to a terminal that is not bound to its Workspace.
- Added ordered security events for scope authorization/denial and rejected cross-Workspace binding/registration attempts. Existing JSONL Agent Bridge audit continues to cover every external RPC.
- Added Cordis `4.0.0-rc.8` behind one Angular service boundary. It dispatches one prompt concurrently to 1-16 Agents, exposes health/wait/collect/cancel, and disposes the run Fiber to cancel unfinished Tasks without closing SSH sessions.
- Added a multi-Agent Workspace UI, per-Agent scopes, run state, and task-result command preview/execute controls. Execution requires `command.execute`, the command must exist in the persisted result, the user must explicitly select execute, and dangerous commands still show the native issh confirmation.
- Cordis run grouping is process-local by design in this MVP; Rust Tasks, results, recovery state, and ordered events remain durable. Herdr and Rust-owned SSH/PTY/SFTP remain outside this phase.
- Verification: Rust format, Clippy with warnings denied, 14 Rust tests, debug and Windows x64 release builds, Node Runtime smoke, 22 Agent protocol tests, application/plugin type checks and builds, the full root build, Cordis four-Fiber lifecycle smoke, and the 12-check GUI smoke all passed.

## Phase 2 - Persistent single-agent workflow complete

- Bumped Runtime/protocol to `0.3.0` and replaced the in-memory Workspace store with SQLite WAL persistence for Workspace, Session Binding, Agent, Task, and ordered Runtime Event records.
- Added profile-identity reconnect semantics. A disconnected binding retains its last tab identity, and when Electron recreates the same profile under a new tab ID both the binding and attached Agent are updated.
- Added Agent register/list plus Task prompt/start/wait/read/list/cancel/complete/fail and Event list RPC methods. Runtime restart marks queued/running work `interrupted` instead of silently resuming it.
- Electron passes a stable per-user database path to `isshd`. The existing secured Named Pipe and 64 KiB control-message limit remain unchanged.
- Added an advisory LLM task executor, Agent Bridge/MCP schemas, and Workspace UI for registration, prompt, wait, result/error inspection, cancellation, recent events, and recovery state. The LLM path reads only allowed, redacted terminal context and never executes terminal commands.
- Agent Bridge protocol is `1.2.0` with 30 tools. Cordis, multi-agent dispatch, Herdr, Rust-owned SSH/PTY/SFTP, and broader policy/audit work remain outside this phase.
- Verification: Rust format, Clippy with warnings denied, 12 Rust tests, debug and Windows x64 release builds, and Node runtime restart smoke; `issh-llm` TypeScript and webpack build; app main TypeScript and webpack build; 22 `issh-agent` tests; 12-check root GUI smoke; `git diff --check`.

## Phase 1 - First vertical slice complete

- Bumped the Runtime and protocol to `0.2.0` and added the `issh-runtime-workspace` crate with in-memory Session Snapshot, Workspace, and Session Binding state.
- Added `session.sync`, `session.list`, `workspace.create`, `workspace.list`, `workspace.bind`, and `workspace.unbind` JSON-RPC methods. Synchronization prunes bindings for tabs that are no longer open.
- Added an Electron main-process `RuntimeManager`: a trusted renderer IPC entry point lazily connects to or starts one per-user `isshd`, uses the existing secured Named Pipe transport, caps requests/responses at 64 KiB, and stops the owned child during application shutdown.
- Added `RuntimeBridgeService` and five additive Agent Bridge/MCP tools: runtime health plus Workspace list/create/bind/unbind. All Workspace calls first mirror the currently registered real terminal tabs into Rust.
- Added an `Agent Workspace` settings shell for Runtime health, Workspace creation, session binding/unbinding, and focusing the corresponding existing terminal tab.
- Added Windows release-build and electron-builder resource wiring for `isshd.exe`; x64 uses `x86_64-pc-windows-msvc` and arm64 uses `aarch64-pc-windows-msvc`.
- State remains intentionally in memory. SSH/PTY/SFTP ownership, SQLite, Agent/Task execution, Cordis, and Herdr were not added in this phase.
- Verification: Rust format/Clippy/tests/build/runtime smoke; app and issh-llm TypeScript checks; app main and issh-llm webpack builds; 22 issh-agent tests; Windows x64 release Runtime build; build-script syntax/YAML parsing; `git diff --check`.

## Phase 0 - Complete

- Implemented the `protocol` and `isshd` crates in a Cargo workspace.
- Added JSON-RPC 2.0 `runtime.health` with protocol/runtime versions, PID, start time, and capabilities.
- Added a Windows Named Pipe transport with first-instance enforcement, remote-client rejection, and an explicit current-user plus SYSTEM ACL.
- Added a 64 KiB message limit and structured parse, invalid-request, unknown-method, and oversized-message errors.
- Added a Node smoke client covering health, invalid JSON, unknown methods, oversized input, duplicate runtime rejection, process stop, and pipe reuse.
- Non-goals remained unchanged: no SSH, PTY, SFTP, persistence, Cordis, Herdr, UI, or existing Agent Bridge behavior was added or modified.
- Verified with `cargo fmt --check`, Clippy with warnings denied, 7 Rust tests, a Windows binary build, and the Node runtime smoke test.
