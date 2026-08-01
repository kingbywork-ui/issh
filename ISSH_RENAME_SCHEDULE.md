# issh 全量改名排班与执行记录

## 目标

将本仓库第一方、产品自有的 `Tabby` / `tabby` 命名迁移为 `issh`，覆盖用户界面、源代码目录、包名、构建链、CLI、MCP/RPC、环境变量、配置发现、文档和发布产物，同时保证现有用户数据和外部 Agent 客户端可迁移。

本计划不机械篡改第三方包的正式名称、上游版权或许可证署名。此类残留必须进入审核过的白名单；若未来要求仓库文本绝对零 `tabby`，需另立任务替换或内置第三方依赖，并在符合法律义务的前提下处理署名。

## 人员与职责

推荐采用三人小组，避免多人同时修改相同的包清单和构建入口。

| 角色 | 主责 | 文件所有权原则 |
|---|---|---|
| A：架构与集成 | 插件目录/包名、导入、根构建、预打包、最终集成 | D2 独占基础机械改名；之后负责根配置与构建脚本 |
| B：Agent 与兼容 | CLI、MCP/RPC、环境变量、发现文件、兼容别名、迁移测试 | 独占 `issh-agent` 与 Agent Bridge 协议相关文件 |
| C：品牌与质量 | UI 文案、样式标识、文档、locale 再生成、测试与发布验收 | 独占品牌资源、翻译和验收报告 |

单人执行时保持相同顺序，预计 12–15 个工作日；三人执行预计 8 个工作日并预留 1 个缓冲日。

## 总体排班

| 日程 | 负责人 | 工作内容 | 出口条件 | 状态 |
|---|---|---|---|---|
| D1 | 全员 | 冻结基线；建立改名映射、兼容矩阵、残留白名单；运行基线验证 | 范围、风险、基线结果均已记录 | 已完成（2026-07-31） |
| D2 | A 主导，B/C 复核 | 一次性重命名第一方插件目录、包名、依赖、导入和基础构建列表 | 基础提交可通过相关 TypeScript 检查 | 已完成（2026-08-01） |
| D3–D4 | A | 插件发现、Webpack、typings、预打包、安全审计与跨平台构建脚本迁移 | `issh-*` 插件可完整构建和预打包 | 进行中（D3 已完成） |
| D3–D4 | B | `issh-agent`、`issh_*` 工具、新环境变量与兼容层 | 新旧客户端均通过协议与安全测试 | 进行中（D3 已完成） |
| D3–D4 | C | 用户可见品牌、样式标识、文档、元数据和 locale 再生成 | 产品可见面不存在未批准的 Tabby 文案 | 进行中（D3 已完成） |
| D5 | A+B | 配置、发现文件、插件标记和用户数据迁移；集成三条工作流 | 旧配置可读取，新写入只使用 issh 命名 | 未开始 |
| D6 | 全员 | 十个内置插件类型检查、完整构建、Agent/迁移/安全测试 | 所有自动化验证通过或有明确阻断记录 | 未开始 |
| D7 | A+C | Windows 打包、升级安装与 SSH/Vault/补全/Agent Bridge 人工验收 | 产物内容、版本、运行时和核心流程正确 | 未开始 |
| D8 | 全员 | 全仓残留扫描、白名单审查、发布候选和文档收口 | 只剩批准残留，形成 RC | 未开始 |
| D9 | 按需 | 只处理集成、打包或验收阻断 | 发布缓冲 | 预留 |

## 阶段依赖

1. D2 的基础目录/包名改名必须作为单独提交先落地。
2. D3–D4 的三条工作流都从同一个 D2 提交开始，避免目录移动与内容修改产生大面积冲突。
3. D5 只做兼容迁移与集成，不夹带功能调整。
4. D6 自动化验证通过后才允许进入 D7 打包。
5. D8 的残留扫描必须使用审核白名单，不能用无差别替换破坏第三方依赖、兼容入口或法律署名。

## 命名迁移规则

