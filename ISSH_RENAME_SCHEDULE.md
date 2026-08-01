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
| D3–D4 | A | 插件发现、Webpack、typings、预打包、安全审计与跨平台构建脚本迁移 | `issh-*` 插件可完整构建和预打包 | 已完成（2026-08-01） |
| D3–D4 | B | `issh-agent`、`issh_*` 工具、新环境变量与兼容层 | 新旧客户端均通过协议与安全测试 | 已完成（2026-08-01） |
| D3–D4 | C | 用户可见品牌、样式标识、文档、元数据和 locale 再生成 | 产品可见面不存在未批准的 Tabby 文案 | 已完成（2026-08-01） |
| D5 | A+B | 配置、发现文件、插件标记和用户数据迁移；集成三条工作流 | 旧配置可读取，新写入只使用 issh 命名 | 已完成（2026-08-01） |
| D6 | 全员 | 十个内置插件类型检查、完整构建、Agent/迁移/安全测试 | 所有自动化验证通过或有明确阻断记录 | 已完成（2026-08-01） |
| D7 | A+C | Windows 打包、升级安装与 SSH/Vault/补全/Agent Bridge 人工验收 | 产物内容、版本、运行时和核心流程正确 | 已完成（用户手工打包/安装，2026-08-01） |
| D8 | 全员 | 全仓残留扫描、白名单审查、发布候选和文档收口 | 只剩批准残留，形成 RC | 已完成（2026-08-01，RC） |
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

### D4 — 环境变量兼容、跨平台构建与预打包验证

状态：已完成（2026-08-01）

#### 实施范围

- 新增应用启动兼容入口 `app/lib/environment.ts`，覆盖 13 个实际运行时、构建和测试环境变量后缀。主进程启动时采用 `ISSH_*` 优先、`TABBY_*` 回退策略；使用旧名时只输出变量名级别的弃用提示，不输出变量值。
- app main/renderer、Core Vault、Electron 插件、LLM Agent Bridge、根开发脚本、`.env` 与 smoke 启动环境全部改为读取或发布 `ISSH_*` 主名称。
- Agent CLI 独立运行时优先读取 `ISSH_AGENT_BRIDGE_FILE` 和 `ISSH_CONFIG_DIRECTORY`，旧变量仅作为带弃用提示的回退；Codex/Cursor 配置片段和设置页改为发布 `ISSH_AGENT_BRIDGE_FILE` / `ISSH_AGENT_BRIDGE_PORT`。
- 新增 `scripts/environment.mjs`，Windows、Linux、macOS 三个打包入口统一以 `ISSH_SKIP_PREPACKAGE` 为主、`TABBY_SKIP_PREPACKAGE` 为回退；README/HACKING/AGENTS 示例同步使用新变量。
- 将 SSH 只读执行的内部退出码标记由 `__TABBY_EXIT_CODE_*` 改为 `__ISSH_EXIT_CODE_*`，生成与解析仍保持同一单路径。
- 新增环境变量兼容回归脚本；Agent 测试增加新名称优先和旧名称回退两种连接文件发现用例。
- 未改动 D5 范围：`tabby-agent-bridge.json`、旧 AppData/config 发现目录、`tabby://`、旧插件 prefix/keyword、旧配置键和用户数据写入路径继续保留。

#### 构建、预打包与安全结果

- 完整根构建首次因沙箱无法读取 Corepack `lastKnownGood.json` 失败；授权读取同一缓存后原命令成功，未修改依赖或构建配置。
- `node scripts/prepackage-plugins.mjs` 首次在同一 Corepack 权限边界中断；授权后从头刷新成功。十个 `issh-*` builtin 插件全部复制并安装 production 依赖，native rebuild 完成，`windows-process-tree` 的 Spectre 配置已移除。
- 预打包结果为 10 个 `issh-*` 目录、0 个旧 `tabby-*` 目录；临时 `builtin-plugins/package.json` 已删除，LLM/SSH/Core 新环境变量和退出码标识均进入预打包 dist。
- 本地 embedded npm hardening 检查通过：`tar@7.5.22`、`brace-expansion@5.0.8`、`minimatch@10.2.6` 均符合预期；Agent 安全专项 7/7 通过。
- 用户明确授权依赖元数据外发后，完整 `npm audit` 成功检查根目录、app 和十个内置插件共 12 个工作区；所有工作区均为 0 条 advisory，info/low/moderate/high/critical 全部为 0。随后 embedded npm hardening 再次通过。

