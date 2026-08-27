# issh 插件体系设计：设置页 + Cordis 插件宿主 + GitHub 插件商城

> 状态：Phase 1 实施中（2026-08-27）
> 范围声明：dev 分支现有功能（终端、HostManager、SFTP、批量输入、ProfileSelector、WelcomeHome）属于应用核心，**不做插件化**。仅将 issh 分支已有、dev 分支未实现的功能分化为可随时安装/卸载的插件。

## 1. 功能对比与插件清单

对比基线：issh 分支（4038329，Electron + Angular 全功能版）vs dev 分支（beabaca，Tauri 2 + Svelte 5 核心）。

| issh 分支功能 | 实现位置 | dev 分支状态 | 处置 |
|---|---|---|---|
| 主机 Profiles 管理 | issh-settings profilesSettingsTab | HostManager + host_profiles.rs 已有 | 核心，不插件化 |
| 终端 / SFTP / 批量输入 | issh-terminal / issh-ssh | issh-tauri 已有 | 核心，不插件化 |
| Vault 保险库 | issh-core vault.service + vaultSettingsTab | Rust vault crate 已有，无管理 UI | **插件 issh-plugin-vault（Phase 1 试点）** |
| Agent Bridge（CLI/MCP） | issh-llm agentBridge.service + 设置页 | issh-agent CLI 保留，无宿主 UI | 插件 issh-plugin-agent-bridge（Phase 2） |
| Herdr / Workspace | issh-llm herdrAdapter/herdrPane + workspaceSettingsTab | adapter 代码保留，无宿主 UI | 插件 issh-plugin-herdr（Phase 2） |
| LLM 命令补全 | issh-llm tabLLMController 等 | 无宿主（Angular 版无 Tauri 宿主） | 插件 issh-plugin-llm（Phase 3，需按新 terminal decorator API 重写） |
| 快捷键设置 | issh-settings hotkeySettingsTab | 无 | 插件 issh-plugin-hotkeys（Phase 3） |
| 配置同步 | issh-settings configSyncSettingsTab | 无 | 插件 issh-plugin-config-sync（Phase 3） |
| Serial 串口 | issh-serial 插件 | 无 | 插件 issh-plugin-serial（Phase 3） |
| UAC 提权 | issh-uac 插件 | 无 | 插件 issh-plugin-uac（Phase 3） |
| 链接识别 | issh-linkifier 插件 | 无 | 插件 issh-plugin-linkifier（Phase 3） |
| sudo 密码自动填充 | issh-auto-sudo-password | 无 | 插件 issh-plugin-auto-sudo（Phase 3） |
| 社区配色 | issh-community-color-schemes | 无（Tauri 端仅内置 4 套） | 插件 issh-plugin-color-schemes（Phase 3） |
| About / 更新检查 | issh-llm aboutSettingsTab | 无 | 插件 issh-plugin-about（Phase 3） |

## 2. 插件协议

### 2.1 Manifest（`plugin.json`）

```jsonc
{
  "id": "issh-plugin-vault",          // 唯一 id，建议 issh-plugin-<name>
  "name": "保险库",
  "version": "0.1.0",                  // semver
  "description": "SSH 凭据保险库：passphrase 管理、机密存取、主机配置锁定",
  "kind": "integration",               // feature | appearance | integration
  "minAppVersion": "0.1.5",
  "entry": "index.js",                 // ESM 入口（构建产物）
  "permissions": ["vault:read", "vault:write", "settings:tab"],
  "author": "kingbywork-ui",
  "homepage": "https://github.com/kingbywork-ui/issh-plugin-vault",
  "repository": "https://github.com/kingbywork-ui/issh-plugin-vault"
}
```

### 2.2 插件接口（issh-tauri/src/lib/plugins/types.ts）

```ts
export interface IsshPluginManifest {
    id: string
    name: string
    version: string
    description: string
    kind: 'feature' | 'appearance' | 'integration'
    minAppVersion?: string
    entry: string
    permissions?: string[]
    author?: string
    homepage?: string
    repository?: string
}

export interface IsshPlugin {
    manifest: IsshPluginManifest
    activate (ctx: IsshPluginContext): void | Promise<void>
}

export interface IsshPluginContext {
    // Cordis Context 能力：ctx.on('event', fn)、ctx.setTimeout、ctx.interval 等，
    // effect 自动随 Fiber dispose 清理
    registerSettingsTab (tab: SettingsTabDefinition): void
    registerHomeCard (card: HomeCardDefinition): void
    registerPanel (panel: PanelDefinition): void
    registerTerminalDecorator (decorator: TerminalDecoratorDefinition): void
    storage: PluginStorage        // 隔离 KV：localStorage key 前缀 issh.plugin.<id>.
    log: (level: 'info' | 'warn' | 'error', message: string) => void
}
```

### 2.3 Cordis 生命周期映射

| 操作 | Cordis 机制 | 效果 |
|---|---|---|
| 安装（install） | 下载解压到插件目录 + 注册 manifest + `ctx.plugin(activate)` | Fiber 创建，activate 执行 |
| 启用（enable） | `ctx.plugin(activate)` | 同上 |
| 禁用（disable） | `fiber.dispose()` | 插件内所有 effect（事件、定时器、UI 注册）自动清理 |
| 卸载（uninstall） | `fiber.dispose()` + 删除插件目录 + 移除注册 | 完全移除 |

