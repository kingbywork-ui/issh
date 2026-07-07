import { ApplicationRef, ComponentRef, createComponent, EnvironmentInjector } from '@angular/core'
import { Subject, Subscription, debounce, timer } from 'rxjs'
import { ConfigService, LogService, Logger, NotificationsService, TranslateService } from 'tabby-core'
import { BaseTerminalTabComponent, XTermFrontend } from 'tabby-terminal'
import { AutocompleteSuggestion, CommandDetail } from './api'
import { LLMTerminalHostComponent } from './components/llmTerminalHost.component'
import { LLMService } from './services/llm.service'
import { RAGCommandService } from './services/ragCommand.service'
import { TerminalContextService } from './services/terminalContext.service'
import { HistoryCommandService } from './services/historyCommand.service'
import { SensitiveInputService } from './services/sensitiveInput.service'
import { normalizeCommand } from './services/commandValidation'
import { LLMAppPanelService } from './services/llmAppPanel.service'
import { LLMAppSidecarHostComponent } from './components/llmAppSidecarHost.component'

/** @hidden */
export class TabLLMController {
    showAutocomplete = false
    aiLoading = false
    suggestions: AutocompleteSuggestion[] = []
    selectedIndex = 0
    panelPosition = { x: 8, y: 8 }
    sidecarVisible = false
    sidecarInput = ''
    sidecarLoading = false
    sidecarRagResults: AutocompleteSuggestion[] = []
    sidecarCommandDetail: CommandDetail | null = null
    sidecarSelectedIndex = 0
    sidecarError = ''

    private lineBuffer = ''
    private inputSubscription?: Subscription
    private sessionChangedSubscription?: Subscription
    private debounceSubject = new Subject<void>()
    private debounceSubscription?: Subscription
    private hostRef: ComponentRef<LLMTerminalHostComponent> | null = null
    private notifyChange: (() => void) | null = null
    private sidecarNotifyChange: (() => void) | null = null
    private appPanelService: LLMAppPanelService | null = null
    private keyHandlerAttached = false
    private lastAutocompletePartial = ''
    private pendingFetchGeneration = 0
    private historyBootstrapPromise: Promise<void> | null = null
    private tabKey: string
    private inputWasSensitive = false
    private sensitiveInputLatched = false
    private lastSidecarMoveAt = 0

    private logger: Logger

    constructor (
        private tab: BaseTerminalTabComponent<any>,
        private llm: LLMService,
        private rag: RAGCommandService,
        private context: TerminalContextService,
        private history: HistoryCommandService,
        private sensitiveInput: SensitiveInputService,
        private config: ConfigService,
        private notifications: NotificationsService,
        private translate: TranslateService,
        private injector: EnvironmentInjector,
        private appRef: ApplicationRef,
        log: LogService,
    ) {
        this.logger = log.create('llm-controller')
        this.tabKey = this.history.getTabKey(tab)
        this.debounceSubscription = this.debounceSubject.pipe(
            debounce(() => timer(this.config.store.llm.debounceMs ?? 300)),
        ).subscribe(() => {
            void this.fetchAutocomplete()
        })
    }

    setAppPanelService (service: LLMAppPanelService): void {
        this.appPanelService = service
    }

    mount (contentElement: HTMLElement): void {
        if (this.hostRef) {
            return
        }
        this.hostRef = createComponent(LLMTerminalHostComponent, {
            environmentInjector: this.injector,
        })
        this.hostRef.instance.bindController(this)
        this.appRef.attachView(this.hostRef.hostView)
        contentElement.appendChild(this.hostRef.location.nativeElement)
    }

    destroy (): void {
        this.llm.cancelPending()
        this.rag.cancelPending()
        this.llm.clearAutocompleteCache(this.tabKey)
        this.rag.clearAutocompleteCache(this.tabKey)
        this.history.clearTabHistory(this.tabKey)
        this.inputSubscription?.unsubscribe()
        this.sessionChangedSubscription?.unsubscribe()
        this.debounceSubscription?.unsubscribe()
        this.debounceSubject.complete()
        if (this.hostRef) {
            this.appRef.detachView(this.hostRef.hostView)
            this.hostRef.destroy()
            this.hostRef = null
        }
    }

    attachView (_host: LLMTerminalHostComponent, notify: () => void): void {
        this.notifyChange = notify
    }

    detachView (_host: LLMTerminalHostComponent): void {
        this.notifyChange = null
    }

