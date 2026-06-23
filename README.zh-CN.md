[![](docs/readme.png)](https://tabby.sh)

---

基于 [Tabby](https://tabby.sh)（前身 **Terminus**）的定制分支，专注于 Windows 下的 SSH 与终端工作流。

基于 Tabby v1.0.7，针对日常 SSH 管理场景进行了 UI 优化和缺陷修复。

## 下载

预构建的 Windows 产物（构建后位于 `dist/` 目录）：

- `tabby-1.0.7-setup-x64.exe` — NSIS 安装程序
- `tabby-1.0.7-portable-x64.zip` — 便携版压缩包

## 功能特性

### 终端

- VT220 终端，支持多个嵌套拆分窗格
- 标签页可放置在窗口任意一侧
- 可选的可停靠窗口，支持全局热键（"Quake console"）
- 进度检测和进程完成通知
- 带括号的粘贴，多行粘贴提示
- 连体字和自定义 shell 配置
- 完整的 Unicode 支持，包括双角字符
- 支持 PowerShell（及 PS Core）、WSL、Git-Bash、Cygwin、MSYS2、Cmder 和 CMD
- 终端工具栏，提供快捷操作

### SSH 客户端

- 带有连接管理器的 SSH2 客户端
- X11 和端口转发（本地/远程/动态 SOCKS）
- 跳板机 / 堡垒机支持
- 代理转发（包括 Pageant 和 Windows 原生 OpenSSH 代理）
- 登录脚本
- 通过 Zmodem 进行 SFTP 文件传输
- RSA-SHA2 / ECDSA 私钥认证，支持口令
- HTTP / SOCKS 代理支持
- **批量输入** — 同时向多个 SSH 会话发送命令
- **增强 SFTP 面板** — 改进的文件管理界面

### 启动页与主机管理

- 重新设计的启动页，提供快速连接快捷方式
- 增强的主机管理界面，采用卡片式布局
- 改进的配置文件设置页，简化配置流程

## 便携式应用

如果在 Tabby.exe 所在的目录创建一个名为 `data` 的文件夹，Tabby 将可以在 Windows 上作为便携式应用程序运行。

## 从源码构建

### 前置条件

- Node.js 18+
- Yarn 1.x
- Python 3（用于原生模块编译）
- Visual Studio Build Tools（用于原生模块编译）

### 构建步骤

```bash
# 安装依赖
yarn

# 冒烟测试：TypeScript 类型检查
npx tsc -p tabby-core/tsconfig.json --noEmit
npx tsc -p tabby-settings/tsconfig.json --noEmit
npx tsc -p tabby-terminal/tsconfig.json --noEmit
npx tsc -p tabby-ssh/tsconfig.json --noEmit
npx tsc -p tabby-local/tsconfig.json --noEmit
npx tsc -p tabby-electron/tsconfig.json --noEmit
npx tsc -p tabby-linkifier/tsconfig.json --noEmit
npx tsc -p tabby-auto-sudo-password/tsconfig.json --noEmit
npx tsc -p tabby-community-color-schemes/tsconfig.json --noEmit

# 冒烟测试：Webpack 构建
yarn run build

# 构建 Windows 安装包
node scripts/build-windows.mjs
```

如果 `prepackage-plugins.mjs` 因原生模块重建失败，可使用跳过标志：

```bash
set TABBY_SKIP_PREPACKAGE=1&&node scripts/build-windows.mjs
```

## 相对于上游 Tabby 的变更

- **批量输入**：同时向多个 SSH 会话发送命令
- **增强 SFTP 面板**：改进的文件管理界面，更好的视觉反馈
- **终端工具栏**：常用终端操作的快捷工具栏
- **重新设计的启动页**：快速连接快捷方式，改进的布局
- **增强的主机管理器**：卡片式主机管理，简化的配置文件配置流程
- **私钥修复**：解决 RSA-SHA2 私钥认证失败问题

## 致谢

基于 [Eugeny](https://github.com/Eugeny) 开发的 [Tabby](https://github.com/Eugeny/tabby)。感谢所有上游贡献者。

---

本 README 还适用于以下语言：[English](./README.md)
