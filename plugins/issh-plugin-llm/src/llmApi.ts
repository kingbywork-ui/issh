export interface LlmConfig {
    baseUrl: string
    apiKey: string
    model: string
    debounceMs: number
    timeoutMs: number
    maxContextLines: number
    sendContext: boolean
}

const DEFAULTS: LlmConfig = {
    baseUrl: 'https://api.openai.com/v1',
    apiKey: '',
    model: 'gpt-4o-mini',
    debounceMs: 600,
    timeoutMs: 3000,
    maxContextLines: 20,
    sendContext: true,
}

const STORAGE_KEY = 'issh-plugin-llm:config'

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
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), config.timeoutMs)
    try {
        const context = config.sendContext ? contextLines.slice(-config.maxContextLines).join('\n') : ''
        const response = await fetch(`${config.baseUrl.replace(/\/$/, '')}/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${config.apiKey}`,
            },
            body: JSON.stringify({
                model: config.model,
                messages: [
                    {
                        role: 'system',
                        content: '你是 shell 命令补全助手。根据用户当前部分输入和终端上下文，返回 1-3 个最可能的完整命令。只返回 JSON 数组：[{"command":"...","confidence":0.9}]，不要其他文字。',
                    },
                    {
                        role: 'user',
                        content: `终端上下文：\n${context}\n\n当前输入：${partial}`,
                    },
                ],
                temperature: 0.1,
                max_tokens: 256,
            }),
            signal: controller.signal,
        })
        if (!response.ok) return []
        const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> }
        const content = data.choices?.[0]?.message?.content ?? ''
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