    attachSidecarView (_host: LLMAppSidecarHostComponent, notify: () => void): void {
        this.sidecarNotifyChange = notify
    }

    detachSidecarView (_host: LLMAppSidecarHostComponent): void {
        this.sidecarNotifyChange = null
    }

    start (): void {
        this.attachKeyHandler()
        this.sessionChangedSubscription = this.tab.sessionChanged$.subscribe(() => {
            this.llm.clearAutocompleteCache(this.tabKey)
            this.rag.clearAutocompleteCache(this.tabKey)
            this.history.clearTabHistory(this.tabKey)
            this.lineBuffer = ''
            this.lastAutocompletePartial = ''
            this.inputWasSensitive = false
            this.sensitiveInputLatched = false
            this.hideAutocomplete()
            this.hideSidecar()
        })
        this.historyBootstrapPromise = new Promise(resolve => {
            setTimeout(() => {
                void this.history.bootstrap(this.tab)
                    .finally(() => resolve())
            }, 200)
        })
        this.inputSubscription = this.tab.input$.subscribe(data => {
            this.handleInput(data)
        })
    }

    handleHotkey (hotkey: string): boolean {
        switch (hotkey) {
            case 'llm-autocomplete':
                void this.triggerAutocomplete()
                return true
            case 'llm-accept-suggestion':
                if (this.showAutocomplete && this.suggestions[this.selectedIndex]) {
                    this.acceptSuggestion(this.suggestions[this.selectedIndex])
                    return true
                }
                return false
            case 'llm-next-suggestion':
                if (this.sidecarVisible) {
                    this.moveSidecarSelection(1)
                    return true
                }
                if (this.showAutocomplete) {
                    this.moveSelection(1)
                    return true
                }
                return false
            case 'llm-prev-suggestion':
                if (this.sidecarVisible) {
                    this.moveSidecarSelection(-1)
                    return true
                }
                if (this.showAutocomplete) {
                    this.moveSelection(-1)
                    return true
                }
                return false
            case 'llm-dismiss':
                if (this.showAutocomplete || this.sidecarVisible) {
                    this.hideAutocomplete()
                    this.hideSidecar()
                    return true
                }
                return false
            default:
                return false
        }
    }

    handlePanelKeyEvent (event: KeyboardEvent): boolean {
        if (!this.showAutocomplete && !this.sidecarVisible) {
            return false
        }
        if (event.type !== 'keydown') {
            return false
        }
        if (event.key === 'Escape') {
            this.hideAutocomplete()
            this.hideSidecar()
            event.preventDefault()
            return true
        }
        if (this.sidecarVisible) {
            if (event.ctrlKey && !event.altKey && !event.metaKey) {
                const key = event.key.toLowerCase()
                if (key === 'n') {
                    this.moveSidecarSelection(1)
                    event.preventDefault()
                    return true
                }
                if (key === 'u') {
                    this.moveSidecarSelection(-1)
                    event.preventDefault()
                    return true
                }
                if (event.key === 'Enter') {
                    this.insertCurrentSidecarResult(false)
                    event.preventDefault()
                    return true
                }
            }
            return false
        }
        if (event.ctrlKey && !event.altKey && !event.metaKey) {
            const key = event.key.toLowerCase()
            if (key === 'n') {
                this.moveSelection(1)
                event.preventDefault()
                return true
            }
            if (key === 'u') {
                this.moveSelection(-1)
                event.preventDefault()
                return true
            }
            if (key === 'y' && this.suggestions[this.selectedIndex]) {
                this.acceptSuggestion(this.suggestions[this.selectedIndex])
                event.preventDefault()
                return true
            }
        }
        return false
    }

    async triggerAutocomplete (): Promise<void> {
        if (this.isSensitiveInputActive()) {
            this.hideAutocomplete()
            return
        }
        if (!this.getPartial().trim()) {
            this.openSidecar()
            return
        }
        if (!this.hasAnyAutocompleteSourceEnabled()) {
            this.hideAutocomplete()
            return
        }
        await this.historyBootstrapPromise
        await this.fetchAutocomplete(true)
    }

    hideAutocomplete (): void {
        this.showAutocomplete = false
        this.aiLoading = false
        this.pendingFetchGeneration++
        this.llm.cancelPending()
        this.rag.cancelPending()
        this.refresh()
    }

