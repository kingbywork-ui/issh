# 需求文档（REQUIREMENTS）

> 本文件是项目的**固定需求文档**。所有用户提出的需求、以及对话过程中新生成/衍生的需求，都必须记录在此。
>
> 使用规则：
> - 新增需求时按编号顺序追加到对应分类下，并填写「来源」「提出日期」「状态」。
> - 状态变更（待办 → 进行中 → 已完成 / 已放弃）时同步更新本文件。
> - 来源取值：`用户需求`（用户直接提出）或 `对话衍生`（实现/讨论过程中产生的新需求）。
> - 状态取值：`待办` / `进行中` / `已完成` / `已放弃`。

## 需求状态总览

| 状态 | 数量 |
|------|------|
| 待办 | 7 |
| 进行中 | 3 |
| 已完成 | 34 |
| 已放弃 | 0 |

## 功能对齐需求（LLM 插件移植）

| 编号 | 需求 | 来源 | 提出日期 | 状态 |
|------|------|------|----------|------|
| R-001 | LLM补全：移植历史命令补全（本地+远程SSH） | 用户需求 | 2026-08-28 | 已完成 |
| R-002 | LLM补全：下一条命令预测 + 首条命令gate | 用户需求 | 2026-08-28 | 已完成 |
| R-003 | LLM补全：AI live 补全细节对齐 | 用户需求 | 2026-08-28 | 已完成 |
| R-004 | LLM补全：编辑器模式（vim/nano） | 用户需求 | 2026-08-28 | 已完成 |
| R-005 | LLM补全：登录脚本补全（Beta） | 用户需求 | 2026-08-28 | 已完成 |
| R-006 | LLM补全：候选面板UI与快捷键对齐 | 用户需求 | 2026-08-28 | 已完成 |
| R-007 | LLM补全：配置项与设置页全集对齐 | 用户需求 | 2026-08-28 | 已完成 |
| R-008 | Agent Bridge 功能对齐（CLI/MCP/工具面/安全） | 用户需求 | 2026-08-28 | 进行中 |
| R-009 | About/版本检查功能移植 | 用户需求 | 2026-08-28 | 待办 |
| R-010 | SSH 主机管理细节对齐 | 用户需求 | 2026-08-28 | 待办 |
| R-011 | 终端功能细节对齐（vim粘贴/右键菜单/搜索/批量输入/linkifier/配色） | 用户需求 | 2026-08-28 | 待办 |
| R-012 | 配置同步插件功能对齐 | 用户需求 | 2026-08-28 | 待办 |
| R-013 | 对齐验收：整体构建+冒烟+HANDOFF 更新 | 用户需求 | 2026-08-28 | 待办 |
| R-014 | Agent Bridge Rust 半成品修复：agent_bridge.rs 语法损坏修复 + 协议契约对齐（protocol.js 1.0.0 / 17 工具 / scope 映射 / exec 返回字段 stdout+exitCode+timedOut）+ lib.rs 接线 | 对话衍生 | 2026-08-28 | 进行中 |
| R-015 | LLM补全补差：AI/历史候选统一 confidence 排序、normalizeCommand 接入候选链路、suggestionCache LRU（maxSize=100/ttl=5min）、敏感输入 gate（密码 prompt 停止补全清空 buffer）、ghost text 轻提示模式 | 对话衍生 | 2026-08-28 | 待办 |
| R-016 | 移植 agentProcessDetection（codex/codex-cli/hermes 等 agent 进程识别）+ codexDesktopConfig（Codex Desktop 配置指引）两个缺失服务 | 对话衍生 | 2026-08-28 | 待办 |
| R-017 | 保险库同步：对比 issh 分支补齐 Tauri 端 Vault 设置页能力（启用主口令/禁用并清除/修改主口令），清除行为与 issh 一致（含主机配置全部删除），保留主机凭据管理 UI | 用户需求 | 2026-08-28 | 已完成 |
| R-018 | 修复 issh-tauri 工作区全部 22 个 svelte-check 警告（10 处 state_referenced_locally + 12 处 a11y），验证 0 errors / 0 warnings + vite build 通过 | 用户需求 | 2026-08-29 | 已完成 |
| R-019 | issh 分支 logo 同步到 Tauri 图标 + 版本号同步（4 处）+ isshd runtime 构建 stage + Tauri NSIS 打包 + 安装/图标验证 | 用户需求 | 2026-08-29 | 已完成 |
| R-020 | 分析 0.1.4 安装包图标"不对齐"：定位是打包链问题还是源素材问题，给出根因与修复方向 | 用户需求 | 2026-08-29 | 已完成 |
| R-021 | 重生成四周留白均衡的图标源素材（ico 7 帧 + tauri icons 全套），替换后重打包 0.1.6，PE 解析验证居中度 + 安装冒烟 | 用户需求 | 2026-08-30 | 已完成 |
| R-022 | 修复 Tauri 端保险库无法识别 Electron 时代已存在主机信息：vault.contents 折叠标量含空白导致 Rust base64 解码失败，解码前剥离 ASCII 空白并加回归测试 | 用户需求 | 2026-08-30 | 已完成 |
| R-023 | R-022 修复后重新打包 0.1.6 Windows 安装包并完成安装验证（isshd/issh-tauri 重编译、NSIS 打包、静默安装、launch test、数据目录回归检查） | 对话衍生 | 2026-08-30 | 已完成 |
| R-024 | 修复保险库设置页卡 loading 无法显示主机凭据：list_credentials 对重复 (user,host,port) profile 输出重复凭据，前端 Svelte keyed each 遇 duplicate key 抛 each_key_duplicate 崩溃；后端去重 + 前端 index key 双层修复 | 用户需求 | 2026-08-30 | 已完成 |
| R-025 | 保险库锁定态 UI 修复：主口令未输入时隐藏主界面头部 ▦/⚙ 按钮；解锁表单补 class 使 flex 布局与 40px 高度生效，输入框与解锁按钮高度对齐 | 用户需求 | 2026-08-31 | 已完成 |
| R-026 | 修复残留孤儿 isshd 进程导致 runtime 启动失败（「Runtime健康响应缺少result」）：ensure_started 探测到旧 runtime 不兼容时终止残留进程并重新拉起，新增 terminate_stale_runtime（按进程名+pipe 名精确匹配，零新依赖） | 用户需求 | 2026-08-31 | 已完成 |

