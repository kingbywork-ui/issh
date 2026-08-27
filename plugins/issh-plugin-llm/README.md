# issh-plugin-llm

issh 桌面客户端（Tauri 版）的 AI 命令补全插件。

## 功能

- 设置页配置 LLM API（baseUrl / apiKey / model / 防抖 / 超时 / 上下文行数）
- 终端输入防抖触发补全请求（OpenAI 兼容 chat/completions）
- 浮动候选提示：Ctrl+Y 接受、Ctrl+N/U 切换候选

## 开发

```bash
npm install
npm run build
npm run package
```
