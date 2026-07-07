import { Injectable } from '@angular/core'
import { ConfigService, LogService, Logger } from 'tabby-core'
import { AutocompleteRequest, AutocompleteSuggestion, CommandDetail } from '../api'
import { SuggestionCache } from './suggestionCache.service'
import { normalizeCommand } from './commandValidation'

interface RAGSearchResult {
    name?: string
    description?: string
    examples?: string[]
    category?: string
    aliases?: string[]
    use_cases?: string[]
    options?: Array<{ flag?: string, description?: string }>
    score?: number
}

/** @hidden */
@Injectable({ providedIn: 'root' })
export class RAGCommandService {
    private logger: Logger
    private caches = new Map<string, SuggestionCache<AutocompleteSuggestion[]>>()
    private abortControllers = new Map<string, AbortController>()

    constructor (
        log: LogService,
        private config: ConfigService,
    ) {
        this.logger = log.create('llm-rag')
        this.config.changed$.subscribe(() => {
            this.caches.clear()
        })
    }

    isConfigured (): boolean {
        return !!this.config.store.llm.ragBaseUrl
    }

    cancelPending (tabKey?: string): void {
        if (tabKey) {
            this.abortControllers.get(tabKey)?.abort()
            this.abortControllers.delete(tabKey)
            return
        }
        for (const controller of this.abortControllers.values()) {
            controller.abort()
        }
        this.abortControllers.clear()
    }

    clearAutocompleteCache (tabKey: string): void {
        this.caches.delete(tabKey)
    }

    async getAutocompleteSuggestions (request: AutocompleteRequest): Promise<AutocompleteSuggestion[]> {
        if (!this.isConfigured() || !request.partialCommand.trim()) {
            return []
        }

        const cache = this.getCache(request.tabKey)
        const cacheKey = cache.makeKey(
            request.partialCommand,
            request.cwd,
            request.shell,
        )
        const cached = cache.get(cacheKey)
        if (cached) {
            return cached
        }

        this.cancelPending(request.tabKey)
        const abortController = new AbortController()
        this.abortControllers.set(request.tabKey, abortController)

        try {
            const baseUrl = this.config.store.llm.ragBaseUrl.replace(/\/$/, '')
            const suggestions = await this.fetchAutocomplete(baseUrl, request, abortController.signal)
            cache.set(cacheKey, suggestions)
            return suggestions
        } catch (error) {
            if (error instanceof DOMException && error.name === 'AbortError') {
                throw error
            }
            if (error instanceof Error && error.message === 'Request cancelled') {
                throw error
            }
            const message = error instanceof Error ? error.message : String(error)
            this.logger.warn('RAG autocomplete request failed', message)
            throw new Error(message)
        } finally {
            if (this.abortControllers.get(request.tabKey) === abortController) {
                this.abortControllers.delete(request.tabKey)
            }
        }
    }