| 类别 | 当前命名 | 目标命名 | 兼容策略 |
|---|---|---|---|
| 第一方插件目录/包 | `tabby-core` 等 | `issh-core` 等 | D2 原子迁移，不保留重复目录 |
| Agent 包/目录 | `tabby-agent`、`@issh/tabby-agent` | `issh-agent`、`@issh/agent` | 一个兼容发布周期提供旧 CLI 包装入口 |
| MCP/RPC 工具 | `tabby_*` | `issh_*` | 新名称为主；旧名称映射到相同实现并输出弃用提示 |
| 环境变量 | `TABBY_*` | `ISSH_*` | 优先读取新名称，兼容读取旧名称；只文档化新名称 |
| 配置/发现文件 | `tabby-agent-bridge.json` 等 | `issh-agent-bridge.json` 等 | 新文件优先，旧文件只读发现和一次性迁移 |
| 插件标记 | `tabby-plugin`、`tabby-` 前缀 | `issh-plugin`、`issh-` 前缀 | 兼容发布周期同时识别旧标记 |
| UI/文档/元数据 | `Tabby` | `issh` | 用户可见内容直接迁移 |
| CSS/内部符号 | `tabby-*`、`Tabby*` | `issh-*`、`ISSH*` 或语义化名称 | 随所属模块迁移，不提供运行时兼容，除非被插件 API 使用 |

## 残留白名单原则

允许保留的 `tabby` 必须属于以下类别并可追溯：

- 第三方正式包名，例如 `@tabby-gang/windows-blurbehind`、`@tabby-gang/windows-process-tree`、`@tabby-gang/to-string-loader`。
- 上游许可证、版权、派生说明及必须保留的仓库来源信息。
- 一个兼容发布周期内的旧环境变量、旧 MCP/RPC 方法、旧发现路径和旧插件标记；这些入口必须集中、带测试并有弃用说明。
- Git 历史、历史交接记录及不参与产品构建的归档资料。

任何业务代码、用户界面、构建产物或新写入配置中的非白名单 `tabby` 都视为缺陷。

## 全局验收门槛

- 用户可见界面、安装器、快捷方式、协议和发布产物统一使用 `issh`。
- 十个内置插件使用 `issh-*` 目录和包名，并能完成 typings、TypeScript 和 Webpack 构建。
- 新的 CLI/MCP 工具使用 `issh` 命名；旧客户端在兼容期内仍能工作。
- 旧用户的配置、Profiles、Vault、历史记录和 Agent Bridge 连接信息不会丢失。
- `rg -i tabby` 的剩余结果全部命中审核白名单。
- 完成 Agent 协议、安全、配置迁移、功能回归与 Windows 安装包验证。
- 根目录 smoke 测试资产若仍缺失，必须记录限制，并至少完成项目规定的插件类型检查、构建验证和等价人工冒烟。

## 每日执行记录

### D1 — 基线、映射与兼容策略

状态：已完成（2026-07-31）

计划输出：

- Git、版本、Node/npm/Yarn/Electron 与工作树基线。
- 第一方目录、包名、Agent 接口、环境变量、配置路径、插件标记和用户可见文案的影响面清单。
- “立即改名 / 临时兼容 / 永久白名单”三类决策。
- 基线 TypeScript、Agent、配置和构建验证结果。

#### 基线快照

| 项目 | 基线值 |
|---|---|
| Git 分支 | `issh` |
| Git 提交 | `e24759a4add123be674093aba6da873980de004d` |
| 应用名/版本 | `issh` / `0.0.9` |
| Node.js | `v24.16.0` |
| npm | `11.13.0` |
| Yarn | `1.22.22` |
| Electron 包 | `43.2.0` |
| 源码基线状态 | 开始 D1 时无产品源码修改；只新增本排班文件 |
| smoke 资产 | 根目录没有 `smoke_test.py`、`test_screenshots/` 或 smoke report |

#### 影响面快照