#### D4 验证结果

| 验证 | 结果 |
|---|---|
| 环境变量兼容回归 | 通过；验证 `ISSH_*` 优先、`TABBY_*` 回退且不覆盖显式新值 |
| Agent 协议/CLI/MCP/环境兼容测试 | 20/20 通过 |
| Codex Desktop MCP 配置测试 | 通过；输出 `ISSH_AGENT_BRIDGE_FILE` |
| app main + renderer TypeScript | 2/2 通过 |
| 十个 builtin 插件 + `issh-serial` `tsc --noEmit` | 11/11 通过 |
| 跨平台/安全/兼容脚本语法 | 8/8 通过 |
| 根目录 ESLint | 0 错误、2 个既有复杂度警告 |
| `corepack.cmd yarn run build` | 通过，约 163.2 秒；typings、app 和十个 builtin 插件全部成功 |
| `node scripts/prepackage-plugins.mjs` | 通过，约 110.3 秒；10 个 builtin 与 native rebuild 全部完成 |
| embedded npm hardening | 通过；3 个受控依赖版本全部验证 |
| `python smoke_test.py` | 12/12 通过；0 console error，隔离配置清理成功，使用新的 `ISSH_*` 启动环境 |
| 外部 registry 依赖审计 | 通过；12/12 工作区、0 条 advisory、所有严重级别均为 0 |

#### D4 残留边界与出口

- 活动代码中的直接旧环境变量读取只存在于三份 Webpack 配置的 `ISSH_DEV ?? TABBY_DEV` 构建兼容入口和 Agent 兼容测试；其余旧变量文本只存在于集中兼容 helper、旧名回归测试与文档兼容说明。
- `FIREBASE_SERVICE_ACCOUNT_TABBY_DOCS` 是现有外部 GitHub/Firebase secret 名，不能在没有外部凭据迁移的情况下擅自改名；继续归入 D8 外部协调白名单。
- `@tabby-gang/*` 仍是正式第三方包名；预打包中的该路径和 Spectre patch 不属于第一方品牌残留。
- 应用版本保持用户刚指定的 `0.1.0`；子插件版本与 Agent 版本未改变。未生成安装包、未暂存、未提交。

D4 的代码、构建、预打包、安全审计和 GUI 验证已经全部完成，出口条件满足；下一阶段可进入 D5 的配置、发现文件、插件标记和用户数据兼容迁移。

### D5 — 配置、发现文件、插件标记与用户数据迁移

状态：已完成（2026-08-01）

#### 配置与用户数据迁移

- `app/lib/config.ts` 在新的 `issh/config.yaml` 不存在时，按顺序查找旧的 `Tabby` / `tabby` AppData、`~/.config/tabby`、`~/.tabby` 和历史 Terminus 配置；只复制首个可用旧配置，不覆盖已存在的新配置，也不删除旧配置。后续保存仍只写当前 `issh` 配置路径。
- 配置迁移日志只记录来源路径，不读取或输出配置内容；候选路径在 Windows 上按大小写无关方式去重。
- App Panel 高度以 `issh.appPanel.bottomHeightPx` 为主键。新键缺失时一次性读取并校验旧 `tabby.appPanel.bottomHeightPx`，迁移到新键后删除旧键；新键存在时不读取旧值。
- 旧 `https://api.tabby.sh` 仅作为历史 config-sync 默认值的迁移哨兵；命中后删除旧 host/token，使后续配置保存不再写回该旧服务地址。

#### Agent discovery 迁移

