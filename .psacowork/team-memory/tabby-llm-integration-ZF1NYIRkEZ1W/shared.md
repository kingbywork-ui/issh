# Shared Notes: tabby-llm-integration

## Goal
在tabby中对接大模型，实现自动补全命令和白话描述命令功能

## Team Context
- Session ID: `ZF1NYIRkEZ1Wrusb80vSs`
- Working Folder: `D:\vibecoding\ssh\new-ssh`
- Created At: `2026-06-23T09:05:24.590Z`

## Current Plan
- Alice 产品经理：制定大模型集成产品方案 → in_progress (迭代187次)
- Bob 前端工程师：设计前端交互方案 → **completed** ✅
- Charlie 后端工程师：设计后端大模型对接方案 → in_progress (迭代121次)

## Stable Findings

### Bob 前端工程师已完成方案 (frontend_design.md)

#### 技术栈分析
- **框架**: Angular 15 + TypeScript 4.9
- **UI 组件库**: ng-bootstrap 14 (基于 Bootstrap 5)
- **终端引擎**: xterm.js (v5.x)
- **状态管理**: RxJS (BehaviorSubject, Subject) + Angular DI
- **构建工具**: Webpack 5 + ts-loader

#### UI/UX 设计方案
1. **自动补全UI** (`AutocompletePanelComponent`)
   - 浮动面板设计，跟随终端光标位置
   - 支持分类展示（command/file/history/ai）
   - 键盘快捷键：↑↓选择, Tab/Enter确认, Esc关闭
   - 置信度可视化

2. **白话描述UI** (`NL2CommandPanelComponent`)
   - 底部弹出面板，不遮挡终端输出
   - 自然语言输入 + 命令转换展示
   - 结果确认机制

3. **AI 智能输入栏** (`AIInputBarComponent`)
   - 模式切换：普通/智能补全/自然语言

#### 服务层设计
- `LLMService`: 封装大模型API交互
  - `getAutocompleteSuggestions()`: 获取命令自动补全建议
  - `convertNaturalLanguage()`: 自然语言转命令
  - `streamAutocomplete()`: 流式获取自动补全

#### 热键配置
- `ai-autocomplete`: 切换AI自动补全
- `ai-nl2command`: 打开自然语言命令转换
- `ai-accept-suggestion`: 接受AI建议
- `ai-next-suggestion`/`ai-previous-suggestion`: 切换建议

#### 技术难点及解决方案
1. **xterm.js 集成**: 光标追踪用onData+正则匹配, 输入拦截用attachCustomKeyEventHandler, 浮层定位用字符尺寸计算
2. **Angular 集成**: 变更检测性能用NgZone.runOutsideAngular, 组件通信用RxJS Subject
3. **大模型API**: 延迟用流式响应+防抖, 上下文用会话状态管理, 安全性用本地过滤

#### 开发顺序建议
1. Phase 1: 基础架构 (LLM Service层)
2. Phase 2: 自动补全 (AutocompletePanel组件)
3. Phase 3: 白话描述 (NL2CommandPanel组件)
4. Phase 4: 优化完善 (性能/错误处理/配置持久化)

## Open Questions
- Alice 产品经理的产品方案尚未完成
- Charlie 后端工程师的后端对接方案尚未完成
- 需要确认大模型API提供商（OpenAI/ Claude/ 通义千问等）
- 需要确认API Key管理和安全配置方案

## Handoff Notes
- Bob的前端方案已输出到 reports/frontend_design.md，可直接指导后续开发
- 方案完全基于tabby现有Angular技术栈，无需引入额外依赖
- 组件化设计便于后续扩展和维护
