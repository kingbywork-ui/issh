# Backlog 任务拆分（PM/BA 视角）

> 生成：2026-09-03（PM/BA 拆分版 v1）
> 依据：`REQUIREMENTS.md`（dev 分支 13 项待办）+ issh 分支插件源码实据（`issh-ssh` / `issh-terminal` / `issh-linkifier` / `issh-settings`）
> 定位：本文件是 REQUIREMENTS.md 待办项的规划拆解（Epic/Story/AC/优先级/依赖/规模）。REQUIREMENTS.md 保持精简，只做状态索引；拆解细节以本文件为准。

---

## 1. 产品定位与目标

| 维度 | 结论 |
|------|------|
| 产品 | issh 终端（dev 分支，Tauri 2 + Svelte 5 + isshd Runtime） |
| 核心差异点 | ① LLM 命令补全（issh-llm 对齐）② Agent Bridge（外部 agent 通过 RPC/MCP 控制终端） |
| 目标用户 | 重度终端用户 + 使用 Codex/Cursor/Claude Desktop 的 AI 开发者 |
| 本次拆分目标 | 把 13 项待办收敛为可排期的 Epic/Story，明确 AC、优先级、依赖与规模 |

**待办清单（13 项）**：R-009、R-010、R-011、R-012、R-013、R-015、R-016、R-050~R-055。

---

## 2. Epic 归并

| Epic | 覆盖需求 | 价值主张 |
|------|----------|----------|
| **A. 产品对齐收尾** | R-009、R-010、R-011、R-012、R-013 | 补完 dev 相对 issh 分支的功能缺口，达成「对齐」交付 |
| **B. LLM 补全补差** | R-015、R-016 | 补全核心体验的置信度排序、命令过滤、缓存、敏感输入防护与 agent 进程识别 |
| **C. Agent Bridge 进阶** | R-050~R-055 | Netcatty 架构超前能力，从「最小闭环」走向「agent 原生工作区」 |

---

## 3. Story 拆分与验收标准

> 规模口径：S=1-2 人日；M=3-5 人日；L=1-2 人周；XL=2 人周以上。
> 优先级：P0 本波必做；P1 下一波；P2 排期后做；P3 单独立项。

### Epic A — 产品对齐收尾

#### A1 About/版本检查（R-009）— M / P1
- **描述**：移植 issh 分支 `AboutSettingsTabComponent` + `VersionCheckService`（Gitea release 检查）到 Tauri 设置页。
- **AC**：
  1. 关于页显示版本号（0.1.6 语义）、运行时信息（Tauri/WebView2/isshd 版本）
  2. 可配置 Gitea 地址/仓库路径；「检查更新」能比对并提示新版本
  3. 网络失败静默降级，不阻塞设置页
- **依赖**：无。**参考**：issh 分支 `issh-llm/src/components/aboutSettingsTab.component.*`、`issh-llm/src/services/versionCheck.service.ts`。

#### A2 SSH 配置/私钥导入 UI（R-010）— L / P2
- **描述**：移植 issh 分支 `issh-ssh/src/api/importer.ts`：从 `~/.ssh/config`（含 Include）导入主机，从文件导入私钥。
- **AC**：
  1. 提供显式导入入口（HostManager 内）；解析 OpenSSH config 的 Host/HostName/User/Port/IdentityFile/ProxyJump
  2. 导入后 HostManager 可见并可连接；重复 host 去重提示
  3. 私钥导入存入保险库（加密），可选用
- **依赖**：无。**注意**：R-037 已完成 ProxyJump/代理字段的 profile 模型，导入器直接落这些字段。

#### A3 已知主机管理 UI（R-010）— M / P2
- **描述**：dev 已有指纹确认弹窗（R-029/R-030），缺管理列表。对齐 `sshKnownHosts.service.ts` 的管理能力。
- **AC**：
  1. 设置页可查看已信任主机列表（host/key 指纹摘要）
  2. 可删除单条信任记录；删除后下次连接重新走指纹确认
