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

interface AutocompleteParseResult {
    valid: boolean
    suggestions: AutocompleteSuggestion[]
    error?: string
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
        const mode: AutocompleteMode = 'shell'
        const request: AutocompleteRequest = {
            tabKey: '__connection_test__',
            partialCommand: 'ec',
            cwd: null,
            shell: 'sh',
            os: 'unknown',
            recentOutput: [],
            excludeCommands: [],
            requestKind: 'live',
            mode,
        }
        const autocompleteModel = this.config.store.llm.autocompleteModel?.trim() || this.config.store.llm.model
        const content = await this.streamChatCompletion([
            { role: 'system', content: AUTOCOMPLETE_SYSTEM_PROMPT },
            { role: 'user', content: this.buildAutocompleteUserMessage(request) },
        ], {
            maxTokens: 256,
            temperature: 0.1,
            model: autocompleteModel,
            timeoutMs: Math.max(250, this.config.store.llm.autocompleteTimeoutMs ?? 3000),
            disableThinking: this.config.store.llm.autocompleteDisableThinking ?? true,
            requestKey: `${request.tabKey}:live`,
        }, candidate => this.parseAutocompleteResponse(
            this.stripThinkingContent(candidate),
            request.partialCommand,
            mode,
        ).suggestions.length > 0)