- 排除锁文件、缓存、历史协作资料和交接记录后，有 296 个受控文件、约 19,403 处大小写无关文本命中。
- 再排除 25 个 locale 目录及法律文件后，有 270 个产品/构建文件、862 处命中。
- 有 711 条受控路径包含 `tabby`；大量路径来自 `tabby-community-color-schemes` 根目录，D2 通过根目录移动一次性处理。
- 发现 13 个一级 `tabby-*` 目录：10 个内置插件、`tabby-agent`、可选 `tabby-serial` 和源码级 `tabby-uac`。后两项不得遗漏。
- 发现 15 个 `TABBY_*` 环境变量、17 个正式 `tabby_*` MCP/RPC 方法，以及 48 个包含大写 `Tabby` 的第一方代码、清单或资源文件。
- 外部应用身份已基本完成 issh 化：`app/package.json` 名称、electron-builder 的 app id、product name、URL protocol、artifact name、shortcut 和 StartupWMClass 均为 `issh`。

#### 一级目录与包映射

| 当前路径/包 | 目标路径/包 | 类型 |
|---|---|---|
| `tabby-agent` / `@issh/tabby-agent` | `issh-agent` / `@issh/agent` | 外部 CLI/MCP 客户端 |
| `tabby-auto-sudo-password` | `issh-auto-sudo-password` | 内置插件 |
| `tabby-community-color-schemes` | `issh-community-color-schemes` | 内置插件 |
| `tabby-core` | `issh-core` | 内置插件、核心 API |
| `tabby-electron` | `issh-electron` | 内置插件 |
| `tabby-linkifier` | `issh-linkifier` | 内置插件 |
| `tabby-llm` | `issh-llm` | 内置插件、Agent Bridge 宿主 |
| `tabby-local` | `issh-local` | 内置插件 |
| `tabby-serial` | `issh-serial` | 可选插件，当前不在 builtin 列表但仍被 app 清单引用 |
| `tabby-settings` | `issh-settings` | 内置插件 |
| `tabby-ssh` | `issh-ssh` | 内置插件 |
| `tabby-terminal` | `issh-terminal` | 内置插件 |
| `tabby-uac` | `issh-uac` | UAC 辅助程序源码；当前打包使用 `extras/UAC.exe` |

#### 协议与环境变量映射

- 17 个工具逐项使用同名后缀映射：`tabby_health`、会话/Profile、上下文/缓冲、命令预览/插入/运行/执行/输出/批量执行及三个 SFTP 方法全部迁移到 `issh_*`。
- 15 个环境变量逐项保留后缀映射到 `ISSH_*`：Agent Bridge file/port/public file、config directory、dev、Glasstron、docs、Sentry、exit code、Angular prod、history、plugins、prepackage、smoke GPU 和 Vault passphrase。
- `tabby-agent-bridge.json`、`.tabby-agent-bridge.json`、旧 `%APPDATA%/Tabby`、`~/.config/tabby` 和 `~/.tabby` 只作为兼容读取源；新写入使用 issh 名称和路径。

#### 三类决策

立即改名：

- 13 个第一方一级目录及其包清单、peer dependencies、导入、tsconfig、Webpack、脚本和测试路径。
- `TabbyCorePlugin`、`TabbyCoreModule`、`TabbyTerminalModule`、`TabbyBrowserWindow`、URL helper 和 date pipe 等第一方符号；保持行为不变，不趁机做无关重构。
- `.tabby-logo`、`.tabby-title`、Webpack `tabby-main`、`TERM_PROGRAM=Tabby`、用户可见提示、README、HACKING 和 locale 来源引用。
- CLI 可执行名和 MCP server 文件名迁移为 `issh-agent` 与 `issh-mcp-server`。

临时兼容一个发布周期：

- 17 个旧 `tabby_*` 方法、15 个旧 `TABBY_*` 环境变量、旧 Agent Bridge 发现文件与目录。
- `tabby://` URL、`tabby-plugin` / `tabby-builtin-plugin` 标记、`tabby-` 插件发现前缀。
- Windows 中旧的 “Open Tabby here” 等注册表项清理逻辑；这些字符串只用于删除旧项。
- `https://api.tabby.sh` 作为旧 config-sync 默认值识别条件，直到配置迁移完成。

永久或外部白名单：