- **依赖**：需确认 isshd known_hosts 存储位置与读取接口（若缺失需 Rust 侧补 `knownHosts.list/remove`）。

#### A4 SSH 连接复用（R-010）— L / P2（可选）
- **描述**：对齐 `sshMultiplexer.service.ts`——同主机多 tab 复用一条 SSH 连接（master connection）。
- **AC**：同主机第 2+ 个会话复用连接，减少握手延迟；主连接关闭时子会话正确收尾。
- **风险**：isshd 基于 russh 的单连接多 channel 能力需确认；若成本过高可降级为「记录但不实现」并回写 REQUIREMENTS.md。

#### A5 vim 粘贴模式（R-011）— M / P2
- **描述**：对齐 `issh-terminal/src/middleware/inputProcessing.ts` 的 bracketed paste：vim/nano 内粘贴不触发自动缩进错乱。
- **AC**：
  1. vim insert 模式粘贴多行文本缩进正常
  2. 普通 shell 粘贴行为不变
- **依赖**：需确认 xterm 前端 paste 路径与 isshd PTY 的 bracketed-paste 开关（`\x1b[?2004h/l`）传递。

#### A6 终端内搜索（R-011）— M / P2
- **描述**：对齐 `searchPanel.component.ts`：当前 buffer 内搜索，支持大小写/正则/全词选项。
- **AC**：
  1. 快捷键打开搜索面板，向上/向下循环匹配并高亮
  2. 大小写/正则/全词三选项可切换
- **依赖**：xterm.js `Terminal.searchAddon` 或自行实现 buffer 扫描。

#### A7 批量输入（R-011）— M / P2
- **描述**：对齐 `batchInput.service.ts` + `batchInputModal/batchInputPanel`：输入广播到全部/选中会话。
- **AC**：
  1. 打开批量输入面板，输入回车后广播到所有目标会话
  2. 支持选择广播目标（全部窗格/选中窗格）
- **依赖**：dev 分屏窗格模型（R-036）已有活动窗格概念。

#### A8 linkifier（R-011）— S / P2
- **描述**：对齐 `issh-linkifier` 插件：终端输出中 URL/文件路径可点击（Ctrl+点击）打开。
- **AC**：
  1. 输出中 http(s) URL 可点击，默认浏览器打开
  2. 绝对路径可点击；可配置点击行为
- **依赖**：xterm.js link 处理（webLinksAddon 或自实现 regex）。

#### A9 配色方案（R-011）— M / P2
- **描述**：对齐 `colorSchemes.ts` + `colorSchemeSelector/colorSchemeSettingsTab`：内置社区配色 + 切换即时生效。
- **AC**：
  1. 提供 issh-community-color-schemes 同款配色列表
  2. 切换后当前终端即时生效；设置持久化
- **依赖**：dev 终端主题设置现状需核对；确认内置 vs 插件网关形态。

#### A10 终端右键菜单（R-011）— S / P2（部分完成，需核对）
- **描述**：dev 已有「选择复制与右键粘贴」（R-040）与「标签右键菜单」（R-043）。核对终端区域右键菜单剩余缺口（新建会话/清屏等）。
- **AC**：终端空白区域右键菜单提供复制/粘贴/清屏/新建会话；与现有行为不冲突。
- **注意**：本 Story 需先与 R-040/R-043 现状比对，若已覆盖则关闭。

#### A11 配置同步（R-012）— M / P2
- **描述**：对齐 `issh-settings/src/components/configSyncSettingsTab.component.*`：配置文件导入/导出。
- **AC**：
  1. 可导出配置到文件（非敏感：config.yaml 等价物 + profiles 结构 + 插件启用表，**不含保险库凭据**）
  2. 可导入并合并；导入前显示差异摘要
- **依赖**：需定义「非敏感配置」边界（与 vault 数据严格隔离）。

