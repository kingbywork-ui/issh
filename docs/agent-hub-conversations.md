# Agent Hub Web 通讯

## 使用

1. 在工作区注册两个 Agent，并为双方授予“发送提示词”权限。
2. 打开“Agent 会话 → 通讯配置”，为各注册记录保存协议、可执行文件、启动参数与工作目录。当前支持 Pi RPC、Hermes ACP、Codex App Server；扫描到其他 CLI 不代表已支持其对话协议。
3. 选择先发言的 Agent 和协作 Agent，点击“新建会话”。输入议题，选择本次回复次数，点击“发送并开始协作”。默认 3 次为 A → B → A；每次真实回复都会写入右侧记录。达到次数后停止，不无限相互回复。

首次使用需在运行 issh 的本机安装 Node.js 18 或更新版本并加入 PATH。目标 Agent 的模型与认证由其自身配置提供，不要把密码或 API key 写入启动参数。

## 通讯方式

- **本地 Pi**：使用 `pi --mode rpc`。Windows 的 npm `.cmd` / `.ps1` 包装器不能直接作为协议进程，请将可执行文件设为 `node.exe`，并把实际 Pi CLI `.js` 的完整路径放到参数数组首项。例如参数形状为 `["C:\\实际安装目录\\cli.js", "--mode", "rpc"]`。纯文本协作可增加 `--no-tools` / `--no-extensions` 等该版本支持的选项。
- **远端 Hermes**：本机可执行文件使用 `ssh.exe`，参数形状为 `["-T", "-o", "BatchMode=yes", "主机别名", "hermes", "acp"]`。使用已经配置、验证过的 SSH 主机与凭据；也可显式配置端口和私钥文件路径。不要关闭主机密钥校验。
- **Codex**：使用支持 App Server 的 CLI，启动参数为 `["app-server"]`，Windows 同样需要使用可直接启动的可执行文件。
- `Agent 工作目录` 是目标 Agent 的目录；SSH 时填写远端路径。本地进程启动目录可单独设置；直接使用 `ssh.exe` / `wsl.exe` 且留空时，使用 issh 本地目录启动传输进程，不把远端 `/root` 当作 Windows 目录。

配置明确关联已注册的 agentId，但协议进程是**独立会话**，不会接管正在运行的交互式终端。需要接入已有原生聊天的任意外部 conversationId，当前 Web 尚不提供该入口。

## 记录与恢复

- 配置和会话记录保存在 issh 用户数据目录的 `agent-conversations.json`，不在浏览器中保存唯一副本；刷新或正常重启后仍可查看。
- 每个 Web 会话保存双方原生 conversationId。继续通讯时，Pi 使用 `--session`，Hermes/Codex 使用协议恢复；无法恢复时显示失败，不偷偷创建新对话。
- 相同 requestId 不会再次投递；一个 Agent 同时只执行一条协作流程。超时和服务中断不自动重发，避免重复执行。
- “停止转发”断开此流程的协议连接并停止后续消息；不代表撤销外部 Agent 已执行的工具操作。
- 注册被删除后，旧会话仍保留历史，但不能向已注销 Agent 继续发送。工作区被删除后，其记录不再通过工作区 API 展示。
- 当前每个流程最多 6 次回复；本地历史文件上限 32 MB、最多 200 个会话。达到上限时明确报错，不静默清除历史。

## 实现与验证

管理服务认证后，通过 Runtime 的 `agent.list` 取得当前工作区真实注册身份与权限；浏览器不能自行提交注册身份作为授权依据。`conversation.*` 只经管理 Web RPC 暴露，未添加到 MCP 工具目录。stdio worker 使用独立进程管道复用已有协议适配器；安装暂存与资源复制均包含该 worker 和适配器。

2026-09-08 实测：新版 Web 经临时本机验证入口连接真实 Hub 注册记录（Pi `agent-17`、Hermes `agent-15`），从页面完成 `WEB_A2A_0909` 的 Pi → Hermes → Pi 闭环。刷新页面后全部记录可见；重启通讯 worker 后，`WEB_RESUME_0909` 再次闭环，双方原生 conversationId 均保持不变。这验证了新版页面和真实协议进程；不是旧安装版 33555 已更新的证据。

回归入口：`node --test issh-agent/test/*.test.mjs`、`cargo test --manifest-path issh-tauri/src-tauri/Cargo.toml --lib`、`npm.cmd run check --prefix issh-tauri/agent-dashboard`。
