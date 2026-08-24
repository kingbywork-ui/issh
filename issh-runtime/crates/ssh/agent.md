# issh-runtime-ssh agent notes

This crate owns the Electron-independent SSH transport boundary for `isshd`.

Scope for the first slice:

- password and OpenSSH private-key authentication;
- required host-key fingerprint verification;
- remote PTY shell open, write, resize, and close primitives;
- no persistence of credentials or private-key bytes.

Do not add UI, Vault storage, SFTP, or Electron compatibility code here. Those
layers consume this transport through the Runtime RPC boundary.
