# issh-plugin-auto-sudo

issh 桌面客户端（Tauri 版）的 sudo 密码自动填充插件。

## 功能

- 检测终端输出中的 sudo 密码提示（支持 20 种语言模式）
- 提示用户名，与本地保存的密码（localStorage，按 sessionId+用户名）匹配
- 检测到已存密码时显示提示，按 Ctrl+Enter 自动填充

## 开发

```bash
npm install
npm run build
npm run package
```
