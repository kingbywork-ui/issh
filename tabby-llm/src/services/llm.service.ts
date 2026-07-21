import axios, { AxiosError } from 'axios'
import { Injectable } from '@angular/core'
import { ConfigService, LogService, Logger } from 'tabby-core'
import {
    AutocompleteMode,
    AutocompleteRequest,
    AutocompleteRequestKind,
    AutocompleteSuggestion,
    NL2CommandRequest,
    NL2CommandResult,
} from '../api'
import { AUTOCOMPLETE_SYSTEM_PROMPT, EDITOR_AUTOCOMPLETE_SYSTEM_PROMPT, NL2COMMAND_SYSTEM_PROMPT } from '../prompts'
import { DangerousCommandGuard } from './dangerousCommandGuard'
import { SuggestionCache } from './suggestionCache.service'
import { normalizeCommand } from './commandValidation'

interface ChatMessage {
    role: 'system' | 'user' | 'assistant'
    content: string
}

interface ChatCompletionResponse {
    choices: { message: { content: string } }[]
}

/** @hidden */
@Injectable({ providedIn: 'root' })
export class LLMService {
    private logger: Logger
    private caches = new Map<string, SuggestionCache<AutocompleteSuggestion[]>>()
    private guard = new DangerousCommandGuard()
    private abortController: AbortController | null = null
    private autocompleteAbortControllers = new Map<string, AbortController>()

    constructor (
        log: LogService,
        private config: ConfigService,
    ) {
        this.logger = log.create('llm')
        this.config.changed$.subscribe(() => {
            this.caches.clear()
        })
    }

    isConfigured (): boolean {
        const { enabled, apiKey, baseUrl, model } = this.config.store.llm
        return !!enabled && !!apiKey && !!baseUrl && !!model
    }

    cancelPending (): void {
        this.abortController?.abort()
        this.abortController = null
        for (const controller of this.autocompleteAbortControllers.values()) {
            controller.abort()
        }
        this.autocompleteAbortControllers.clear()
    }

    cancelAutocompleteRequests (tabKey: string, requestKind?: AutocompleteRequestKind): void {
        const prefix = `${tabKey}:`
        for (const [key, controller] of this.autocompleteAbortControllers) {
            if (key.startsWith(prefix) && (!requestKind || key === `${prefix}${requestKind}`)) {
                controller.abort()
                this.autocompleteAbortControllers.delete(key)
            }
        }
    }

    async testConnection (): Promise<void> {
        await this.chatCompletion([
            { role: 'system', content: 'Reply with OK only.' },
            { role: 'user', content: 'ping' },
        ], { maxTokens: 5, temperature: 0 })
    }

    async getAutocompleteSuggestions (request: AutocompleteRequest): Promise<AutocompleteSuggestion[]> {
        if (!this.isConfigured() || (!request.partialCommand.trim() && !request.previousCommand?.trim())) {
            return []
        }

        const mode: AutocompleteMode = request.mode ?? 'shell'
        const cache = this.getCache(request.tabKey)
        const cacheKey = cache.makeKey(
            mode,
            request.partialCommand,
            request.previousCommand,
            request.cwd,
            request.shell,
        )
        const cached = cache.get(cacheKey)
        if (cached) {
            return cached
        }

        const systemPrompt = mode === 'editor'
            ? EDITOR_AUTOCOMPLETE_SYSTEM_PROMPT
            : AUTOCOMPLETE_SYSTEM_PROMPT
        const userContent = this.buildAutocompleteUserMessage(request)
        const autocompleteModel = this.config.store.llm.autocompleteModel?.trim() || this.config.store.llm.model
        const requestKind = request.requestKind ?? 'live'
        const configuredTimeout = Math.max(250, this.config.store.llm.autocompleteTimeoutMs ?? 3000)
        const content = await this.streamChatCompletion([
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userContent },
        ], {
            maxTokens: 256,
            temperature: 0.1,
            model: autocompleteModel,
            timeoutMs: requestKind === 'prediction'
                ? Math.max(3000, configuredTimeout)
                : configuredTimeout,
            disableThinking: this.config.store.llm.autocompleteDisableThinking ?? true,
            requestKey: `${request.tabKey}:${requestKind}`,
        })