#### A12 对齐验收（R-013）— S / P0（收尾闸门）
- **描述**：全量构建 + 冒烟 + 文档终审。
- **AC**：
  1. 根 `yarn build`（tsc + webpack 全插件）全绿；`npm run test:issh-agent` 全绿；`cargo test` 全绿；tauri build 产出安装包
  2. 冒烟测试报告生成（smoke_test.py 或等效 CDP 冒烟）
  3. REQUIREMENTS.md 状态与正文一致；HANDOFF.md 终态更新
- **依赖**：排在全部 P0/P1 完成后执行。

### Epic B — LLM 补全补差

#### B1 候选 confidence 排序（R-015）— M / P0
- **描述**：对齐 issh 分支 `TabLLMController`：AI live/prefetch + 历史 + 脚本候选统一 confidence 评分排序。
- **AC**：
  1. 多来源候选按 confidence 降序展示；同分按来源优先级稳定排序
  2. 预取 AI 命中时不再发 live 请求（已有 gate，保持）
- **参考**：issh 分支 `issh-llm/src/tabLLMController.ts` 的排序逻辑；dev 端现状需先核对（issh-llm 为 Angular 遗留，dev 的 Tauri LLM 实现位置待确认）。

#### B2 normalizeCommand 接入（R-015）— M / P0
- **描述**：所有候选（LLM/历史/脚本）经 `normalizeCommand()` 过滤后才可展示/执行。
- **AC**：
  1. 非法首 token、不完整命令（`&&`/`|`/`\` 结尾）、损坏 docker-compose 命令被拦截
  2. inline comment 剥离、多行合并 `&&` 行为与 issh 分支一致
- **参考**：issh 分支 `issh-llm/src/services/commandValidation.ts`。

#### B3 suggestionCache LRU（R-015）— S / P0
- **描述**：补全结果 LRU 缓存（maxSize=100 / ttl=5min）。
- **AC**：同 key 命中不重复请求 LLM；超容量逐出最久未用；过期自动失效。

#### B4 敏感输入 gate（R-015）— M / P0
- **描述**：对齐 `sensitiveInput.service.ts`：检测密码 prompt → 停止补全 + 清空 lineBuffer。
- **AC**：
  1. 检测到 password/passphrase 提示立即停止补全请求
  2. 清空候选与行缓冲；用户手动输入不受干扰
- **安全要求**：任何密码输入不进入 LLM 上下文（与 sendContextToCloud 脱敏联动）。

#### B5 ghost text 轻提示（R-015）— M / P1
- **描述**：`lightweightHintEnabled` 开启后，候选以行内幽灵文本展示（非浮动面板）。
- **AC**：
  1. 候选作为 ghost text 内联显示在光标后
  2. Ctrl+Y 接受；输入变化实时刷新/消退
- **依赖**：xterm.js 前端是否支持行内覆盖渲染需确认。

#### B6 agentProcessDetection（R-016）— M / P0
- **描述**：移植 issh 分支 agent 进程识别服务：识别本机运行的 codex/codex-cli/hermes 等 agent 进程。
- **AC**：
  1. 列出本机 agent 进程（名称/可执行路径/PID）
  2. 进程清单可被 Agent Bridge 设置页引用（连接指引）
- **依赖**：无。**注意**：是 C2（agent 注册识别）的前置。

#### B7 codexDesktopConfig（R-016）— S / P1
- **描述**：移植 Codex Desktop 配置指引服务：生成可复制的 MCP 配置。
- **AC**：
  1. 生成 Codex Desktop MCP 配置 JSON（指向 127.0.0.1:59688 + token 占位）
  2. 设置页一键复制
- **依赖**：与 Agent Bridge 设置页（内置插件）复用同一配置生成逻辑。

### Epic C — Agent Bridge 进阶

#### C1 workspace 服务端（R-050）— XL / P3
- **描述**：isshd Runtime 侧 workspace 模块：workspace 创建/列出/切换，会话归属 workspace。
- **AC**：
  1. workspace CRUD RPC；会话列表按 workspace 过滤
  2. `issh_workspace_*` 工具集在 issh-agent 放开
- **依赖**：需先做 Netcatty 技术选型（JS/TS → Rust 映射）。

#### C2 agent 注册识别（R-050）— L / P3
- **描述**：agent 进程注册进 workspace（进程名 → workspace 映射）。
- **AC**：注册/查询/注销 RPC；与 B6 进程清单联动。
- **依赖**：B6。

#### C3 task 调度（R-050）— XL / P3
- **描述**：task 队列 + 状态机（pending/running/done/failed）+ 结果回调。
- **AC**：提交任务返回 taskId；状态可查；完成回调推送到订阅端。
- **依赖**：C1。**关联**：与 C9（job 化）合并设计，避免两套异步模型。

#### C4 cordis 事件总线（R-051）— XL / P3（**已放弃 kernel，事件流保留** 2026-09-03）
- **描述**：终端事件 pub/sub 总线（输出流、会话状态、通知）。
- **AC**：订阅/退订 RPC；事件带时间戳与来源 session。
- **依赖**：无。**风险**：isshd 现有 session.subscribe 是单向流，cordis 需要多订阅者广播，需评估扩展成本。
- **决策（2026-09-03）**：事件流部分已落地（`issh_workspace_events` 工具，基于 event.list SQLite + 游标）；cordis kernel（多 agent 并发 Fiber run）判定范围外，`issh_cordis_health`/`issh_run_wait/collect/cancel`/`issh_agent_dispatch` 保持诚实降级，不再实现。

#### C5 pane 编排（R-051）— L / P3
- **描述**：服务端分屏窗格编排模型，与 R-036 `SplitLayoutNode` 对齐。
- **AC**：pane 树结构 RPC（读布局/执行窗格操作）。
- **依赖**：R-036 已完成的 SplitLayoutNode 状态模型。

#### C6 herdr UI 集成（R-051）— L / P3（**判定：商城插件路线** 2026-09-03）
- **描述**：工作区 UI 集成（agent 工作区面板）。
- **AC**：与商城 Herdr 插件边界确认后接入，不重复造轮子。
- **依赖**：**前置决策**：R-034 已审核 Herdr 产品边界，实施前需与用户确认路线（商城插件 vs 内置）。
- **决策（2026-09-03）**：走商城插件路线（issh-plugin-herdr 已落地，经 PluginGateway 调 isshd `workspace.*`/`session.*`/`runtime.health`）。Netcatty 的 herdr 为外部 sidecar（herdr.exe），本仓库无该二进制亦无接入需求，`issh_herdr_*` 7 工具保持 roadmap 诚实降级，不重复造轮子。

#### C7 codegen 能力目录重构（R-052）— M / P2
- **描述**：issh-agent 能力目录改为从工具表生成 codegen 风格目录，客户端动态加载。
- **AC**：
  1. 工具定义单源（协议表），生成目录不手写
  2. 新增工具无需改客户端导出代码
- **依赖**：无。当前基线：`protocol.js` 50 工具静态表 + 17 工具诚实降级。

#### C8 SKILL.md 随包发布（R-053）— S / P0
- **描述**：编写 issh SKILL.md（agent 使用指南：能力、工具、示例），随 Windows 安装包发布。
- **AC**：
  1. SKILL.md 含工具清单、使用示例、安全边界说明
  2. NSIS extraResources 打包；安装后可定位（设置页展示路径）
- **依赖**：无。**前置**：需用户提供 SKILL.md 目标受众/格式约定（Claude Skills / Codex 格式）。

#### C9 长命令 job 化（R-054）— M / P1
- **描述**：命令执行超时后转异步 job + 结果轮询，替代当前「超时即失败」。
- **AC**：
  1. exec 超时自动转 job（返回 jobId 而非失败）
  2. job 状态/输出查询；完成回调
  3. 与 C3 的 task 模型合并设计（先出统一异步执行模型，C3 复用）
- **依赖**：无（可先行，为 C3 铺路）。

#### C10 权限三档（R-055）— M / P1
- **描述**：危险/敏感操作由布尔确认门升级为 Observer（只读）/ Confirm（确认后执行）/ Auto（自动放行）三档。
- **AC**：
  1. 每类工具可配置档位；默认 Confirm
  2. Observer 档只返回计划不执行；Auto 档白名单放行
  3. 档位决策写入审计日志
- **依赖**：无。当前基线：`DangerousCommandGuard` 布尔确认。

#### C11 SSE MCP transport（R-055）— M / P1
- **描述**：服务端增加 SSE MCP transport（对齐 issh 分支 `agentBridgeSseEnabled`）。
- **AC**：
  1. SSE endpoint 可被 MCP 客户端连接（GET events + POST 消息）
  2. token 校验与 RPC 一致
- **依赖**：无。当前基线：HTTP JSON-RPC（stdio MCP 由 issh-agent CLI 提供）。

---

## 4. 排期波次

| 波次 | Story | 说明 |
|------|-------|------|
| **Wave 0（收尾，1-2 周）** | A12、B1~B6、C8 | 验收收尾 + 补全核心体验补差 + 最小可发布项 |
| **Wave 1（增强，2-4 周）** | A1、B7、C9、C10、C11 | 版本检查 + Agent Bridge 安全/异步能力增强 |
| **Wave 2（对齐细节）** | A2~A11、C7 | 工作量大价值中等；开工前逐项与用户确认范围 |
| **Wave 3（大工程，单独立项）** | C1~C6 | Netcatty 跨技术栈能力，需技术选型 + 边界决策 |

## 5. 依赖链与风险

**依赖链**：
- `B6 → C2`；`C1 → C3`；`C9 先于 C3（统一异步模型）`
- `R-034 边界决策 → C6`；`A12（R-013）依赖 Wave 0 全部完成`

**风险与待确认**：
1. **B1/B2/B3 的 dev 端现状未知**：issh-llm 是 Angular 遗留，dev 的 Tauri LLM 补全实现位置需先探明，可能已有部分实现（避免重复开发）。
2. **A4 连接复用**：isshd russh 多 channel 能力未确认，可能降级。
3. **C1~C6 跨技术栈**：Netcatty 为 JS/TS，本项目 Rust 后端，需先技术选型。
4. **C8 SKILL.md 格式**：需用户确认受众格式（Claude Skills / Codex 或其他）。
5. **A10 右键菜单**：可能与 R-040/R-043 已覆盖，开工前先核对现状。
6. **A9 配色**：内置 vs 插件网关形态未定。

## 6. 范围依据索引（issh 分支源码）

| 待办 | 依据文件（issh 分支） |
|------|----------------------|
| R-009 | `issh-llm/src/components/aboutSettingsTab.component.*`、`issh-llm/src/services/versionCheck.service.ts` |
| R-010 | `issh-ssh/src/api/importer.ts`、`services/sshKnownHosts.service.ts`、`services/sshMultiplexer.service.ts`、`profiles.ts`、`recoveryProvider.ts` |
| R-011 | `issh-terminal/src/middleware/inputProcessing.ts`、`components/searchPanel.component.ts`、`services/batchInput.service.ts`、`components/batchInputModal|batchInputPanel.component.*`、`colorSchemes.ts`、`components/colorSchemeSelector|colorSchemeSettingsTab.component.*`、`tabContextMenu.ts`、`api/contextMenuProvider.ts`；`issh-linkifier/src/*` |
| R-012 | `issh-settings/src/components/configSyncSettingsTab.component.*` |
| R-015 | `issh-llm/src/tabLLMController.ts`、`services/commandValidation.ts`、`services/suggestionCache.service.ts`、`services/sensitiveInput.service.ts`、`config.ts (lightweightHintEnabled)` |
| R-016 | issh 分支 `issh-llm/src/services/` 中 agentProcessDetection / codexDesktopConfig 服务 |
| R-050~R-055 | Netcatty 仓库（github.com/binaricat/Netcatty）架构 + REQUIREMENTS.md R-050~R-055 登记 |

---

*本文档为规划文件，执行时每个 Story 开工前需回读 REQUIREMENTS.md 确认状态未被后续会话变更覆盖。*
