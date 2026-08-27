# issh 插件开发者指南

面向第三方开发者编写 issh Tauri 客户端插件。issh 插件 = 一个自包含的 ESM 模块（tgz 包），经商城安装后由 Cordis 宿主加载，可注册设置页、首页卡片、面板、终端装饰器。

## 1. 快速开始

```bash
# 1. 从模板创建（推荐直接复制 plugins/issh-plugin-sandbox-demo）
cp -r plugins/issh-plugin-sandbox-demo plugins/issh-plugin-your-name

# 2. 改 plugin.json（id 必须 issh-plugin- 前缀）
# 3. 写 index.ts（导出 default: IsshPlugin）
# 4. 构建 & 打包
npm install && npm run build && npm run package
```

## 2. plugin.json（manifest）

```jsonc
{
    "id": "issh-plugin-your-name",      // 唯一 id，issh-plugin- 前缀
    "name": "插件显示名",
    "version": "0.1.0",
    "description": "一句话描述",
    "kind": "feature",                  // feature | appearance | integration
    "entry": "index.js",                // vite lib 输出文件名
    "permissions": ["panel:register"],  // 权限声明（见 §4）
    "minAppVersion": "0.2.0",           // 可选：最低客户端版本
    "dependencies": [                   // 可选：依赖其它插件
        "issh-plugin-vault",
        { "id": "issh-plugin-llm", "minVersion": "0.2.0" }
    ],
    "author": "you",
    "homepage": "https://…",
    "repository": "https://…"
}
```

## 3. 插件入口（index.ts）

```ts
import type { IsshPlugin, IsshPluginContext } from './src/types'

const plugin: IsshPlugin = {
    manifest,                            // 与 plugin.json 一致
    activate (ctx: IsshPluginContext) {  // 宿主激活时调用
        ctx.registerSettingsTab({ id: 'my', title: '我的插件', order: 20, component: MyTab })
        ctx.registerSandboxPanel({ id: 'main', title: '面板', placement: 'bottom',
            sandboxUrl, sandboxOrigin, height: 140 })
        ctx.registerTerminalDecorator({ id: 'dec', async decorate (options) { … } })
        ctx.storage.set('lastActive', new Date().toISOString())
        ctx.log('info', 'activated')
    },
}
export default plugin
```

生命周期（Cordis Fiber）：
- **activate**：`ctx.plugin()` 创建 Fiber 时执行（安装/启用/启动加载）
- **dispose**：Fiber 销毁时自动清理注册的 tabs/cards/panels/decorators（宿主按 `pluginId:` 前缀清除）
- **禁用/卸载**：`deactivatePlugin` → dispose → UI 撤下；卸载额外清除 `issh.plugin.<id>.*` storage

## 4. 权限

| 权限 | 授权的 API |
|---|---|
| `settings:tab` | `registerSettingsTab` |
| `home:card` | `registerHomeCard` |
| `panel:register` | `registerPanel` / `registerSandboxPanel` |
| `terminal:decorate` | `registerTerminalDecorator`（读终端 buffer、拦截按键、写入） |
| `profiles:read` / `profiles:write` | 主机配置读写（沙箱 RPC `profiles.list` 等） |

未声明权限调用注册 API 会被宿主拦截并记录警告。安装时商城详情页会向用户展示权限说明。

## 5. 沙箱面板（推荐第三方 UI 方式）

第三方插件 UI 应使用沙箱面板（iframe `sandbox="allow-scripts"`，无 allow-same-origin → 无法访问宿主 DOM/localStorage/Tauri IPC）：

```
插件 activate() → ctx.registerSandboxPanel({ sandboxUrl: convertFileSrc(dir + '/sandbox.html'), … })
宿主 SandboxPanel.svelte 渲染 iframe → registerSandboxOrigin(pluginId, origin)
沙箱内 window.parent.postMessage({ channel:'issh-plugin-rpc', id, method, params })
宿主 sandboxBridge.ts 校验 origin + 权限 → 执行 → postMessage 响应
```

可用 RPC method（白名单，按 manifest.permissions 映射）：
- `storage.get/set/delete/keys`（自动隔离到 `issh.plugin.<id>.*` 前缀；key 禁含 `..`、禁 `issh.` 前缀）
- `manifest.get`
- `terminal.read/write`（需 `terminal:decorate`）
- `profiles.list`（需 `profiles:read`）

超时 5s；未知 method / 越权 → 错误响应。

## 6. Terminal Decorator

```ts
ctx.registerTerminalDecorator({
    id: 'my-decorator',
    async decorate (options) {
        const { terminal, write, dispose } = options
        const keyHandler = terminal.attachCustomKeyEventHandler((event) => {
            if (event.type === 'keydown' && event.ctrlKey && event.key === 'y') {
                write('echo hi\n')   // 写入终端
                return false
            }
            return true
        })
        const dataListener = terminal.onData((data) => { /* 监听输入 */ })
        dispose(() => { keyHandler?.(); dataListener.dispose() })  // 卸载回调
    },
})
```

每个终端 tab 挂载时调用一次 decorate；tab 关闭/插件停用时执行 dispose 回调。

## 7. 构建与打包

- vite lib 模式（ESM，`entry` 与 plugin.json 一致，target es2022，minify false）
- `@tauri-apps/api` 通过 alias 指向 `issh-tauri/node_modules`（不打进包）
- 额外静态资源（如 sandbox.html）用 vite 插件在 `closeBundle` 时 copy 到 dist
- `npm run package` → `tar -czf <id>-<version>.tgz dist/*` + sha256

## 8. 发布

```bash
node scripts/publish-plugin.mjs issh-plugin-your-name
```

自动完成：build → tgz → ed25519 签名（对 `id\nversion\nsha256`）→ subtree split 推独立 GitHub 仓库 → gh release create（tgz + sha256 资产）→ 更新 registry 索引。

要求：gh CLI 已认证；签名私钥 `~/.psacowork/issh-plugin-signing.key`（`node scripts/gen-signing-key.mjs` 生成）；GitHub 仓库已创建。

## 9. 调试

- `npm run tauri -- dev` 启动客户端，设置 → 插件管理可启停/卸载
- 插件 `ctx.log()` 输出到 devtools console（`[plugin <id>]` 前缀）
- 加载失败会在插件列表显示 state=failed + 错误信息
- 沙箱面板内可用浏览器原生 console（iframe 独立 context）