PluginHost 是 Cordis 的唯一调用边界（RC 版本 API 变化时只改 pluginHost.ts）。

### 2.4 UI 组件策略

- **内置/随包插件**：静态 import 的 Svelte 组件，生命周期仍走 Cordis Fiber。
- **商城外部插件**：entry 为纯 ESM JS，UI 约定 custom elements（Web Components），规避 Svelte 运行时编译依赖。

## 3. 仓库模型：monorepo 目录 + 独立 GitHub 仓库

- 开发在 monorepo：`plugins/<name>/`（如 `plugins/issh-plugin-vault/`）
- 发布为独立 GitHub 仓库：`kingbywork-ui/<name>`，通过 `git subtree split --prefix=plugins/<name>` 同步历史后 push
- 每插件仓库用 tag（如 `v0.1.0`）触发 GitHub Release，资产为 `issh-plugin-<name>-<version>.tgz` + `.sha256`
- 索引仓库：`kingbywork-ui/issh-plugin-registry`，根目录 `index.json`

### 3.1 商城索引格式（index.json）

```jsonc
{
  "schema": 1,
  "updated": "2026-08-27T00:00:00Z",
  "plugins": [
    {
      "id": "issh-plugin-vault",
      "name": "保险库",
      "version": "0.1.0",
      "description": "...",
      "kind": "integration",
      "permissions": ["vault:read", "vault:write", "settings:tab"],
      "minAppVersion": "0.1.5",
      "downloadUrl": "https://github.com/kingbywork-ui/issh-plugin-vault/releases/download/v0.1.0/issh-plugin-vault-0.1.0.tgz",
      "sha256": "<hex>",
      "homepage": "...",
      "repository": "..."
    }
  ]
}
```

### 3.2 安装流程

1. 前端调 Rust `plugin_fetch_registry(url)` 拉取 index.json（reqwest，走系统代理）
2. 商城 UI 展示插件卡片（名称/版本/描述/权限）
3. 用户点安装 → 权限确认弹窗（逐条列出 permissions）
4. Rust `plugin_download(id, version, url, sha256)`：下载 tgz → SHA256 校验 → 解压到 `<appData>/plugins/<id>/`（校验 manifest.id 与目录一致，拒绝路径穿越条目）
5. 前端 dynamic import `<appData>/plugins/<id>/index.js` → PluginHost 激活
6. 更新 = 重复安装流程（先 dispose 旧 Fiber）

### 3.3 安全边界

- CSP：`default-src 'self'` 不变；新增 Tauri `assetProtocol`，scope 限定 `<appData>/plugins/**`
- 外部插件代码运行在 webview 主世界，但 UI 只能通过注册 API 挂载（Web Components），无 Node/Rust 直通权限
- `permissions` 仅作安装时声明与确认，Phase 1 不做运行时细粒度拦截（写入文档为后续项）
- 危险面控制：Rust 端解压限制单文件 ≤ 8 MiB、总解压体积 ≤ 64 MiB、条目数 ≤ 512、拒绝符号链接条目
- 插件存储隔离：`localStorage` key 强制前缀 `issh.plugin.<id>.`，registry 层校验

## 4. 设置页设计（Settings.svelte）

- 入口：App.svelte 顶部栏新增 ⚙ 按钮，打开全屏设置层（覆盖在 tab 内容之上，不中断会话）
- 布局：左侧分组导航 + 右侧内容区，复用 app.css 变量（--bg、--fg、--border 等），支持浅/深色
- 分组：
  - **通用**：语言（中文/英文）、颜色方案（内置 4 套）、Welcome 页开关 —— 迁移现有 localStorage 键（`issh.language` 等 5 个），保持兼容读取
  - **插件**：已安装列表（名称/版本/描述/来源），启停开关（PluginHost enable/disable），卸载按钮（dispose + 删除目录），禁用有活动面板时确认
  - **商城**：拉取 GitHub 索引，搜索/分类浏览，安装/更新按钮，权限确认弹窗
  - **关于**：版本、runtime 健康信息（只读）
- 插件注册的设置 tab 动态追加到导航（registry 驱动渲染）

## 5. Phase 1 实施清单（本次）

1. `git push` 同步 issh 分支（已完成，github 远程）
2. 本设计文档
3. `issh-tauri/src/lib/plugins/`：types.ts / pluginHost.ts / registry.ts（Cordis 4.0.0-rc.8）
4. `Settings.svelte` + App.svelte 入口接线
5. Rust commands：plugin_fetch_registry / plugin_download / plugin_list_installed / plugin_delete
6. 试点插件 `plugins/issh-plugin-vault/`：保险库管理 UI（启用开关、passphrase 设置、锁定/解锁、机密 CRUD）+ 设置 tab；同时作为商城分发格式样板
7. 验证：svelte-check、vite build、cargo fmt/clippy/test、手动冒烟
8. 更新 HANDOFF.md

## 6. 路线图

- **Phase 1（本次）**：插件框架 + 设置页 + 商城安装链路 + vault 试点插件
- **Phase 2**：agent-bridge、herdr 插件迁移；issh-plugin-registry 索引仓库上线；插件独立 GitHub 仓库发布流水线（tag → Release）；版本号 bump 0.2.0
- **Phase 3**：llm（terminal decorator API 定型后）、hotkeys、config-sync、serial、uac、linkifier、auto-sudo、color-schemes、about
- **后续**：运行时权限拦截、插件签名、离线镜像源、第三方开发者文档