## 需求记录（后续追加）

### R-027 分组记忆失效 + Reconnect 指纹丢失修复（2026-08-31，已完成，待用户最终确认）

**需求**：用户再次反馈「保险库的功能不对，没有正确识别已存在的主机信息」。R-026 修复后 runtime/数据链路已正常，本次定位到三个**前端独立 bug**。

**根因与实现**（均在 `issh-tauri/src/`，无 Rust 改动）：
1. **分组记忆失效（主因）**：`HostManager.svelte` 中 `view/recentIds/collapsed` 三个 `$state` 初始化（调用 `loadStartView()` 等 loader）位于 `recentKey/activeGroupKey/activeViewKey/collapsedGroupsKey` 四个 const 声明**之前**——loader 访问 TDZ 中的 const 抛 `ReferenceError`，被 loader 内 `try/catch` 静默吞掉，恢复逻辑永远回退「全部」。leveldb 取证证实写入路径正常（`startPageActiveGroupId=52418f2a-...` 已持久化）仅读取失效。修复：4 个 key 常量声明移到所有 `$state` 初始化之前。
2. **指纹清空顺序 bug**：`App.svelte` `confirmFingerprint()` 中 `pendingFingerprint = ''`（L539）在 `hostKeyFingerprint: pendingFingerprint`（L554）之前执行 → tab 记录空指纹 → Reconnect 必报 "host-key fingerprint is required"（Rust `validate_spec` 空指纹返回 `MissingHostKey`，已核实）。修复：函数开头快照 `const fingerprint = pendingFingerprint`，`openSshSession` 与 `tab.ssh.hostKeyFingerprint` 均用快照值。
3. **连接弹窗用户名**：核实手动连接表单已有用户名输入框（必填校验）；指纹确认弹窗用户名取自所选 profile。确认非 bug，无需改动。

**验证**：svelte-check 0 errors / 0 warnings → 重打包 0.1.6 NSIS（12:05）→ 杀 issh-tauri/isshd 后 `/S` 静默安装（exe 时间戳 12:05）→ leveldb 用户数据（分组 ID/最近主机）安装后完好 → 新 exe 引用本次构建哈希 `index-CDxOjyhq.js`（与 vite 输出一致，确认新 UI 内嵌；JS 压缩存储致明文扫描 False 属预期）→ 应用正常启动。本次未带 CDP 端口，最终效果以用户人工确认为准。未提交 git。

### R-026 残留 isshd 进程导致 runtime 启动失败修复（2026-08-31，已完成）

**需求**：用户再次反馈「保险库的功能不对，没有正确识别已存在的主机信息」。R-022/R-024 修复后数据链路已正常，本次定位到另一独立根因。

**根因**：NSIS 安装/升级流程只杀 issh-tauri 不杀 isshd，升级后残留孤儿 isshd（持旧 auth token）继续占用 named pipe；新 issh-tauri 启动时生成新随机 token，probe 旧 isshd 被拒（Unauthorized 错误响应无 result 字段），`assert_compatible()` 报「Runtime健康响应缺少result」，`ensure_started()` 直接 Err 返回、永不走 spawn 分支 → 终端/SSH/保险库整体不可用（表象为保险库不识别主机）。进程证据：isshd PID 20752 启动于 9:24:26，早于新 issh-tauri PID 21684（10:40:41）。

**实现**（`issh-tauri/src-tauri/src/lib.rs`，零新依赖）：
1. `ensure_started()`：probe Ok 但 `assert_compatible` 失败 → 调用 `terminate_stale_runtime()` 终止残留 isshd 后继续 spawn 流程（probe Err 照旧 spawn；spawn 后重试循环逻辑不变）
2. 新增 `terminate_stale_runtime()`：PowerShell CIM `Get-CimInstance Win32_Process` 按进程名 + pipe 名（`pipe_name.trim_start_matches(r"\\.\pipe\")`）双重过滤精确 `Stop-Process -Force`，CREATE_NO_WINDOW，kill 后 sleep 250ms 等内核释放 pipe 句柄

**验证**：cargo check 通过、cargo test 24 passed；重打包 0.1.6 NSIS 并静默安装（安装前同时清理 issh-tauri/isshd）；CDP（remote-debugging-port=9333 + `.psacowork/tmp/cdp-eval.ps1` 经 bundle 内部 invoke）实测 `runtime_health` 返回完整 result（protocolVersion 0.4.0 / 56 capabilities）、`host_profiles`/`host_credentials` 正常返回、错误口令解锁被正确拒绝；验证后已不带调试端口正常重启，issh-tauri/isshd 均为新进程（11:33:51/11:33:53）。未提交 git。

### R-025 保险库锁定态 UI 修复（2026-08-31，已完成）

**需求**：用户反馈两处 UI 问题——① 主界面头部 ▦（主机选择）/⚙（设置）按钮在未输入主密码（保险库锁定）时不应显示；② 锁定页主口令输入框高度与旁边文字/按钮不匹配，需增高。

