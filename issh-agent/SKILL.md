---
name: issh
description: Operate issh Agent Bridge sessions, commands, SFTP and workspace tasks with explicit session targeting and execution verification.
---

# issh MCP 操作

## 发现与连接

先搜索当前宿主可调用的 issh MCP 工具或延迟工具目录，再调用 issh_health。不要假设存在 mcps/、CallMcpTool 或某种权限参数；没有原生 MCP 工具时可用下述 RPC 脚本回退。配置存在、RPC 健康、MCP tools/list 可见是三个不同验证层级。

连接配置见 issh-mcp-cursor 技能。Bridge 必须由用户手动开启；已有任务授权在范围内持续有效，不重复申请。连接失败先看文件、进程、端口和实际错误，只有明确沙箱拒绝时才使用当前宿主提供的提权机制，不默认请求全权限。

读取 discovery 文件时只提取必要字段，不输出 token。优先 ISSH_AGENT_BRIDGE_FILE，其次 ISSH_CONFIG_DIRECTORY，再查 APPDATA/LOCALAPPDATA 下 issh 及 ~/.config/issh；旧 TABBY_* 与 tabby 文件仅作兼容。端口以 rpcUrl 为准，支持固定或动态配置。轮换 token/端口可重新读取连接文件；工具代码或清单更新需要重启 MCP server 并刷新客户端，不能只看旧缓存。

## 会话与命令

1. health → list_sessions；按用户指定主机、profile 身份确认目标。不要猜 session id，重连后重新查。
2. get_context/read_buffer/preview/insert/run/exec/SFTP 使用 **tab**；workspace.bind/unbind 和 agent.register 使用 **sessionId**，不能互换。始终显式传 tab 可避免多 Agent 切换 active 的竞态。
3. Tauri 当前 exec 仅支持 SSH，返回隔离输出；本地 Pi 的探测接口不等于本地 shell exec。交互终端用 run（回车、不等待）或 insert（不回车）；先确认终端处于 shell，不能把 shell 命令注入 Pi 等 TUI。
4. preview 只归一化和检查危险性，不返回插入后的缓冲。危险操作须有用户授权，并遵守宿主确认；confirmDangerous 不能作为自行授权。
5. exec 返回 jobId/status=running 时，查询 get_job，必要时 list_jobs；不可因等待超时重跑原命令。截断输出用 get_output 的 outputId/offset/limit 获取。exitCode=null 表示退出码未知，不能仅凭 stdout 判成功。
6. read_buffer 用 lines，不支持 offset/limit。SFTP read 用 maxBytes/encoding，不能假定分页读取。SFTP write 仅限用户批准路径，遵守 root/字节限制。

示例（id 必须来自本次列表）：
```json
{"tool":"issh_get_context","arguments":{"tab":"ssh-1"}}
{"tool":"issh_exec_command","arguments":{"tab":"ssh-1","command":"hostname","timeoutMs":30000}}
{"tool":"issh_get_job","arguments":{"jobId":"实际返回的 jobId"}}
{"tool":"issh_get_output","arguments":{"outputId":"实际返回的 outputId","offset":0,"limit":8000}}
```

## Workspace / Agent 协作边界

workspace 和任务状态已持久化。先 list workspace/agents，再按用户意图 create/bind/register，避免重复注册。
- agent_prompt 仅入队并返回 task id；task_wait/read/list 查看状态，workspace_events 用 afterSequence 增量读。没有消费者时任务会停 queued，注册 Agent 不会自动控制 TUI 或唤醒 Codex/OpsClaw 当前聊天。
- task_start/complete 是状态接口：执行者实际开始后 start，工作确实完成后 complete 并提交 output；不能用这两个接口伪造完成，不能假定它们实现原子领取或自动执行。多人调度需指定唯一执行者。
- task_cancel 更新任务状态；不保证已启动的外部 Agent/进程已经终止，需执行器确认。
- Pi adapter 在源码 issh-agent/src/conversation-adapters.mjs，使用 pi --mode rpc；当前属于实验性独立对话链，未接生产 workspace relay 或安装包。会话恢复不代表接管运行中的 TUI。真实验收须检查同一 conversationId 上的请求→回复，不以握手为完成。
- Codex 与 OpsClaw 可作为同一 Bridge 的 MCP 客户端，但自动任务领取、转发 Pi、回写结果和聊天唤醒仍需明确实现；技能不提供这些产品功能。
- Pane 原始输入必须先 claim_input，写入携带其返回的所有权凭据，完成后 release_input。普通终端命令不是 pane 协议。
- 未列入实际 tools/list 的工具不可调用：当前不包含 issh_search_rag 或 issh_agent_unregister；UI 注销能力不等于已暴露同名 MCP 工具。