        const parsed = this.parseAutocompleteResponse(
            this.stripThinkingContent(content),
            request.partialCommand,
            mode,
        )
        if (!parsed.valid || !parsed.suggestions.length) {
            throw new Error(parsed.error ?? 'Autocomplete model returned an invalid response')
        }
    }

    async getAutocompleteSuggestions (request: AutocompleteRequest): Promise<AutocompleteSuggestion[]> {
        if (!this.isConfigured()
            || (!request.partialCommand.trim() && !request.previousCommand?.trim())
            || (!this.config.store.llm.sendContextToCloud && !request.partialCommand.trim())) {
            return []
        }

        const mode: AutocompleteMode = request.mode ?? 'shell'
        const requestKind = request.requestKind ?? 'live'
        const cache = this.getCache(request.tabKey)
        const cacheKey = cache.makeKey({
            requestKind,
            mode,
            partialCommand: request.partialCommand,
            previousCommand: request.previousCommand,
            cwd: request.cwd,
            shell: request.shell,
        })
        const cached = cache.get(cacheKey)
        if (cached?.length) {
            return cached
        }

        const systemPrompt = mode === 'editor'
            ? EDITOR_AUTOCOMPLETE_SYSTEM_PROMPT
            : AUTOCOMPLETE_SYSTEM_PROMPT
        const userContent = this.buildAutocompleteUserMessage(request)
        const autocompleteModel = this.config.store.llm.autocompleteModel?.trim() || this.config.store.llm.model
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
        }, candidate => this.parseAutocompleteResponse(
            this.stripThinkingContent(candidate),
            request.partialCommand,
            mode,
        ).suggestions.length > 0)

        const parsed = this.parseAutocompleteResponse(
            this.stripThinkingContent(content),
            request.partialCommand,
            mode,
        )
        if (!parsed.valid) {
            const responseSummary = content.trim()
                ? `non-empty response (${content.length} characters)`
                : 'empty response'
            this.logger.warn('Failed to parse autocomplete response', responseSummary, parsed.error)
            throw new Error(`Invalid autocomplete response: ${parsed.error ?? 'unknown response format'}`)
        }
        if (parsed.suggestions.length) {
            cache.set(cacheKey, parsed.suggestions)
        }
        return parsed.suggestions
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
        const parts = [`Mode: ${mode}`]
        if (this.config.store.llm.sendContextToCloud) {
            parts.push(`OS: ${request.os}`, `Shell: ${request.shell}`)
            if (request.cwd) {
                parts.push(`Current directory: ${request.cwd}`)
            }
            if (request.recentOutput.length) {
                const label = mode === 'editor' ? 'Nearby editor / screen context' : 'Recent terminal output'
                parts.push(`${label}:\n${request.recentOutput.slice(-10).join('\n')}`)
            }
            if (request.excludeCommands.length) {
                parts.push(`Items to exclude (already shown):\n${request.excludeCommands.map(c => `- ${c}`).join('\n')}`)
            }
            if (request.previousCommand?.trim()) {
                parts.push(`Previous command: ${request.previousCommand.trim()}`)
            }
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
        isUsableContent: (content: string) => boolean,
    ): Promise<string> {
        this.autocompleteAbortControllers.get(options.requestKey)?.abort()
        const localController = new AbortController()
        this.autocompleteAbortControllers.set(options.requestKey, localController)
        const { baseUrl, apiKey, model } = this.config.store.llm
        const url = `${baseUrl.replace(/\/$/, '')}/chat/completions`
        const requestModel = options.model || model
        const baseRequestBody: Record<string, unknown> = {
            model: requestModel,
            messages,
            max_tokens: options.maxTokens,
            temperature: options.temperature,
        }
        if (options.disableThinking) {
            if (/qwen/i.test(requestModel)) {
                baseRequestBody.enable_thinking = false
            } else if (/^(o\d|gpt-5)|reason/i.test(requestModel)) {
                baseRequestBody.reasoning_effort = 'minimal'
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
            const streamedContent = await this.performAutocompleteRequest(
                url,
                apiKey,
                baseRequestBody,
                true,
                localController,
                restartTimeout,
            )
            if (streamedContent.trim() && isUsableContent(streamedContent)) {
                return streamedContent.trim()
            }
            if (localController.signal.aborted) {
                throw new DOMException('Request aborted', 'AbortError')
            }

            // The streaming HTTP request completed successfully but did not contain a
            // usable autocomplete payload. Retry once without streaming, preserving
            // the same request key and AbortController so cancellation remains scoped.
            restartTimeout()
            return (await this.performAutocompleteRequest(
                url,
                apiKey,
                baseRequestBody,
                false,
                localController,
                restartTimeout,
            )).trim()
        } catch (error) {
            if (this.isAbortError(error)) {
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

    private async performAutocompleteRequest (
        url: string,
        apiKey: string,
        baseRequestBody: Record<string, unknown>,
        stream: boolean,
        controller: AbortController,
        restartTimeout: () => void,
    ): Promise<string> {
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ ...baseRequestBody, stream }),
            signal: controller.signal,
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

        if (!stream) {
            return this.parseCompletionBody(await response.text())
        }

        const reader = response.body?.getReader()
        if (!reader) {
            return ''
        }

        try {
            const decoder = new TextDecoder()
            let body = ''
            while (true) {
                const { done, value } = await reader.read()
                if (done) {
                    break
                }
                restartTimeout()
                body += decoder.decode(value, { stream: true })
                if (this.hasStreamDone(body)) {
                    break
                }
            }
            body += decoder.decode()
            return this.parseCompletionBody(body)
        } finally {
            reader.cancel().catch(() => {})
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
    ): AutocompleteParseResult {
        try {
            const json = this.extractJSON(content)
            const payload: unknown = JSON.parse(json)
            let items: unknown[] | null = null
            if (Array.isArray(payload)) {
                items = payload
            } else if (this.isRecord(payload)) {
                if (Array.isArray(payload.suggestions)) {
                    items = payload.suggestions
                } else if (Array.isArray(payload.commands)) {
                    items = payload.commands
                }
            }
            if (!items) {
                return {
                    valid: false,
                    suggestions: [],
                    error: 'Expected a JSON array or a suggestions/commands array',
                }
            }
            const lower = partialCommand.trim().toLowerCase()
            const suggestions = items.slice(0, 5).map((item, index) => {
                const itemRecord = this.isRecord(item) ? item : null
                const rawValue = typeof item === 'string' ? item : itemRecord?.command
                const raw = String(rawValue ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim()
                const command = mode === 'editor'
                    ? this.normalizeEditorSuggestion(raw)
                    : (normalizeCommand(raw, { allowMultiline: true }) ?? '')
                return {
                    id: `ai-${index}`,
                    command,
                    description: String(itemRecord?.description ?? ''),
                    category: 'ai' as const,
                    confidence: typeof itemRecord?.confidence === 'number'
                        ? Math.max(0, Math.min(1, itemRecord.confidence))
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
            return { valid: true, suggestions }
        } catch (e) {
            return {
                valid: false,
                suggestions: [],
                error: e instanceof Error ? e.message : String(e),
            }
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

    private hasStreamDone (body: string): boolean {
        return /(?:^|\r?\n)\s*data:\s*\[DONE\]\s*(?:\r?\n|$)/.test(body)
    }

    private parseCompletionBody (body: string): string {
        const trimmed = body.trim()
        if (!trimmed) {
            return ''
        }

        const dataLines = body.split(/\r?\n/).map(line => line.trim()).filter(line => line.startsWith('data:'))
        if (dataLines.length) {
            let content = ''
            for (const line of dataLines) {
                const payloadText = line.substring(5).trim()
                if (!payloadText || payloadText === '[DONE]') {
                    continue
                }
                try {
                    const extracted = this.extractCompletionContent(JSON.parse(payloadText))
                    if (extracted !== null) {
                        content += extracted
                    }
                } catch {
                    // A malformed SSE payload makes the accumulated response unusable;
                    // the caller will retry once using a non-streaming request.
                }
            }
            return content
        }

        try {
            const parsed = JSON.parse(trimmed)
            return this.extractCompletionContent(parsed) ?? trimmed
        } catch {
            // Ollama and some OpenAI-compatible gateways stream newline-delimited
            // JSON without the SSE "data:" prefix.
            const lines = body.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
            if (lines.length > 1) {
                let content = ''
                let parsedLine = false
                for (const line of lines) {
                    try {
                        const extracted = this.extractCompletionContent(JSON.parse(line))
                        if (extracted !== null) {
                            content += extracted
                            parsedLine = true
                        }
                    } catch {
                        return trimmed
                    }
                }
                if (parsedLine) {
                    return content
                }
            }
            // Some compatible endpoints return the assistant text as a plain body.
            return trimmed
        }
    }

    private extractCompletionContent (payload: unknown): string | null {
        if (typeof payload === 'string') {
            return payload
        }
        if (Array.isArray(payload)) {
            return this.extractContentValue(payload) ?? JSON.stringify(payload)
        }
        if (!this.isRecord(payload)) {
            return null
        }

        const reasoningParts: string[] = []
        const choices = payload.choices
        if (Array.isArray(choices)) {
            let content = ''
            let found = false
            for (const choice of choices) {
                if (!this.isRecord(choice)) {
                    continue
                }
                const delta = this.isRecord(choice.delta) ? choice.delta : null
                const message = this.isRecord(choice.message) ? choice.message : null
                for (const reasoningCandidate of [
                    delta?.reasoning_content,
                    message?.reasoning_content,
                    choice.reasoning_content,
                ]) {
                    const reasoning = this.extractContentValue(reasoningCandidate)
                    if (reasoning !== null) {
                        reasoningParts.push(reasoning)
                    }
                }
                const candidates: unknown[] = [
                    delta?.content,
                    delta?.text,
                    message?.content,
                    message?.text,
                    choice.text,
                ]
                for (const candidate of candidates) {
                    const extracted = this.extractContentValue(candidate)
                    if (extracted !== null && extracted !== '') {
                        content += extracted
                        found = true
                        break
                    }
                }
            }
            if (found) {
                return content
            }
        }

        const delta = this.isRecord(payload.delta) ? payload.delta : null
        const directCandidates: unknown[] = [
            delta?.content,
            delta?.text,
            payload.output_text,
            payload.content,
            payload.text,
        ]
        for (const candidate of directCandidates) {
            const extracted = this.extractContentValue(candidate)
            if (extracted !== null && extracted !== '') {
                return extracted
            }
        }

        const output = this.extractContentValue(payload.output)
        if (output !== null && output !== '') {
            return output
        }

        const message = this.isRecord(payload.message) ? payload.message : null
        const messageContent = this.extractContentValue(message?.content)
        if (messageContent !== null && messageContent !== '') {
            return messageContent
        }
        const messageText = this.extractContentValue(message?.text)
        if (messageText !== null && messageText !== '') {
            return messageText
        }
        for (const reasoningCandidate of [
            delta?.reasoning_content,
            message?.reasoning_content,
            payload.reasoning_content,
        ]) {
            const reasoning = this.extractContentValue(reasoningCandidate)
            if (reasoning !== null) {
                reasoningParts.push(reasoning)
            }
        }

        if (payload.response !== undefined) {
            const response = this.extractCompletionContent(payload.response)
            if (response !== null && response !== '') {
                return response
            }
        }

        const candidates = payload.candidates
        if (Array.isArray(candidates)) {
            const candidateContent = candidates.map(candidate => {
                if (!this.isRecord(candidate) || !this.isRecord(candidate.content)) {
                    return null
                }
                return this.extractContentValue(candidate.content.parts)
            }).filter((value): value is string => value !== null).join('')
            if (candidateContent) {
                return candidateContent
            }
        }

        const reasoningContent = reasoningParts.join('')
        if (reasoningContent && this.parseAutocompleteResponse(
            this.stripThinkingContent(reasoningContent),
            '',
            'editor',
        ).suggestions.length > 0) {
            return reasoningContent
        }

        return null
    }

    private extractContentValue (value: unknown): string | null {
        if (typeof value === 'string') {
            return value
        }
        if (Array.isArray(value)) {
            let content = ''
            let found = false
            for (const item of value) {
                const extracted = this.extractContentValue(item)
                if (extracted !== null) {
                    content += extracted
                    found = true
                }
            }
            return found ? content : null
        }
        if (!this.isRecord(value)) {
            return null
        }
        if (typeof value.text === 'string') {
            return value.text
        }
        if (this.isRecord(value.text) && typeof value.text.value === 'string') {
            return value.text.value
        }
        if (typeof value.output_text === 'string') {
            return value.output_text
        }
        const nestedContent = this.extractContentValue(value.content)
        if (nestedContent !== null) {
            return nestedContent
        }
        if (typeof value.type === 'string' && /text/i.test(value.type) && typeof value.value === 'string') {
            return value.value
        }
        return null
    }

    private isRecord (value: unknown): value is Record<string, unknown> {
        return typeof value === 'object' && value !== null && !Array.isArray(value)
    }

    private isAbortError (error: unknown): boolean {
        return this.isRecord(error) && error.name === 'AbortError'
    }

    private stripThinkingContent (content: string): string {
        return content
            .replace(/<think\b[^>]*>[\s\S]*?<\/think>/gi, '')
            .replace(/^\s*<think\b[^>]*>[\s\S]*?(?=[\[{])/i, '')
            .trim()
    }
}
