# issh-plugin-agent-bridge

issh 桌面客户端（Tauri 版）的 Agent 桥接插件。

## 功能

- 工作区管理（创建/列表，对接 isshd `workspace.create` / `workspace.list`）
- 终端会话绑定/解绑（`workspace.bind` / `workspace.unbind`）
- Agent 注册与授权（`agent.register` / `agent.list` / `agent.authorize`）

## 结构

```
plugin.json
index.ts
src/BridgeSettingsTab.svelte
src/bridgeRpc.ts
src/bridge.css
```

## 开发

```bash
npm install
npm run build      # dist/index.js
npm run package    # issh-plugin-agent-bridge-<version>.tgz + sha256
```
