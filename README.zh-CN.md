![issh 主机管理器](docs/readme.png)

# issh — 轻量、安全、AI 原生的 SSH 终端

**issh** 是基于 **Tauri 2 + Rust** 构建的新一代 SSH 终端。它将原生性能的终端内核、企业级 SSH 工具链、本地加密凭据保险库与 AI 辅助工作流整合进一个 **约 5 MB** 的安装包——体积远小于基于 Electron 的同类终端。

## 为什么选择 issh

- **极致轻量** —— 约 5 MB 的 NSIS 安装包与极低的运行时占用，采用 Rust 引擎替代内置的 Chromium 浏览器。启动快、内存省，适合常驻的终端工作流。
- **原生性能** —— 本地 PTY、SSH、SFTP 与加密保险库全部运行在 `isshd` 这个专用 Rust 运行时中，数据链路无 Node.js 中间层，高负载下击键、流式传输与文件操作依然流畅。
- **安全优先** —— 凭据仅保存在本机，使用 **AES-256-GCM** 加密（PBKDF2-SHA512 派生密钥），绝不上传云端。商城插件安装前需通过 ed25519 签名与 SHA-256 摘要校验。
- **企业级 SSH** —— 本地 / 远程 / 动态（SOCKS5）端口转发、跳板机、ProxyCommand、HTTP/SOCKS 代理、X11 转发、Agent 转发、键盘交互认证，均可按主机配置独立管理。
- **AI 原生** —— LLM 驱动的命令补全，以及可将终端工作区暴露给 Codex、Cursor、Claude Desktop 等 AI 智能体的 Agent Bridge（token 保护的 localhost 通道）。
- **开放的插件生态** —— 带签名校验、权限声明、依赖管理的一键安装/更新插件商城，让产品随你的工作流持续生长。

## 功能特性

### 终端体验

- 多标签工作区，支持**递归分屏**：窗格任意嵌套、拖动分隔条调整比例、任意窗格最大化/还原，整个布局跨重启持久化。
- **会话恢复**：已信任主机重启后自动重连；本地 Shell 以相同的 shell、工作目录与尺寸自动重建。
- 原生系统剪贴板，支持**选区自动复制**与右键粘贴。
- 一键**导出终端内容**到本地文件；将文件路径拖入终端即可注入。
- 本地 Shell 可选：`cmd`、Windows PowerShell、PowerShell 7、WSL、Git Bash（Unix 类系统支持 `bash`/`zsh`/`fish`）。
- 首页、工具栏快捷操作、标签页右键菜单，以及基于 xterm.js 的完整 Unicode 渲染。

### SSH 客户端

- 基于 Rust（`russh`）的 SSH 引擎，配以分组卡片式**主机管理器**与三标签主机编辑器（通用 / 高级 / 安全）。
- **端口转发**：本地、远程、动态（SOCKS5），按主机配置持久化，连接与重连时自动启动。
- **可达性工具**：跳板机（多级）、支持 `%h`/`%p`/`%r` 展开的 `ProxyCommand`、HTTP CONNECT 与 SOCKS5 代理。
- **可信主机密钥**：首次确认后记住主机指纹；登录脚本在连接后自动执行。
- X11 转发、SSH Agent 转发、键盘交互认证与会话复用。

### SFTP 浏览器

- 内置 SFTP 面板，支持浏览、上传、下载、重命名、删除与目录导航，无需额外客户端。

### 凭据保险库与 sudo 自动填充

- 密码、私钥口令、**sudo 密码**等全部凭据保存在本地加密保险库（**AES-256-GCM**，PBKDF2-SHA512 派生密钥、31 万次迭代）中，由主口令保护并自动锁定。
- 凭据按 `主机 + 用户 + 端口` 精确匹配，绝不在不同服务器间串用。
- **sudo 自动填充**：出现 `sudo` 密码提示时一键填充——保险库仅为该次读取临时解锁，填充后立即重新锁定；待填充密码 10 秒后自动失效。

### 插件商城

- 从**签名商城**一键安装与更新（ed25519 签名 + SHA-256 校验、权限声明、依赖检查）。
- 内置插件：**AI 命令补全**（LLM 补全）、**Agent 桥接**（工作区 / 智能体管理）、**配置同步**（JSON 导出导入 + GitHub Gist）、**链接识别**（URL/IP/路径识别）、**串口终端**（Web Serial）、**Herdr 工作区**。
- 自动 CDN 回退，主源缓慢或被阻断时商城依然可达。

## AI 与智能体集成

- **命令补全**：输入时由 OpenAI 兼容的大模型（OpenAI、Azure OpenAI、Ollama、DeepSeek 等）预测下一条命令，`Ctrl+Y` 接受，防抖设计不打断输入节奏。
- **Agent Bridge**：通过 token 保护的 localhost RPC/MCP 通道，将终端工作区暴露给 Codex、Cursor、Claude Desktop 等 AI 编码智能体；会话访问、命令执行与文件操作均受作用域限制与审计日志保护。

## 架构

```
┌──────────────────────────────┐    JSON-RPC     ┌───────────────────────────┐
│  issh 界面（Tauri 2 + Svelte │◄────────────────►│  isshd（Rust 运行时）      │
│  5 + xterm.js）              │   本地 IPC       │  PTY · SSH · SFTP · 保险库 │
└──────────────────────────────┘                  └───────────────────────────┘
```

- **前端**：Tauri 2 + Svelte 5 + xterm.js 5，发布产物不包含 Node.js 运行时。
- **运行时**：`isshd`，一个专用 Rust 守护进程，承载全部终端、SSH、SFTP、保险库与工作区逻辑。
- **可扩展性**：沙箱化插件通过基于能力（capability）的权限系统通信；商城中的每个插件均附带 ed25519 签名。

## 安全设计

- 凭据静态加密（**AES-256-GCM** / PBKDF2-SHA512），永不出本机。
- 插件安装前**签名与哈希双重校验**；每个插件的权限均声明并可审阅。
- Agent Bridge RPC 仅监听 localhost，受 token 保护、作用域限制与审计日志约束。
- 界面强制 CSP；远程内容仅在沙箱化的插件面板内加载。

## 下载

- **Windows x64**：`issh-<version>-x64-setup.exe` NSIS 安装程序（约 5 MB，当前用户安装）。缺少 WebView2 时按需静默安装。
- Rust 运行时与前端均为跨平台设计，Linux 与 macOS 版本可从源码构建（见下）。

## 从源码构建

### 前置条件

- Node.js 18+
- Rust stable 工具链
- Windows：MSVC 构建工具（用于 Rust 运行时）与 WebView2

### 构建步骤

```bash
# 1. 构建 Rust 运行时
cd issh-runtime
cargo build --release -p isshd

# 2. 前端与产物暂存
cd ../issh-tauri
npm install
npm run stage:runtime        # 将 isshd 拷贝到 src-tauri/bin

# 3. 开发模式
npm run tauri -- dev

# 4. Windows 安装包（NSIS）
npm run tauri -- build
```

## 致谢

issh 起源于 [Eugeny](https://github.com/Eugeny) 开发的 [Tabby](https://github.com/Eugeny/tabby)。桌面客户端现已基于 Tauri + Rust 重建，并引入了全新的运行时、插件系统与商城。感谢所有上游贡献者。

---

本 README 亦提供：[English](./README.md)
