# 安全漏洞修复记录（2026-07-28）

## 最终结论

本轮已修复剩余 11 条高危依赖漏洞，并完成 Angular 20 兼容迁移、全量构建、功能回归、GUI 冒烟和 Windows 安装包验证。

最终 npm 漏洞审计结果：

| 工作区 | 严重 | 高危 | 中危（唯一通告） | 低危（唯一通告） |
| --- | ---: | ---: | ---: | ---: |
| 根目录 `yarn.lock` | 0 | 0 | 6 | 2 |
| `app/yarn.lock` | 0 | 0 | 4 | 0 |

按受影响依赖路径计数：

| 工作区 | 严重 | 高危 | 中危 | 低危 |
| --- | ---: | ---: | ---: | ---: |
| 根目录 | 0 | 0 | 10 | 2 |
| `app` | 0 | 0 | 17 | 0 |

审计时间：2026-07-28 17:57（Asia/Shanghai）。

审计只向配置的 npm 漏洞数据库提交依赖包名、版本和锁文件元数据，不提交源代码、配置、密钥或终端内容。

## 本轮修复的 11 条高危漏洞

| 类别 | 数量 | 原因 | 修复 |
| --- | ---: | --- | --- |
| Angular 安全通告 | 10 | Angular 15 已超出通告的安全修复范围，受影响包包括 `@angular/common`、`@angular/core` 和 `@angular/compiler` | Angular 全家桶升级到 20.3.26，并同步升级 CDK、ng-bootstrap、ngtools、ngx-toastr、TypeScript、RxJS 和 Zone.js |
| `brace-expansion` 资源耗尽通告 | 1 | 旧版构建工具通过旧版 `minimatch` 间接引入易受攻击版本 | 升级 ESLint、TypeDoc、gettext、ShellJS 及 Electron 构建链相关依赖，移除无用旧工具，并更新锁文件 |

修复后两个锁文件的高危和严重漏洞均为 0。

## 关键依赖版本

| 依赖 | 修复后版本 |
| --- | --- |
| Angular core/common/compiler/forms/platform-browser | 20.3.26 |
| Angular CDK | 20.2.14 |
| ng-bootstrap | 19.0.1 |
| `@ngtools/webpack` | 20.3.26 |
| ngx-toastr | 19.1.0 |
| TypeScript | 5.9.3 |
| RxJS | 7.8.2 |
| Zone.js | 0.15.1 |
| `@types/node` | 22.15.21 |
| ESLint | 10.8.0 |
| Electron | 39.8.10 |
| electron-builder | 26.15.3 |
| npm（应用内插件管理） | 11.13.0 |

## Angular 20 兼容修复

- 为 79 个现有 `@Component`、`@Directive` 和 `@Pipe` 声明显式添加 `standalone: false`。Angular 19 起默认值变为 standalone；若不迁移，应用能编译但模块指令不会正确实例化，主界面会空白。
- 关闭应用渲染包的 Webpack 模块拼接优化。Angular 20 拆分后的 ESM 浏览器模块在旧强制拼接配置下会生成无效的 `__webpack_require__(null)`。
- 将已移除的 Angular `InjectFlags.Optional` 调用改为 `{ optional: true }`。
- 调整终端输入的 Buffer 转换，兼容 Node 22 类型定义。
- 将 ESLint 迁移到 ESLint 10 flat config，并保留原有规则边界。
- 同步更新所有插件的 Angular/ng-bootstrap peer dependency 范围和相关锁文件。

## 之前已修复的代码安全问题

本文件继续作为本次完整安全修复的统一记录：

- 富文本入口使用 DOMPurify 净化 HTML/SVG，限制危险标签、属性和链接协议。
- Vault 新写入使用 AES-256-GCM、随机 nonce、认证标签和 PBKDF2-SHA512；旧 AES-CBC 数据只读兼容并在保存时迁移。
- `sendContextToCloud=false` 时禁止向 LLM 发送终端输出、目录、shell、上一条命令和空输入预测。
- 扩展危险命令、包装命令和凭据检测；历史及审计文件使用限制权限，审计日志限制大小并轮换。
- WinSCP 命令行不再携带 SSH 密码、隧道密码或密钥口令。
- 新 SSH 配置默认不启用弱 RSA/SHA-1 算法。
- Electron 限制导航、WebView、worker、subframe、拖放导航和设备权限。
- 插件管理器改用 Electron Node 模式调用 npm 11 CLI，不再依赖 npm 6 私有 API。
- SSH 代理和本地命令解析拒绝 `shell-quote` 返回的非字符串控制操作符。
- CI Action 固定到提交 SHA，下载的 VC Runtime 必须通过 Microsoft Authenticode 校验。

## 验证结果

| 验证 | 结果 |
| --- | --- |
| 11 个插件及 Electron 主进程 `tsc --noEmit` | 全部通过 |
| 全量 typings + Webpack 构建 | 通过；应用及 10 个内置插件均成功生成 |
| `npm.cmd run lint` | 0 错误；2 条既有复杂度警告 |
| `npm.cmd run test:tabby-agent` | 15/15 通过 |
| `python functional_regression_test.py` | 8/8 通过 |
| `python smoke_test.py` | 10/10 通过 |
| Electron 运行时 | 39.8.10，可执行 |
| 应用内 npm CLI | 11.13.0，可执行 |
| 最终 npm 审计 | 严重 0、高危 0 |
| Windows 安装包 | 正常预打包和原生模块重建通过；NSIS 安装包生成成功 |
| 打包内容 | Angular 20.3.26 已包含；不存在 `__webpack_require__(null)`；独立 Agent CLI 可运行 |
| `git diff --check` | 通过，仅有 Windows 换行提示 |

## 安装包

- 文件：`dist/issh-0.0.7-setup-x64.exe`
- 大小：153,981,038 字节
- SHA-256：`236C1CD2C5D167091CB4DA6145B3417E851CAC4E1F27FF09D5A598AAAEE1CB29`
- 同步生成：`issh-0.0.7-setup-x64.exe.blockmap`、`latest.yml`
- `win-unpacked`、builder debug 文件及本轮临时依赖缓存已清理。

首次正常打包的内置插件预打包和原生模块重建成功，但 Electron 压缩包联网下载在 600 秒后超时。随后使用仓库现有且已验证的 Electron 39.8.10 运行时继续执行相同 electron-builder/NSIS 配置，安装包生成成功；未使用 `TABBY_SKIP_PREPACKAGE=1`。

## 复现命令

```powershell
npm.cmd run audit:security
npm.cmd run lint
npm.cmd run test:tabby-agent
python functional_regression_test.py
python smoke_test.py
```

## 剩余风险

- npm 数据库仍报告中危和低危通告，数量见本文开头；本轮目标的高危和严重通告已全部清零。
- 渲染器仍依赖当前架构的 `nodeIntegration: true` 与 `contextIsolation: false`。现有导航和权限边界已收紧，但彻底移除此架构风险需要单独进行 preload/contextBridge 迁移。