- Agent 客户端以 `issh-agent-bridge.json` 和工作区 `.issh-agent-bridge.json` 为主；所有新候选都排在旧候选之前，避免旧文件抢占已存在的新配置。
- 兼容期内仍可只读发现 `tabby-agent-bridge.json`、`.tabby-agent-bridge.json`、旧 `%APPDATA%/Tabby`、`%APPDATA%/tabby`、`~/.config/tabby` 和 `~/.tabby`；显式旧环境变量路径仍可加载并输出弃用提示。
- Agent Bridge 服务只写 `issh-agent-bridge.json`。新文件成功写入并完成权限收紧后，清理同一配置目录中的旧临时 connection file；不会向旧目录或旧文件名写入新状态。
- Codex Desktop 测试样例、smoke 隔离配置与 Agent README 已同步新文件名，并明确旧发现入口只保留一个兼容发布周期。

#### 插件标记与 URL 兼容

- 新增集中式插件兼容分类器：`issh-`、`issh-plugin`、`issh-builtin-plugin` 为主接口；旧 `tabby-` / `terminus-` 前缀与旧关键词只作为带弃用警告的识别入口。
- 十个内置插件和可选 `issh-serial` 的发布清单只包含 `issh-builtin-plugin`，不再发布旧 builtin marker；第三方旧插件仍可在兼容期加载。
- 应用只注册并生成 `issh://` URL；`tabby://` 仅保留解析兼容，并在首次使用时输出一次弃用提示。
- 新增 `scripts/test-issh-migrations.mjs`，覆盖配置不覆盖迁移、插件分类/清单、URL、localStorage、Agent discovery 写入/清理和旧 config-sync 哨兵。

#### D5 验证结果

| 验证 | 结果 |
|---|---|
| D5 配置/发现/插件/URL/用户数据迁移回归 | 通过 |
| Agent 协议/CLI/MCP/发现兼容测试 | 22/22 通过 |
| 环境变量兼容与 Codex Desktop 配置测试 | 2/2 通过 |
| 十个 builtin 插件 + `issh-serial` `tsc --noEmit` | 11/11 通过 |
| 根目录 ESLint | 0 错误、2 个既有复杂度警告 |
| `corepack.cmd yarn run build` | 通过，约 154.2 秒；主进程、renderer、typings 和十个 builtin 插件全部成功 |
| dist 迁移标识核对 | 通过；app、Core、LLM 的新写入标识与旧兼容读取标识均进入当前产物 |
| `node scripts/prepackage-plugins.mjs` | 通过，约 124.9 秒；10 个 builtin 清单与 dist 已刷新，native rebuild 完成 |
| builtin 产物核对 | 通过；10/10 清单只发布新 marker，LLM discovery 产物为当前版本 |
| `python smoke_test.py` | 12/12 通过；0 失败，新 discovery 文件已写入、旧文件已清理，隔离配置清理成功 |
| GUI 截图复核 | 通过；issh 品牌、中文设置页与 Agent Bridge 运行状态正常 |
| `git diff --check` | 通过，仅有 Windows 行尾提示 |

#### D5 残留边界与出口

- 活动代码中的旧发现文件、旧 URL、旧插件标记和旧 config-sync host 均集中在兼容常量/迁移分支与回归测试中；第一方插件清单和正常写入路径不再发布或写入这些旧名称。
- 旧 Agent discovery、旧插件前缀/关键词和 `tabby://` 只保留一个兼容发布周期，后续移除应作为单独的破坏性变更执行。
- 永久白名单仍包括正式第三方 `@tabby-gang/*` 包名和真实上游/法律归属；Windows 旧注册表字符串只用于卸载清理。
- 应用版本保持 `0.1.0`；子插件和 Agent 版本未改变。D5 未改依赖、未生成安装包、未暂存、未提交。

D5 出口条件已经满足：旧配置和 discovery 可兼容读取，所有新的产品写入、发布标记和 URL 均使用 `issh` 命名。下一阶段进入 D6 的全量自动化验收与残留白名单复核，不在 D5 提前执行 Windows 安装包发布。

### D6 — 集中自动化验收与残留白名单复核

状态：已完成（2026-08-01）

#### 验收范围

- 从 D5 当前工作树独立重跑 Agent 协议/CLI/MCP/安全测试、配置与 discovery 迁移、环境变量兼容、Codex Desktop 配置、embedded npm 加固、app/插件 TypeScript、脚本语法、ESLint、完整 Webpack 构建、依赖安全审计和隔离 GUI 冒烟。
- 核对 app、Core、LLM、SSH 的当前 dist 标识、十个 `builtin-plugins` 清单和旧 source-map/typings 路径，避免只凭源码或 D5 的历史结果通过验收。
- 对活动仓库执行大小写无关的 `tabby` 残留扫描，区分兼容入口、第三方正式名称、上游/法律归属、外部服务配置和禁止的新写入/发布残留。
- D6 不执行 Windows 打包、安装/升级或人工 SSH/Vault/补全验收；这些操作仍属于 D7。

