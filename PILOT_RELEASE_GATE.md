# Phase 6 Pilot Release Gate

Date: 2026-08-20
Branch: `dev`
Application: `issh 0.1.3`
Electron: `43.2.0` x64
Rust Runtime: `0.4.0`

## Automated evidence

- All ten built-in plugin TypeScript projects and the two existing Electron TypeScript configurations passed `tsc --noEmit`.
- `cargo fmt --all -- --check`, workspace Clippy with warnings denied, and workspace tests passed (14 Rust tests).
- Agent/Herdr Node tests passed: 27/27.
- Root `corepack.cmd yarn run build` passed. Existing Webpack warnings are non-fatal (`require-in-the-middle` dynamic require and known unused app/lib files).
- `node issh-runtime/scripts/runtime-smoke.mjs` passed, including malformed JSON, unknown method, oversize message, single-instance, persistence recovery, and cleanup checks.
- `python smoke_test.py` passed: 12/12 GUI and CLI/MCP checks.
- `npm.cmd run test:pilot-release-gate` passed:
  - Named Pipe `runtime.health`: 40 samples, p50 0.47 ms, p95 0.68 ms, max 1.14 ms.
  - Settings accessibility contract: 7/7 checks.
- `npm.cmd run audit:security` completed. Embedded npm is not shipped. Existing dependency advisories remain in the root/app/issh-core graphs; no unrelated dependency upgrades were made.
- `git diff --check` passed.

## Windows artifact

The normal `node scripts/build-windows.mjs` flow completed with the validated local Electron distribution and a release Rust runtime. No Electron download was used.

- Installer: `dist/issh-0.1.3-setup-x64.exe`
- Size: `104,051,627` bytes
- SHA-256: `5EA0FFF19D6D2318D8FC177EA3EA3F444018BB13F918AA6CFF57DA42BFDAC5F9`
- `latest.yml` size and SHA-512 match the installer.
- Packaged Electron version: `43.2.0`
- Packaged ASAR version/name: `0.1.3` / `issh`
- Packaged resources include `issh-agent` and `issh-runtime/isshd.exe`.
- Packaged `issh-llm` contains Herdr and `workspace.create` markers.
- Packaged CLI `issh-agent --help` and runtime `isshd --help` both exit successfully.

## Upgrade, rollback, and UAT status

- The current installer, blockmap, `latest.yml`, unpacked application, ASAR metadata, CLI, and runtime resources were verified in an isolated build directory.
- A live install/upgrade/rollback rehearsal was not run because it would mutate the user's installed application and registry. The release artifact is therefore ready for an isolated pilot install, but not marked as a production upgrade sign-off.
- Native-only UAT is complete through the GUI smoke test and Agent/Runtime tests.
- Real Herdr-binary UAT is pending because Herdr is not installed on this machine; the adapter remains optional and native-only downgrade was verified.
- Two-host/four-agent SSH UAT is pending because no authorized remote hosts were provided in this environment.

## Release decision

This is a **conditional pilot release**. The code, automated gates, Windows artifact, and native-only path are ready. Before a production rollout, perform one isolated installer upgrade/rollback rehearsal, one real Herdr 0.8.x UAT, and the two-host/four-agent SSH acceptance run; then attach their evidence to this document.
