# issh-plugin-serial

issh 桌面客户端（Tauri 版）的串口终端插件。

## 功能

- Web Serial API 串口连接（选择端口 + 波特率 9600~921600）
- 底部面板收发数据（TextDecoderStream 流式读取）
- 发送输入框（Enter 发送，自动追加 CRLF）

依赖 WebView 的 Web Serial API 支持（Chromium 89+，Tauri WebView2 满足）。

## 开发

```bash
npm install
npm run build
npm run package
```