**实现**：
1. `HostManager.svelte`：新增 `onvaultstate` 回调 prop，`reportVaultState()` 在 refresh/unlock/lock/mutate 后上报 `locked = encrypted && !unlocked`，并加 `$effect` 响应式兜底；解锁 `<form>` 补 `class="vault-unlock-form"`（此前 CSS 规则因缺 class 全部未生效——CDP 实测 `inputH: "no-input"` 证实，这是高度不匹配的根因）
2. `App.svelte`：新增 `vaultLocked` 状态，接收 `onvaultstate` 回调；头部 ▦ 与 ⚙ 按钮用 `{#if !vaultLocked}` 条件渲染
3. `app.css`：`.vault-unlock-form input` 与 `.vault-locked button/.vault-unlock-form button` 高度 34px → 40px

**验证**：svelte-check 0 errors / 0 warnings；重打包 0.1.6 NSIS（10:38）并静默安装；CDP 探针实测锁定态 `btns: []`（头部按钮已隐藏）、`inputH: "40px"` 与 `btnH: ["40px"]`（高度一致）；验证后已不带调试端口重启应用。

### R-024 保险库设置页 duplicate key 崩溃修复（2026-08-30，已完成，待最终确认）

**需求**：用户反馈「保险库功能不对，没有正确识别已存在的主机信息」。R-022 修复解密链路后问题仍在。

**根因**：`host_profiles.rs list_credentials()` 因 profiles 含两条相同 (user,host,port) 主机条目（.ssh/config 导入 + 手动创建）输出重复凭据；VaultSettings.svelte keyed each 以 user|host|port 为 key，Svelte 5.56.9 生产构建遇重复 key 抛 `each_key_duplicate`（each.js:355-361 生产分支直接 throw），渲染 effect 崩溃绕过 try/catch，DOM 停留 loading 态。CDP 实测 `host_credentials` 返回 10 条凭据中 index0/index5 完全重复。

**实现**：① 后端 `list_credentials()` 加 `emitted: HashSet<String>` 按 user|host|port 去重（cargo test 24 passed）；② 前端 VaultSettings.svelte 两处 keyed each 改 index key（只读列表安全）。重打包 0.1.6（NSIS 16:38）并静默安装成功。

**验证**：解锁后 `host_credentials` 应返回 9 条凭据、设置页显示「已解锁 / 9 台主机凭据」；等待用户解锁后跑 CDP 探针确认。

### R-023 R-022 修复重打包验证（2026-08-30，已完成）

**需求**：R-022 vault 空白容错修复在 Rust 侧（`issh-runtime-vault` crate），需重新打包才能对已安装客户端生效。用户确认执行完整打包。

**实现**：isshd release 重构建（vault crate 重编译）→ stage-runtime → tauri build（cargo 重编译 issh-runtime-vault + issh-tauri）→ NSIS。版本号 4 处均为 0.1.6 无需同步。

**验证**：
- 产物 `issh_0.1.6_x64-setup.exe` 4,650,531 B（2026-08-30 12:37）
- `/S` 静默安装成功，注册表 DisplayVersion = 0.1.6
- 安装布局正确（`issh-tauri.exe` + `issh-runtime\isshd.exe` 目录形式）
- Launch test：窗口标题 `issh`，isshd 从安装目录拉起，验证后进程清理
- 数据目录回归：`%APPDATA%\issh\config.yaml` 安装前后一致（36,857 B / 08-28 19:34），用户真实数据未被改动

### R-017 保险库同步（2026-08-28，已完成）

**需求**：用户提出「保险库是有偏差，对比下issh分支然后同步」。对比结论：Angular 层 7 个 vault 文件两分支一致，偏差在 Tauri 端 VaultSettings.svelte 缺失 issh 分支的启用/禁用/改口令能力。用户确认方案：补齐三项核心能力，清除时与 issh 一致（含主机配置全部删除），保留主机凭据管理 UI。

**实现**：
- `host_profiles.rs`：新增 `enable_vault`（明文 profiles/groups/secrets 打包为 Electron 形态 vault JSON 加密，移除明文段）、`disable_vault`（删 vault 段与加密标志）、`change_passphrase`（验证旧口令后重加密）
- `lib.rs`：新增 Tauri 命令 `enable_host_vault` / `disable_host_vault` / `change_host_passphrase` 并注册
- `runtime.ts`：新增 `enableHostVault` / `disableHostVault` / `changeHostPassphrase` 封装
- `VaultSettings.svelte`：三态 UI（未启用→设置主口令；已启用未解锁→解锁；已解锁→凭据管理 + 修改主口令/锁定/禁用并清除）
- 测试：新增 3 个生命周期测试（enable 后解锁数据一致/改口令旧口令失效/禁用全部清除），12/12 通过

**验证**：cargo check 通过；cargo test 12 passed；svelte-check issh-tauri 工作区 0 errors（22 个既有警告与本次改动无关）

### R-018 修复 22 个 svelte-check 警告（2026-08-29，已完成）

**需求**：用户在 svelte-check 基线（0 errors / 22 warnings / 5 文件）后指示「修复」。范围仅限这 22 个警告。

**实现**（6 文件，5 改 1 新建）：
- 新建 `issh-tauri/src/lib/a11y.ts`：`focusOnMount` action 替代 `autofocus`
- `HostGroupEditor.svelte` / `HostProfileEditor.svelte`：`state_referenced_locally` 加 ignore（模态打开时快照 props 是有意语义）；modal 结构调整（backdrop 承担点击关闭 + `target===currentTarget`，内层 div 承担 `role="dialog"`）；`autofocus` → `use:focusOnMount`
- `HostManager.svelte`：口令输入 `autofocus` → action；treeitem 补 `aria-selected` + `tabindex="-1"`
- `Settings.svelte`：2 处 dialog 补 `tabindex="-1"`
- `SandboxPanel.svelte`：3 处 ignore（挂载时快照，onMount 读 localStorage 覆盖）；拖拽栏 `role="separator"` → `role="slider"` + aria-valuenow/min/max

