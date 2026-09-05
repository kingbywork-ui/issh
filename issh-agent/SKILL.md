---
name: issh
description: 通过 issh Agent Bridge 安全操作本地与 SSH 终端会话——列出会话/主机、读取终端上下文与输出缓冲、预览/插入/执行 shell 命令、批量执行、SFTP 文件读写。Use when the user asks to run commands in their issh terminal, inspect terminal context or output, or transfer files over SFTP.
---

# issh Agent Bridge

issh 终端通过本地 HTTP RPC（默认 `127.0.0.1:59688`）把终端会话暴露给外部 agent。连接需 Bearer token；所有写/执行/SFTP 操作受 scope 限制并记录审计日志。

## 连接

- 端点：优先读取 discovery 文件中的 `rpcUrl`；默认 `http://127.0.0.1:59688/rpc`（JSON-RPC 2.0）。Bridge 设置页可改用其它端口。
- 认证：请求头 `Authorization: Bearer <token>`，token 在 issh 设置页「Agent Bridge」中查看/轮换
- 手动开启：Agent Bridge 开关每次启动默认关闭，必须在 issh 设置页手动开启；完全退出 issh 时自动关闭

## 工具清单（17 个）

### 健康与会话发现
| 工具 | 用途 |
|------|------|
| `issh_health` | 返回服务端能力与协议版本 |
| `issh_list_sessions` | 列出当前终端会话（id/kind/title/cwd） |
| `issh_list_profiles` | 列出已保存的 SSH 主机 profile |
| `issh_connect_profile` | 按 profile 建立 SSH 会话 |
| `issh_disconnect_session` | 断开指定会话 |
| `issh_select_session` | 设置活动会话（后续命令默认目标） |

### 上下文读取
| 工具 | 用途 |
|------|------|
| `issh_get_context` | 读取会话上下文（cwd/shell/os/部分输入/最近输出） |
| `issh_read_buffer` | 读取终端输出缓冲（支持翻页 offset/limit） |

### 命令执行
| 工具 | 用途 |
|------|------|
| `issh_preview_command` | 预览命令但不执行（返回插入后的缓冲区预览） |
| `issh_insert_command` | 把命令插入终端输入行（不回车） |
| `issh_run_command` | 插入命令并执行 |
| `issh_exec_command` | 后台执行命令，返回 stdout/stderr/exitCode |
| `issh_get_output` | 按 outputId 拉取后台执行输出 |
| `issh_batch_exec` | 跨多个会话批量执行命令 |

### SFTP 文件操作
| 工具 | 用途 |
|------|------|
| `issh_sftp_list` | 列出远程目录 |
| `issh_sftp_read` | 读取远程文件（分块） |
| `issh_sftp_write` | 写入远程文件（受单次字节上限限制） |

## 使用示例

```
1. 列出会话：    issh_list_sessions
2. 读取上下文：  issh_get_context { sessionId: "..." }
3. 只读执行：    issh_exec_command { sessionId: "...", command: "ls -la" }
4. 预览再执行：  issh_preview_command { command: "git status" } → issh_run_command
5. 读取文件：    issh_sftp_read { path: "/etc/hosts" }
```

## 安全边界

- 只监听 `127.0.0.1`，默认端口 `59688`；每次启动默认关闭，需手动开启。设置页的“断开 Agent 连接”会关闭现有 SSE 长连接但保留 Bridge 监听。
- 危险命令（`rm -rf`、`dd`、`mkfs` 等）执行前在 issh 界面弹确认框，agent 无法绕过
- SFTP 根目录与单次写入字节上限由用户配置，越界直接拒绝
- 所有操作写入本地审计日志（`agent-bridge-audit.jsonl`）
- 密码/令牌等敏感输入不进入 agent 可读的上下文（敏感输入检测自动停止补全）