- `@tabby-gang/to-string-loader`、`@tabby-gang/windows-blurbehind`、`@tabby-gang/windows-process-tree` 的正式第三方包名和其真实文件路径。
- 法律要求的上游版权、许可证和派生来源说明。
- Git 历史、历史 HANDOFF 条目和不参与产品构建的归档资料。

#### 外部协调项

- 当前 Git origin 仍为 `https://hnittestgit.isoftstone.com/it/tabby.git`，`app/package.json` repository 仍指向上游 GitHub。D8 前需要项目维护方提供或完成 issh 仓库地址迁移，再更新产品元数据和开发文档。
- `https://translate.tabby.sh/project/tabby` 没有已知 issh 对应服务。D3 默认从用户界面移除该外链；若维护方提供 issh 翻译站则改为新地址。
- 25 个 PO/POT 文件仍带 Tabby/Crowdin 项目头和大量旧源码路径。源目录迁移后统一重新提取并更新头信息，不逐文件手工替换路径引用。

#### 基线验证结果

| 验证 | 结果 |
|---|---|
| 10 个内置插件 `tsc --noEmit` | 10/10 通过 |
| 可选 `tabby-serial` `tsc --noEmit` | 通过 |
| Agent 测试 | 17/17 通过 |
| Codex Desktop MCP 配置测试 | 通过 |
| 根目录 ESLint | 0 错误、2 个既有复杂度警告 |
| `corepack.cmd yarn run build` | 通过，耗时约 184.56 秒；typings、app 和 10 个插件全部构建成功 |
| 构建告警 | `tabby-main` 1 个动态 require 警告；app renderer 12 个已知警告；无构建错误 |
| `git diff --check` | 通过 |

完整构建全部显示 `[compared for emit]` 或成功缓存命中，与“基线无源码变化”的预期一致。D1 出口条件已满足，下一阶段可以进入 D2 的基础目录/包名原子迁移。

### D2 — 第一方目录、包名与基础构建迁移

状态：已完成（2026-08-01）

#### 实施范围

- 将 D1 记录的 13 个一级目录全部原子移动到 `issh-*`：10 个 builtin 插件、Agent、Serial 和 UAC 源码目录；旧一级目录均已不存在。
- 十一个 JavaScript/TypeScript 包的 `package.json` 名称迁移到 `issh-*`，Agent 包从 `@issh/tabby-agent` 迁移到 `@issh/agent`；所有子包版本保持 `1.0.231-nightly.0`，Agent 保持 `1.0.0`，应用版本保持 `0.0.9`。
- 在 190 个受控代码/配置文件中机械更新第一方包名、peer dependencies、import、tsconfig、Webpack external、测试路径和构建清单；根级共有 16 个受控配置/脚本文件发生对应修改。
- 更新 app builtin 依赖、`scripts/vars.mjs`、native/security/icon/test 脚本、Dependabot 目录、patch 中的第一方包名、根 TypeScript path alias 和 Webpack package external。
- 为原本已受控但被根 `*.sln` 规则覆盖的 `issh-uac/UAC.sln` 增加精确 `.gitignore` 反向规则，确保目录移动后 699 个原受控文件均可重新纳入版本控制。
- Agent 仅迁移源码目录、源码 import、开发态查找路径和 npm package scope。`tabby-agent` CLI 文件名、旧 MCP/RPC 方法、旧发现文件及打包后的兼容资源目录没有在 D2 提前改动。
- 同步更新当前 `AGENTS.md` 中的结构和构建路径；历史 HANDOFF、排班映射、README/HACKING、locale 与法律文件不做机械覆盖。

#### 构建链修复

第一次运行 `build:typings` 时，`issh-settings` 无法解析 `issh-core`。根因是十一个 `tsconfig.typings.json` 仍覆盖根配置并保留 `tabby-* -> ../../tabby-*` 路径规则。

已将十一个 typings 配置统一改为 `issh-* -> ../../issh-*`。修复后 typings 串行构建全部通过。该失败及修复属于 D2 的包解析迁移，没有改变运行时功能。

#### D2 验证结果