    isLightweightHintEnabled (): boolean {
        return this.config.store.llm.lightweightHintEnabled ?? false
    }

    getAutocompleteHintText (): string {
        if (!this.showAutocomplete || !this.isLightweightHintEnabled()) {
            return ''
        }
        const suggestion = this.suggestions[this.selectedIndex]
        if (!suggestion) {
            return ''
        }
        const partial = this.getPartial()
        if (partial && suggestion.command.startsWith(partial)) {
            return suggestion.command.substring(partial.length)
        }
        const trimmed = partial.trim()
        if (trimmed && suggestion.command.startsWith(trimmed)) {
            return suggestion.command.substring(trimmed.length)
        }
        return suggestion.command
    }

    openSidecar (): void {
        this.hideAutocomplete()
        this.sidecarVisible = true
        if (!this.sidecarInput.trim()) {
            this.sidecarInput = '/rag '
        }
        this.refresh()
        this.appPanelService?.onSidecarVisibilityChanged(this)
        this.requestTerminalResize()
    }

    hideSidecar (): void {
        this.sidecarVisible = false
        this.sidecarLoading = false
        this.llm.cancelPending()
        this.rag.cancelPending()
        this.refresh()
        this.appPanelService?.onSidecarVisibilityChanged(this)
        this.requestTerminalResize()
    }

    clearSidecar (): void {
        this.sidecarInput = '/rag '
        this.sidecarRagResults = []
        this.sidecarCommandDetail = null
        this.sidecarSelectedIndex = 0
        this.sidecarError = ''
        this.refresh()
    }

    async submitSidecarInput (): Promise<void> {
        const query = this.parseSidecarInput(this.sidecarInput).trim()
        if (!query) {
            this.clearSidecar()
            return
        }
        await this.runSidecarRAG(query)
    }

    async selectSidecarRagResult (suggestion: AutocompleteSuggestion): Promise<void> {
        const index = this.sidecarRagResults.findIndex(s => s.command === suggestion.command)
        if (index >= 0) {
            this.sidecarSelectedIndex = index
        }
        this.sidecarCommandDetail = await this.rag.getCommandDetail(suggestion.command)
        this.refresh()
    }

    insertSidecarSuggestion (suggestion: AutocompleteSuggestion): void {
        this.insertCommand(suggestion.command, false)
        this.lineBuffer = suggestion.command
        this.refresh()
    }

    private async runSidecarRAG (query: string): Promise<void> {
        if (!this.rag.isConfigured()) {
            this.sidecarError = this.translate.instant('Configure RAG base URL in Settings first')
            this.sidecarRagResults = []
            this.sidecarCommandDetail = null
            this.refresh()
            return
        }

        this.sidecarLoading = true
        this.sidecarError = ''
        this.sidecarRagResults = []
        this.sidecarCommandDetail = null
        this.sidecarSelectedIndex = 0
        this.refresh()

        try {
            const ctx = await this.context.collectContext(this.tab)
            const results = await this.rag.getAutocompleteSuggestions({
                tabKey: `${this.tabKey}:sidecar`,
                partialCommand: query,
                cwd: ctx.cwd,
                shell: ctx.shell,
                os: ctx.os,
                recentOutput: [],
                excludeCommands: [],
                limit: 50,
            })
            this.sidecarRagResults = results
            if (results[0]) {
                this.sidecarCommandDetail = await this.rag.getCommandDetail(results[0].command)
            }
            if (!results.length) {
                this.sidecarError = this.translate.instant('No command knowledge found')
            }
        } catch (e) {
            if (e instanceof DOMException && e.name === 'AbortError') {
                return
            }
            if (e instanceof Error && e.message === 'Request cancelled') {
                return
            }
            this.sidecarError = e instanceof Error ? e.message : String(e)
        } finally {
            this.sidecarLoading = false
            this.refresh()
        }
    }

    private parseSidecarInput (text: string): string {
        const trimmed = text.trim()
        if (trimmed.toLowerCase().startsWith('/rag')) {
            return trimmed.substring(4).trim()
        }
        return trimmed
    }

    moveSidecarSelection (delta: number): void {
        if (!this.sidecarVisible || !this.sidecarRagResults.length) {
            return
        }
        const now = Date.now()
        if (now - this.lastSidecarMoveAt < 40) {
            return
        }
        this.lastSidecarMoveAt = now
        const next = this.sidecarSelectedIndex + delta
        this.sidecarSelectedIndex = Math.max(0, Math.min(this.sidecarRagResults.length - 1, next))
        const selected = this.sidecarRagResults[this.sidecarSelectedIndex]
        if (selected) {
            void this.selectSidecarRagResult(selected)
        }
        this.refresh()
    }