## 工具参考

以下为当前源码 getMcpTools() 的 40 项快照；调用前以运行中服务器的 schema 和宿主实现为准。`?` 表示可选。共享 schema 对 exec 的旧本地执行描述与 Tauri 实现不一致，遵循上面的 SSH 限制，不据此扩大能力。

| 工具 | 参数 |
|---|---|
| `issh_health` |  |
| `issh_list_sessions` |  |
| `issh_pane_list` |  |
| `issh_pane_snapshot` | `paneId` |
| `issh_pane_subscribe` | `paneId`, `afterSequence?`, `maxEvents?`, `maxBytes?` |
| `issh_pane_claim_input` | `paneId`, `ownerId` |
| `issh_pane_release_input` | `paneId`, `ownerId` |
| `issh_pane_write` | `paneId`, `ownerId`, `data` |
| `issh_pane_resize` | `paneId`, `actorId`, `columns`, `rows` |
| `issh_workspace_list` |  |
| `issh_workspace_create` | `name` |
| `issh_workspace_bind` | `workspaceId`, `sessionId` |
| `issh_workspace_unbind` | `workspaceId`, `sessionId` |
| `issh_agent_register` | `workspaceId`, `name`, `sessionId?`, `scopes?` |
| `issh_agent_list` | `workspaceId` |
| `issh_agent_prompt` | `agentId`, `prompt` |
| `issh_task_wait` | `taskId`, `timeoutMs?` |
| `issh_task_read` | `taskId` |
| `issh_task_list` | `workspaceId` |
| `issh_task_cancel` | `taskId` |
| `issh_task_start` | `taskId` |
| `issh_task_complete` | `taskId`, `output` |
| `issh_workspace_events` | `workspaceId`, `afterSequence?`, `limit?` |
| `issh_list_profiles` |  |
| `issh_connect_profile` | `id?`, `name?`, `timeoutMs?` |
| `issh_disconnect_session` | `tab?` |
| `issh_get_context` | `tab?` |
| `issh_read_buffer` | `tab?`, `lines?` |
| `issh_select_session` | `tab?` |
| `issh_preview_command` | `tab?`, `command` |
| `issh_insert_command` | `tab?`, `command` |
| `issh_run_command` | `tab?`, `command`, `confirmDangerous?` |
| `issh_exec_command` | `tab?`, `command`, `timeoutMs?`, `cwd?`, `confirmDangerous?` |
| `issh_get_output` | `outputId`, `offset?`, `limit?` |
| `issh_batch_exec` | `tabs?`, `command`, `timeoutMs?`, `cwd?`, `parallel?`, `confirmDangerous?` |
| `issh_sftp_list` | `tab?`, `path` |
| `issh_sftp_read` | `tab?`, `path`, `encoding?`, `maxBytes?` |
| `issh_sftp_write` | `tab?`, `path`, `content`, `encoding?` |
| `issh_list_jobs` |  |
| `issh_get_job` | `jobId` |

## RPC 回退与故障

个人技能附带 scripts/issh-rpc.ps1；随包技能未附此脚本时，使用 issh-agent/bin/issh-agent.mjs 支持的命令，或用已安装 client.mjs 的 loadConnection/rpc 对照 schema 调用，勿猜测本地文件存在。
```powershell
& "$env:USERPROFILE/.agents/skills/issh-mcp-tools/scripts/issh-rpc.ps1" health
& "$env:USERPROFILE/.agents/skills/issh-mcp-tools/scripts/issh-rpc.ps1" exec -Tab ssh-1 -Command 'hostname' -TimeoutMs 30000
& "$env:USERPROFILE/.agents/skills/issh-mcp-tools/scripts/issh-rpc.ps1" rpc -Method issh_task_read -ParamsJson '{"taskId":"task-1"}'
```
RPC 通用入口支持已授权工具，不改变权限边界。超时单位为毫秒，health 5000、普通 15000、SFTP 35000；connect/exec/batch/task_wait 使用 timeoutMs 加 5000 毫秒余量。

No active session：显式传本次查询的 tab。Unknown tool：对照源码、已安装 MCP 和运行中宿主清单，更新后刷新进程。敏感输入出现时停止 context/buffer 读取；不能假定所有历史输出都已脱敏。排障读取最少审计信息，避免输出 token、密码、密钥或无关终端内容。
