import { SuggestionCache } from './suggestionCache'

export interface LlmConfig {
    baseUrl: string
    apiKey: string
    model: string
    aiAutocompleteEnabled: boolean
    editorAutocompleteEnabled: boolean
    predictionEnabled: boolean
    historyAutocompleteEnabled: boolean
    scriptAutocompleteEnabled: boolean
    historyAutocompleteLimit: number
    triggerWithoutSpaceEnabled: boolean
    minTriggerLength: number
    executeOnConfirm: boolean
    autocompleteModel: string
    autocompleteDisableThinking: boolean
    debounceMs: number
    timeoutMs: number
    maxContextLines: number
    sendContext: boolean
    lightweightHintEnabled: boolean
}

const DEFAULTS: LlmConfig = {
    baseUrl: 'https://api.openai.com/v1',
    apiKey: '',
    model: 'gpt-4o-mini',
    aiAutocompleteEnabled: true,
    editorAutocompleteEnabled: false,
    predictionEnabled: true,
    historyAutocompleteEnabled: true,
    scriptAutocompleteEnabled: false,
    historyAutocompleteLimit: 10,
    triggerWithoutSpaceEnabled: true,
    minTriggerLength: 2,
    executeOnConfirm: false,
    autocompleteModel: '',
    autocompleteDisableThinking: true,
    debounceMs: 600,
    timeoutMs: 3000,
    maxContextLines: 20,
    sendContext: true,
    lightweightHintEnabled: false,
}

const STORAGE_KEY = 'issh-plugin-llm:config'

// 敏感信息脱敏：发送终端上下文到 LLM API 前必须经过
const REDACT_PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
    { pattern: /((?:password|passwd|pwd|token|secret|api[_-]?key|access[_-]?key|private[_-]?key)\s*[=:]\s*)\S+/gi, replacement: '$1***' },
    { pattern: /Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, replacement: 'Bearer ***' },
    { pattern: /sk-[A-Za-z0-9]{16,}/g, replacement: 'sk-***' },
    { pattern: /-----BEGIN[A-Z ]*PRIVATE KEY-----[\s\S]*?-----END[A-Z ]*PRIVATE KEY-----/g, replacement: '***PRIVATE KEY***' },
    { pattern: /(?:\d{1,3}\.){3}\d{1,3}/g, replacement: '[ip]' },
]

export function redactLines (lines: string[]): string[] {
    return lines.map((line) => {
        let result = line
        for (const { pattern, replacement } of REDACT_PATTERNS) {
            result = result.replace(pattern, replacement)
        }
        return result
    })
}

const suggestionCache = new SuggestionCache<AutocompleteSuggestion[]>()

export function loadConfig (): LlmConfig {
    try {
        const raw = localStorage.getItem(STORAGE_KEY)
        if (!raw) return { ...DEFAULTS }
        return { ...DEFAULTS, ...(JSON.parse(raw) as Partial<LlmConfig>) }
    } catch {
        return { ...DEFAULTS }
    }
}

export function saveConfig (config: LlmConfig): void {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(config))
}

export interface AutocompleteSuggestion {
    command: string
    confidence: number
}

export async function fetchAutocomplete (config: LlmConfig, partial: string, contextLines: string[]): Promise<AutocompleteSuggestion[]> {
    if (!config.apiKey || !config.baseUrl || !config.model) return []
    return withCache('autocomplete', partial, contextLines, config, () => requestSuggestions(config, {
        system: '你是 shell 命令补全助手。根据用户当前部分输入和终端上下文，返回 1-3 个最可能的完整命令。只返回 JSON 数组：[{"command":"...","confidence":0.9}]，不要其他文字。',
        user: (context) => `终端上下文：\n${context}\n\n当前输入：${partial}`,
        contextLines,
    }))
}