    insertCurrentSidecarResult (execute: boolean): void {
        const selected = this.sidecarRagResults[this.sidecarSelectedIndex]
        if (selected) {
            this.insertCommand(selected.command, execute)
            this.lineBuffer = execute ? '' : selected.command
            this.refresh()
        }
    }

    acceptSuggestion (suggestion: AutocompleteSuggestion): void {
        const partial = this.getPartial()
        this.insertCommand(suggestion.command, false, partial)
        this.hideAutocomplete()
        this.lineBuffer = suggestion.command
        this.refresh()
    }

    private moveSelection (delta: number): void {
        if (!this.suggestions.length) {
            return
        }
        const next = this.selectedIndex + delta
        this.selectedIndex = Math.max(0, Math.min(this.suggestions.length - 1, next))
        this.refresh()
    }

    private preserveSelection (previousIndex: number, previousSuggestions: AutocompleteSuggestion[]): void {
        if (!this.suggestions.length) {
            this.selectedIndex = 0
            return
        }
        const previous = previousIndex < previousSuggestions.length ? previousSuggestions[previousIndex] : null
        if (previous) {
            const sameIndex = this.suggestions.findIndex(
                s => s.id === previous.id && s.command === previous.command,
            )
            if (sameIndex >= 0) {
                this.selectedIndex = sameIndex
                return
            }
        }
        this.selectedIndex = Math.min(previousIndex, this.suggestions.length - 1)
    }

    private getPartial (): string {
        const fromBuffer = this.lineBuffer.trim()
        if (fromBuffer) {
            return fromBuffer
        }
        return this.context.getPartialCommand(this.tab)
    }

    private async fetchAutocomplete (force = false): Promise<void> {
        if (this.isSensitiveInputActive()) {
            this.lastAutocompletePartial = ''
            this.hideAutocomplete()
            return
        }
        if (!this.hasAnyAutocompleteSourceEnabled()) {
            this.lastAutocompletePartial = ''
            this.hideAutocomplete()
            return
        }
        const partial = this.getPartial()
        if (!this.shouldTriggerForPartial(partial, force)) {
            this.hideAutocomplete()
            this.lastAutocompletePartial = ''
            return
        }
        if (!force && !this.config.store.llm.autoCompleteOnType) {
            return
        }
        if (this.historyBootstrapPromise) {
            await this.historyBootstrapPromise
        }

        const partialChanged = partial !== this.lastAutocompletePartial
        this.lastAutocompletePartial = partial
        const previousIndex = this.selectedIndex
        const previousSuggestions = [...this.suggestions]
        const fetchGeneration = ++this.pendingFetchGeneration
        const historyEnabled = this.isHistoryAutocompleteEnabled()
        const scriptEnabled = this.isScriptAutocompleteEnabled()
        const aiEnabled = this.isAIEnabledForCommands()

        this.updatePanelPosition()
        const anySource = historyEnabled || scriptEnabled || aiEnabled
        this.showAutocomplete = anySource
        this.aiLoading = aiEnabled
        if (partialChanged) {
            this.selectedIndex = 0
        }

        if (historyEnabled && this.history.usesRemoteHistory(this.tab)) {
            await this.history.refreshRemoteHistory(this.tab, this.tabKey)
            if (fetchGeneration !== this.pendingFetchGeneration) {
                return
            }
        }

        const historyResults = historyEnabled
            ? this.history.search(partial, undefined, this.tabKey, {
                includeGlobal: !this.history.usesRemoteHistory(this.tab),
            })
            : []
        const historySuggestions: AutocompleteSuggestion[] = historyResults.map((r, i) => ({
            id: `history-${i}`,
            command: r.command,
            description: 'History',
            category: 'history' as const,
            confidence: Math.min(1, r.score / 200),
        }))

        const scriptSuggestions = scriptEnabled
            ? this.getScriptSuggestions(partial)
            : []

        const merged = this.mergeSuggestions(historySuggestions, scriptSuggestions)
        this.suggestions = merged
        if (!partialChanged) {
            this.preserveSelection(previousIndex, previousSuggestions)
        }
        this.refresh()
        this.logger.debug('fetchAutocomplete: history=%d script=%d ai_pending=%s', historySuggestions.length, scriptSuggestions.length, aiEnabled)

        if (!aiEnabled) {
            if (!merged.length) {
                this.showAutocomplete = false
            }
            return
        }

        try {
            const ctx = await this.context.collectContext(this.tab)
            const recentOutput = this.llm.redactOutput(
                this.context.getRecentOutput(this.tab, this.config.store.llm.maxContextLines ?? 20),
            )
            const aiSuggestions = await this.llm.getAutocompleteSuggestions({
                tabKey: this.tabKey,
                partialCommand: partial,
                cwd: ctx.cwd,
                shell: ctx.shell,
                os: ctx.os,
                recentOutput,
                excludeCommands: merged.map(s => s.command),
            })
            if (fetchGeneration !== this.pendingFetchGeneration) {
                return
            }
            const existingSet = new Set(merged.map(s => s.command))
            const deduped = aiSuggestions.filter(s => !existingSet.has(s.command))
            const indexBeforeMerge = this.selectedIndex
            const suggestionsBeforeMerge = [...this.suggestions]
            this.suggestions = [...merged, ...deduped]
            if (partialChanged) {
                this.selectedIndex = 0
            } else {
                this.preserveSelection(indexBeforeMerge, suggestionsBeforeMerge)
            }
            if (!this.suggestions.length && !force) {
                this.showAutocomplete = false
            }
        } catch (e) {
            if (fetchGeneration !== this.pendingFetchGeneration) {
                return
            }
            if (force) {
                this.notifications.error(this.translate.instant('AI request failed: {error}', {
                    error: e instanceof Error ? e.message : String(e),
                }))
            }
            if (!merged.length) {
                this.showAutocomplete = false
            }
        } finally {
            if (fetchGeneration === this.pendingFetchGeneration) {
                this.aiLoading = false
                this.refresh()
            }
        }
    }

