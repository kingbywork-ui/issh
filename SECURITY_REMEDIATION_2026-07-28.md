# 安全漏洞修复记录（2026-07-28）

## 最终结论

本轮已修复仓库中 npm/Yarn 依赖审计发现的全部已知漏洞，并完成源码、构建产物和 Windows 安装包验证。

最终审计时间：2026-07-28 19:43（Asia/Shanghai，对应 `2026-07-28T11:43:38.125Z`）。

| 审计范围 | 严重 | 高危 | 中危 | 低危 | 信息 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 根目录 `yarn.lock` | 0 | 0 | 0 | 0 | 0 |
| `app/yarn.lock` | 0 | 0 | 0 | 0 | 0 |
| 10 个内置插件的独立 `yarn.lock` | 0 | 0 | 0 | 0 | 0 |
| 合计 12 个工作区 | 0 | 0 | 0 | 0 | 0 |

审计命令只向配置的 npm 漏洞数据库提交依赖包名、版本和锁文件元数据，不提交源代码、配置、密钥或终端内容。

## 已修复漏洞

### 第一阶段：原剩余 11 条高危漏洞

| 类别 | 数量 | 风险来源 | 修复 |
| --- | ---: | --- | --- |
| Angular 安全通告 | 10 | Angular 15 已超出相关通告的安全修复范围，影响 `@angular/common`、`@angular/core`、`@angular/compiler` 等包 | Angular 全家桶升级到 20.3.26，并同步升级 CDK、ng-bootstrap、ngtools、ngx-toastr、TypeScript、RxJS 和 Zone.js |
| `brace-expansion` 资源耗尽通告 | 1 | 旧构建工具通过旧版 `minimatch` 间接引入易受攻击版本 | 升级 ESLint、TypeDoc、gettext、ShellJS 和 Electron 构建链依赖，移除无用旧工具并刷新锁文件 |

### 第二阶段：扩大到全部插件锁文件后的剩余漏洞

此前的审计只覆盖根目录和 `app`。本轮将范围扩大到 10 个内置插件后，发现 `tabby-terminal`、`tabby-ssh`、`tabby-electron` 和 `tabby-core` 的独立锁文件仍保留易受攻击的旧依赖。修复前各受影响工作区的高危通告数量分别为 10、6 和 7；这些通告存在重复，不能直接相加。

| 依赖或依赖链 | 风险 | 修复 |
| --- | --- | --- |
| `@sentry/electron` 2.x | 旧版 Sentry/Electron 依赖链包含多项已披露问题 | 升级到 7.15.0，并改用受支持的 `@sentry/electron/main`、`renderer` 导出 |
| `electron-promise-ipc` | 已停止维护的 IPC 包及其依赖链带来漏洞和维护风险 | 完全移除；主进程改用 `ipcMain.handle`，渲染进程改用 `ipcRenderer.invoke` |
| `@luminati-io/socksv5` | 停止维护的 SOCKS5 实现及其传递依赖存在漏洞 | 替换为维护中的 `@mongodb-js/socksv5` 0.0.11，并通过直接 SOCKS5 握手测试 |
| `uuid` 9.x | 受影响版本存在可预测 UUID 安全通告 | `tabby-core` 升级到 11.1.1；仅用于本机标识的两个调用改用 Node `crypto.randomUUID()` |
| `tar`、`brace-expansion`、`minimatch` | 路径处理、模式匹配和资源耗尽类通告 | 分别固定到 7.5.22、5.0.8、10.2.6 |
| `micromatch`、`braces`、`picomatch` | 构建/补丁工具传递依赖中的正则或资源耗尽风险 | 固定到 4.0.8、3.0.3、2.3.2 |
| `tmp` | 临时文件/目录处理通告 | 固定到 0.2.7 |
| `yaml`、`yaml-loader` | 旧 YAML 解析链通告 | 升级到 `yaml` 2.9.0、`yaml-loader` 0.9.0 |
| `ajv`、`ejs` | 旧 loader/模板构建链通告 | 将对应传递依赖固定到已修复版本 |
| `node-gyp`、`socks`、`ip-address` | 构建、代理和地址解析传递依赖通告 | 分别升级或固定到 12.4.0、2.8.9、10.3.1 |
| `browserify-sign` | 根项目未使用的旧依赖链 | 删除未使用的直接依赖 |
| 应用内置 npm | npm 自带依赖不完全受 Yarn `resolutions` 约束，普通 Yarn 审计可能漏检 | npm 升级到 11.18.0；新增安装后加固脚本，将其内部 `tar`、`brace-expansion`、`minimatch` 替换为已修复版本，并在每次安全审计中强制校验 |

