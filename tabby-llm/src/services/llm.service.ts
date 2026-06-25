import axios, { AxiosError } from 'axios'
import { Injectable } from '@angular/core'
import { ConfigService, LogService, Logger } from 'tabby-core'
import { AutocompleteRequest, AutocompleteSuggestion, NL2CommandRequest, NL2CommandResult } from '../api'
import { AUTOCOMPLETE_SYSTEM_PROMPT, NL2COMMAND_SYSTEM_PROMPT } from '../prompts'
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
    private cache = new SuggestionCache<AutocompleteSuggestion[]>()
    private guard = new DangerousCommandGuard()
    private abortController: AbortController | null = null

    constructor (
        log: LogService,
        private config: ConfigService,
    ) {
        this.logger = log.create('llm')
    }

    isConfigured (): boolean {
        const { enabled, apiKey, baseUrl, model } = this.config.store.llm
        return !!enabled && !!apiKey && !!baseUrl && !!model
    }

    cancelPending (): void {
        this.abortController?.abort()
        this.abortController = null
    }

    async testConnection (): Promise<void> {
        await this.chatCompletion([
            { role: 'system', content: 'Reply with OK only.' },
            { role: 'user', content: 'ping' },
        ], { maxTokens: 5, temperature: 0 })
    }

    async getAutocompleteSuggestions (request: AutocompleteRequest): Promise<AutocompleteSuggestion[]> {
        if (!this.isConfigured() || !request.partialCommand.trim()) {
            return []
        }

        const cacheKey = this.cache.makeKey(
            request.partialCommand,
            request.cwd,
            request.shell,
        )
        const cached = this.cache.get(cacheKey)
        if (cached) {
            return cached
        }

        const userContent = this.buildAutocompleteUserMessage(request)
        const content = await this.streamChatCompletion([
            { role: 'system', content: AUTOCOMPLETE_SYSTEM_PROMPT },
            { role: 'user', content: userContent },
        ], { maxTokens: 512, temperature: 0.2 })

        const suggestions = this.parseAutocompleteResponse(content)
        this.cache.set(cacheKey, suggestions)
        return suggestions
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
        const parts = [
            `OS: ${request.os}`,
            `Shell: ${request.shell}`,
        ]
        if (request.cwd) {
            parts.push(`Current directory: ${request.cwd}`)
        }
        if (this.config.store.llm.sendContextToCloud && request.recentOutput.length) {
            parts.push(`Recent terminal output:\n${request.recentOutput.slice(-10).join('\n')}`)
        }
        if (request.excludeCommands.length) {
            parts.push(`Commands to exclude (already shown from history):\n${request.excludeCommands.map(c => `- ${c}`).join('\n')}`)
        }
        parts.push(`Partial command: ${request.partialCommand}`)
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
        options: { maxTokens: number, temperature: number },
    ): Promise<string> {
        this.cancelPending()
        this.abortController = new AbortController()
        const { baseUrl, apiKey, model } = this.config.store.llm
        const url = `${baseUrl.replace(/\/$/, '')}/chat/completions`

        try {
            const response = await fetch(url, {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${apiKey}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    model,
                    messages,
                    max_tokens: options.maxTokens,
                    temperature: options.temperature,
                    stream: true,
                }),
                signal: this.abortController.signal,
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

            const decoder = new TextDecoder()
            let content = ''
            let buffer = ''

            while (true) {
                const { done, value } = await reader.read()
                if (done) {
                    break
                }
                buffer += decoder.decode(value, { stream: true })
                const lines = buffer.split('\n')
                buffer = lines.pop() ?? ''
                content += this.parseStreamLines(lines)
            }
            content += this.parseStreamLines([buffer])

            return content.trim()
        } catch (error) {
            if (error instanceof DOMException && error.name === 'AbortError') {
                throw error
            }
            const message = error instanceof Error ? error.message : String(error)
            this.logger.error('LLM stream request failed', message)
            throw new Error(message)
        } finally {
            this.abortController = null
        }
    }

    private async chatCompletion (
        messages: ChatMessage[],
        options: { maxTokens: number, temperature: number },
    ): Promise<string> {
        this.cancelPending()
        this.abortController = new AbortController()
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
                signal: this.abortController.signal,
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
            this.abortController = null
        }
    }

    private parseAutocompleteResponse (content: string): AutocompleteSuggestion[] {
        try {
            const json = this.extractJSON(content)
            const items = JSON.parse(json)
            if (!Array.isArray(items)) {
                return []
            }
            return items.slice(0, 5).map((item, index) => ({
                id: `ai-${index}`,
                command: normalizeCommand(String(item.command ?? '').trim(), { allowMultiline: true }) ?? '',
                description: String(item.description ?? ''),
                category: 'ai' as const,
                confidence: typeof item.confidence === 'number' ? item.confidence : undefined,
            })).filter(item => item.command)
        } catch (e) {
            this.logger.warn('Failed to parse autocomplete response', content, e)
            return []
        }
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
}