    private handleInput (data: Buffer): void {
        const text = data.toString('utf-8')
        const isSensitive = this.isSensitiveInputActive()
        if (isSensitive) {
            this.inputWasSensitive = true
            this.sensitiveInputLatched = true
            this.lineBuffer = ''
            this.lastAutocompletePartial = ''
            this.hideAutocomplete()
        }

        if (text.startsWith('\x1b')) {
            this.lineBuffer = this.context.getPartialCommand(this.tab)
            if (!this.lineBuffer) {
                this.hideAutocomplete()
            } else if (this.hasAnyAutocompleteSourceEnabled() && this.config.store.llm.autoCompleteOnType) {
                this.debounceSubject.next()
            }
            return
        }

        if (text === '\r' || text === '\n') {
            if (this.shouldRecordInputHistory()) {
                this.history.addCommand(this.lineBuffer.trim(), { tabKey: this.tabKey })
            }
            this.lineBuffer = ''
            this.inputWasSensitive = false
            this.sensitiveInputLatched = false
            this.hideAutocomplete()
            return
        }

        for (const char of text) {
            if (char === '\r' || char === '\n') {
                if (this.shouldRecordInputHistory()) {
                    this.history.addCommand(this.lineBuffer.trim(), { tabKey: this.tabKey })
                }
                this.lineBuffer = ''
                this.inputWasSensitive = false
                this.sensitiveInputLatched = false
                this.hideAutocomplete()
                continue
            }
            if (char === '\x7f' || char === '\b') {
                this.lineBuffer = this.lineBuffer.slice(0, -1)
            } else if (char === '\x1b') {
                this.lineBuffer = this.context.getPartialCommand(this.tab)
                return
            } else if (char >= ' ' && !isSensitive) {
                this.lineBuffer += char
            }
        }
        if (!isSensitive && this.hasAnyAutocompleteSourceEnabled() && this.config.store.llm.autoCompleteOnType) {
            this.debounceSubject.next()
        }
    }

    private insertCommand (command: string, execute: boolean, partial?: string): void {
        const current = partial ?? this.lineBuffer
        let toSend = command
        if (current && command.startsWith(current)) {
            toSend = command.substring(current.length)
        } else if (current) {
            const backspaceCount = Array.from(current).length
            toSend = '\x7f'.repeat(backspaceCount) + command
        }
        if (execute) {
            toSend += '\r'
        }
        this.tab.sendInput(toSend)
    }

