# issh-plugin-registry

issh 终端插件商城索引仓库。

商城客户端从本仓库 `index.json` 拉取插件列表（raw URL）：
`https://raw.githubusercontent.com/kingbywork-ui/issh-plugin-registry/main/index.json`

## 索引格式

```jsonc
{
  "schema": 1,
  "updated": "ISO8601",
  "plugins": [
    {
      "id": "issh-plugin-xxx",        // 插件 id（与 plugin.json 一致）
      "name": "名称",
      "version": "0.1.0",
      "description": "描述",
      "kind": "feature",              // feature | appearance | integration
      "permissions": ["..."],
      "minAppVersion": "0.1.5",
      "downloadUrl": "GitHub Release tgz 直链",
      "sha256": "tgz 的 sha256",
      "homepage": "...",
      "repository": "..."
    }
  ]
}
```

## 发布新插件

1. 插件源码在 monorepo `plugins/<name>/`，`git subtree split --prefix=plugins/<name>` 推送到独立仓库
2. 独立仓库打 tag 并发 Release，上传 `<name>-<version>.tgz` + `.sha256`
3. 在本仓库 `index.json` 追加/更新条目（downloadUrl 指向 Release 资产，sha256 与资产一致）