## 审计与防回归

- `scripts/security-audit.mjs` 现在审计根目录、`app` 和全部 10 个内置插件，共 12 份锁文件。
- 报告保留通告编号、严重性、包名、标题、链接、受影响/修复版本和依赖路径。
- 针对 npm 注册表的 HTTP 429 限流增加退避重试和工作区间隔。
- `scripts/harden-embedded-npm.mjs` 负责安装后加固和只读校验应用内置 npm。
- `npm.cmd run audit:security` 同时执行全工作区联网审计和内置 npm 校验。

## 功能与构建验证

| 验证项 | 结果 |
| --- | --- |
| 11 个插件及 Electron 主进程 `tsc --noEmit` | 全部通过 |
| 全量 typings + Webpack 构建 | 通过；应用及 10 个内置插件均成功生成 |
| `npm.cmd run lint` | 0 错误；仅 2 条既有复杂度警告 |
| `npm.cmd run test:tabby-agent` | 15/15 通过 |
| `python functional_regression_test.py` | 8/8 通过 |
| `python smoke_test.py` | 加固前后均为 10/10 通过 |
| SOCKS5 动态转发握手 | 通过 |
| Electron 运行时 | 39.8.10，可执行 |
| 应用内 npm CLI | 11.18.0，可执行 |
| 安装包独立 Agent CLI | `--help` 正常退出 |
| 最终 npm 审计 | 12 个工作区所有严重性均为 0 |
| 安装包 `app.asar` | 实际包含 npm 11.18.0、tar 7.5.22、brace-expansion 5.0.8、minimatch 10.2.6 |
| 安装包旧依赖检查 | 不含 `electron-promise-ipc`；SSH bundle 不再引用 `@luminati-io/socksv5` |
| `git diff --check` | 通过，仅有 Windows 换行提示 |

全量构建有一条 Sentry/OpenTelemetry 动态加载警告，应用 TypeScript 仍有 10 条上游遗留的未使用代码警告；均未导致类型检查、构建、测试或 GUI 冒烟失败。

## Windows 安装包

- 文件：`dist/issh-0.0.7-setup-x64.exe`
- 大小：155,274,072 字节
- SHA-256：`8F45D010835CDD40AD18B9DECF1002DFF0D78D359B0699715C166D2CEB3245CF`
- 同步产物：`issh-0.0.7-setup-x64.exe.blockmap`、`latest.yml`

正常的内置插件预打包和原生模块重建已完成，未使用 `TABBY_SKIP_PREPACKAGE=1`。随后 electron-builder 的联网 Electron 下载在完成进度后长时间无响应，因此停止该进程；使用仓库现有且 SHA-256 校验通过的 Electron 39.8.10 运行时，以相同 NSIS 配置成功生成最终安装包。

## 复现命令

```powershell
npm.cmd run audit:security
npm.cmd run lint
npm.cmd run test:tabby-agent
python functional_regression_test.py
python smoke_test.py
```

## 剩余架构风险

npm 漏洞数据库在本次审计的 12 份锁文件中没有剩余通告，安装包内置 npm 的已知审计盲点也已独立校验。渲染器仍依赖现有架构的 `nodeIntegration: true` 与 `contextIsolation: false`；现有导航和权限边界已收紧，但彻底移除该架构风险需要单独进行 preload/contextBridge 迁移，不属于本轮依赖漏洞修复范围。
