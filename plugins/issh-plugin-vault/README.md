# issh-plugin-vault

issh 桌面客户端（Tauri 版）的保险库插件。

## 功能

- 启用/禁用保险库（passphrase 加密存储，由 isshd Rust runtime `vault` crate 提供）
- 解锁/锁定
- 机密 CRUD（查看/新增/删除）

## 结构

```
plugin.json            # 插件 manifest（商城分发元数据）
index.ts               # 插件入口：registerSettingsTab
src/types.ts           # 插件协议类型（独立仓库自带，避免依赖 monorepo）
src/VaultSettingsTab.svelte
src/vault.css
```

## 作为内置插件接入 issh-tauri

`issh-tauri/src/lib/plugins/builtin.ts` 中静态导入并注册：

```ts
import vaultPlugin from '../../../plugins/issh-plugin-vault/index'
registerPlugin(vaultPlugin, 'builtin')
```

## 商城分发

1. `git subtree split --prefix=plugins/issh-plugin-vault -b vault-split`
2. push 到 `kingbywork-ui/issh-plugin-vault`
3. 打 tag `v0.1.0`，Release 附 `issh-plugin-vault-0.1.0.tgz`（package/ 目录打包）+ `.sha256`
4. 在 `kingbywork-ui/issh-plugin-registry` 的 index.json 登记条目