#### D6 发现并修正的残留

- 中文 README 仍有旧安装包名、`tabby-llm`、Tabby 会话和 `Tabby.exe` 便携说明；统一改为版本 `0.1.0` 的 `issh` 名称，并移除顶部图片到上游产品站点的无必要跳转。
- 英文 README 的示例安装包版本仍为 `1.0.7`；改为当前应用版本 `0.1.0`。上游 Tabby 基线与致谢继续保留真实来源名称。
- `app/dev-app-update.yml` 的本地 updater cache 仍使用旧产品目录名；改为 `issh-updater`。未知的新发布仓库不能在 D6 中凭空创建，因此 owner/repo 仍归入 D8 外部协调项。
- GitHub issue 模板仍要求跳转上游 Tabby issue/release；改为当前项目的通用 issue 搜索和最新 `issh` 版本说明，不伪造尚未提供的新仓库 URL。

#### 自动化验收结果

| 验证 | 结果 |
|---|---|
| Agent 协议/CLI/MCP/discovery/安全回归 | 22/22 通过；旧工具和旧环境变量兼容用例会输出预期弃用提示 |
| D5 迁移回归 | 通过；配置、discovery、插件、URL 与用户数据迁移全部成功 |
| 环境变量兼容 + Codex Desktop 配置 | 2/2 通过 |
| embedded npm hardening | 通过；`tar@7.5.22`、`brace-expansion@5.0.8`、`minimatch@10.2.6` |
| app main + renderer TypeScript | 2/2 通过 |
| 十个 builtin 插件 + `issh-serial` `tsc --noEmit` | 11/11 通过 |
| 改名相关 Node 脚本语法 | 8/8 通过 |
| 根目录 ESLint | 0 错误、2 个既有复杂度警告 |
| `corepack.cmd yarn run build` | 通过，约 136.5 秒；typings、app 和十个 builtin 插件全部成功 |
| dist/builtin 产物核对 | 通过；主/兼容标识齐全，10/10 清单只发布新 marker，无旧 builtin 目录或 stale moved-path/source-map 标识 |
| npm 依赖安全审计 | 通过；根、app 和十个 builtin 共 12/12 工作区，所有严重级别均为 0 advisory |
| `python smoke_test.py` | 12/12 通过；版本 `0.1.0`、0 console error、隔离配置清理成功 |
| GUI 截图复核 | 通过；`issh` 品牌、中文设置页、loopback Agent Bridge 与连接健康状态正常 |
| `git diff --check` | 通过，仅有 Windows 行尾提示 |

#### 残留白名单审查

- 排除 `node_modules`、`builtin-plugins`、dist/source map、lockfile、历史排班/交接、locale catalog、许可证与 smoke 产物后，共 51 个活动文件包含大小写无关的 `tabby`，均已逐项归类。
- 活动路径名只剩 `issh-agent/bin/tabby-agent.mjs` 与 `issh-agent/bin/tabby-mcp-server.mjs` 两个旧包装入口；二者有明确弃用提示、Agent 回归测试和一版兼容期限。
- 兼容白名单包括旧 MCP/RPC 名、`TABBY_*`、旧 config/discovery 路径、`tabby://`、旧插件 prefix/keyword、localStorage/config-sync 迁移哨兵、旧 Windows registry/Updater 卸载清理，以及相应测试。
- 永久或外部白名单包括正式 `@tabby-gang/*` 包名、真实上游 Tabby 来源/Issue/文档链接、Contributor/Funding/Crowdin 元数据、外部 `FIREBASE_SERVICE_ACCOUNT_TABBY_DOCS` secret 和历史安全记录。
- 尚需 D8 外部协调复核的发布面包括：Git origin/仓库元数据、GitHub workflow 的 packagecloud/docs 配置、`dev-app-update.yml` 的上游 repo、Release Notes/Updater 的上游 release endpoint。仓库中没有获批的 issh 对应服务地址，D6 不伪造替代值；其中 Electron updater 当前由 `UPDATES_ENABLED = false` 禁用。
- 禁止残留检查已通过：无旧版本安装包名、`tabby-llm`、`Tabby.exe`、Tabby 会话文案、旧 updater cache、第一方旧包名或第一方清单旧 builtin marker。

