[![](docs/readme.png)](https://tabby.sh)

---

A customized fork of [Tabby](https://tabby.sh) (formerly **Terminus**), focused on SSH and terminal workflows for Windows.

Based on Tabby v1.0.7, with UI enhancements and bug fixes for daily SSH management.

## Downloads

Pre-built Windows artifacts (located in `dist/` after building):

- `tabby-1.0.7-setup-x64.exe` — NSIS installer
- `tabby-1.0.7-portable-x64.zip` — portable archive

## Features

### Terminal

- VT220 terminal with multiple nested split panes
- Tabs on any side of the window
- Optional dockable window with global hotkey ("Quake console")
- Progress detection and process completion notifications
- Bracketed paste, multiline paste warnings
- Font ligatures and custom shell profiles
- Full Unicode support including double-width characters
- PowerShell (and PS Core), WSL, Git-Bash, Cygwin, MSYS2, Cmder and CMD support
- Terminal toolbar with quick actions

### SSH Client

- SSH2 client with connection manager
- X11 and port forwarding (local, remote, dynamic/SOCKS)
- Jump host / bastion support
- Agent forwarding (incl. Pageant and Windows native OpenSSH Agent)
- Login scripts
- SFTP file transfer via Zmodem
- RSA-SHA2 / ECDSA key authentication with passphrase support
- HTTP / SOCKS proxy support
- Batch input — send commands to multiple SSH sessions simultaneously
- Enhanced SFTP panel with improved file management UI

### Start Page & Host Manager

- Redesigned start page with quick-connect shortcuts
- Enhanced host management interface with card-based layout
- Improved profile settings tab with streamlined configuration flow

## Portable

Tabby will run as a portable app on Windows if you create a `data` folder in the same location where `Tabby.exe` lives.

## Building from Source

### Prerequisites

- Node.js 18+
- Yarn 1.x
- Python 3 (for native module builds)
- Visual Studio Build Tools (for native module compilation)

### Build Steps

```bash
# Install dependencies
yarn

# Smoke test: TypeScript type-checks
npx tsc -p tabby-core/tsconfig.json --noEmit
npx tsc -p tabby-settings/tsconfig.json --noEmit
npx tsc -p tabby-terminal/tsconfig.json --noEmit
npx tsc -p tabby-ssh/tsconfig.json --noEmit
npx tsc -p tabby-local/tsconfig.json --noEmit
npx tsc -p tabby-electron/tsconfig.json --noEmit
npx tsc -p tabby-linkifier/tsconfig.json --noEmit
npx tsc -p tabby-auto-sudo-password/tsconfig.json --noEmit
npx tsc -p tabby-community-color-schemes/tsconfig.json --noEmit

# Smoke test: Webpack build
yarn run build

# Build Windows installer
node scripts/build-windows.mjs
```

If `prepackage-plugins.mjs` fails due to native module rebuild issues, use the skip flag:

```bash
set TABBY_SKIP_PREPACKAGE=1&&node scripts/build-windows.mjs
```

## Changes from Upstream Tabby

- **Batch input**: Send commands to multiple SSH sessions at once
- **Enhanced SFTP panel**: Improved file management UI with better visual feedback
- **Terminal toolbar**: Quick-action toolbar for common terminal operations
- **Redesigned start page**: Quick-connect shortcuts with improved layout
- **Enhanced host manager**: Card-based host management with streamlined profile configuration
- **Private key fix**: Resolved RSA-SHA2 private key authentication failures

## Acknowledgements

Based on [Tabby](https://github.com/Eugeny/tabby) by Eugeny. Thanks to all upstream contributors.

---

This README is also available in: [简体中文](./README.zh-CN.md)