| 验证 | 结果 |
|---|---|
| 10 个 builtin 插件 `tsc --noEmit` | 10/10 通过 |
| `issh-serial` `tsc --noEmit` | 通过 |
| `corepack.cmd yarn run build:typings` | 修复旧 wildcard 后 10/10 通过 |
| Agent 测试 | 17/17 通过，根测试脚本已跟随 `issh-agent` 目录 |
| Codex Desktop MCP 配置测试 | 通过，源码测试路径已迁移到 `issh-llm` |
| `corepack.cmd yarn run build` | 通过，约 150.12 秒；app、typings 和 10 个 `issh-*` 插件全部成功 |
| Dist 标识 | 新 bundle 包含 `issh-core`、`issh-terminal`、`issh-ssh` 等 external；各插件 dist 已重新 emitted |
| 根目录 ESLint | 0 错误、2 个既有复杂度警告，文件位置已变为 `issh-electron` 与 `issh-llm` |
| 活动源码/配置旧第一方包名扫描 | 0 命中；排除文档、locale、历史、第三方和后续兼容标识 |
| `git diff --check` | 通过，仅显示现有 Windows 行尾转换提示 |

#### 明确保留到后续阶段

- D3：`PLUGIN_PREFIX = 'tabby-'` 的插件发现逻辑、`webpack-tabby-*` source-map scheme、i18n 的 `./tabby-*/src` glob、用户可见文案、README/HACKING 和 25 个 locale 文件。
- D3–D4 Agent 工作流：CLI/bin 文件名、MCP server name、`tabby_*` 工具、`tabby-agent-bridge.json` 及设置页提示。
- D5：`TABBY_*` 环境变量、旧插件 keyword/prefix、`tabby://`、旧配置/发现路径和旧 Windows registry 清理兼容。
- `@tabby-gang/*` 第三方正式包名与法律署名继续遵守白名单。

当前 Git 尚未暂存改名，因此状态以 699 个旧路径删除、13 个新 `issh-*` 目录和 1 个排班文件未跟踪、16 个根级文件修改呈现；这与物理目录迁移后的未暂存状态一致。未创建提交，也未修改版本号或引入依赖。D2 出口条件已经满足。

### D3 — 运行时主命名、Agent 主接口与可见品牌迁移

状态：已完成（2026-08-01）

#### A：插件发现、构建标识与派生产物

- 插件发现主前缀切换为 `issh-`，新增 `issh-plugin` / `issh-builtin-plugin` 识别；兼容期继续识别 `tabby-`、`terminus-` 及其旧 keyword。
- 在模块缓存层为第一方 `issh-*` 包集中生成 `tabby-*` / `terminus-*` 加载别名，避免旧插件依赖在启动竞态中失效。
- Webpack source-map scheme、app/main 配置名称、app TypeScript 排除规则和 i18n TypeScript glob 均迁移到 `issh`；Snap 名称、命令与安装目录迁移为 `issh`。
- Electron 额外资源目标改为 `issh-agent`；运行时优先发现新资源目录，同时保留旧 `tabby-agent` 资源目录只读兼容候选。
- 清理并重建十个 builtin 插件和可选 `issh-serial` 的 `typings/`、dist，确认不存在旧 `webpack-tabby-*` scheme 或 stale `tabby-*` 第一方声明。

#### B：Agent 主接口与兼容包装

- 新增并发布 `issh-agent`、`issh-mcp-server` bin 与根 npm scripts；17 个规范工具全部迁移为 `issh_*`，MCP server 名称迁移为 `issh-agent-bridge`。
- Agent Bridge、CLI、Codex/Cursor/Claude 配置片段和设置页以 `issh` 名称为主；安装后的 CLI/MCP 脚本也优先使用新文件名。
- 旧 `tabby-agent`、`tabby-mcp-server` 文件和 17 个 `tabby_*` 调用保留一个兼容发布周期：统一归一化到同一实现，并输出弃用提示；协议 scope、安全确认与审计路径不分叉。
- 按阶段边界暂不迁移 `TABBY_*` 环境变量和 `tabby-agent-bridge.json` 发现文件；这些进入 D5 的“新名称优先、旧名称只读兼容”迁移。

#### C：用户可见品牌、内部符号、文档与 locale