#### D6 出口

D6 所有自动化验证通过，无代码、构建、安全或 GUI 阻断；可以进入 D7 的 Windows 打包与安装/升级人工验收。应用版本保持 `0.1.0`，子插件和 Agent 版本未改变；未修改依赖、未生成安装包、未暂存、未提交。D8 仍需对上述外部服务和上游归属白名单作最终发布决策。

### D7 — Windows 打包、安装与已安装实例验收

状态：已完成（用户手工打包/安装，2026-08-01）

#### 用户执行与产物核对

- 用户明确报告已手工执行 `node scripts/build-windows.mjs`，打包过程顺利；随后安装生成的 issh，并打开了一个 tab，指示直接进入 D8。
- 工作区产物为 `dist/issh-0.1.0-setup-x64.exe`，大小 163,001,910 字节，生成时间 2026-08-01 17:34:36，SHA-256 为 `08F45F12A3A0934AF1588888F35BD00D06DEF6DA0C3E70BA95E219B78DEA6D54`。
- 安装器 PE 元数据为 `ProductName=issh`、`ProductVersion=0.1.0`、`FileVersion=0.1.0`；`latest.yml` 的版本、路径、大小与安装器一致。
- electron-builder effective config 核对通过：`appId=org.issh`、`productName=issh`、协议、安装包名、快捷方式和跨平台 artifact 模板均使用 issh。

#### 已安装实例实机验收

- 运行进程来自用户程序目录中的 `issh.exe`；已安装 `app.asar` 清单为 `name=issh`、`version=0.1.0`，包含 10 个 `issh-*` 内置插件、0 个旧 builtin 目录和当前 `issh-agent` 资源。
- 当前私有 Agent Bridge discovery 使用 `%APPDATA%/issh/issh-agent-bridge.json`，旧同目录 connection file 不存在；健康检查成功并识别到 1 个已连接、聚焦中的 SSH tab。
- 在不输出远程地址、用户名、终端内容或 token 的前提下，完成以下无副作用实测：Profile 清单读取；context 和终端 buffer 读取；交互 tab 回显命令执行并从缓冲读回标记；独立 SSH exec 回显及退出码；SFTP 根目录只读列表；执行后的 Bridge 再次健康检查。
- 危险命令仅通过 preview 检查：被正确识别为危险、`wouldExecute=false` 且要求用户确认；没有执行危险命令。
- 安装版与 D7 构建强一致性通过：`app/dist/main.js`、`bundle.js`、`preload.js` 3/3 哈希一致；10/10 内置插件身份和 dist 哈希一致；Agent `bin/src` 9/9 文件哈希一致。打包后的 app 清单只按预期裁剪 `scripts` 和 `devDependencies`，产品身份字段一致。
- 安装目录所有含旧名的路径均命中白名单：asar 内 26 条全部属于正式 `@tabby-gang/*` 第三方包；asar 外 131 条全部属于同一第三方包树或两个兼容 Agent 包装器，未批准路径为 0。

#### 验收边界

- `computer-use` 安全规则禁止自动接管终端类应用，因此未通过鼠标/键盘向 issh 终端注入输入；实机终端、SSH、SFTP 与危险命令检查全部通过项目自身的 token 保护 Agent Bridge 完成。
- 未读取或修改 Vault 密钥，未写远程文件，未执行破坏性命令。用户确认完成了安装并打开 tab，但未说明这是覆盖升级还是全新安装；本记录不虚构独立的旧版覆盖升级证据。

D7 的用户手工打包/安装、产物身份、已安装资源一致性和当前 SSH tab 核心功能验证均通过。按用户指示进入 D8。

### D8 — 全仓残留白名单、发布候选与文档收口

状态：已完成（2026-08-01，RC）

#### 发布配置与文档收口

