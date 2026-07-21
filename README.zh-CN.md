[![](docs/readme.png)](https://tabby.sh)

---

基于 [Tabby](https://tabby.sh)（前身 **Terminus**）的定制分支，专注于 Windows 下的 SSH 与终端工作流。

基于 Tabby v1.0.7，针对日常 SSH 管理场景进行了 UI 优化和缺陷修复。

## 下载

预构建的 Windows 产物（构建后位于 `dist/` 目录）：

- `tabby-1.0.7-setup-x64.exe` — NSIS 安装程序
- `tabby-1.0.7-portable-x64.zip` — 便携版压缩包

## 功能特性

### 终端

- VT220 终端，支持多个嵌套拆分窗格
- 标签页可放置在窗口任意一侧
- 可选的可停靠窗口，支持全局热键（"Quake console"）
- 进度检测和进程完成通知
- 带括号的粘贴，多行粘贴提示
- 连体字和自定义 shell 配置
- 完整的 Unicode 支持，包括双角字符
- 支持 PowerShell（及 PS Core）、WSL、Git-Bash、Cygwin、MSYS2、Cmder 和 CMD
- 终端工具栏，提供快捷操作

### SSH 客户端

- 带有连接管理器的 SSH2 客户端
- X11 和端口转发（本地/远程/动态 SOCKS）
- 跳板机 / 堡垒机支持
- 代理转发（包括 Pageant 和 Windows 原生 OpenSSH 代理）
- 登录脚本
- 通过 Zmodem 进行 SFTP 文件传输
- RSA-SHA2 / ECDSA 私钥认证，支持口令
- HTTP / SOCKS 代理支持
- **批量输入** — 同时向多个 SSH 会话发送命令
- **增强 SFTP 面板** — 改进的文件管理界面

### 启动页与主机管理

- 重新设计的启动页，提供快速连接快捷方式
- 增强的主机管理界面，采用卡片式布局
- 改进的配置文件设置页，简化配置流程

### AI 助手（tabby-llm）

基于大语言模型的命令自动补全、下一条命令预测和本地 CLI/MCP Agent Bridge，直接内嵌于终端。

#### 功能

- **智能补全**：输入时从本地历史、登录脚本、AI 预取预测和 live AI 补全中获取候选。本地候选即时显示；live AI 经过防抖并在超时后静默回退。
- **下一条命令预测**：提交命令后，助手会基于上一条命令和终端上下文预取可能的后续命令，并在你开始输入时与历史候选一起排序展示。
- **危险命令检测**：自动识别潜在破坏性命令（`rm -rf`、`dd`、`mkfs`、`chmod 777`、`curl | sh` 等），执行前弹出警告对话框。
- **敏感信息脱敏**：终端输出中的 API 密钥、令牌、密码和私钥在发送给 LLM 前就地脱敏。
- **命令历史**：读取本地 shell 历史和 SSH 历史，记录当前 tab 最近命令，并限制历史候选数量，避免补全面板过载。
- **建议缓存**：补全结果缓存 5 分钟，减少 API 调用。
- **CLI / MCP Agent Bridge**：可选的 localhost agent bridge，可供 Codex、Cursor、Claude Desktop 等外部 agent 访问 Tabby 会话，并通过 token scope 和审计日志保护。

#### 配置

打开 **设置 → AI assistant** 进行配置：

| 设置项 | 默认值 | 说明 |
|---|---|---|
| 启用 AI 功能 | 关 | 所有 AI 功能的总开关 |
| API base URL | `https://api.openai.com/v1` | 任何 OpenAI 兼容端点 |
| API key | — | 本地存储于 `config.yaml` |
| 模型 | `gpt-4o-mini` | 聊天补全模型名称 |
| 补全专用模型 | 空 | 可选快速补全模型；留空时使用主模型 |
| 补全时关闭思考 | 开 | 对支持的模型发送关闭/最低思考参数 |
| AI 补全超时（ms） | `1000` | live AI 超时后继续使用本地历史/缓存候选 |
| 补全防抖（ms） | `600` | 输入时触发 live AI 补全的延迟 |
| 历史候选上限 | `10` | 历史候选最大展示数量 |
| 编辑器内 AI 补全 | 关 | 在 vim/nano alternate screen 内启用 AI 文本补全 |
| 输入时自动补全 | 开 | 输入时自动触发建议 |
| 发送终端上下文到 API | 开 | 发送最近终端输出以提供更好上下文（敏感模式就地脱敏） |
| 最大上下文行数 | `20` | AI 请求中包含的最近终端行数 |
| 确认时执行 | 关 | 接受补全候选后立即回车执行 |
| 面板水平/垂直偏移 | `32` / `52` | 让补全面板远离光标，减少遮挡 |

输入 API key 后点击 **Test connection** 验证连接。

#### 兼容的 API 提供商

任何实现了 OpenAI Chat Completions API（`/chat/completions`）的服务商：

- **OpenAI** — `https://api.openai.com/v1`
- **Azure OpenAI** — `https://<resource>.openai.azure.com/openai/deployments/<deployment>/v1`
- **Ollama** — `http://localhost:11434/v1`
- **LM Studio** — `http://localhost:1234/v1`
- **DeepSeek** — `https://api.deepseek.com/v1`
- **Moonshot（Kimi）** — `https://api.moonshot.cn/v1`

#### 快捷键

| 快捷键 | 功能 |
|---|---|
| `Ctrl+Shift+Space` | 手动触发补全 |
| `Ctrl+Y` | 接受选中建议 |
| `Ctrl+N` | 下一条建议 |
| `Ctrl+U` | 上一条建议 |
| `Esc` | 关闭补全面板 |

所有快捷键均可在 **设置 → 快捷键** 中自定义。

#### 工作原理

1. **命令补全**：插件从 xterm.js 缓冲区读取当前部分命令，收集终端上下文（操作系统、shell、工作目录、最近输出），并将历史、登录脚本、AI 预取和 live AI 候选去重排序后展示。
2. **下一条命令预测**：每个 shell 会话的第一条命令不触发 live AI 补全。提交命令后，AI 会基于上一条命令和当前上下文预取可能的后续命令，并在你开始输入时优先复用缓存。
3. **隐私**：启用「发送终端上下文到 API」时，最近终端输出会被包含以提升建议质量。敏感模式（API 密钥、令牌、密码、私钥）在发送前就地脱敏。禁用此选项则仅发送命令片段，不附带最近输出。
4. **Agent Bridge**：可选 CLI/MCP bridge 通过 localhost 暴露 Tabby 会话给外部 agent，使用 token scope、SFTP 限制、危险命令确认和审计日志保护。

## 便携式应用

如果在 Tabby.exe 所在的目录创建一个名为 `data` 的文件夹，Tabby 将可以在 Windows 上作为便携式应用程序运行。

## 从源码构建

### 前置条件

- Node.js 18+
- Yarn 1.x
- Python 3（用于原生模块编译）
- Visual Studio Build Tools（用于原生模块编译）

### 构建步骤

```bash
# 安装依赖
yarn

# 冒烟测试：TypeScript 类型检查
npx tsc -p tabby-core/tsconfig.json --noEmit
npx tsc -p tabby-settings/tsconfig.json --noEmit
npx tsc -p tabby-terminal/tsconfig.json --noEmit
npx tsc -p tabby-ssh/tsconfig.json --noEmit
npx tsc -p tabby-local/tsconfig.json --noEmit
npx tsc -p tabby-electron/tsconfig.json --noEmit
npx tsc -p tabby-linkifier/tsconfig.json --noEmit
npx tsc -p tabby-auto-sudo-password/tsconfig.json --noEmit
npx tsc -p tabby-community-color-schemes/tsconfig.json --noEmit

# 冒烟测试：Webpack 构建
yarn run build

# 构建 Windows 安装包
node scripts/build-windows.mjs
```

如果 `prepackage-plugins.mjs` 因原生模块重建失败，可使用跳过标志：

```bash
set TABBY_SKIP_PREPACKAGE=1&&node scripts/build-windows.mjs
```

## 相对于上游 Tabby 的变更

- **批量输入**：同时向多个 SSH 会话发送命令
- **增强 SFTP 面板**：改进的文件管理界面，更好的视觉反馈
- **终端工具栏**：常用终端操作的快捷工具栏
- **重新设计的启动页**：快速连接快捷方式，改进的布局
- **增强的主机管理器**：卡片式主机管理，简化的配置文件配置流程
- **私钥修复**：解决 RSA-SHA2 私钥认证失败问题
- **AI 助手（tabby-llm）**：基于 LLM 的命令补全、下一条命令预测、CLI/MCP Agent Bridge、危险命令检测和敏感信息脱敏

## 致谢

基于 [Eugeny](https://github.com/Eugeny) 开发的 [Tabby](https://github.com/Eugeny/tabby)。感谢所有上游贡献者。

---

本 README 还适用于以下语言：[English](./README.md)
