# issh-plugin-config-sync

issh 桌面客户端（Tauri 版）的配置同步插件。

## 功能

- 主机配置导出 JSON 文件（含 profiles + groups）
- 粘贴 JSON 导入（按 id 去重：存在则更新，不存在则新建）
- GitHub Gist 云同步（推送/拉取，token 本地存储）

## 开发

```bash
npm install
npm run build
npm run package
```