        const suggestions = this.parseAutocompleteResponse(
            this.stripThinkingContent(content),
            request.partialCommand,
            mode,
        )
        cache.set(cacheKey, suggestions)
        return suggestions
    }

    clearAutocompleteCache (tabKey: string): void {
        this.caches.delete(tabKey)
    }

    async convertNaturalLanguage (request: NL2CommandRequest): Promise<NL2CommandResult> {
        const userContent = this.buildNL2UserMessage(request)
        const content = await this.chatCompletion([
            { role: 'system', content: NL2COMMAND_SYSTEM_PROMPT },
            { role: 'user', content: userContent },
        ], { maxTokens: 256, temperature: 0.1 })

        const parsed = this.parseNL2Response(content)
        const danger = this.guard.isDangerous(parsed.command)
        return {
            command: parsed.command,
            explanation: parsed.explanation,
            dangerous: danger.dangerous,
            dangerReason: danger.reason,
        }
    }

    redactOutput (lines: string[]): string[] {
        if (!this.config.store.llm.sendContextToCloud) {
            return []
        }
        return this.guard.redactLines(lines)
    }

    private buildAutocompleteUserMessage (request: AutocompleteRequest): string {
        const mode: AutocompleteMode = request.mode ?? 'shell'
        const parts = [
            `Mode: ${mode}`,
            `OS: ${request.os}`,
            `Shell: ${request.shell}`,
        ]
        if (request.cwd) {
            parts.push(`Current directory: ${request.cwd}`)
        }
        if (this.config.store.llm.sendContextToCloud && request.recentOutput.length) {
            const label = mode === 'editor' ? 'Nearby editor / screen context' : 'Recent terminal output'
            parts.push(`${label}:\n${request.recentOutput.slice(-10).join('\n')}`)
        }
        if (request.excludeCommands.length) {
            parts.push(`Items to exclude (already shown):\n${request.excludeCommands.map(c => `- ${c}`).join('\n')}`)
        }
        if (request.previousCommand?.trim()) {
            parts.push(`Previous command: ${request.previousCommand.trim()}`)
        }
        parts.push(mode === 'editor'
            ? `Partial text: ${request.partialCommand}`
            : `Partial command: ${request.partialCommand}`)
        return parts.join('\n')
    }

    private buildNL2UserMessage (request: NL2CommandRequest): string {
        const parts = [
            `OS: ${request.os}`,
            `Shell: ${request.shell}`,
        ]
        if (request.cwd) {
            parts.push(`Current directory: ${request.cwd}`)
        }
        parts.push(`Request: ${request.naturalLanguage}`)
        return parts.join('\n')
    }

    private async streamChatCompletion (
        messages: ChatMessage[],
        options: {
            maxTokens: number
            temperature: number
            model?: string
            timeoutMs?: number
            disableThinking?: boolean
            requestKey: string
        },
    ): Promise<string> {
        this.autocompleteAbortControllers.get(options.requestKey)?.abort()
        const localController = new AbortController()
        this.autocompleteAbortControllers.set(options.requestKey, localController)
        const { baseUrl, apiKey, model } = this.config.store.llm
        const url = `${baseUrl.replace(/\/$/, '')}/chat/completions`
        const requestModel = options.model || model
        const requestBody: Record<string, unknown> = {
            model: requestModel,
            messages,
            max_tokens: options.maxTokens,
            temperature: options.temperature,
            stream: true,
        }
        if (options.disableThinking) {
            if (/qwen/i.test(requestModel)) {
                requestBody.enable_thinking = false
            } else if (/^(o\d|gpt-5)|reason/i.test(requestModel)) {
                requestBody.reasoning_effort = 'minimal'
            }
        }
        const timeoutMs = Math.max(250, options.timeoutMs ?? 0)
        let timeout: ReturnType<typeof setTimeout> | null = null
        const restartTimeout = () => {
            if (!options.timeoutMs) {
                return
            }
            if (timeout) {
                clearTimeout(timeout)
            }
            timeout = setTimeout(() => localController.abort(), timeoutMs)
        }
        restartTimeout()

        try {
            const response = await fetch(url, {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${apiKey}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(requestBody),
                signal: localController.signal,
            })

            if (!response.ok) {
                const errorBody = await response.text()
                let detail = response.statusText
                try {
                    detail = JSON.parse(errorBody)?.error?.message ?? detail
                } catch {
                    detail = errorBody || detail
                }
                throw new Error(detail)
            }

            const reader = response.body?.getReader()
            if (!reader) {
                throw new Error('No response body')
            }

            try {
                const decoder = new TextDecoder()
                let content = ''
                let buffer = ''

                while (true) {
                    const { done, value } = await reader.read()
                    if (done) {
                        break
                    }
                    restartTimeout()
                    buffer += decoder.decode(value, { stream: true })
                    const lines = buffer.split('\n')
                    buffer = lines.pop() ?? ''
                    content += this.parseStreamLines(lines)
                    const streamDone = lines.some(line => {
                        const trimmed = line.trim()
                        return trimmed.startsWith('data:') && trimmed.substring(5).trim() === '[DONE]'
                    })
                    if (streamDone) {
                        break
                    }
                }
                buffer += decoder.decode()
                content += this.parseStreamLines([buffer])

                return content.trim()
            } finally {
                reader.cancel().catch(() => {})
            }
        } catch (error) {
            if (error instanceof DOMException && error.name === 'AbortError') {
                throw error
            }
            const message = error instanceof Error ? error.message : String(error)
            this.logger.error('LLM stream request failed', message)
            throw new Error(message)
        } finally {
            if (timeout) {
                clearTimeout(timeout)
            }
            if (this.autocompleteAbortControllers.get(options.requestKey) === localController) {
                this.autocompleteAbortControllers.delete(options.requestKey)
            }
        }
    }

    private async chatCompletion (
        messages: ChatMessage[],
        options: { maxTokens: number, temperature: number },
    ): Promise<string> {
        this.cancelPending()
        const localController = new AbortController()
        this.abortController = localController
        const { baseUrl, apiKey, model } = this.config.store.llm
        const url = `${baseUrl.replace(/\/$/, '')}/chat/completions`

        try {
            const response = await axios.post<ChatCompletionResponse>(url, {
                model,
                messages,
                max_tokens: options.maxTokens,
                temperature: options.temperature,
                stream: false,
            }, {
                headers: {
                    Authorization: `Bearer ${apiKey}`,
                    'Content-Type': 'application/json',
                },
                signal: localController.signal,
                timeout: 60000,
            })
            return response.data.choices[0]?.message?.content?.trim() ?? ''
        } catch (error) {
            if (axios.isCancel(error)) {
                throw new Error('Request cancelled')
            }
            const axiosError = error as AxiosError
            const detail = (axiosError.response?.data as any)?.error?.message ?? axiosError.message
            this.logger.error('LLM request failed', detail)
            throw new Error(detail)
        } finally {
            if (this.abortController === localController) {
                this.abortController = null
            }
        }
    }

    private getCache (tabKey: string): SuggestionCache<AutocompleteSuggestion[]> {
        let cache = this.caches.get(tabKey)
        if (!cache) {
            cache = new SuggestionCache<AutocompleteSuggestion[]>()
            this.caches.set(tabKey, cache)
        }
        return cache
    }

    private parseAutocompleteResponse (
        content: string,
        partialCommand = '',
        mode: AutocompleteMode = 'shell',
    ): AutocompleteSuggestion[] {
        try {
            const json = this.extractJSON(content)
            const items = JSON.parse(json)
            if (!Array.isArray(items)) {
                return []
            }
            const lower = partialCommand.trim().toLowerCase()
            return items.slice(0, 5).map((item, index) => {
                const raw = String(item.command ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim()
                const command = mode === 'editor'
                    ? this.normalizeEditorSuggestion(raw)
                    : (normalizeCommand(raw, { allowMultiline: true }) ?? '')
                return {
                    id: `ai-${index}`,
                    command,
                    description: String(item.description ?? ''),
                    category: 'ai' as const,
                    confidence: typeof item.confidence === 'number'
                        ? Math.max(0, Math.min(1, item.confidence))
                        : undefined,
                }
            }).filter(item => {
                if (!item.command) {
                    return false
                }
                if (!lower) {
                    return true
                }
                const cmd = item.command.toLowerCase()
                if (mode === 'editor') {
                    return cmd.startsWith(lower) || cmd.includes(lower)
                }
                return cmd.startsWith(lower) ||
                    cmd.includes(lower) ||
                    cmd.split(/[\s/._-]+/).some(word => word.startsWith(lower))
            })
        } catch (e) {
            this.logger.warn('Failed to parse autocomplete response', content, e)
            return []
        }
    }

    private normalizeEditorSuggestion (raw: string): string {
        if (!raw) {
            return ''
        }
        // Keep a single logical line for panel insertion.
        const singleLine = raw.split('\n').map(line => line.trimEnd()).filter(Boolean)[0] ?? ''
        const trimmed = singleLine.trim()
        if (!trimmed || trimmed.length > 500) {
            return ''
        }
        return trimmed
    }

    private parseNL2Response (content: string): { command: string, explanation: string } {
        try {
            const json = this.extractJSON(content)
            const item = JSON.parse(json)
            return {
                command: normalizeCommand(String(item.command ?? '').trim(), { allowMultiline: true }) ?? '',
                explanation: String(item.explanation ?? ''),
            }
        } catch {
            const trimmed = normalizeCommand(content.trim(), { allowMultiline: true }) ?? content.trim()
            return { command: trimmed, explanation: '' }
        }
    }

    private extractJSON (content: string): string {
        const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(content)
        if (fence) {
            return fence[1].trim()
        }
        const arrayStart = content.indexOf('[')
        const objectStart = content.indexOf('{')
        if (arrayStart >= 0 && (objectStart < 0 || arrayStart < objectStart)) {
            const end = content.lastIndexOf(']')
            if (end > arrayStart) {
                return content.substring(arrayStart, end + 1)
            }
        }
        if (objectStart >= 0) {
            const end = content.lastIndexOf('}')
            if (end > objectStart) {
                return content.substring(objectStart, end + 1)
            }
        }
        return content.trim()
    }

    private parseStreamLines (lines: string[]): string {
        let content = ''
        for (const line of lines) {
            const trimmed = line.trim()
            if (!trimmed.startsWith('data:')) {
                continue
            }
            const payload = trimmed.substring(5).trim()
            if (payload === '[DONE]') {
                continue
            }
            try {
                const chunk = JSON.parse(payload)
                const delta = chunk.choices?.[0]?.delta?.content
                if (delta) {
                    content += delta
                }
            } catch {
                // ignore malformed chunks
            }
        }
        return content
    }

    private stripThinkingContent (content: string): string {
        return content
            .replace(/<think\b[^>]*>[\s\S]*?<\/think>/gi, '')
            .replace(/^\s*<think\b[^>]*>[\s\S]*?(?=[\[{])/i, '')
            .trim()
    }
}
