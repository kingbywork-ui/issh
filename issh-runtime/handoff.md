# issh-runtime Handoff

## Phase 14 - Vault subsystem complete (2026-08-24)

- New crate `issh-runtime-vault` implementing the issh Electron `StoredVault`
  format: v1 AES-256-CBC (PKCS7) and v2 AES-256-GCM, both keyed by
  PBKDF2-SHA512 (100k / 310k iterations, 8-byte salt, 12-byte GCM nonce).
  Existing Electron `vault` files decrypt as-is; new writes always use v2.
- `VaultStore` lifecycle: `open` (lazy, tolerates missing file), `create`,
  `unlock`, `lock`, `set_enabled`, plus secret CRUD (`list_secrets`,
  `get_secret`, `put_secret`, `delete_secret`) with atomic re-encrypt +
  persist. Passphrase held in `Zeroizing<String>`; guards: 4 MiB vault file
  cap, 64 KiB per-secret cap, 10k secrets cap. 7 unit tests including v1/v2
  roundtrips and wrong-passphrase rejection.
- `isshd` integration: `--vault <path>` flag and `ISSH_VAULT_FILE` env
  (default: `<db dir>/vault.json`), `RuntimeState.vault` behind a
  `std::sync::Mutex`, and RPC surface `vault.status`, `vault.unlock`,
  `vault.lock`, `vault.setEnabled`, `vault.listSecrets`, `vault.getSecret`,
  `vault.putSecret`, `vault.deleteSecret` with dedicated error codes
  (-32004 locked, -32005 bad passphrase, -32006/07 malformed, -32008
  secret-level).
- `session.openSsh` now accepts optional `vaultSecretId`: when the vault is
  unlocked, the secret value overrides the inline password (and fills the
  username when the inline username is blank); when locked, it silently falls
  back to inline credentials so UI flows degrade gracefully.
- Workspace totals after this phase: 46 tests passing, `cargo fmt` clean,
  Clippy zero warnings across all crates.
- Tauri SSH/SFTP UI, and Electron main-process removal remain future gates.
  No package was built.

## Phase 13 - SFTP subsystem bridge complete (2026-08-24)

- Extended `issh-runtime-ssh` `SshSftpSession` with chunked transfer primitives:
  `read_file_chunk(path, offset, length)` returns `SftpReadChunk { offset, data,
  total_size, eof }` using seek + bounded reads, and `write_file_chunk(path,
  offset, data, truncate)` returns `SftpWriteOutcome { total_size }` using
  `OpenFlags`-based open with optional TRUNCATE. Both enforce
  `MAX_SFTP_CHUNK_BYTES` (4 MiB) and the existing `MAX_SFTP_FILE_BYTES` cap.
- `isshd` now exposes the full SFTP RPC surface: `sftp.open`, `sftp.read`,
  `sftp.write`, `sftp.list`, `sftp.stat`, `sftp.mkdir`, `sftp.remove`,
  `sftp.removeDir`, `sftp.rename`, and `sftp.close`. Reads and writes are
  chunk-capped at 32 KiB per RPC with base64 payloads; `sftp.list` is paginated
  with `SFTP_MAX_LIST_PAGE`. All calls route through `with_sftp_session` with a
  `SFTP_RPC_TIMEOUT_MS` timeout and structured `SftpRpcError` mapping.
- `sftp.read` no longer reads whole files into memory: it delegates to the new
  chunk API and returns `eof` so clients can stream. `sftp.write` accepts
  `offset`/`truncate`/`eof` params for streaming uploads, and `sftp.close`
  removes the session from the registry before closing.
- Added two ssh-crate tests covering exact-range chunk reads (including
  past-EOF), append vs truncate writes, and the chunk-size limit rejection.
  Workspace now has 38 tests; fmt, Clippy (warnings denied), and full workspace
  checks pass.
- Vault, Tauri SSH/SFTP UI, and packaging remain future gates. No package was
  built.

## Phase 12 - SSH session migration complete (2026-08-24)

- Extended `issh-runtime-ssh` with `open_interactive(columns, rows)`: it opens
  a session channel, requests a `xterm-256color` PTY and shell, splits the
  russh channel, and streams stdout/stderr chunks through a bounded 256-message
  mpsc queue. `SshChannelWriter` provides write/resize/eof/close, and the
  interactive channel closes by sending EOF, closing the channel, and
  disconnecting the shared client handle.
- Added the `RemoteShellIo` trait (`try_write`/`try_resize`/`request_close`)
  plus `SshSessionSpec` and `SshSession` to `issh-runtime-session`. SSH
  sessions reuse the same bounded 2 MiB output ring, cursor sequencing, and
  batched subscription contract as local PTY sessions; the store also exposes
  `push_ssh_output` and `mark_ssh_exited` for the isshd output pump.
- Added the `session.openSsh` RPC to `isshd`. Connect and interactive-channel
  open are each wrapped in a 10 s tokio timeout so unreachable hosts fail with
  a structured RPC error instead of hanging the Named Pipe client. A spawned
  pump task bridges SSH output chunks into the session store, forwards
  write/resize commands, marks exit on channel close, and detaches the pump
  registration when the session ends.