**验证**：`npx.cmd svelte-check --workspace issh-tauri` → 0 ERRORS / 0 WARNINGS（314 文件）；`npm.cmd run build --prefix issh-tauri` → vite built in 2.26s 通过

### R-019 logo 同步 + 打包安装验证（2026-08-29，已完成）

**需求**：用户要求核对 issh logo 并同步到 Tauri 图标，同步版本号后重新打包并安装验证。

**实现**：`build/windows/icon.ico` 同步到 `issh-tauri/src-tauri/icons/`（含 32x32.png/128x128.png/128x128@2x.png/icon.icns/icon.ico/Square*.png）；版本号同步 4 处（根 package.json、issh-tauri package.json、tauri.conf.json、Cargo.toml → 0.1.6）；`cargo build --release -p isshd` + `stage-runtime.mjs` 后 `tauri build` 产出 NSIS 安装包。

**验证**：
- PE 资源解析（RT_ICON=type 3）：安装版与构建版 exe 内嵌 7 张图标图像（16~256px）逐张 MD5 与源 icon.ico 完全一致。注意：PowerShell 解析 RT_GROUP_ICON 目录数据会误报"只有 1 个图标"，须解析 RT_ICON 才是真实图像数据
- 安装版 vs 构建 exe 仅 3 字节差异（0x4896E2-4 `NSS` vs `UNK`），为 NSIS 安装器固定偏移补丁标记，预期行为
- 静默安装冒烟通过：窗口标题正常、isshd 从安装目录正确拉起
- 产物：`issh_0.1.6_x64-setup.exe`（4,573,660 字节，MD5 `87c6cad49145007b67a23451dd7c04e7`）

### R-021 图标源素材重生成 + 0.1.6 重打包（2026-08-30，已完成）

**需求**：用户确认执行 R-020 修复方案——重生成四周留白均衡的图标并重打包。

**实现**：
- 脚本 `.psacowork/tmp/regen_icon.py`：源 ico 256 帧 → alpha bbox 裁剪（227x237）→ 居中重排 → LANCZOS 缩放 7 帧（16/24/32/48/64/128/256）写回 `build\windows\icon.ico`（旧文件备份 `.bak`）；tauri icons 全套 15 张 PNG + icon.icns 重写
- 补漏：`issh-tauri/src-tauri/icons/icon.ico`（bundle.icon 实际嵌入文件）首轮遗漏，从 `build\windows\icon.ico` 复制同步
- `tauri.conf.json` nsis 段新增 `"installerIcon": "icons/icon.ico"`（此前安装器用 NSIS stub 默认图标）
- touch `build.rs` 强制 winres 重嵌 → stage-runtime → `npm --prefix issh-tauri run tauri -- build`

**验证**（脚本 `.psacowork/tmp/verify_icon_centered.py`，PE 解析 RT_ICON 逐帧 alpha bbox）：
- 构建版/安装包/安装版 exe 三者一致：256 帧 bbox **left=14 top=9 right=15 bottom=10**（旧 12/19/17/0 底部顶格），128 帧 4/2/5/2，四周均衡
- 安装包 RT_GROUP 103 从 NSIS 默认 3 帧（16/32/48px）变为 7 帧业务 logo（installerIcon 生效）
- 产物：`issh_0.1.6_x64-setup.exe` 4,649,466 B，MD5 `3f43717344703c06cf958391519b935d`
- 安装冒烟：/S 静默安装 → 启动后 issh-tauri + isshd 进程均拉起 → taskkill 清理

**环境教训**：`python -X utf8 -c "<多行脚本>"` 退出码 0 但 stdout 为空（单行正常）→ 多行 Python 必须写脚本文件执行

### R-028 dev 分支 SFTP 切换目录修复（2026-08-31，已完成）

**需求**（用户需求）：dev 分支 SFTP 功能需与 issh 分支一致，修复点击目录后无法切换目录。

**范围**：仅修复 SFTP 条目路径构造，确保目录列表返回绝对 POSIX 路径。

**实现**：`issh-runtime/crates/ssh/src/sftp.rs` 新增 `entry_path()`，列表条目统一按请求目录和条目名拼接为绝对 POSIX 路径。

**验证**：`cargo test -p issh-runtime-ssh --manifest-path issh-runtime/Cargo.toml` → 12 passed。

### R-029 已信任主机不重复弹出指纹确认（2026-08-31，已完成）

**需求**（用户需求）：连接已信任主机时不应每次重复弹出信任窗口；指纹变化时仍需重新确认。

**范围**：仅在 Tauri 前端持久化并复用 `host:port` 对应的已确认指纹。

**实现**：`App.svelte` 在首次确认成功后保存指纹；后续发现相同指纹时自动连接，指纹变化仍显示确认窗口。

**验证**：`npm.cmd run check --prefix issh-tauri` → 0 errors / 0 warnings。

**打包验证**（2026-08-31）：`cargo build --release -p isshd`、runtime 暂存、`npm.cmd run tauri -- build` 全部通过；NSIS 安装包 4,651,055 bytes。

### R-030 已信任主机仍弹出空白 SSH 表单（2026-08-31，已完成）

**需求**（用户需求）：每次连接不应重复弹出截图红框中的 SSH 连接参数窗口。

**根因**：`connectHost()` 在 `connectWithParams()`（已信任指纹会自动连接并关闭弹窗）返回后无条件执行 `showConnect = true`，重新打开空白连接表单。

**修复**：删除该无条件打开逻辑，保留异常路径的错误弹窗。

**验证**：`npm.cmd run check --prefix issh-tauri` → 0 errors / 0 warnings。

**实测补充**（2026-08-31）：release 程序连接与 SFTP 面板加载成功；重连路径未出现信任弹窗。发现目录点击状态问题后，`SftpBrowser.openEntry()` 已统一改走 `navigate(entry.path)`；最新构建因 Vault 锁定未完成远程目录最终回归。