- 内部第一方符号迁移到 `ISSH*`：BrowserWindow/URL helper、Core/Terminal 模块别名、date pipe；pipe 名称迁移为 `isshDate`。
- `.tabby-logo` / `.tabby-title` / `html.tabby`、`TERM_PROGRAM=Tabby`、Agent/SSH/设置页提示、包描述/作者和用户可见文案迁移到 `issh`。
- README、HACKING、插件文档、Agent 文档、AGENTS 结构说明和 Snap 文案完成迁移；上游 Tabby 派生说明与真实链接作为永久来源白名单保留。
- 由于没有已知 issh 翻译站，设置页移除了旧 Tabby 翻译入口，没有虚构替代地址。
- i18n 提取改为扫描 `issh-*`，直接使用本地 Pug CLI，并用 `gettext-parser` 在无系统 gettext 的 Windows 环境中按新 POT 合并翻译。25 个 PO/POT 文件已统一重提取：651 条消息、843 处用法、111 个含消息源文件；旧 source reference、旧 Crowdin 项目头和 `Tabby` 文案均为 0。

#### 实施中发现并修复的问题

- Windows 没有全局 `yarn`，Corepack 又因沙箱无法读用户缓存，初次 i18n 提取无法启动 Pug；改为调用仓库本地 `node_modules/.bin/pug.cmd` 后成功。
- 初版 locale 编译使用 `foldLength: 0`，使 PO 头单行化并触发下游误判 Latin-1；第一次 GUI 冒烟因此出现中文乱码。提取脚本现保留标准折行头、自动检测并恢复已误判的 UTF-8，重新生成后 `zh-CN` 与其他语言解析正常。
- `issh-core` 自身 package build script 仍带 Webpack 5 不支持的既有 `--display-modules` 参数；未借机修改该无关脚本，而是使用根目录同一 Webpack 配置直接重建 core locale bundle。

#### D3 验证结果

| 验证 | 结果 |
|---|---|
| 十个 builtin 插件 + `issh-serial` `tsc --noEmit` | 11/11 通过 |
| Agent 协议/CLI/MCP/安全测试 | 18/18 通过，含旧 `tabby_*` 兼容别名与弃用提示 |
| Codex Desktop MCP 配置测试 | 通过 |
| locale 提取与合并 | 通过；25 个文件，旧引用/品牌/项目头均 0 |
| 根目录 ESLint | 0 错误、2 个既有复杂度警告 |
| `corepack.cmd yarn run build` | 通过，约 148.1 秒；typings、app 和十个 builtin 插件全部成功 |
| 可选 `issh-serial` typings + Webpack | 通过，dist 已 emitted |
| 产物标识 | `issh` HTML/CSS、`ISSHFormatedDatePipe`、`issh_*` Agent、`webpack-issh-*` 均存在；旧 scheme/stale typings 为 0 |
| `python smoke_test.py` | 最终 12/12 通过；`issh_health`、安装后 `issh-agent`、Bridge 安全与中文界面均验证 |
| `git diff --check` | 通过，仅有 Windows 行尾提示 |

#### D3 残留边界

- 活动源码中大小写精确的 `Tabby` 只剩 6 处：两个旧 `%APPDATA%/Tabby` 发现候选和四个旧 Windows registry 项删除字符串，均为 D5 兼容白名单。
- 活动文件名只剩两个 `tabby-*`：Agent 旧 CLI/MCP 包装文件，均带弃用提示和回归测试。
- 其余残留属于 D5 的 `TABBY_*`、旧发现文件、旧插件标记/前缀、`tabby://` 与旧配置键，或永久保留的 `@tabby-gang/*`、上游来源/许可证链接。
- 当前工作树仍未暂存/提交：699 个旧路径删除、54 个已跟踪文件修改、702 个未跟踪文件（699 个移动后的文件、排班文件和两个新 Agent bin）。未修改任何版本号或依赖。

D3 出口条件已经满足；D4 继续完成预打包、安全审计和跨平台脚本的剩余迁移，以及 Agent 新环境变量兼容层的准备工作，但不提前执行 D5 的配置/用户数据写入迁移。
