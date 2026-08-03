# Chromium 风险补偿性加固记录（2026-08-02）

## 范围

当前应用运行时为 Electron `43.2.0`、Chromium `150.0.7871.129`。用户要求将 Chromium 直接替换为 `150.0.7871.219`，但维护自定义 Electron/Chromium 构建的成本过高，因此本轮采用不改 Chromium 二进制的低成本补偿方案。

NVD 匹配结果是版本和 CPE 适用性证据，不等同于确认所有 Chrome CVE 都能在 Electron Windows 应用中利用；Chrome 产品、平台和功能差异需要 Electron/Chromium 供应商复核。

## 已实施控制

1. **内容安全策略（CSP）**
   - `app/index.pug` 的主窗口 CSP 默认只允许同源资源。
   - 禁止对象加载和页面嵌入；脚本来自打包资源。
   - 为现有 Angular JIT、style-loader、Worker、LLM API 和本地 Agent Bridge 保留必要兼容项。
   - 原内联 bootstrap 已移到 `app/src/entry.preload.ts`，避免继续依赖内联脚本。

2. **特权 IPC 发送者校验**
   - `Application.isTrustedRenderer()` 要求发送者属于应用自己的 `WebContents`，且 URL 必须是本地 `dist/index.html`。
   - 配置写入、插件安装/卸载、配置同步、PTY 操作、窗口控制和新窗口创建均拒绝不可信发送者。

3. **打包 Fuse**
   - `enableEmbeddedAsarIntegrityValidation: true`
   - `onlyLoadAppFromAsar: true`
   - 继续禁用 `runAsNode`、`enableNodeOptionsEnvironmentVariable` 和 `enableNodeCliInspectArguments`。

4. **GPU 和远程内容策略**
   - 不强制默认关闭 GPU；需要时使用 **设置 → 窗口 → Hacks → Disable GPU acceleration**。
   - 继续只加载受信任的本地插件，不在特权窗口加载远程页面。
   - Electron alpha/nightly 只适合内部兼容性测试，不作为生产升级方案。

## 残余风险与后续

主渲染器仍使用 `nodeIntegration: true` 和 `contextIsolation: false`。完整的 preload/contextBridge/sandbox 迁移应作为独立架构工作评估，不能由本次小范围修复替代。待官方稳定 Electron 版本包含相关 Chromium 修复后，应升级依赖并重新执行类型检查、Webpack、回归测试、打包和安装验证。

参考：

- [Electron 安全指南](https://www.electronjs.org/docs/latest/tutorial/security)
- [Electron Fuses](https://www.electronjs.org/docs/latest/tutorial/fuses)
- [Electron 稳定版本列表](https://releases.electronjs.org/release/)

## 验证记录

- 应用主进程和渲染器 TypeScript 检查：通过
- 生产 Webpack 构建：通过
- `scripts/build-typings.mjs` + `scripts/build-modules.mjs`：通过
- Lint：通过，仅保留两个既有复杂度警告
- Agent、迁移、环境兼容和 Codex Desktop 测试：通过
- electron-builder 配置解析及 Fuse 读取：通过
- Corepack Yarn 构建和 npm 安全审计：受现有 `lastKnownGood.json` EPERM 阻塞，未修改依赖

本记录描述的是补偿性控制，不是 NVD、Electron 或 Chromium 的安全认证。