**补充修复**：SFTP 初始化 effect 增加 session/initialPath 去重保护，避免响应式重跑将用户当前目录重置为打开时目录；上级目录按钮统一调用 `navigate()`。

**验证**：`npm.cmd run check --prefix issh-tauri` → 0 errors / 0 warnings。

### R-031 设置页“sudo 密码”产品完整性审核与补齐（2026-09-01，已完成）

**需求**（用户需求）：从产品经理角度审核设置中的“sudo 密码”功能，识别是否为残缺版并明确需要补齐的能力。

**审核结论**：当前功能是残缺版。设置页只有开关、按用户名列出和删除，没有新增/修改密码入口；代码库中也没有对应写入 `localStorage` 的路径，因此新用户无法通过产品界面完成首次配置，列表通常为空，自动填充闭环断裂。

**本次实施范围**：新增/修改/删除 sudo 密码；按 SSH 主机/端口/用户名隔离；迁移到已启用的主机 Vault（禁止明文 localStorage）；sudo-rs 无用户名提示回退当前 SSH 用户；仅 SSH 会话启用；提示、取消与认证失败状态反馈；旧版明文 key 清理、待填充密码 TTL、锁定态错误区分与选择状态修复。

**实现**：新增 `ssh:sudo-password` Vault secret 类型、精确连接解析和 Tauri `resolve_sudo_password` 命令；设置页使用主机选择器保存/删除；终端 decorator 仅 SSH 挂载并带 10 秒待填充 TTL。未纳入本次范围：运行命令测试、最近使用/全量清除与审计页。

**验证**：`npx.cmd svelte-check --tsconfig ./tsconfig.json` 0 errors / 0 warnings；`cargo test -p issh-tauri --manifest-path issh-tauri\\src-tauri\\Cargo.toml` 25 passed；`npm.cmd run build --prefix issh-tauri` 通过；Sol 模型独立复核后修正遗留 key、TTL、锁定态和选择状态问题。

### R-032 HostManager 分组与主机右键功能同步（2026-09-01，已完成）

**需求**（用户需求）：同步 issh 中 HostManager 分组和主机的右键功能到 Tauri 客户端。

**范围**：主机右键补齐连接、编辑、克隆、更改分组、收藏、删除；分组右键补齐批量连接、新增主机、新增子组、重命名、删除；删除分组时支持“移到未分组”“同时删除主机”“取消”。

**实现**：`HostManager.svelte` 新增主机分组迁移弹层、分组批量连接和分组删除确认弹层；`host_profiles.rs` 放宽分组删除流程以支持前端先迁移/删除主机后删除分组。`ContextMenu.svelte` 保持既有键盘/点击关闭行为。

**验证**：`npx.cmd svelte-check --tsconfig ./tsconfig.json` → 0 errors / 0 warnings。按小功能约定未执行全量构建、安装和 GUI 冒烟。

### R-033 离开保险库页面自动锁定（2026-09-01，已完成）

**需求**（用户需求）：用户切换到保险库之外时，立即自动锁住保险库，重新输入密码才能解开。

**实现**：离开 Settings > 保险库、关闭设置窗口、按 Esc 退出或 Vault 组件卸载时调用 `lock_host_profiles`，清除 runtime 内存中的解密配置；再次进入保险库必须重新输入主口令。未清除磁盘上的加密数据。

**验证**：`npx.cmd svelte-check --tsconfig ./tsconfig.json` → 0 errors / 0 warnings。按小功能约定未执行全量构建、安装和 GUI 冒烟。

### R-034 Herdr 工作区与沙箱演示插件产品边界审核（2026-09-01，已完成）

**需求**（用户需求）：判断插件商城中的“Herdr 工作区”和“沙箱演示插件”是否应合并，以及沙箱是否有独立用途。

**审核结论**：不应合并为一个面向用户的产品插件。Herdr 是对接 isshd `workspace.*` RPC 的工作区/终端会话绑定集成；沙箱演示插件是验证 iframe 隔离、postMessage RPC、存储/终端事件和权限边界的开发样例，两者的用户目标、权限模型和生命周期不同。保留独立实现，将沙箱演示标为“开发者示例/测试插件”，默认不在普通商城推荐位展示；另行评估 Herdr 与 Agent Bridge 的工作区能力重叠。

**代码依据**：`plugins/issh-plugin-herdr` 仅注册设置页并声明 `workspace:read/workspace:write/session:read`；`plugins/issh-plugin-sandbox-demo` 注册底部沙箱面板，声明 `panel:register/terminal:decorate/profiles:write`，通过 `SandboxPanel.svelte` 与 `sandboxBridge.ts` 运行在 `iframe sandbox="allow-scripts"` 隔离环境中。

**实施**：商城索引新增 `audience` 字段；沙箱演示标记为 `developer`，设置页默认隐藏开发者插件，提供持久化“显示开发者插件”开关及卡片徽标。Herdr 与 Agent Bridge 保持独立，工作区能力重复列为后续产品整合议题。

**验证**：`issh-tauri/node_modules/.bin/svelte-check.cmd --tsconfig issh-tauri/tsconfig.json` → 0 errors / 0 warnings；商城索引 JSON 解析通过。

### R-035 dev 与 issh 分支功能遗漏审计（2026-09-01，已完成）

**需求**（用户需求）：继续对比 `dev` 与 `issh` 分支，识别 Tauri 迁移后遗漏的功能。

**审计结论**：两分支是 Electron → Tauri/isshd 的架构迁移，Electron 主进程、打包和平台服务的文件删除属于预期替代，不作为遗漏。确认的高价值功能缺口为：SSH 本地/远程/动态端口转发、X11 转发、SSH Agent Forwarding、跳板机/ProxyCommand/SOCKS/HTTP 代理、键盘交互认证回调；中优先级缺口为本地 Shell/WSL/Git Bash/Cygwin 等环境选择、终端路径拖拽注入和终端内容导出、SSH 配置/私钥导入的显式 UI。