    async getCommandDetail (command: string): Promise<CommandDetail | null> {
        if (!this.isConfigured() || !command.trim()) {
            return null
        }

        const baseUrl = this.config.store.llm.ragBaseUrl.replace(/\/$/, '')
        const name = command.trim().split(/\s+/)[0]
        try {
            const response = await fetch(`${baseUrl}/api/commands/${encodeURIComponent(name)}`)
            if (!response.ok) {
                return null
            }
            const body = await response.json()
            return {
                name: String(body?.name ?? name),
                description: String(body?.description ?? ''),
                examples: Array.isArray(body?.examples) ? body.examples.map(String) : [],
                options: Array.isArray(body?.options) ? body.options.map((option: any) => ({
                    flag: String(option?.flag ?? ''),
                    description: String(option?.description ?? ''),
                })) : [],
                useCases: Array.isArray(body?.use_cases) ? body.use_cases.map(String) : [],
                related: Array.isArray(body?.related) ? body.related.map(String) : [],
                tags: Array.isArray(body?.tags) ? body.tags.map(String) : [],
                category: String(body?.category ?? ''),
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            this.logger.warn('RAG command detail request failed', message)
            return null
        }
    }

    private async fetchAutocomplete (baseUrl: string, request: AutocompleteRequest, signal: AbortSignal): Promise<AutocompleteSuggestion[]> {
        const endpoints = [
            {
                path: '/api/autocomplete',
                init: () => ({
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    signal,
                    body: JSON.stringify({
                        q: request.partialCommand,
                        partial: request.partialCommand,
                        cwd: request.cwd,
                        shell: request.shell,
                        os: request.os,
                        top_k: request.limit ?? this.config.store.llm.ragTopK ?? 5,
                        semantic: this.config.store.llm.ragUseSemanticSearch ?? true,
                        limit: request.limit ?? this.config.store.llm.ragTopK ?? 5,
                        exclude: request.excludeCommands,
                    }),
                }),
                parse: (body: unknown) => this.parseAutocompletePayload(body, request),
            },
            {
                path: '/api/search',
                init: () => ({
                    method: 'GET',
                    signal,
                }),
                parse: (body: unknown) => this.parseSearchPayload(body, request),
                query: () => new URLSearchParams({
                    q: request.partialCommand,
                    top_k: String(request.limit ?? this.config.store.llm.ragTopK ?? 5),
                    semantic: String(this.config.store.llm.ragUseSemanticSearch ?? true),
                }).toString(),
            },
        ]

        let lastError: Error | null = null
        for (const endpoint of endpoints) {
            try {
                const url = endpoint.query ? `${baseUrl}${endpoint.path}?${endpoint.query()}` : `${baseUrl}${endpoint.path}`
                const response = await fetch(url, endpoint.init())
                if (!response.ok) {
                    lastError = new Error(`HTTP ${response.status} ${response.statusText}`)
                    continue
                }
                return endpoint.parse(await response.json())
            } catch (error) {
                if (error instanceof DOMException && error.name === 'AbortError') {
                    throw error
                }
                lastError = error instanceof Error ? error : new Error(String(error))
                continue
            }
        }
        if (lastError) {
            throw new Error(`RAG service unavailable: ${lastError.message}`)
        }
        return []
    }

    private getCache (tabKey: string): SuggestionCache<AutocompleteSuggestion[]> {
        let cache = this.caches.get(tabKey)
        if (!cache) {
            cache = new SuggestionCache<AutocompleteSuggestion[]>()
            this.caches.set(tabKey, cache)
        }
        return cache
    }

    private mapResults (results: RAGSearchResult[], request: AutocompleteRequest): AutocompleteSuggestion[] {
        const suggestions: AutocompleteSuggestion[] = []
        const seen = new Set(request.excludeCommands)
        const lower = request.partialCommand.toLowerCase().trim()

        for (const result of results ?? []) {
            const description = String(result.description ?? '').trim()
            const score = typeof result.score === 'number' ? result.score : 0
            const candidates = this.extractCandidateCommands(result, lower)

            for (const candidate of candidates) {
                if (!candidate || seen.has(candidate)) {
                    continue
                }
                seen.add(candidate)
                suggestions.push({
                    id: `rag-${suggestions.length}`,
                    command: candidate,
                    description: description || `Knowledge Graph: ${result.name ?? candidate}`,
                    category: 'rag',
                    confidence: Math.max(0, Math.min(1, score)),
                })
            }
        }

        return suggestions
    }

    private parseAutocompletePayload (body: unknown, request: AutocompleteRequest): AutocompleteSuggestion[] {
        const items = Array.isArray(body)
            ? body
            : Array.isArray((body as any)?.suggestions)
                ? (body as any).suggestions
                : Array.isArray((body as any)?.results)
                    ? (body as any).results
                    : []
        return items.flatMap(item => this.mapAutocompleteItem(item, request))
    }

    private parseSearchPayload (body: unknown, request: AutocompleteRequest): AutocompleteSuggestion[] {
        return this.mapResults(Array.isArray(body) ? body : [], request)
    }

    private mapAutocompleteItem (item: any, request: AutocompleteRequest): AutocompleteSuggestion[] {
        const command = normalizeCommand(String(item?.insertText ?? item?.command ?? item?.name ?? '').trim(), { allowMultiline: true })
        if (!command) {
            return []
        }
        if (request.excludeCommands.includes(command)) {
            return []
        }
        const description = String(item?.display ?? item?.description ?? '').trim()
        const confidence = typeof item?.confidence === 'number' ? item.confidence : undefined
        return [{
            id: `rag-${command}`,
            command,
            description: description || 'Knowledge Graph',
            category: 'rag',
            confidence,
        }]
    }

    private extractCandidateCommands (result: RAGSearchResult, lower: string): string[] {
        const candidates: string[] = []
        const examples = Array.isArray(result.examples) ? result.examples : []
        const name = normalizeCommand(String(result.name ?? '').trim(), { allowMultiline: true })

        for (const example of examples) {
            const normalized = normalizeCommand(String(example).trim(), { allowMultiline: true })
            if (!normalized) {
                continue
            }
            const exampleLower = normalized.toLowerCase()
            if (this.matchesPartial(exampleLower, lower)) {
                candidates.push(normalized)
            }
        }

        if (name) {
            const lowerName = name.toLowerCase()
            if (this.matchesPartial(lowerName, lower) || !candidates.length) {
                candidates.unshift(name)
            }
            for (const template of this.buildTemplates(result, name, lower)) {
                if (this.matchesPartial(template.toLowerCase(), lower)) {
                    candidates.push(template)
                }
            }
        }

        return Array.from(new Set(candidates))
    }

    private buildTemplates (result: RAGSearchResult, name: string, lower: string): string[] {
        const templates: string[] = []
        const category = String(result.category ?? '').toLowerCase()
        const push = (cmd: string) => {
            const normalized = normalizeCommand(cmd, { allowMultiline: true })
            if (normalized) {
                templates.push(normalized)
            }
        }

        if (category === 'package' || /package|rpm|dnf|yum|apt|apt-get|pkg/.test(`${name} ${result.description ?? ''}`.toLowerCase())) {
            push(`${name} install <package>`)
            push(`${name} update`)
            push(`${name} upgrade`)
            push(`${name} remove <package>`)
            push(`${name} search <keyword>`)
            push(`${name} list installed`)
            return templates
        }

        if (category === 'file' || /file|directory|path/.test(`${name} ${result.description ?? ''}`.toLowerCase())) {
            push(`${name} .`)
            push(`${name} <path>`)
        }

        if (Array.isArray(result.aliases)) {
            for (const alias of result.aliases) {
                const normalizedAlias = normalizeCommand(String(alias).trim(), { allowMultiline: true })
                if (normalizedAlias) {
                    push(normalizedAlias)
                }
            }
        }

        if (Array.isArray(result.use_cases)) {
            for (const useCase of result.use_cases.slice(0, 3)) {
                const text = String(useCase).trim()
                if (!text) {
                    continue
                }
                const maybe = this.commandFromUseCase(name, text)
                if (maybe) {
                    push(maybe)
                }
            }
        }

        if (Array.isArray(result.options)) {
            for (const option of result.options.slice(0, 4)) {
                const flag = String(option?.flag ?? '').trim()
                if (flag) {
                    push(`${name} ${flag}`)
                }
            }
        }

        return templates
    }

    private commandFromUseCase (name: string, text: string): string | null {
        const lower = text.toLowerCase()
        if (/(安装|install|add|deploy)/.test(lower)) {
            return `${name} install <package>`
        }
        if (/(升级|update|upgrade|sync)/.test(lower)) {
            return `${name} update`
        }
        if (/(删除|移除|remove|delete|uninstall)/.test(lower)) {
            return `${name} remove <package>`
        }
        if (/(搜索|查找|search|find)/.test(lower)) {
            return `${name} search <keyword>`
        }
        if (/(列表|list|show|查看|display)/.test(lower)) {
            return `${name} list`
        }
        return null
    }

    private matchesPartial (command: string, lower: string): boolean {
        return command.startsWith(lower) || this.wordStartsWith(command, lower)
    }

    private wordStartsWith (command: string, partial: string): boolean {
        return command
            .split(/[\s/._-]+/)
            .some(word => word.startsWith(partial))
    }
}
