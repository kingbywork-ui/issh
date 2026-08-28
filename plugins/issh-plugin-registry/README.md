# issh-plugin-registry

issh 桌面客户端（Tauri 版）的官方插件索引仓库。客户端「设置 → 插件商城」从此仓库拉取 `index.json` 浏览与安装插件。

## 索引格式

`index.json`（schema 1）：

```json
{
    "schema": 1,
    "updated": "2026-08-27T00:00:00Z",
    "plugins": [
        {
            "id": "issh-plugin-llm",
            "name": "AI 命令补全",
            "version": "0.2.0",
            "description": "…",
            "kind": "feature",
            "permissions": ["terminal:decorate", "settings:tab"],
            "minAppVersion": "0.1.6",
            "downloadUrl": "https://github.com/kingbywork-ui/issh-plugin-llm/releases/download/v0.2.0/issh-plugin-llm-0.2.0.tgz",
            "sha256": "…",
            "signature": "…",
            "homepage": "…",
            "repository": "…"
        }
    ]
}
```

### 字段说明

| 字段 | 说明 |
|---|---|
| `id` | 插件唯一标识（`issh-plugin-` 前缀） |
| `name` / `version` / `description` | 展示信息 |
| `kind` | 分类：`feature`（功能）/ `appearance`（外观）/ `integration`（集成） |
| `permissions` | 权限声明：`settings:tab` / `home:card` / `panel:register` / `terminal:decorate` / `profiles:read` / `profiles:write` |
| `minAppVersion` | 最低客户端版本门槛 |
| `downloadUrl` | GitHub Release tgz 资产 |
| `sha256` | tgz 包哈希，安装时 Rust 端强制校验 |
| `signature` | ed25519 签名（base64），对 `id\nversion\nsha256` UTF-8 字节签名；客户端内置公钥验签 |

## 签名机制

- 客户端 Rust 端内置 ed25519 公钥（`plugin_market.rs` 的 `SIGNING_PUBLIC_KEY`）
- 拉取索引与安装下载时双重强制验签：签名不匹配 → 拒绝加载/安装
- 私钥由维护者本地保管（`~/.psacowork/issh-plugin-signing.key`，勿提交）

## 发布流程

monorepo 中开发（`plugins/<name>/`），用发布脚本一键完成 build → 打包 tgz + sha256 → ed25519 签名 → subtree split 推送独立仓库 → 创建 GitHub Release → 更新本仓库 `index.json`：

```bash
node scripts/publish-plugin.mjs <pluginDirName>
```

要求：gh CLI 已认证、签名私钥已生成（`node scripts/gen-signing-key.mjs`）。

## 当前收录插件

| 插件 | 版本 | 分类 | 说明 |
|---|---|---|---|
| issh-plugin-agent-bridge | 0.1.1 | feature | Workspace/Agent 管理 |
| issh-plugin-herdr | 0.1.1 | feature | Herdr 工作区管理 |
| issh-plugin-linkifier | 0.1.1 | feature | 终端链接识别 |
| issh-plugin-llm | 0.2.0 | feature | AI 命令补全 |
| issh-plugin-config-sync | 0.1.0 | integration | 主机配置同步 |
| issh-plugin-serial | 0.1.0 | integration | 串口终端 |
| issh-plugin-sandbox-demo | 0.4.0 | feature | 沙箱面板演示 |

> 已内置进程序、不再作为插件分发：sudo 密码自动填充、保险库（vault）。客户端会拒绝安装同名插件。
