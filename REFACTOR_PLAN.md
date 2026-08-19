# issh Rust Runtime and Multi-Agent Refactor Plan

## Decision

issh will migrate through a dual-runtime architecture instead of a one-shot rewrite:

```text
Electron / Angular compatibility UI
                |
                v
         Rust isshd runtime
        /        |        \
 Agent Bridge  Cordis    Herdr adapter
 compatibility adapter   (optional)
```

- Rust owns the long-lived runtime, local IPC, session lifecycle, security policy, and eventually SSH, PTY, SFTP, and Vault access.
- The existing Electron/Angular application remains the compatibility UI until the Rust APIs are stable.
- Cordis is a Node sidecar for agent workflow orchestration and never receives SSH credentials or direct transport access.
- Herdr is an optional socket-level integration for workspace and agent interoperability. It is not a core dependency and is not embedded or forked.
- The first product capability is an issh-native Workspace for coordinating agents attached to existing SSH tabs. A full Herdr pane proxy is a later, separately gated feature.

## Target Runtime

The Rust workspace is organized around these boundaries:

- `protocol`: versioned JSON-RPC types, errors, limits, and capability discovery.
- `isshd`: one per-user runtime process with Windows Named Pipe and future Unix Domain Socket transports.
- `session`: SSH, local PTY, resize, output buffering, cancellation, and SFTP.
- `workspace`: Workspace, Agent, Task, and Session Binding state.
- `policy`: token scopes, command preview and confirmation, redaction, and audit policy.
- `storage`: SQLite WAL for runtime state and audit metadata; secrets remain in Vault.
- `bridge-compat`: compatibility for the existing `issh_*` CLI/MCP protocol.
- `cordis-adapter`: high-level `prompt`, `wait`, `dispatch`, `cancel`, and result collection.
- `herdr-adapter`: optional Herdr lifecycle, version handshake, workspace mapping, and state synchronization.

Public runtime operations will grow from the Phase 0 health check into:

```text
runtime.health
session.list / connect / close / read / subscribe / write / resize / exec
workspace.create / list / bind / unbind
agent.register / prompt / wait / focus / read / report_state
task.dispatch / cancel
events.subscribe
```

All execution continues to follow `preview -> confirm -> execute`. Cordis and Herdr receive restricted capabilities, never the primary Agent Bridge token or SSH secrets.

## Product and UI

The MVP augments the existing terminal rather than replacing it:

- Workspace header: active workspace, agent counts, task counts, and runtime health.
- Agent sidebar: state, host, working directory, bound SSH tab, recent activity, focus, prompt, and unbind actions.
- Existing xterm.js terminal: remains the source of truth for the interactive SSH session.
- Task drawer: task targets, dependency and progress state, output summaries, retry, cancel, and collect actions.
- Inspector: session details, scopes, audit records, and dangerous-operation state.

Angular and the future Svelte UI use the same `WorkspaceDataSource` contract. UI components do not call Electron, Cordis, or Herdr directly.

## Team

- Business Analyst: scenarios, workflow rules, permission matrix, and acceptance criteria.
- Product Manager: scope, priorities, milestones, release gates, and risk decisions.
- UI/UX Designer: information architecture, agent/task states, confirmation, recovery, and accessibility.
- Frontend Engineer: Angular Workspace MVP, RPC data source, event rendering, and later Svelte/Tauri migration.
- Backend Engineer: Rust runtime, RPC, compatibility bridge, persistence, security, Cordis, and Herdr adapters.

For the lowest initial cost there is no separate QA or DevOps role. BA owns acceptance cases, engineers own automation, PM owns the release gate, and backend owns security/performance baselines.

## 12-Week MVP Schedule

### Weeks 1-2: requirements and architecture

- Freeze MVP, non-goals, domain objects, permission matrix, RPC schema, errors, event ordering, and UI information architecture.
- Deliver a Rust process and local IPC health-check spike with a Node client.

### Weeks 3-4: first vertical slice

- Implement runtime lifecycle, session/binding abstraction, Agent Bridge compatibility, Workspace shell, session listing, binding, and tab focus.
- Demo an existing SSH tab being listed and bound through the new API without changing its behavior.

### Weeks 5-6: single-agent workflow

- Add Workspace, Agent, Task, event sequencing, reconnect semantics, SQLite state, prompt, wait, read, cancel, and UI recovery states.
- Complete `create workspace -> bind tab -> register agent -> prompt -> wait -> inspect result`.

### Weeks 7-8: multi-agent and Cordis MVP

- Add Cordis dispatch/wait/collect, multi-agent UI, capability scopes, audit, cross-workspace isolation, and dangerous-command confirmation.
- Accept at least four agents across two SSH hosts.

### Weeks 9-10: Herdr adapter and resilience

- Add optional Herdr sidecar lifecycle, version contract, workspace/state synchronization, downgrade behavior, output backpressure, and crash/reconnect recovery.
- Herdr remains optional; the native Workspace continues to work when it is absent.

### Weeks 11-12: pilot release

- Complete Windows packaging, upgrade/rollback checks, security tests, performance baselines, accessibility review, UAT, documentation, and release gate.

## Post-MVP Gates

- Weeks 13-16: Tauri 2 + Svelte 5 vertical slice using the same RPC and data model.
- Weeks 17-22: optional Herdr native-pane proxy only if pilot users require it. This includes raw terminal bytes, resize/control characters, input ownership, full-screen apps, and recovery.
- Electron removal begins only after Rust SSH/PTY/SFTP and Tauri UI reach verified parity.

## Acceptance Targets

- Existing SSH, SFTP, autocomplete, and CLI/MCP Agent Bridge behavior remains compatible during migration.
- Local RPC p95 is below 20 ms on the reference Windows machine.
- One hundred agent state events do not block terminal input or cause visible UI stalls.
- Every event has ordering and reconnect semantics; security and audit events are never dropped.
- Herdr or Cordis can stop independently without closing an SSH session.
- Final Tauri packaging targets a 40-50% size reduction and a material idle-memory reduction relative to the current Electron package.