**代码依据**：旧分支 `issh-ssh/src/api/interfaces.ts` 及 `session/forwards.ts` 提供 `forwardedPorts`、`x11`、`agentForward`、`jumpHost`、`proxyCommand` 和代理配置；旧 `issh-electron/src/index.ts` 注册多种 ShellProvider、PathDropDecorator 与终端导出菜单。当前 `issh-tauri/src/lib/runtime.ts`、`issh-tauri/src-tauri/src` 未发现对应转发/X11/Agent Forwarding/代理 API；虽然 Tauri 编辑器显示 `keyboardInteractive` 选项，但 Runtime 未发现认证提示事件路径；本地会话由 Runtime 默认启动 `cmd.exe`。

**状态**：仅完成只读审计，未合并或修改上述功能。

### R-036 Tauri 分屏会话能力对齐（2026-09-01，已完成）

**需求**（对话衍生）：按功能对齐目标补齐 `issh` 的分屏能力。

**已实现**：Tauri 支持当前会话与其他会话的左右/上下多窗格网格、活动窗格切换、继续新增同方向窗格、取消分屏；双窗格支持拖动分隔条调整 20%～80% 比例并持久化；关闭窗格后自动收敛为单窗格。实现位于 `issh-tauri/src/App.svelte` 与 `issh-tauri/src/app.css`。

**仍待补齐**：旧版递归多窗格树、分屏布局完整持久化/恢复；窗格重排、比例调整和核心快捷键已补齐当前平面布局版本。

**验证**：Tauri `svelte-check` 0 errors / 0 warnings。

**补充实现**：终端工具栏新增内容导出（原生保存对话框）；终端区域支持拖入本地文件并将路径安全引用后写入会话，覆盖旧版导出菜单与 PathDropDecorator 的核心用户路径。

**补充实现**：增加 `Ctrl/⌘+Alt+Right` 左右分屏、`Ctrl/⌘+Alt+Down` 上下分屏、`Ctrl/⌘+Alt+0` 取消分屏快捷键；分屏方向保存到 `issh.splitDirection`。

**补充实现**：分屏中的标签支持拖拽到其他分屏标签位置以交换窗格顺序；活动窗格支持 `Ctrl/⌘+Alt+Enter` 最大化/恢复，`Ctrl/⌘+Alt+Shift+方向键` 在窗格间导航。

**补充实现**：本地会话支持在设置中选择 `cmd`、Windows PowerShell、PowerShell 7、WSL 或 Git Bash；选择值通过 `session.openLocal` 传入 isshd，由 Runtime 决定 PTY 启动程序。

**验证**：`cargo test -p issh-runtime-session --manifest-path issh-runtime/Cargo.toml` → 8 passed；`svelte-check` 已通过。当前仍未实现旧版递归分屏树的布局恢复，也未实现 SSH 转发、跳板机、代理、X11 和 Agent Forwarding。

### R-037 SSH 高级配置兼容迁移（2026-09-01，已完成）

**需求**（对话衍生）：继续对齐 dev/issh 时，旧版 SSH 主机配置中的高级连接选项不得在 Tauri 迁移中丢失。

**已实现**：Tauri profile 模型与 JSON 迁移保留 X11、Agent Forwarding、跳板机、ProxyCommand、Local/Remote/Dynamic 端口转发及 SOCKS/HTTP 代理字段；主机编辑器提供查看和保存入口。

**部分实现**：`Local` 端口转发已接入 Runtime：isshd 提供 `ssh.forwardLocal`/`ssh.stopForward`，使用 russh `direct-tcpip` 为每个本地连接建立双向转发；SSH 会话关闭自动取消所属监听任务，profile 的 Local 规则在连接及重连后自动启动。`Dynamic` 已实现为无认证 SOCKS5 listener，支持 IPv4、IPv6、域名 CONNECT，并复用 SSH direct-tcpip；Dynamic profile 规则同样自动启动。

**部分实现**：`Remote` 转发已接入 Runtime：SSH 连接对象注册 russh `forwarded-tcpip` 回调队列，`ssh.forwardRemote` 通过 `tcpip_forward` 申请远端监听，并把回调连接双向转发到本地目标；`ssh.stopForward(kind: Remote)` 通过相同 bind host 发出取消请求。Remote profile 规则在连接及重连后自动启动。

**部分实现**：HTTP 代理已接入 SSH transport：`SshConnection` 使用 russh `connect_stream`，先对 HTTP proxy 发起 CONNECT 到目标 SSH host:port，再复用该 socket 完成 SSH 协商、认证和会话。profile 的 HTTP proxy 字段已传入 Runtime。

**部分实现**：外部 SOCKS5 代理已接入 SSH transport，使用无认证 SOCKS5 CONNECT 后通过 russh `connect_stream` 建立 SSH；profile 的 SOCKS host/port 已贯通 Tauri 与 isshd。

**部分实现**：`keyboardInteractive` profile 现在会调用 russh keyboard-interactive authentication，并将已保存的密码作为每个认证提示的响应提交；认证成功后进入正常 SSH 会话。

**部分实现**：ProxyCommand 已接入：Runtime 按平台启动用户指定命令，展开 `%h/%p/%r`，以子进程 stdin/stdout 作为 russh `connect_stream` 的 SSH transport；命令启动失败会返回连接错误。

**仍待实现**：X11、跳板机（多级 SSH profile 解析）仍未接入 Runtime 执行，不能视为完整对齐。

**验证**：`cargo test -p issh-tauri --manifest-path issh-tauri\\src-tauri\\Cargo.toml` → 25 passed；`svelte-check` → 0 errors / 0 warnings；`cargo check -p issh-tauri --manifest-path issh-tauri\\src-tauri\\Cargo.toml` 通过。