- Added `ssh-session-smoke.mjs` covering missing host key, bad dimensions,
  and an unreachable host. `runtime-smoke.mjs` asserts the new method in the
  capability list.
- Verification passed: `cargo fmt --check`, Clippy with warnings denied, 32
  workspace tests (including a real in-process russh server round-trip), and
  all four Node smoke scripts.
- Smoke-script timeout note: the unreachable-host case intentionally exceeds
  the default 2 s client timeout (isshd takes up to 10 s to fail the TCP
  connect), so that request uses a 30 s socket timeout with 10 attempts.
- SFTP, Vault, Tauri SSH UI, and packaging remain future gates. No package
  was built.

## Phase 11 - Rust SSH transport probe complete (2026-08-21)

- Added `issh-runtime-ssh` after creating its required `agent.md` and
  `handoff.md`. It uses `russh 0.62.7` with the `ring` backend, requires a
  `SHA256:` host-key fingerprint, supports password/private-key authentication,
  and exposes remote PTY open/resize primitives without persisting secrets.
- Added `ssh.probe` to `isshd`; connect, host-key verification, authentication,
  and disconnect are Rust-owned. `ssh-probe-smoke.mjs` validates the required
  host-key parameter, and the full Runtime smoke passes with the new capability.
- Persistent remote session streaming, SFTP, Vault, and Tauri SSH UI remain
  future gates. No package was built.

## Phase 10 - Local PTY session migration complete (2026-08-21)

- Added the `issh-runtime-session` crate and its own `agent.md`/`handoff.md`.
- Local sessions use `portable-pty 0.9.0`; Windows uses explicit `cmd.exe /d`
  through ConPTY. The store owns the child and PTY handles, retains raw output
  in a bounded 2 MiB cursor ring, supports write/resize/subscribe and cleans up
  only its own child.
- Runtime exposes additive `session.openLocal`, `session.snapshot`,
  `session.write`, `session.resize`, `session.subscribe`, and `session.close`.
  Existing Workspace `session.list` remains compatible.
- `issh-tauri` renders the session through xterm.js and fit-driven resize. Local
  PTY smoke passed marker echo, DSR response, resize and close cleanup.
- SSH, SFTP, Vault, and Electron removal remain future gates.

## Phase 8 - Herdr native pane proxy complete

- Implemented and verified on `dev` without running a new Electron/Windows package build.
- Added the `issh-runtime-pane` crate with a producer-agnostic pane lifecycle, raw output event cursor, 2 MiB per-pane backpressure buffer, 48 KiB subscription batches, exclusive input ownership, bounded raw writes, and resize authorization.
- Added additive Runtime RPC methods: `pane.list`, `pane.open`, `pane.snapshot`, `pane.close`, `pane.claimInput`, `pane.releaseInput`, `pane.write`, `pane.resize`, `pane.pushOutput`, and `pane.subscribe`.
- Added seven Agent Bridge/MCP tools (`issh_pane_*`) plus CLI commands for list/snapshot/subscribe/claim/release/write/resize. The Agent Bridge protocol is now `1.5.0` with 50 tools; writes require the existing token `write` scope and a pane ownership token.
- Electron main now adapts official Herdr `0.8.2` / protocol `20` `terminal session control` NDJSON frames to the generic Runtime contract. It preserves raw ANSI/control bytes, enforces sequence and frame bounds, splits byte-array RPC messages into 12 KiB chunks, authorizes input/resize through Rust before forwarding them to Herdr, and retries controller loss at most five times.
- Added an issh xterm pane tab with full-screen control-sequence support, resize/input forwarding, recovery tokens, and recovered-tab deduplication. Closing it detaches the controller, releases ownership, and clears the Runtime ring without closing the underlying Herdr pane or SSH session.
- Added `pane-smoke.mjs` and `herdr-pane-live-uat.mjs`. The live UAT passed against the official Windows x64 Herdr binary and a real local `isshd`, covering attach, full frame, input, resize, marker output, release, closed state, and zero buffered bytes.
- Fixed the Windows server accept loop so the next Named Pipe instance exists before the current client receives its response. `runtime-smoke.mjs` now proves two immediate requests succeed without retry, preventing the fresh-profile Electron `ENOENT` race that the earlier retrying smoke client hid.
- Added `herdr-pane-gui-uat.py`. It verifies a fresh isolated profile can create/map a Workspace, open the real pane in standard xterm, send a marker through xterm, receive the marker through Electron pane events, and reopen without a duplicate tab. Pane startup now orders first input/resize behind asynchronous attachment, and empty successful Herdr metadata output is accepted.
- Verification passed: Rust format, Clippy with warnings denied, 21 Rust tests, Runtime and pane Named Pipe smoke, 33 Agent/Herdr tests, actual Runtime/Herdr live UAT, source-tree Herdr pane GUI UAT, app and `issh-llm` TypeScript checks/builds, the full repository build, the 12-check GUI smoke, and `git diff --check`. Tauri/Svelte embedding remains a separate Electron-removal gate.

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
