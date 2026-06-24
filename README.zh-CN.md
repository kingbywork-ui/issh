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

基于大语言模型的命令自动补全和自然语言转命令，直接内嵌于终端。

#### 功能

- **智能补全**：输入时同时从本地历史和 AI 获取命令建议。历史匹配即时显示，AI 建议通过 OpenAI 兼容 API 流式返回。
- **自然语言转命令**：用自然语言描述你想做的事（例如「列出所有大于 100MB 的文件」），生成可执行命令并附带解释。
- **危险命令检测**：自动识别潜在破坏性命令（`rm -rf`、`dd`、`mkfs`、`chmod 777`、`curl | sh` 等），执行前弹出警告对话框。
- **敏感信息脱敏**：终端输出中的 API 密钥、令牌、密码和私钥在发送给 LLM 前就地脱敏。
- **命令历史与模糊搜索**：跟踪最多 500 条命令，结合使用频率和时效评分。跨会话持久化到 `llm-command-history.json`。
- **建议缓存**：补全结果缓存 5 分钟，减少 API 调用。

#### 配置

打开 **设置 → AI assistant** 进行配置：

| 设置项 | 默认值 | 说明 |
|---|---|---|
| 启用 AI 功能 | 关 | 所有 AI 功能的总开关 |
| API base URL | `https://api.openai.com/v1` | 任何 OpenAI 兼容端点 |
| API key | — | 本地存储于 `config.yaml` |
| 模型 | `gpt-4o-mini` | 聊天补全模型名称 |
| 补全防抖（ms） | `300` | 输入时触发补全的延迟 |
| 输入时自动补全 | 开 | 输入时自动触发建议 |
| 发送终端上下文到 API | 开 | 发送最近终端输出以提供更好上下文（敏感模式就地脱敏） |
| 最大上下文行数 | `20` | AI 请求中包含的最近终端行数 |
| 确认时执行 | 关 | 从自然语言转命令确认后直接运行，不按回车 |

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
| `Ctrl+Shift+N` | 打开自然语言转命令面板 |
| `Ctrl+Y` | 接受选中建议 |
| `Ctrl+N` | 下一条建议 |
| `Ctrl+U` | 上一条建议 |
| `Esc` | 关闭 AI 面板 |

所有快捷键均可在 **设置 → 快捷键** 中自定义。

#### 工作原理

1. **命令补全**：启用并输入时，插件从 xterm.js 缓冲区读取当前部分命令，收集终端上下文（操作系统、shell、工作目录、最近输出），发送请求给 LLM。历史匹配立即显示；AI 建议流式返回后去重合并。
2. **自然语言转命令**：打开浮层面板，输入自然语言请求。LLM 返回单条命令及解释。危险命令触发确认对话框。可选择直接运行或插入终端编辑。
3. **隐私**：启用「发送终端上下文到 API」时，最近终端输出会被包含以提升建议质量。敏感模式（API 密钥、令牌、密码、私钥）在发送前就地脱敏。禁用此选项则仅发送部分命令，不附带上下文。

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
- **AI 助手（tabby-llm）**：基于 LLM 的命令补全、自然语言转命令、危险命令检测和敏感信息脱敏

## 致谢

基于 [Eugeny](https://github.com/Eugeny) 开发的 [Tabby](https://github.com/Eugeny/tabby)。感谢所有上游贡献者。

---

本 README 还适用于以下语言：[English](./README.md)