**补充修正**：加密 profile 重写现已保留全部高级字段；Agent Forwarding 已贯通连接请求；分屏状态同步、关闭最大化窗格、比例拖拽和重排显示问题已修复；转发 JSON 保存前增加校验；本地 Shell 增加跨平台和 Git Bash 路径回退。`open_direct_tcpip` 已加入 SSH 库，但本地监听器/RPC 尚未接入。

**验证补充**：`cargo test -p isshd --manifest-path issh-runtime/Cargo.toml` → 10 passed（覆盖未知 SSH session 的转发拒绝）；`svelte-check` → 0 errors / 0 warnings。

**最终状态同步（2026-09-01）**：ProxyCommand、keyboard-interactive、HTTP/SOCKS 代理及 Local/Remote/Dynamic 转发均已完成基础 Runtime 闭环并通过测试；R-037 仍保持“进行中”，剩余 X11 转发与 jumpHost 多级 profile 解析。分屏递归树/布局恢复归 R-036 继续跟踪。

**X11 状态同步（2026-09-01）**：已完成基础 Runtime 闭环。`x11` profile 选项会触发 SSH `x11-req`，并将远端 X11 channel 转发到本地 `DISPLAY`（TCP 或 Unix socket）。R-037 剩余 jumpHost 多级 profile 解析；递归分屏树/布局恢复归 R-036 跟踪。

**jumpHost 状态同步（2026-09-01）**：已完成基础链式 transport。Tauri 按 profile ID 递归解析跳板配置，isshd 通过 russh `direct-tcpip` 建立目标连接并持有父连接；每级独立校验已信任主机密钥和认证信息。R-037 仅剩分屏之外的历史兼容细节，R-036 仍跟踪递归分屏树与完整布局恢复。

**分屏状态同步（2026-09-01）**：新增递归 `SplitLayoutNode` 状态模型及 `issh.splitLayout` 持久化，窗格顺序/方向/比例变更会同步保存；当前 UI 仍为平面网格，递归嵌套渲染与跨重启会话 recovery 尚未完成，R-036 保持进行中。

**递归渲染同步（2026-09-01）**：新增 `SplitLayout.svelte` 递归组件，split 节点已按方向/比例实际嵌套渲染，失效 session ID 会自动清理。R-036 仍剩跨重启 tab recovery token 与递归节点分隔条拖拽调整。

**递归分隔条同步（2026-09-01）**：每个递归 split 节点现支持独立分隔条拖拽，比例调整会持久化整个 `issh.splitLayout` 树。R-036 仅剩跨重启 tab/session recovery token，当前运行周期内的递归结构、方向、顺序和比例均可恢复。

**跨重启恢复同步（2026-09-01）**：已增加 SSH 与本地 tab recovery。启动时读取 profile ID，只有已信任主机密钥且 Vault 可用时才自动重连 SSH，并将新 session ID 映射回递归分屏树；本地 shell 自动重建。未确认指纹或未解锁 Vault 的 SSH tab 仍需手动处理。

**最终验收状态（2026-09-01）**：R-036/R-037 所列功能均已实现基础闭环并完成针对性验证；未确认指纹、未解锁 Vault 等需要用户确认的安全流程属于预期行为，不作为功能缺失。

### R-038 dev 分支复制与边框拉伸问题诊断（2026-09-01，已完成）

**需求**（用户需求）：检查 dev 分支的复制功能和边框拉伸功能，确认问题与影响范围。

**结论**：相关旧 Angular/Electron 代码相对 `issh` 基线没有差异，不是 dev 新引入的回归；但既存实现存在无选区仍提示复制成功、分屏边框拖出父容器后比例按旧坐标结算、窗口外释放鼠标后拖拽状态可能无法清理等问题。迁移后的 Tauri 客户端没有任何终端选区复制、快捷键复制、右键复制或剪贴板接线，属于功能遗漏。

**已修复**：Tauri 终端补齐选区复制（Ctrl/⌘+C 与右键）；旧终端复制仅在存在选区时提示成功，空白选区可正常复制；分屏边框改用 document 级移动追踪，并在 mouseup、窗口失焦和组件销毁时清理；底部边框在窗口失焦时清理。

**验证**：`svelte-check` 0 errors / 0 warnings；`issh-terminal` 与 `issh-core` TypeScript 检查通过。

### R-039 递归分屏终端高度坍缩（2026-09-01，已完成）

**需求**（用户需求）：修复递归分屏/恢复布局后终端只能显示一两行的问题。

**根因**：递归布局使 `.terminal-pane.split-pane` 成为 flex 子项，但该样式未设置 flex 增长，窗格按内容最小高度布局。

**已修复**：为 `.terminal-pane.split-pane` 增加 `flex: 1 1 0`，使叶子窗格占满递归 split child 的可用宽高。

**补充根因**：xterm 仅在 `open()` 时调用一次 `fit()`，递归布局恢复或容器尺寸变化后不重新计算行列，导致终端仍保持首次测得的一行尺寸。

**最终修复**：每个 tab 对 terminal host 使用 `ResizeObserver`；尺寸变化后重新 `fit()`，并通过 xterm `onResize` 将新的 rows/columns 同步到 PTY。tab 关闭时断开观察器。

**验证**：`svelte-check` 0 errors / 0 warnings；`npm.cmd --prefix issh-tauri run tauri -- build` 通过，生成新的 NSIS 安装包。

**运行态复核**：用户再次反馈仍为一行后检查发现，当前 `issh-tauri.exe` 进程启动时间为 18:28，而包含最终修复的安装文件在 18:34 才覆盖到安装目录；当前窗口仍是旧进程内存，尚未加载最终修复。需完整退出并重新启动后做最终 GUI 验收。