- 移除 GitHub tag workflow 中向上游 `eugeny/tabby` Packagecloud 发布的步骤；保留本地构建和 GitHub Artifact 上传。
- 移除 docs workflow 中使用上游 `tabby-docs` Firebase project/secret 的部署步骤；保留文档构建。仓库未提供获批的 issh Packagecloud/Firebase 目标，D8 不伪造服务地址。
- `app/dev-app-update.yml` 的本地缓存目录使用 `issh-updater`。上游 repository/dev-update/release 地址只作为明确的来源或已禁用开发配置保留；Electron updater 继续由 `UPDATES_ENABLED=false` 禁用，不影响已验证安装包。
- 更新被 Git 忽略但仍属当前项目的 `AGENTS.md` 版本为 `0.1.0`；用户手册改为 `issh-mcp-server.mjs` 和 `ISSH_AGENT_BRIDGE_FILE`；旧 functional regression 资产改为使用 `issh_*` 主方法和 `issh-llm` 路径。

#### 可重复残留审计

- 新增 `scripts/audit-issh-residuals.mjs` 和 `npm run audit:rename`，递归扫描受控文本，排除依赖、构建缓存、dist、历史协作目录与 smoke 产物；任何未归类的大小写无关 `tabby` 命中、旧产品安装包名、旧第一方插件清单、旧 updater cache 或未批准发布配置都会使命令失败。
- 最终门禁扫描 1,489 个文本文件；170 条残留分布于 54 个文件，全部进入以下批准类别：一版兼容入口、兼容回归测试、正式第三方名称、真实上游归属、法律署名、历史安全记录和审计规则自身。
- 活动路径名只允许两个经过测试和弃用提示的兼容包装器：`issh-agent/bin/tabby-agent.mjs`、`issh-agent/bin/tabby-mcp-server.mjs`。
- 一版兼容白名单：旧 MCP/RPC 方法、`TABBY_*` 环境变量、旧 config/discovery 路径、`tabby://`、旧插件 prefix/keyword、localStorage/config-sync 迁移哨兵、旧 Windows registry/Updater 清理字符串及其测试。
- 永久/上游白名单：`@tabby-gang/*` 正式包名与物理路径、README/帮助/源码注释中的真实上游 Tabby 来源、LICENSE 署名、Contributor/Funding/Crowdin 元数据和历史安全记录。
- 当前 Git origin 仍为外部维护的旧路径 `https://hnittestgit.isoftstone.com/it/tabby.git`；未提供新的 issh remote，D8 不擅自修改远端。它不进入应用发布产物，作为仓库管理员后续外部协调项记录。

#### D8 最终验证

| 验证 | 结果 |
|---|---|
| `npm run audit:rename` | 通过；1,489 文件、54 个批准残留文件、0 未批准残留 |
| Agent 协议/CLI/MCP/安全回归 | 22/22 通过 |
| 配置/发现/插件/URL/用户数据迁移 | 通过 |
| 环境变量兼容与 Codex Desktop 配置 | 2/2 通过 |
| workflow / app-update / electron-builder YAML | 4/4 语法通过 |
| D7 安装器身份与 latest metadata | 通过；版本 `0.1.0`、名称和哈希一致 |
| 已安装 app 运行 bundle 哈希 | 3/3 与当前 D7 构建一致 |
| 已安装 builtin 插件 | 10/10 身份/dist 一致，0 旧 builtin 目录 |
| 已安装 Agent 资源 | 9/9 `bin/src` 文件哈希一致 |
| 已安装路径白名单 | asar 26/26、外部 131/131 均获批准；0 未批准路径 |
| 当前实例实机功能 | Bridge、session、profile、context、buffer、tab run、SSH exec、SFTP list、危险 preview 全部通过 |
| `git diff --check` | 通过，仅有 Windows 行尾提示 |

#### RC 结论

issh `0.1.0` 已满足 D1–D8 改名、兼容迁移、构建、安全、安装产物、已安装实例功能和残留白名单门槛，形成 RC。只保留有期限的兼容入口、正式第三方名称、真实上游/法律归属和明确的外部仓库协调项。未暂存、未提交、未推送；D9 仅在后续集成、提交或发布发现阻断时启用。
