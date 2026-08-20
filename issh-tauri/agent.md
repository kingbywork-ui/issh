# issh-tauri Agent Guide

## Objective

`issh-tauri` is the replacement desktop client. Its completion criterion is full
feature parity followed by removal of Electron, Angular, and the Node main
process from the shipped application.

## Boundaries

- Tauri 2 owns native windows, trusted command dispatch, process lifecycle, and
  OS integration.
- Svelte 5 owns the desktop UI. It must not call Electron or import an `issh-*`
  Angular plugin.
- `isshd` remains the versioned local runtime over the secured per-user Named
  Pipe. New UI work uses that protocol instead of duplicating domain state.
- During migration the legacy Electron client is a parity oracle only. Do not
  add new product capability exclusively to Electron.
- Do not package until the user explicitly requests it. A successful dev build
  is not packaged-artifact verification.

## Verification

- Frontend: `npm run check` and `npm run build`.
- Native: `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`, and
  `cargo test` from `src-tauri`.
- GUI slices require a source-tree Tauri launch test against a real `isshd`.