// 下一条命令预测：基于刚提交的命令与终端上下文，预取下一步可能命令
export async function fetchPrediction (config: LlmConfig, submitted: string, contextLines: string[]): Promise<AutocompleteSuggestion[]> {
    if (!config.apiKey || !config.baseUrl || !config.model) return []
    return withCache('prediction', submitted, contextLines, config, () => requestSuggestions(config, {
        system: '你是 shell 命令预测助手。用户刚执行了一条命令，根据该命令和终端上下文，预测用户接下来最可能执行的 1-3 条新命令。不要返回刚执行命令的变体或重复。只返回 JSON 数组：[{"command":"...","confidence":0.9}]，不要其他文字。',
        user: (context) => `终端上下文：\n${context}\n\n刚执行的命令：${submitted}\n\n预测接下来可能执行的命令。`,
        contextLines,
    }))
}

// 编辑器文本补全（vim/nano 等 alternate screen）：补全当前行文本而非 shell 命令
export async function fetchEditorAutocomplete (config: LlmConfig, partial: string, contextLines: string[]): Promise<AutocompleteSuggestion[]> {
    if (!config.apiKey || !config.baseUrl || !config.model) return []
    return withCache('editor', partial, contextLines, config, () => requestSuggestions(config, {
        system: '你是文本编辑补全助手。用户正在终端编辑器（vim/nano）中编辑文件，根据编辑器上下文补全当前行文本。返回补全后的完整行文本。只返回 JSON 数组：[{"command":"补全后的整行文本","confidence":0.9}]，不要其他文字。',
        user: (context) => `编辑器上下文：\n${context}\n\n当前行：${partial}\n\n补全当前行。`,
        contextLines,
    }))
}

/** LRU 缓存包装：命中直接返回，未命中请求后写入（key=kind+model+输入+上下文） */
async function withCache (
    kind: string,
    input: string,
    contextLines: string[],
    config: LlmConfig,
    request: () => Promise<AutocompleteSuggestion[]>,
): Promise<AutocompleteSuggestion[]> {
    const model = config.autocompleteModel || config.model
    const key = suggestionCache.makeKey({
        kind,
        model,
        input,
        context: contextLines.join('\n'),
    })
    const cached = suggestionCache.get(key)
    if (cached) {
        return cached
    }
    const result = await request()
    if (result.length > 0) {
        suggestionCache.set(key, result)
    }
    return result
}

// 剥离推理模型 <think> 块（deepseek-r1 等），避免污染 JSON 提取
function stripThinkBlock (content: string): string {
    return content.replace(/<think>[\s\S]*?<\/think>/gi, '').trim()
}

async function requestSuggestions (
    config: LlmConfig,
    options: { system: string; user: (context: string) => string; contextLines: string[] },
): Promise<AutocompleteSuggestion[]> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), config.timeoutMs)
    try {
        const context = config.sendContext ? redactLines(options.contextLines).slice(-config.maxContextLines).join('\n') : ''
        const model = config.autocompleteModel || config.model
        const body: Record<string, unknown> = {
            model,
            messages: [
                {
                    role: 'system',
                    content: options.system,
                },
                {
                    role: 'user',
                    content: options.user(context),
                },
            ],
            temperature: 0.1,
            max_tokens: 256,
        }
        if (config.autocompleteDisableThinking) {
            body.thinking = { type: 'disabled' }
            body.enable_thinking = false
            body.reasoning_effort = 'low'
        }
        const response = await fetch(`${config.baseUrl.replace(/\/$/, '')}/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${config.apiKey}`,
            },
            body: JSON.stringify(body),
            signal: controller.signal,
        })
        if (!response.ok) return []
        const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> }
        const content = stripThinkBlock(data.choices?.[0]?.message?.content ?? '')
        const match = content.match(/\[[\s\S]*\]/)
        if (!match) return []
        const parsed = JSON.parse(match[0]) as AutocompleteSuggestion[]
        return Array.isArray(parsed)
            ? parsed.filter((item) => typeof item.command === 'string' && item.command.length > 0).slice(0, 3)
            : []
    } catch {
        return []
    } finally {
        clearTimeout(timer)
    }
}
