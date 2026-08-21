# issh-runtime-session Agent Guide

## Objective

Own interactive terminal transports independently from Electron and UI code.
The first transport is a local PTY; SSH will implement the same session-facing
contract in a later migration gate.

## Boundaries

- This crate owns child, PTY master, reader, writer, resize, and cleanup state.
- Output is raw bytes in a bounded sequence ring; never decode or normalize ANSI.
- UI, Tauri, Workspace, Agent, Cordis, and Herdr concerns stay outside.
- Closing a session must terminate only the child created by that session.
- Input, output, identifiers, dimensions, and batch sizes must be bounded.

## Verification

- Unit tests cover validation, ordered output, cursor recovery, backpressure,
  write/resize behavior where practical, and idempotent cleanup.
- A live smoke must spawn the platform shell through `isshd`, exchange a marker,
  resize it, close it, and confirm the child/session is gone.
