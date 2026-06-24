# Tabby 大模型集成后端技术方案

## 版本信息

- **文档版本**: v1.0
- **更新日期**: 2024-06-23
- **作者**: Charlie (后端工程师)
- **适用范围**: Tabby Terminal v1.x

---

## 目录

1. [系统架构设计](#1-系统架构设计)
2. [API 设计](#2-api-设计)
3. [大模型对接方案](#3-大模型对接方案)
4. [性能优化](#4-性能优化)
5. [安全和隐私](#5-安全和隐私)
6. [错误处理和日志](#6-错误处理和日志)

---

## 1. 系统架构设计

### 1.1 整体架构图

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              Tabby Application                               │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                         Renderer Process                             │   │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────────┐   │   │
│  │  │ Angular 15   │  │ RxJS Service │  │      LLM Service         │   │   │
│  │  │ UI Layer     │◄─┤  Layer       │◄─┤  (LLMService)           │   │   │
│  │  │              │  │              │  │  - getAutocomplete()     │   │   │
│  │  │ Autocomplete │  │  Behavior    │  │  - convertNL2Command() │   │   │
│  │  │ Panel        │  │  Subject     │  │  - streamAutocomplete()│   │   │
│  │  │ NL2Command   │  │              │  │                          │   │   │
│  │  │ Panel        │  │              │  │                          │   │   │
│  │  └──────────────┘  └──────────────┘  └──────────────────────────┘   │   │
│  │                              │                                       │   │
│  │                              ▼                                       │   │
│  │  ┌─────────────────────────────────────────────────────────────────┐   │   │
│  │  │              Electron IPC / Node.js API                         │   │   │
│  │  │  (ipcRenderer.invoke / ipcMain.handle)                        │   │   │
│  │  └─────────────────────────────────────────────────────────────────┘   │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                      │                                       │
│                                      ▼                                       │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                         Main Process                                 │   │
│  │  ┌──────────────────────────────────────────────────────────────┐   │   │
│  │  │                    LLM Backend Service                       │   │   │
│  │  │  ┌────────────┐  ┌────────────┐  ┌──────────────────────┐  │   │   │
│  │  │  │  Provider  │  │  Cache     │  │  Security Filter     │  │   │   │
│  │  │  │  Adapter   │  │  Manager   │  │  - Sensitive check   │  │   │   │
│  │  │  │  Layer     │  │  - LRU     │  │  - Data masking      │  │   │   │
│  │  │  │            │  │  - Memory  │  │  - Command filter    │  │   │   │
│  │  │  └────────────┘  └────────────┘  └──────────────────────┘  │   │   │
│  │  │  ┌────────────┐  ┌────────────┐  ┌──────────────────────┐  │   │   │
│  │  │  │  Request   │  │  Prompt    │  │  Retry & Fallback    │  │   │   │
│  │  │  │  Queue     │  │  Builder   │  │  - Circuit breaker   │  │   │   │
│  │  │  │  - Debounce│  │  - Template│  │  - Local fallback    │  │   │   │
│  │  │  │  - Throttle│  │  - Context │  │  - Offline mode      │  │   │   │
│  │  │  └────────────┘  └────────────┘  └──────────────────────┘  │   │   │
│  │  └──────────────────────────────────────────────────────────────┘   │   │
│  │                              │                                       │   │
│  │                              ▼                                       │   │
│  │  ┌──────────────────────────────────────────────────────────────┐   │   │
│  │  │                    LLM Provider APIs                           │   │   │
│  │  │  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐   │   │   │
│  │  │  │ OpenAI   │  │ Claude   │  │ Local    │  │ Custom   │   │   │   │
│  │  │  │ API      │  │ API      │  │ Ollama   │  │ Provider │   │   │   │
│  │  │  │          │  │          │  │          │  │          │   │   │   │
│  │  │  │ GPT-4    │  │ Claude 3 │  │ llama.cpp│  │          │   │   │   │
│  │  │  │ GPT-3.5  │  │ Claude 3.5│ │ vLLM     │  │          │   │   │   │
│  │  │  │          │  │          │  │          │  │          │   │   │   │
│  │  │  └──────────┘  └──────────┘  └──────────┘  └──────────┘   │   │   │
│  │  └──────────────────────────────────────────────────────────────┘   │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 1.2 与现有 Tabby 架构的集成方式

Tabby 采用 **Electron + Angular** 架构，大模型集成需要同时涉及 **Renderer Process** 和 **Main Process** 两个层面：

#### 1.2.1 Renderer Process 集成

在渲染进程中，我们通过 Angular 的 **Dependency Injection (DI)** 系统注入 LLM Service：

```typescript
// tabby-terminal/src/services/llm.service.ts
import { Injectable } from '@angular/core'
import { ConfigService } from 'tabby-core'

@Injectable({ providedIn: 'root' })
export class LLMService {
    constructor (
        private config: ConfigService,
    ) {}

    // 通过 Electron IPC 调用主进程
    private async callMainProcess<T>(channel: string, ...args: any[]): Promise<T> {
        const { ipcRenderer } = require('electron')
        return ipcRenderer.invoke(channel, ...args)
    }
}
```

#### 1.2.2 Main Process 集成

在主进程中，我们通过 Electron 的 `ipcMain.handle` 注册 LLM 处理程序：

```typescript
// tabby-electron/src/main/llm.handler.ts
import { ipcMain } from 'electron'
import { LLMBackendService } from './services/llmBackend.service'

const llmBackend = new LLMBackendService()

// 注册 IPC 处理程序
export function registerLLMHandlers (): void {
    ipcMain.handle('llm:autocomplete', async (event, request) => {
        return llmBackend.getAutocompleteSuggestions(request)
    })

    ipcMain.handle('llm:nl2command', async (event, request) => {
        return llmBackend.convertNaturalLanguage(request)
    })

    ipcMain.handle('llm:stream-autocomplete', async (event, request) => {
        // 流式响应通过 event.sender.send 返回
        return llmBackend.streamAutocomplete(event, request)
    })
}
```

### 1.3 模块划分和职责定义

| 模块 | 文件路径 | 职责 |
|------|----------|------|
| **LLM Service** | `tabby-terminal/src/services/llm.service.ts` | 渲染进程中的 LLM 服务封装，提供 Angular DI 接口 |
| **LLM Backend Service** | `tabby-electron/src/services/llmBackend.service.ts` | 主进程中的 LLM 后端服务，处理实际请求 |
| **Provider Adapter** | `tabby-electron/src/services/llm/providers/*.ts` | 各 LLM 提供商的适配器实现 |
| **Cache Manager** | `tabby-electron/src/services/llm/cache.service.ts` | 缓存管理，包括 LRU 缓存和结果缓存 |
| **Security Filter** | `tabby-electron/src/services/llm/security.service.ts` | 敏感命令过滤、数据脱敏、隐私保护 |
| **Prompt Builder** | `tabby-electron/src/services/llm/promptBuilder.service.ts` | 提示词构建，支持模板和上下文管理 |
| **Request Queue** | `tabby-electron/src/services/llm/requestQueue.service.ts` | 请求队列管理，防抖、节流、并发控制 |

---

## 2. API 设计

### 2.1 自动补全 API

#### 2.1.1 接口定义

```typescript
// shared/types/llm.types.ts

/**
 * 自动补全请求
 */
export interface AutocompleteRequest {
    /** 当前输入的命令前缀 */
    currentInput: string

    /** 光标位置 */
    cursorPosition: number

    /** 终端上下文信息 */
    terminalContext?: TerminalContext

    /** 会话 ID，用于上下文关联 */
    sessionId?: string

    /** 补全数量限制 */
    maxSuggestions?: number

    /** 温度参数，控制创造性 (0-1) */
    temperature?: number
}

/**
 * 终端上下文
 */
export interface TerminalContext {
    /** 当前工作目录 */
    currentDirectory: string

    /** 最近的命令历史 */
    recentCommands: string[]

    /** 环境变量 */
    environment: Record<string, string>

    /** Shell 类型 (bash/zsh/fish/powershell/cmd) */
    shellType: string

    /** 操作系统类型 */
    platform: 'linux' | 'darwin' | 'win32'
}

/**
 * 自动补全响应
 */
export interface AutocompleteResponse {
    /** 补全建议列表 */
    suggestions: CommandSuggestion[]

    /** 响应时间 (ms) */
    responseTime: number

    /** 是否来自缓存 */
    fromCache: boolean

    /** 请求 ID */
    requestId: string
}

/**
 * 命令建议项
 */
export interface CommandSuggestion {
    /** 建议的命令 */
    command: string

    /** 命令描述 */
    description: string

    /** 建议分类 */
    category: 'command' | 'file' | 'history' | 'ai'

    /** 置信度 (0-1) */
    confidence: number

    /** 参数说明 */
    arguments?: string[]
}
```

#### 2.1.2 实现代码

```typescript
// tabby-electron/src/services/llmBackend.service.ts
import { LLMProvider } from './llm/providers/base.provider'
import { CacheManager } from './llm/cache.service'
import { SecurityFilter } from './llm/security.service'
import { PromptBuilder } from './llm/promptBuilder.service'
import { RequestQueue } from './llm/requestQueue.service'

export class LLMBackendService {
    private provider: LLMProvider
    private cache: CacheManager
    private security: SecurityFilter
    private promptBuilder: PromptBuilder
    private requestQueue: RequestQueue

    constructor () {
        this.provider = this.createProvider()
        this.cache = new CacheManager()
        this.security = new SecurityFilter()
        this.promptBuilder = new PromptBuilder()
        this.requestQueue = new RequestQueue()
    }

    /**
     * 获取自动补全建议
     */
    async getAutocompleteSuggestions (
        request: AutocompleteRequest
    ): Promise<AutocompleteResponse> {
        const startTime = Date.now()
        const requestId = this.generateRequestId()

        try {
            // 1. 检查缓存
            const cacheKey = this.buildCacheKey(request)
            const cached = this.cache.get<AutocompleteResponse>(cacheKey)
            if (cached) {
                return { ...cached, fromCache: true, requestId }
            }

            // 2. 安全检查
            if (this.security.isBlockedInput(request.currentInput)) {
                return this.createEmptyResponse(requestId, startTime)
            }

            // 3. 构建提示词
            const prompt = this.promptBuilder.buildAutocompletePrompt(request)

            // 4. 调用 LLM
            const result = await this.requestQueue.enqueue(() =>
                this.provider.complete(prompt, {
                    temperature: request.temperature ?? 0.3,
                    maxTokens: 200,
                })
            )

            // 5. 解析结果
            const suggestions = this.parseSuggestions(result)

            // 6. 安全过滤
            const filteredSuggestions = this.security.filterSuggestions(suggestions)

            const response: AutocompleteResponse = {
                suggestions: filteredSuggestions,
                responseTime: Date.now() - startTime,
                fromCache: false,
                requestId,
            }

            // 7. 缓存结果
            this.cache.set(cacheKey, response, { ttl: 60000 }) // 60秒缓存

            return response
        } catch (error) {
            this.logger.error('Autocomplete failed:', error)
            return this.createEmptyResponse(requestId, startTime)
        }
    }

    private createEmptyResponse (requestId: string, startTime: number): AutocompleteResponse {
        return {
            suggestions: [],
            responseTime: Date.now() - startTime,
            fromCache: false,
            requestId,
        }
    }

    private generateRequestId (): string {
        return `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
    }

    private buildCacheKey (request: AutocompleteRequest): string {
        return `autocomplete:${request.currentInput}:${request.terminalContext?.shellType ?? 'default'}`
    }

    private parseSuggestions (result: string): CommandSuggestion[] {
        // 解析 LLM 返回的 JSON 格式建议
        try {
            const parsed = JSON.parse(result)
            return parsed.suggestions || []
        } catch {
            // 如果不是 JSON，尝试按行解析
            return result.split('\n')
                .filter(line => line.trim())
                .map(line => ({
                    command: line.trim(),
                    description: '',
                    category: 'ai' as const,
                    confidence: 0.8,
                }))
        }
    }

    private createProvider (): LLMProvider {
        // 根据配置创建对应的 Provider
        const config = this.getConfig()
        switch (config.provider) {
            case 'openai':
                return new OpenAIProvider(config)
            case 'claude':
                return new ClaudeProvider(config)
            case 'ollama':
                return new OllamaProvider(config)
            default:
                throw new Error(`Unknown provider: ${config.provider}`)
        }
    }

    private getConfig (): LLMConfig {
        // 从配置文件读取
        return {
            provider: 'openai',
            apiKey: process.env.OPENAI_API_KEY || '',
            model: 'gpt-4',
            baseURL: 'https://api.openai.com/v1',
        }
    }
}
```

### 2.2 白话描述 API

#### 2.2.1 接口定义

```typescript
// shared/types/llm.types.ts

/**
 * 自然语言转命令请求
 */
export interface NL2CommandRequest {
    /** 自然语言描述 */
    naturalLanguage: string

    /** 当前工作目录 */
    currentDirectory: string

    /** Shell 类型 */
    shellType?: string

    /** 操作系统 */
    platform?: string

    /** 是否需要解释 */
    includeExplanation?: boolean

    /** 备选命令数量 */
    maxAlternatives?: number
}

/**
 * 自然语言转命令响应
 */
export interface NL2CommandResponse {
    /** 生成的命令 */
    command: string

    /** 命令解释 */
    explanation: string

    /** 备选命令 */
    alternatives?: string[]

    /** 置信度 */
    confidence: number

    /** 是否安全 */
    isSafe: boolean

    /** 警告信息 */
    warnings?: string[]

    /** 响应时间 */
    responseTime: number

    /** 请求 ID */
    requestId: string
}
```

#### 2.2.2 实现代码

```typescript
// tabby-electron/src/services/llmBackend.service.ts

export class LLMBackendService {
    /**
     * 自然语言转命令
     */
    async convertNaturalLanguage (
        request: NL2CommandRequest
    ): Promise<NL2CommandResponse> {
        const startTime = Date.now()
        const requestId = this.generateRequestId()

        try {
            // 1. 输入安全检查
            if (this.security.isBlockedInput(request.naturalLanguage)) {
                return this.createUnsafeResponse(requestId, startTime, 'Input contains blocked content')
            }

            // 2. 构建提示词
            const prompt = this.promptBuilder.buildNL2CommandPrompt(request)

            // 3. 调用 LLM
            const result = await this.requestQueue.enqueue(() =>
                this.provider.complete(prompt, {
                    temperature: 0.2, // 较低的创造性，确保命令准确性
                    maxTokens: 500,
                })
            )

            // 4. 解析结果
            const parsed = this.parseNL2CommandResult(result)

            // 5. 安全验证
            const safetyCheck = this.security.validateCommand(parsed.command)

            const response: NL2CommandResponse = {
                command: parsed.command,
                explanation: parsed.explanation,
                alternatives: parsed.alternatives,
                confidence: parsed.confidence,
                isSafe: safetyCheck.isSafe,
                warnings: safetyCheck.warnings,
                responseTime: Date.now() - startTime,
                requestId,
            }

            return response
        } catch (error) {
            this.logger.error('NL2Command failed:', error)
            throw error
        }
    }

    private parseNL2CommandResult (result: string): Partial<NL2CommandResponse> {
        try {
            const parsed = JSON.parse(result)
            return {
                command: parsed.command || '',
                explanation: parsed.explanation || '',
                alternatives: parsed.alternatives || [],
                confidence: parsed.confidence || 0.8,
            }
        } catch {
            // 如果 LLM 返回非 JSON，尝试提取命令
            const lines = result.split('\n').filter(l => l.trim())
            return {
                command: lines[0] || '',
                explanation: lines.slice(1).join('\n') || '',
                alternatives: [],
                confidence: 0.7,
            }
        }
    }

    private createUnsafeResponse (
        requestId: string,
        startTime: number,
        reason: string
    ): NL2CommandResponse {
        return {
            command: '',
            explanation: '',
            confidence: 0,
            isSafe: false,
            warnings: [reason],
            responseTime: Date.now() - startTime,
            requestId,
        }
    }
}
```

### 2.3 流式响应实现方案

对于自动补全场景，流式响应可以显著提升用户体验。我们使用 Electron 的 IPC 流式传输：

```typescript
// tabby-electron/src/services/llmBackend.service.ts
import { IpcMainEvent } from 'electron'

export class LLMBackendService {
    /**
     * 流式自动补全
     */
    async streamAutocomplete (
        event: IpcMainEvent,
        request: AutocompleteRequest
    ): Promise<void> {
        const requestId = this.generateRequestId()
        const sender = event.sender

        try {
            const prompt = this.promptBuilder.buildAutocompletePrompt(request)

            // 使用流式 API
            const stream = this.provider.streamComplete(prompt, {
                temperature: request.temperature ?? 0.3,
                maxTokens: 200,
            })

            let buffer = ''
            for await (const chunk of stream) {
                buffer += chunk

                // 尝试解析完整的建议项
                const lines = buffer.split('\n')
                for (let i = 0; i < lines.length - 1; i++) {
                    const suggestion = this.parseSuggestionLine(lines[i])
                    if (suggestion) {
                        sender.send(`llm:stream-chunk:${requestId}`, {
                            type: 'suggestion',
                            data: suggestion,
                        })
                    }
                }
                buffer = lines[lines.length - 1]
            }

            // 发送完成信号
            sender.send(`llm:stream-end:${requestId}`, { status: 'completed' })
        } catch (error) {
            sender.send(`llm:stream-error:${requestId}`, {
                error: error.message,
            })
        }
    }
}
```

**Renderer Process 接收端：**

```typescript
// tabby-terminal/src/services/llm.service.ts
import { Injectable, NgZone } from '@angular/core'
import { Observable, Subject } from 'rxjs'

@Injectable({ providedIn: 'root' })
export class LLMService {
    private ipcRenderer = require('electron').ipcRenderer

    constructor (private zone: NgZone) {}

    /**
     * 流式获取自动补全建议
     */
    streamAutocomplete (request: AutocompleteRequest): Observable<CommandSuggestion> {
        const subject = new Subject<CommandSuggestion>()
        const requestId = `stream_${Date.now()}`

        // 监听流式数据
        this.ipcRenderer.on(`llm:stream-chunk:${requestId}`, (_event, data) => {
            this.zone.run(() => {
                subject.next(data.data)
            })
        })

        this.ipcRenderer.on(`llm:stream-end:${requestId}`, () => {
            this.zone.run(() => {
                subject.complete()
            })
        })

        this.ipcRenderer.on(`llm:stream-error:${requestId}`, (_event, error) => {
            this.zone.run(() => {
                subject.error(error)
            })
        })

        // 发起请求
        this.ipcRenderer.invoke('llm:stream-autocomplete', {
            ...request,
            requestId,
        })

        return subject.asObservable()
    }
}
```

---

## 3. 大模型对接方案

### 3.1 支持的 LLM 平台

| 平台 | 模型 | 特点 | 适用场景 |
|------|------|------|----------|
| **OpenAI** | GPT-4, GPT-3.5-turbo | 能力强、稳定、速度快 | 云端默认 |
| **Anthropic** | Claude 3.5 Sonnet, Claude 3 Opus | 代码能力强、安全对齐好 | 云端备选 |
| **Ollama** | Llama 3, Mistral, CodeLlama | 本地部署、隐私好 | 本地优先 |
| **vLLM** | 各类开源模型 | 高性能推理、可扩展 | 自托管 |
| **通义千问** | Qwen2.5-Coder | 中文支持好、代码强 | 国内用户 |
| **DeepSeek** | DeepSeek-Coder | 代码能力强、性价比高 | 国内用户 |

### 3.2 API 封装和适配层设计

采用 **Strategy Pattern** 设计适配层：

```typescript
// tabby-electron/src/services/llm/providers/base.provider.ts

/**
 * LLM Provider 抽象基类
 */
export abstract class LLMProvider {
    protected config: LLMConfig

    constructor (config: LLMConfig) {
        this.config = config
    }

    /**
     * 非流式完成
     */
    abstract complete (prompt: string, options: CompletionOptions): Promise<string>

    /**
     * 流式完成
     */
    abstract streamComplete (prompt: string, options: CompletionOptions): AsyncIterable<string>

    /**
     * 获取可用模型列表
     */
    abstract getModels (): Promise<string[]>

    /**
     * 验证配置是否有效
     */
    abstract validateConfig (): Promise<boolean>
}

export interface LLMConfig {
    provider: string
    apiKey: string
    model: string
    baseURL?: string
    timeout?: number
    maxRetries?: number
}

export interface CompletionOptions {
    temperature?: number
    maxTokens?: number
    topP?: number
    stopSequences?: string[]
}
```

#### 3.2.1 OpenAI Provider 实现

```typescript
// tabby-electron/src/services/llm/providers/openai.provider.ts
import { LLMProvider, CompletionOptions } from './base.provider'
import OpenAI from 'openai'

export class OpenAIProvider extends LLMProvider {
    private client: OpenAI

    constructor (config) {
        super(config)
        this.client = new OpenAI({
            apiKey: config.apiKey,
            baseURL: config.baseURL,
            timeout: config.timeout || 30000,
            maxRetries: config.maxRetries || 3,
        })
    }

    async complete (prompt: string, options: CompletionOptions): Promise<string> {
        const response = await this.client.chat.completions.create({
            model: this.config.model,
            messages: [
                { role: 'system', content: this.getSystemPrompt() },
                { role: 'user', content: prompt },
            ],
            temperature: options.temperature ?? 0.3,
            max_tokens: options.maxTokens ?? 200,
            top_p: options.topP ?? 1,
            stop: options.stopSequences,
        })

        return response.choices[0]?.message?.content || ''
    }

    async *streamComplete (prompt: string, options: CompletionOptions): AsyncIterable<string> {
        const stream = await this.client.chat.completions.create({
            model: this.config.model,
            messages: [
                { role: 'system', content: this.getSystemPrompt() },
                { role: 'user', content: prompt },
            ],
            temperature: options.temperature ?? 0.3,
            max_tokens: options.maxTokens ?? 200,
            stream: true,
        })

        for await (const chunk of stream) {
            const content = chunk.choices[0]?.delta?.content
            if (content) {
                yield content
            }
        }
    }

    async getModels (): Promise<string[]> {
        const models = await this.client.models.list()
        return models.data.map(m => m.id)
    }

    async validateConfig (): Promise<boolean> {
        try {
            await this.client.models.list()
            return true
        } catch {
            return false
        }
    }

    private getSystemPrompt (): string {
        return `You are a terminal command assistant. You help users by suggesting shell commands based on their input and context. Always respond in JSON format with a "suggestions" array.`
    }
}
```

#### 3.2.2 Ollama (本地模型) Provider 实现

```typescript
// tabby-electron/src/services/llm/providers/ollama.provider.ts
import { LLMProvider, CompletionOptions } from './base.provider'
import axios from 'axios'

export class OllamaProvider extends LLMProvider {
    private baseURL: string

    constructor (config) {
        super(config)
        this.baseURL = config.baseURL || 'http://localhost:11434'
    }

    async complete (prompt: string, options: CompletionOptions): Promise<string> {
        const response = await axios.post(`${this.baseURL}/api/generate`, {
            model: this.config.model,
            prompt: this.buildPrompt(prompt),
            stream: false,
            options: {
                temperature: options.temperature ?? 0.3,
                num_predict: options.maxTokens ?? 200,
            },
        })

        return response.data.response
    }

    async *streamComplete (prompt: string, options: CompletionOptions): AsyncIterable<string> {
        const response = await axios.post(`${this.baseURL}/api/generate`, {
            model: this.config.model,
            prompt: this.buildPrompt(prompt),
            stream: true,
        }, {
            responseType: 'stream',
        })

        // 处理流式响应
        for await (const chunk of response.data) {
            const lines = chunk.toString().split('\n').filter(l => l.trim())
            for (const line of lines) {
                try {
                    const data = JSON.parse(line)
                    if (data.response) {
                        yield data.response
                    }
                } catch {
                    // 忽略解析错误
                }
            }
        }
    }

    async getModels (): Promise<string[]> {
        const response = await axios.get(`${this.baseURL}/api/tags`)
        return response.data.models.map(m => m.name)
    }

    async validateConfig (): Promise<boolean> {
        try {
            const response = await axios.get(`${this.baseURL}/api/tags`, { timeout: 5000 })
            return response.status === 200
        } catch {
            return false
        }
    }

    private buildPrompt (prompt: string): string {
        return `${this.getSystemPrompt()}\n\nUser: ${prompt}\n\nAssistant:`
    }

    private getSystemPrompt (): string {
        return `You are a terminal command assistant. Respond with shell commands in JSON format.`
    }
}
```

### 3.3 模型选择和切换机制

```typescript
// tabby-electron/src/services/llm/providerManager.service.ts
import { LLMProvider } from './providers/base.provider'
import { OpenAIProvider } from './providers/openai.provider'
import { ClaudeProvider } from './providers/claude.provider'
import { OllamaProvider } from './providers/ollama.provider'

export interface ProviderConfig {
    id: string
    name: string
    type: 'openai' | 'claude' | 'ollama' | 'vllm'
    enabled: boolean
    apiKey?: string
    model: string
    baseURL?: string
    priority: number // 优先级，数字越小优先级越高
}

export class ProviderManager {
    private providers: Map<string, LLMProvider> = new Map()
    private configs: ProviderConfig[] = []

    constructor () {
        this.loadConfigs()
    }

    /**
     * 获取当前活跃的 Provider
     */
    getActiveProvider (): LLMProvider {
        // 按优先级排序，返回第一个可用的 Provider
        const sortedConfigs = [...this.configs]
            .filter(c => c.enabled)
            .sort((a, b) => a.priority - b.priority)

        for (const config of sortedConfigs) {
            const provider = this.getOrCreateProvider(config)
            if (provider) {
                return provider
            }
        }

        throw new Error('No available LLM provider')
    }

    /**
     * 切换 Provider
     */
    switchProvider (providerId: string): void {
        const config = this.configs.find(c => c.id === providerId)
        if (!config) {
            throw new Error(`Provider ${providerId} not found`)
        }

        // 更新优先级，将选中的 Provider 设为最高优先级
        const maxPriority = Math.max(...this.configs.map(c => c.priority))
        config.priority = 0
        config.enabled = true

        // 其他 Provider 优先级后移
        for (const c of this.configs) {
            if (c.id !== providerId) {
                c.priority = c.priority + 1 + maxPriority
            }
        }

        this.saveConfigs()
    }

    private getOrCreateProvider (config: ProviderConfig): LLMProvider {
        if (this.providers.has(config.id)) {
            return this.providers.get(config.id)!
        }

        let provider: LLMProvider
        switch (config.type) {
            case 'openai':
                provider = new OpenAIProvider(config)
                break
            case 'claude':
                provider = new ClaudeProvider(config)
                break
            case 'ollama':
                provider = new OllamaProvider(config)
                break
            default:
                throw new Error(`Unknown provider type: ${config.type}`)
        }

        this.providers.set(config.id, provider)
        return provider
    }

    private loadConfigs (): void {
        // 从配置文件加载
        // 默认配置...
    }

    private saveConfigs (): void {
        // 保存到配置文件
    }
}
```

### 3.4 提示词(Prompt)设计

#### 3.4.1 自动补全 Prompt

```typescript
// tabby-electron/src/services/llm/promptBuilder.service.ts

export class PromptBuilder {
    /**
     * 构建自动补全提示词
     */
    buildAutocompletePrompt (request: AutocompleteRequest): string {
        const { currentInput, terminalContext } = request
        const shellType = terminalContext?.shellType || 'bash'
        const platform = terminalContext?.platform || 'linux'

        return `You are a ${shellType} shell command autocomplete assistant running on ${platform}.

Current directory: ${terminalContext?.currentDirectory || '~'}
Recent commands: ${(terminalContext?.recentCommands || []).slice(-5).join(', ')}

Given the current input, suggest the most likely command completions.
Respond in JSON format:
{
  "suggestions": [
    {
      "command": "full command text",
      "description": "brief description of what this command does",
      "category": "command|file|history|ai",
      "confidence": 0.95
    }
  ]
}

Current input: ${currentInput}

Suggestions:`
    }

    /**
     * 构建自然语言转命令提示词
     */
    buildNL2CommandPrompt (request: NL2CommandRequest): string {
        const { naturalLanguage, currentDirectory, shellType, platform } = request

        return `You are a terminal command expert. Convert natural language descriptions into precise shell commands.

Current directory: ${currentDirectory || '~'}
Shell: ${shellType || 'bash'}
Platform: ${platform || 'linux'}

Rules:
1. Provide only the command, no extra explanation
2. Use proper escaping for special characters
3. Consider the current directory context
4. If the request is ambiguous, provide the most common interpretation

Respond in JSON format:
{
  "command": "the generated command",
  "explanation": "what this command does",
  "alternatives": ["alternative command 1", "alternative command 2"],
  "confidence": 0.95
}

User request: ${naturalLanguage}

Command:`
    }
}
```

---

## 4. 性能优化

### 4.1 请求防抖和节流

```typescript
// tabby-electron/src/services/llm/requestQueue.service.ts
import { Subject, debounceTime, throttleTime } from 'rxjs'

export class RequestQueue {
    private pendingRequests = new Map<string, Promise<any>>()
    private autocompleteSubject = new Subject<() => Promise<any>>()

    constructor () {
        // 自动补全防抖：300ms
        this.autocompleteSubject.pipe(
            debounceTime(300)
        ).subscribe(async (fn) => {
            await fn()
        })
    }

    /**
     * 防抖执行自动补全请求
     */
    debounceAutocomplete<T> (key: string, fn: () => Promise<T>): Promise<T> {
        return new Promise((resolve, reject) => {
            this.autocompleteSubject.next(async () => {
                try {
                    const result = await fn()
                    resolve(result)
                } catch (error) {
                    reject(error)
                }
            })
        })
    }

    /**
     * 节流执行请求
     */
    async throttle<T> (key: string, fn: () => Promise<T>, interval: number): Promise<T> {
        const now = Date.now()
        const lastRequest = this.lastRequestTime.get(key) || 0

        if (now - lastRequest < interval) {
            throw new Error(`Request throttled for key: ${key}`)
        }

        this.lastRequestTime.set(key, now)
        return fn()
    }

    private lastRequestTime = new Map<string, number>()
}
```

### 4.2 缓存策略

```typescript
// tabby-electron/src/services/llm/cache.service.ts
import { LRUCache } from 'lru-cache'

interface CacheEntry<T> {
    data: T
    timestamp: number
    ttl: number
}

export class CacheManager {
    private cache: LRUCache<string, CacheEntry<any>>
    private resultCache: LRUCache<string, CacheEntry<any>>

    constructor () {
        // 请求缓存：最多 1000 条，TTL 60 秒
        this.cache = new LRUCache({
            max: 1000,
            ttl: 1000 * 60,
        })

        // 结果缓存：最多 500 条，TTL 5 分钟
        this.resultCache = new LRUCache({
            max: 500,
            ttl: 1000 * 60 * 5,
        })
    }

    /**
     * 获取缓存
     */
    get<T> (key: string): T | undefined {
        const entry = this.cache.get(key)
        if (!entry) return undefined

        if (Date.now() - entry.timestamp > entry.ttl) {
            this.cache.delete(key)
            return undefined
        }

        return entry.data as T
    }

    /**
     * 设置缓存
     */
    set<T> (key: string, data: T, options: { ttl?: number } = {}): void {
        this.cache.set(key, {
            data,
            timestamp: Date.now(),
            ttl: options.ttl || 60000,
        })
    }

    /**
     * 清空缓存
     */
    clear (): void {
        this.cache.clear()
        this.resultCache.clear()
    }

    /**
     * 获取缓存统计
     */
    getStats (): { size: number; hits: number; misses: number } {
        return {
            size: this.cache.size,
            hits: 0, // LRUCache 不直接提供 hit/miss 统计
            misses: 0,
        }
    }
}
```

### 4.3 异步处理和并发控制

```typescript
// tabby-electron/src/services/llm/requestQueue.service.ts
import pLimit from 'p-limit'

export class RequestQueue {
    // 限制并发请求数
    private limit = pLimit(3) // 最多 3 个并发请求

    /**
     * 带并发控制的请求执行
     */
    async enqueue<T> (fn: () => Promise<T>): Promise<T> {
        return this.limit(() => fn())
    }

    /**
     * 批量处理请求
     */
    async batch<T> (fns: Array<() => Promise<T>>, concurrency: number = 3): Promise<T[]> {
        const limit = pLimit(concurrency)
        return Promise.all(fns.map(fn => limit(() => fn())))
    }
}
```

### 4.4 流式响应优化

```typescript
// tabby-electron/src/services/llm/streamOptimizer.service.ts

export class StreamOptimizer {
    /**
     * 优化流式响应，减少前端渲染压力
     */
    async *optimizeStream<T> (
        stream: AsyncIterable<T>,
        options: {
            chunkSize?: number
            delayMs?: number
        } = {}
    ): AsyncIterable<T> {
        const { chunkSize = 10, delayMs = 16 } = options // 16ms ≈ 60fps
        let buffer: T[] = []
        let lastYield = Date.now()

        for await (const item of stream) {
            buffer.push(item)

            const now = Date.now()
            if (buffer.length >= chunkSize || now - lastYield >= delayMs) {
                yield* buffer
                buffer = []
                lastYield = now
            }
        }

        // 输出剩余数据
        if (buffer.length > 0) {
            yield* buffer
        }
    }
}
```

---

## 5. 安全和隐私

### 5.1 敏感命令过滤

```typescript
// tabby-electron/src/services/llm/security.service.ts

export class SecurityFilter {
    // 危险命令模式
    private dangerousPatterns = [
        /rm\s+-rf\s*\//i,
        /dd\s+if=.*of=\/dev\//i,
        /mkfs\./i,
        /:\(\)\{[^}]*\}[^;]*;\1/i, // fork bomb
        /curl\s+.*\|\s*(ba)?sh/i,
        /wget\s+.*\|\s*(ba)?sh/i,
        /eval\s*\(/i,
        /\bpassword\b/i,
        /\bsecret\b/i,
        /\bapi[_-]?key\b/i,
    ]

    // 敏感文件路径
    private sensitivePaths = [
        '~/.ssh/',
        '~/.gnupg/',
        '~/.aws/',
        '~/.config/',
        '/etc/shadow',
        '/etc/passwd',
        '/etc/hosts',
    ]

    /**
     * 检查输入是否包含被阻止的内容
     */
    isBlockedInput (input: string): boolean {
        return this.dangerousPatterns.some(pattern => pattern.test(input))
    }

    /**
     * 过滤建议列表中的危险命令
     */
    filterSuggestions (suggestions: CommandSuggestion[]): CommandSuggestion[] {
        return suggestions.filter(suggestion => {
            return !this.dangerousPatterns.some(pattern =>
                pattern.test(suggestion.command)
            )
        })
    }

    /**
     * 验证命令安全性
     */
    validateCommand (command: string): { isSafe: boolean; warnings: string[] } {
        const warnings: string[] = []

        // 检查危险模式
        for (const pattern of this.dangerousPatterns) {
            if (pattern.test(command)) {
                warnings.push(`Command matches dangerous pattern: ${pattern.source}`)
            }
        }

        // 检查敏感路径
        for (const path of this.sensitivePaths) {
            if (command.includes(path)) {
                warnings.push(`Command references sensitive path: ${path}`)
            }
        }

        return {
            isSafe: warnings.length === 0,
            warnings,
        }
    }
}
```

### 5.2 用户隐私保护

```typescript
// tabby-electron/src/services/llm/privacy.service.ts

export class PrivacyService {
    // 需要脱敏的模式
    private sensitivePatterns = [
        { pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g, replacement: '[EMAIL]' },
        { pattern: /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, replacement: '[IP]' },
        { pattern: /\b(?:[0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}\b/g, replacement: '[MAC]' },
        { pattern: /password\s*=\s*\S+/gi, replacement: 'password=[REDACTED]' },
        { pattern: /api[_-]?key\s*=\s*\S+/gi, replacement: 'api_key=[REDACTED]' },
        { pattern: /token\s*=\s*\S+/gi, replacement: 'token=[REDACTED]' },
        { pattern: /sk-[a-zA-Z0-9]{48}/g, replacement: '[API_KEY]' },
    ]

    /**
     * 对输入进行脱敏处理
     */
    sanitizeInput (input: string): string {
        let sanitized = input
        for (const { pattern, replacement } of this.sensitivePatterns) {
            sanitized = sanitized.replace(pattern, replacement)
        }
        return sanitized
    }

    /**
     * 检查是否包含敏感信息
     */
    containsSensitiveInfo (input: string): boolean {
        return this.sensitivePatterns.some(({ pattern }) => pattern.test(input))
    }
}
```

### 5.3 API Key 安全管理

```typescript
// tabby-electron/src/services/llm/keyManager.service.ts
import { safeStorage } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import { app } from 'electron'

export class APIKeyManager {
    private configPath: string

    constructor () {
        this.configPath = path.join(app.getPath('userData'), 'llm-keys.json')
    }

    /**
     * 安全存储 API Key
     */
    async storeAPIKey (provider: string, apiKey: string): Promise<void> {
        const encrypted = safeStorage.encryptString(apiKey)
        const keys = await this.loadKeys()
        keys[provider] = encrypted.toString('base64')
        await fs.promises.writeFile(this.configPath, JSON.stringify(keys, null, 2))
    }

    /**
     * 获取 API Key
     */
    async getAPIKey (provider: string): Promise<string | null> {
        try {
            const keys = await this.loadKeys()
            const encrypted = keys[provider]
            if (!encrypted) return null

            const decrypted = safeStorage.decryptString(Buffer.from(encrypted, 'base64'))
            return decrypted
        } catch {
            return null
        }
    }

    /**
     * 删除 API Key
     */
    async removeAPIKey (provider: string): Promise<void> {
        const keys = await this.loadKeys()
        delete keys[provider]
        await fs.promises.writeFile(this.configPath, JSON.stringify(keys, null, 2))
    }

    private async loadKeys (): Promise<Record<string, string>> {
        try {
            const data = await fs.promises.readFile(this.configPath, 'utf-8')
            return JSON.parse(data)
        } catch {
            return {}
        }
    }
}
```

---

## 6. 错误处理和日志

### 6.1 异常分类和处理策略

```typescript
// tabby-electron/src/services/llm/errors.ts

export class LLMError extends Error {
    constructor (
        message: string,
        public code: string,
        public retryable: boolean = false
    ) {
        super(message)
        this.name = 'LLMError'
    }
}

export class NetworkError extends LLMError {
    constructor (message: string) {
        super(message, 'NETWORK_ERROR', true)
        this.name = 'NetworkError'
    }
}

export class RateLimitError extends LLMError {
    constructor (message: string, public retryAfter: number) {
        super(message, 'RATE_LIMIT', true)
        this.name = 'RateLimitError'
    }
}

export class AuthenticationError extends LLMError {
    constructor (message: string) {
        super(message, 'AUTH_ERROR', false)
        this.name = 'AuthenticationError'
    }
}

export class ValidationError extends LLMError {
    constructor (message: string) {
        super(message, 'VALIDATION_ERROR', false)
        this.name = 'ValidationError'
    }
}
```

### 6.2 重试机制

```typescript
// tabby-electron/src/services/llm/retry.service.ts

export interface RetryConfig {
    maxRetries: number
    baseDelay: number
    maxDelay: number
    backoffMultiplier: number
}

export class RetryService {
    private defaultConfig: RetryConfig = {
        maxRetries: 3,
        baseDelay: 1000,
        maxDelay: 30000,
        backoffMultiplier: 2,
    }

    async withRetry<T> (
        fn: () => Promise<T>,
        config: Partial<RetryConfig> = {}
    ): Promise<T> {
        const mergedConfig = { ...this.defaultConfig, ...config }
        let lastError: Error | null = null

        for (let attempt = 0; attempt <= mergedConfig.maxRetries; attempt++) {
            try {
                return await fn()
            } catch (error) {
                lastError = error as Error

                if (!this.isRetryable(error)) {
                    throw error
                }

                if (attempt < mergedConfig.maxRetries) {
                    const delay = this.calculateDelay(attempt, mergedConfig)
                    await this.sleep(delay)
                }
            }
        }

        throw lastError
    }

    private isRetryable (error: any): boolean {
        if (error instanceof LLMError) {
            return error.retryable
        }
        // 网络错误默认可重试
        if (error.code && ['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED'].includes(error.code)) {
            return true
        }
        return false
    }

    private calculateDelay (attempt: number, config: RetryConfig): number {
        const delay = config.baseDelay * Math.pow(config.backoffMultiplier, attempt)
        return Math.min(delay, config.maxDelay)
    }

    private sleep (ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms))
    }
}
```

### 6.3 降级方案

```typescript
// tabby-electron/src/services/llm/fallback.service.ts

export class FallbackService {
    // 本地命令库
    private localCommandDB = new Map<string, string[]>(
        Object.entries({
            'git': ['git status', 'git add', 'git commit', 'git push', 'git pull', 'git branch', 'git checkout'],
            'docker': ['docker ps', 'docker run', 'docker build', 'docker exec', 'docker logs'],
            'npm': ['npm install', 'npm run', 'npm test', 'npm build', 'npm publish'],
            'ls': ['ls -la', 'ls -lh', 'ls -ltr'],
            'cd': ['cd ~', 'cd ..', 'cd -'],
        })
    )

    /**
     * 本地自动补全（离线模式）
     */
    getLocalSuggestions (input: string): CommandSuggestion[] {
        const suggestions: CommandSuggestion[] = []
        const prefix = input.split(' ')[0]

        for (const [cmd, completions] of this.localCommandDB) {
            if (cmd.startsWith(prefix)) {
                for (const completion of completions) {
                    if (completion.startsWith(input)) {
                        suggestions.push({
                            command: completion,
                            description: `Local suggestion for ${cmd}`,
                            category: 'command',
                            confidence: 0.6,
                        })
                    }
                }
            }
        }

        return suggestions
    }

    /**
     * 检查网络可用性
     */
    async isOnline (): Promise<boolean> {
        try {
            const response = await fetch('https://api.openai.com/v1/models', {
                method: 'HEAD',
                signal: AbortSignal.timeout(5000),
            })
            return response.status < 500
        } catch {
            return false
        }
    }

    /**
     * 获取当前运行模式
     */
    async getMode (): Promise<'online' | 'offline' | 'degraded'> {
        const online = await this.isOnline()
        if (online) return 'online'

        // 检查本地模型是否可用
        const localAvailable = await this.checkLocalModel()
        if (localAvailable) return 'degraded'

        return 'offline'
    }

    private async checkLocalModel (): Promise<boolean> {
        try {
            const response = await fetch('http://localhost:11434/api/tags', {
                signal: AbortSignal.timeout(3000),
            })
            return response.ok
        } catch {
            return false
        }
    }
}
```

### 6.4 日志系统

```typescript
// tabby-electron/src/services/llm/log.service.ts
import { LogService } from 'tabby-core'

export class LLMLogService {
    constructor (private logService: LogService) {}

    private get logger () {
        return this.logService.create('LLM')
    }

    logRequest (operation: string, request: any): void {
        this.logger.debug(`[LLM Request] ${operation}:`, {
            timestamp: new Date().toISOString(),
            inputLength: JSON.stringify(request).length,
        })
    }

    logResponse (operation: string, response: any, duration: number): void {
        this.logger.debug(`[LLM Response] ${operation}:`, {
            timestamp: new Date().toISOString(),
            duration: `${duration}ms`,
            responseLength: JSON.stringify(response).length,
        })
    }

    logError (operation: string, error: Error): void {
        this.logger.error(`[LLM Error] ${operation}:`, {
            timestamp: new Date().toISOString(),
            message: error.message,
            stack: error.stack,
        })
    }

    logCacheHit (key: string): void {
        this.logger.debug(`[LLM Cache] Hit: ${key}`)
    }

    logCacheMiss (key: string): void {
        this.logger.debug(`[LLM Cache] Miss: ${key}`)
    }
}
```

---

## 附录

### A. 配置文件示例

```yaml
# ~/.config/tabby/config.yaml
llm:
  # 默认 Provider
  defaultProvider: openai

  # Provider 配置
  providers:
    - id: openai
      name: OpenAI
      type: openai
      enabled: true
      model: gpt-4
      baseURL: https://api.openai.com/v1

    - id: claude
      name: Anthropic Claude
      type: claude
      enabled: true
      model: claude-3-5-sonnet-20241022
      baseURL: https://api.anthropic.com

    - id: ollama
      name: Local Ollama
      type: ollama
      enabled: true
      model: llama3
      baseURL: http://localhost:11434

  # 自动补全配置
  autocomplete:
    enabled: true
    triggerDelay: 300
    minChars: 2
    maxSuggestions: 5
    temperature: 0.3

  # 白话描述配置
  nl2command:
    enabled: true
    temperature: 0.2
    maxTokens: 500

  # 缓存配置
  cache:
    enabled: true
    ttl: 60000
    maxSize: 1000

  # 隐私配置
  privacy:
    sendContextToLLM: true
    filterSensitiveCommands: true
    maskCredentials: true
```

### B. 文件目录结构

```
tabby-electron/src/services/llm/
├── index.ts                          # 模块导出
├── llmBackend.service.ts            # 主服务
├── providers/
│   ├── base.provider.ts              # Provider 基类
│   ├── openai.provider.ts            # OpenAI 适配器
│   ├── claude.provider.ts            # Claude 适配器
│   ├── ollama.provider.ts            # Ollama 适配器
│   └── vllm.provider.ts             # vLLM 适配器
├── cache.service.ts                  # 缓存管理
├── security.service.ts               # 安全过滤
├── privacy.service.ts                # 隐私保护
├── promptBuilder.service.ts          # 提示词构建
├── requestQueue.service.ts           # 请求队列
├── providerManager.service.ts        # Provider 管理
├── keyManager.service.ts            # API Key 管理
├── retry.service.ts                 # 重试机制
├── fallback.service.ts              # 降级方案
├── streamOptimizer.service.ts        # 流式优化
├── errors.ts                        # 错误定义
└── log.service.ts                   # 日志服务

tabby-terminal/src/services/
├── llm.service.ts                   # 渲染进程 LLM 服务
└── llm.types.ts                     # 类型定义
```

### C. 依赖列表

```json
{
  "dependencies": {
    "openai": "^4.0.0",
    "axios": "^1.6.0",
    "lru-cache": "^10.0.0",
    "p-limit": "^4.0.0"
  }
}
```

---

## 总结

本技术方案为 Tabby 终端模拟器的大模型集成提供了完整的后端设计，涵盖：

1. **系统架构**: 基于 Electron IPC 的 Renderer-Main 进程通信架构，模块清晰、职责分明
2. **API 设计**: 完整的自动补全和白话描述 API，支持流式响应
3. **大模型对接**: 支持 OpenAI、Claude、Ollama 等多种 LLM 平台，通过 Strategy Pattern 实现灵活切换
4. **性能优化**: 防抖、节流、缓存、并发控制、流式优化等多重机制
5. **安全隐私**: 敏感命令过滤、数据脱敏、API Key 加密存储
6. **错误处理**: 分类异常处理、指数退避重试、多级降级方案

该方案与前端工程师 Bob 的前端设计方案完全兼容，可直接指导后续开发实现。