**最终实测根因**：重启最新版后通过 CDP 测量确认，即使 `issh.splitLayout=null`，普通终端也因 `visiblePaneIds` 包含 active tab 而始终获得 `.split-pane`。该类把普通窗格从 absolute fill 改为 relative；普通 `.terminal-stack` 是 block，flex 不生效，最终 terminal pane 高 55px、xterm 高 15px。

**修复**：新增 `hasSplitLayout = layoutPaneIds.length > 1`；仅真实多窗格布局启用 recursive-split、split-pane、active outline 和 SplitLayout 递归渲染。

**分屏实测补充**：真实左右分屏时两个 pane 均为 722px，但原 SSH pane 的新 terminal host 不含 `.xterm-screen`；布局切换创建了新 host，而已存在的 xterm 因 `mountTerminal()` 早退仍挂在已移除的旧 host。

**补充修复**：terminal action 检测已有 xterm 时将其 element 重挂载到新 host，同时迁移 ResizeObserver 并重新 fit；action 销毁时按当前 host 身份清理。

**GUI 最终验收**：重新构建、静默安装并于 19:17 启动新进程。普通模式实测 pane 722px / host 688px / xterm screen 675px；左右分屏两个 pane 均 722px、两个 xterm screen 均 675px。模拟拖动分隔条 100px 后比例从 50/50 更新为 58.47/41.53，两侧 screen 高度保持 675px，宽度分别更新为 672px/472px。测试 tab 已关闭，应用回到 Vault 锁定首页。

### R-040 终端选择复制与右键粘贴（2026-09-01，已完成）

**需求**（用户需求）：取消终端对 Ctrl+C 的复制拦截，保证 Ctrl+C 始终用于 shell 中止；终端文本选中后自动复制；在终端内点击右键时粘贴系统剪贴板文本。

**实现**：移除 App 层的 Ctrl+C 自定义按键处理；xterm 选区变化后自动写入剪贴板；终端右键无条件读取剪贴板并通过 xterm `paste()` 粘贴。Windows 安装版新增 Tauri 原生 Unicode 剪贴板读写命令，Web Clipboard API 仅作为非 Windows/异常时回退。

**验证**：`svelte-check` 0 errors / 0 warnings；Tauri `cargo check` 通过；Tauri 单元测试 25 passed；Tauri release/NSIS 构建成功。静默安装后通过 WebView2 CDP 实测：原生剪贴板 roundtrip、右键粘贴唯一 `echo` 标记、拖选后系统剪贴板读回均成功；持续 ping 且存在选区时按 Ctrl+C，终端显示 `Control-C`/`^C` 并恢复 shell 提示符。sol 复核后补充：右键监听改挂稳定的 xterm 元素，分屏重挂载后仍有效；剪贴板分配失败不会先清空用户原剪贴板。旧 `smoke_test.py` 仍依赖已删除的 Electron `app/package.json`，本轮执行后在启动前失败，不适用于 Tauri 客户端。

### R-041 Hosts Manager 与保险库信息一致（2026-09-01，已完成）

**需求**（用户需求）：首页 Hosts Manager 与设置中的保险库展示信息不完全匹配，需要统一。

**方案**：保险库以完整主机配置 `profiles` 为展示主数据，按相同分组树展示全部主机；密码、sudo 密码、私钥口令作为每台主机的附属状态，无凭据的主机也保留并标记“未保存凭据”。主机名称、账号地址、分组层级和分组计数与 Hosts Manager 对齐。

**实现**：保险库主列表与分组计数改为基于 `profiles`，再按 `user + host + port` 关联凭据；行内同时展示 Host Manager 的主机名称和账号地址。无凭据主机支持直接新增密码、sudo 密码和私钥口令，已有 sudo 密码可查看、编辑和清除；重复连接地址的编辑状态以 profile ID 隔离。

**验证**：`npm.cmd run check` → 0 errors / 0 warnings；`npm.cmd run build` 成功；定向 `git diff --check` 通过（仅有 Git 的 LF/CRLF 提示）。

### R-042 sudo 密码实际使用入口（2026-09-01，已完成）

**需求**（用户需求）：sudo 密码虽然可以保存，但终端中没有明确的使用入口。

**实现**：SSH 终端检测到 sudo 提示并取得当前主机密码后，在终端工具栏显示“填充 sudo 密码”按钮；保险库锁定时显示“解锁并填充 sudo 密码”，通过主口令临时解锁、读取当前主机 sudo 密码、提交并立即重新锁定。Ctrl+Enter 继续作为快捷入口，任意手动输入/超时会清除待填充操作。

**验证**：`npm.cmd run check` 0 errors / 0 warnings；`npm.cmd run build` 成功；定向 `git diff --check` 通过。

### R-043 首页 Home、复制分屏与标签右键菜单（2026-09-02，已完成）

**需求**（用户需求）：修复 Home 点击无反应；分屏应复制当前主屏；1 号位置右键菜单调整为“复制”“右分屏”“下分屏”“关闭”。

**实现**：Home 工具栏按钮阻止终端窗格点击事件冒泡；分屏和复制均克隆当前标签，会话类型保持一致，SSH 复用同一 Host profile，本地终端继承当前工作目录与终端尺寸；标签头右键菜单提供四个指定操作。

**验证**：`npm.cmd run check` 0 errors / 0 warnings；定向 `git diff --check` 通过。

### R-044 每次提交需附带详细版本更新说明（2026-09-02，进行中）

**需求**（用户需求）：从 2026-09-02 本次提交（commit 0f2b05e）起，每次提交必须附带详细的版本更新说明，介绍修复了哪些功能、优化了哪些功能、新增了哪些功能；格式参考 GitHub Release Notes（Highlights 概览 + Notes 按功能模块分节的列表）。

**说明**：该规范为持续生效的提交约定，非一次性需求；遵循它即可视为满足，状态保持「进行中」直至用户明确解除。