    private updatePanelPosition (): void {
        const pos = this.context.getCursorPosition(this.tab)
        if (pos) {
            this.panelPosition = { x: Math.max(8, pos.x), y: Math.max(8, pos.y) }
        }
    }

    private attachKeyHandler (): void {
        if (this.keyHandlerAttached || !(this.tab.frontend instanceof XTermFrontend)) {
            return
        }
        const xterm = this.tab.frontend.xterm
        const previous = (xterm as any)._customKeyEventHandler
        xterm.attachCustomKeyEventHandler((event: KeyboardEvent) => {
            if (this.handlePanelKeyEvent(event)) {
                return false
            }
            if (previous) {
                return previous(event)
            }
            return true
        })
        this.keyHandlerAttached = true
    }

    private refresh (): void {
        this.notifyChange?.()
        this.sidecarNotifyChange?.()
    }

    private requestTerminalResize (): void {
        setTimeout(() => {
            window.dispatchEvent(new Event('resize'))
        }, 50)
        setTimeout(() => {
            window.dispatchEvent(new Event('resize'))
        }, 200)
    }

    private isSensitiveInputActive (): boolean {
        if (this.sensitiveInputLatched) {
            return true
        }
        return this.sensitiveInput.isSensitiveInputActive(this.tab, this.lineBuffer)
    }

    private shouldRecordInputHistory (): boolean {
        return !!this.lineBuffer.trim() && !this.inputWasSensitive && !this.history.usesRemoteHistory(this.tab)
    }

    private isHistoryAutocompleteEnabled (): boolean {
        return this.config.store.llm.historyAutocompleteEnabled ?? true
    }

    private isScriptAutocompleteEnabled (): boolean {
        return this.config.store.llm.scriptAutocompleteEnabled ?? false
    }

    private isAIEnabledForCommands (): boolean {
        return (this.config.store.llm.aiAutocompleteEnabled ?? true) && this.llm.isConfigured()
    }

    private hasAnyAutocompleteSourceEnabled (): boolean {
        return this.isHistoryAutocompleteEnabled() ||
            this.isScriptAutocompleteEnabled() ||
            this.isAIEnabledForCommands()
    }

    private shouldTriggerForPartial (partial: string, force: boolean): boolean {
        const trimmed = partial.trim()
        if (!trimmed) {
            return false
        }
        const minLen = this.config.store.llm.minTriggerLength ?? 2
        if (trimmed.length < minLen) {
            return false
        }
        const triggerWithoutSpace = this.config.store.llm.triggerWithoutSpaceEnabled ?? true
        if (!triggerWithoutSpace && !force) {
            if (!trimmed.includes(' ')) {
                return false
            }
        }
        return true
    }

    private getScriptSuggestions (partial: string): AutocompleteSuggestion[] {
        const profile = this.tab.profile
        const options = (profile as any)?.options
        const scripts = options?.scripts
        if (!Array.isArray(scripts) || !scripts.length) {
            return []
        }
        const lower = partial.toLowerCase().trim()
        const results: AutocompleteSuggestion[] = []
        const seen = new Set<string>()
        for (const script of scripts) {
            const raw = typeof script?.send === 'string' ? script.send.trim() : ''
            if (!raw) {
                continue
            }
            const normalized = normalizeCommand(raw, { allowMultiline: true })
            if (!normalized || !this.sensitiveInput.shouldStoreCommand(normalized)) {
                continue
            }
            if (seen.has(normalized)) {
                continue
            }
            seen.add(normalized)
            if (!normalized.toLowerCase().includes(lower) &&
                !this.wordStartsWith(normalized.toLowerCase(), lower)) {
                continue
            }
            results.push({
                id: `script-${results.length}`,
                command: normalized,
                description: 'Login Script',
                category: 'script' as const,
                confidence: 0.5,
            })
        }
        return results
    }

    private wordStartsWith (command: string, partial: string): boolean {
        return command
            .split(/[\s/._-]+/)
            .some(word => word.startsWith(partial))
    }

    private mergeSuggestions (
        left: AutocompleteSuggestion[],
        right: AutocompleteSuggestion[],
    ): AutocompleteSuggestion[] {
        const merged = [...left]
        const seen = new Set(merged.map(s => s.command))
        for (const s of right) {
            if (!seen.has(s.command)) {
                merged.push(s)
                seen.add(s.command)
            }
        }
        return merged
    }
}
