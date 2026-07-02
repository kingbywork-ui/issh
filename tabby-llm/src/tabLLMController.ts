import { ApplicationRef, ComponentRef, createComponent, EnvironmentInjector } from '@angular/core'
import { Subject, Subscription, debounce, timer } from 'rxjs'
import { ConfigService, LogService, Logger, NotificationsService, PlatformService, TranslateService } from 'tabby-core'
import { BaseTerminalTabComponent, XTermFrontend } from 'tabby-terminal'
import { AutocompleteSuggestion, CommandDetail } from './api'
import { CommandSidecarMode } from './components/commandSidecar.component'
import { LLMTerminalHostComponent } from './components/llmTerminalHost.component'
import { LLMService } from './services/llm.service'
import { RAGCommandService } from './services/ragCommand.service'
import { TerminalContextService } from './services/terminalContext.service'
import { HistoryCommandService } from './services/historyCommand.service'
import { SensitiveInputService } from './services/sensitiveInput.service'
import { normalizeCommand } from './services/commandValidation'

/** @hidden */
export class TabLLMController {
    showAutocomplete = false
    showNL2 = false
    aiLoading = false
    nl2Loading = false
    suggestions: AutocompleteSuggestion[] = []
    selectedIndex = 0
    panelPosition = { x: 8, y: 8 }
    nl2Input = ''
    nl2ResultCommand = ''
    nl2ResultExplanation = ''
    nl2Dangerous = false
    nl2DangerReason = ''
    sidecarVisible = false
    sidecarMode: CommandSidecarMode = 'rag'
    sidecarInput = ''
    sidecarLoading = false
    sidecarRagResults: AutocompleteSuggestion[] = []
    sidecarCommandDetail: CommandDetail | null = null
    sidecarAICommand = ''
    sidecarAIExplanation = ''
    sidecarAIDangerous = false
    sidecarAIDangerReason = ''
    sidecarSelectedIndex = 0
    sidecarError = ''

    private lineBuffer = ''
    private inputSubscription?: Subscription
    private debounceSubject = new Subject<void>()
    private debounceSubscription?: Subscription
    private hostRef: ComponentRef<LLMTerminalHostComponent> | null = null
    private notifyChange: (() => void) | null = null
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
        private platform: PlatformService,
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

    start (): void {
        this.attachKeyHandler()
        this.tab.sessionChanged$.subscribe(() => {
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
            case 'llm-nl2command':
                this.openSidecar('ai')
                return true
            case 'llm-accept-suggestion':
                if (this.showAutocomplete && this.suggestions[this.selectedIndex]) {
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
                if (this.showAutocomplete || this.showNL2 || this.sidecarVisible) {
                    this.hideAutocomplete()
                    this.hideNL2()
                    this.hideSidecar()
                    return true
                }
                return false
            default:
                return false
        }
    }

    handlePanelKeyEvent (event: KeyboardEvent): boolean {
        if (!this.showAutocomplete && !this.showNL2 && !this.sidecarVisible) {
            return false
        }
        if (event.type !== 'keydown') {
            return false
        }
        if (event.key === 'Escape') {
            this.hideAutocomplete()
            this.hideNL2()
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
        if (this.showNL2) {
            return true
        }
        if (event.ctrlKey && !event.altKey && !event.metaKey) {
            const key = event.key.toLowerCase()
            if (key === 'n') {
                event.preventDefault()
                return true
            }
            if (key === 'u') {
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
            this.openSidecar('rag')
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

    openNL2 (): void {
        this.openSidecar('ai')
    }

    hideNL2 (): void {
        this.showNL2 = false
        this.nl2Loading = false
        this.llm.cancelPending()
        this.rag.cancelPending()
        this.refresh()
    }

    openSidecar (mode: CommandSidecarMode = this.sidecarMode): void {
        this.hideAutocomplete()
        this.hideNL2()
        this.sidecarMode = mode
        this.sidecarVisible = true
        if (!this.sidecarInput.trim()) {
            this.sidecarInput = mode === 'rag' ? '/rag ' : '/ai '
        }
        this.refresh()
    }

    hideSidecar (): void {
        this.sidecarVisible = false
        this.sidecarLoading = false
        this.llm.cancelPending()
        this.rag.cancelPending()
        this.refresh()
    }

    clearSidecar (): void {
        this.sidecarInput = this.sidecarMode === 'rag' ? '/rag ' : '/ai '
        this.sidecarRagResults = []
        this.sidecarCommandDetail = null
        this.sidecarAICommand = ''
        this.sidecarAIExplanation = ''
        this.sidecarAIDangerous = false
        this.sidecarAIDangerReason = ''
        this.sidecarSelectedIndex = 0
        this.sidecarError = ''
        this.refresh()
    }

    async submitSidecarInput (): Promise<void> {
        const parsed = this.parseSidecarInput(this.sidecarInput)
        this.sidecarMode = parsed.mode
        const query = parsed.query.trim()
        if (!query) {
            this.clearSidecar()
            return
        }
        if (parsed.mode === 'rag') {
            await this.runSidecarRAG(query)
        } else {
            await this.runSidecarAI(query)
        }
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

    async insertSidecarAIResult (execute: boolean): Promise<void> {
        if (!this.sidecarAICommand) {
            return
        }
        if (execute && this.sidecarAIDangerous) {
            const confirmed = await this.platform.showMessageBox({
                type: 'warning',
                message: this.translate.instant('Run potentially dangerous command?'),
                detail: this.sidecarAICommand,
                buttons: [
                    this.translate.instant('Run anyway'),
                    this.translate.instant('Cancel'),
                ],
                defaultId: 1,
                cancelId: 1,
            })
            if (confirmed.response !== 0) {
                return
            }
        }
        this.insertCommand(this.sidecarAICommand, execute)
        this.lineBuffer = execute ? '' : this.sidecarAICommand
        if (execute) {
            this.hideSidecar()
        } else {
            this.refresh()
        }
    }

    private async runSidecarRAG (query: string): Promise<void> {
        this.sidecarLoading = true
        this.sidecarError = ''
        this.sidecarRagResults = []
        this.sidecarCommandDetail = null
        this.sidecarSelectedIndex = 0
        this.refresh()

        try {
            const ctx = await this.context.collectContext(this.tab)
            const results = await this.rag.getAutocompleteSuggestions({
                tabKey: this.tabKey,
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
            this.sidecarError = e instanceof Error ? e.message : String(e)
        } finally {
            this.sidecarLoading = false
            this.refresh()
        }
    }

    private async runSidecarAI (prompt: string): Promise<void> {
        if (!this.isAIEnabledForCommands()) {
            this.sidecarError = this.translate.instant('Configure AI assistant in Settings first')
            this.sidecarAICommand = ''
            this.sidecarAIExplanation = ''
            this.refresh()
            return
        }

        this.sidecarLoading = true
        this.sidecarError = ''
        this.sidecarAICommand = ''
        this.sidecarAIExplanation = ''
        this.sidecarAIDangerous = false
        this.sidecarAIDangerReason = ''
        this.refresh()

        try {
            const ctx = await this.context.collectContext(this.tab)
            const result = await this.llm.convertNaturalLanguage({
                naturalLanguage: prompt,
                cwd: ctx.cwd,
                shell: ctx.shell,
                os: ctx.os,
            })
            this.sidecarAICommand = result.command
            this.sidecarAIExplanation = result.explanation
            this.sidecarAIDangerous = result.dangerous
            this.sidecarAIDangerReason = result.dangerReason ?? ''
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

    private parseSidecarInput (text: string): { mode: CommandSidecarMode, query: string } {
        const trimmed = text.trim()
        if (trimmed.toLowerCase().startsWith('/rag')) {
            return { mode: 'rag', query: trimmed.substring(4).trim() }
        }
        if (trimmed.toLowerCase().startsWith('/ai')) {
            return { mode: 'ai', query: trimmed.substring(3).trim() }
        }
        return { mode: this.sidecarMode, query: trimmed }
    }

    moveSidecarSelection (delta: number): void {
        if (!this.sidecarVisible || this.sidecarMode !== 'rag' || !this.sidecarRagResults.length) {
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
        if (this.sidecarMode === 'rag') {
            const selected = this.sidecarRagResults[this.sidecarSelectedIndex]
            if (selected) {
                this.insertCommand(selected.command, execute)
                this.lineBuffer = execute ? '' : selected.command
                this.refresh()
            }
            return
        }
        void this.insertSidecarAIResult(execute)
    }

    async convertNL2 (): Promise<void> {
        if (!this.isAIEnabledForCommands()) {
            return
        }
        if (!this.nl2Input.trim()) {
            return
        }
        this.nl2Loading = true
        this.nl2ResultCommand = ''
        this.refresh()
        try {
            const ctx = await this.context.collectContext(this.tab)
            const result = await this.llm.convertNaturalLanguage({
                naturalLanguage: this.nl2Input.trim(),
                cwd: ctx.cwd,
                shell: ctx.shell,
                os: ctx.os,
            })
            this.nl2ResultCommand = result.command
            this.nl2ResultExplanation = result.explanation
            this.nl2Dangerous = result.dangerous
            this.nl2DangerReason = result.dangerReason ?? ''
        } catch (e) {
            if (e instanceof DOMException && e.name === 'AbortError') {
                return
            }
            if (e instanceof Error && e.message === 'Request cancelled') {
                return
            }
            this.notifications.error(this.translate.instant('AI request failed: {error}', {
                error: e instanceof Error ? e.message : String(e),
            }))
        } finally {
            this.nl2Loading = false
            this.refresh()
        }
    }

    async confirmNL2 (execute: boolean): Promise<void> {
        if (!this.nl2ResultCommand) {
            return
        }
        if (this.nl2Dangerous) {
            const confirmed = await this.platform.showMessageBox({
                type: 'warning',
                message: this.translate.instant('Run potentially dangerous command?'),
                detail: this.nl2ResultCommand,
                buttons: [
                    this.translate.instant('Run anyway'),
                    this.translate.instant('Cancel'),
                ],
                defaultId: 1,
                cancelId: 1,
            })
            if (confirmed.response !== 0) {
                return
            }
        }
        const shouldExecute = execute || this.config.store.llm.executeOnConfirm
        this.insertCommand(this.nl2ResultCommand, shouldExecute)
        this.hideNL2()
        this.lineBuffer = ''
        this.sensitiveInputLatched = false
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
        const ragEnabled = this.isRAGAutocompleteEnabled()
        const aiEnabled = this.isAIEnabledForCommands()

        this.updatePanelPosition()
        const anySource = historyEnabled || scriptEnabled || ragEnabled || aiEnabled
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
        this.logger.debug('fetchAutocomplete: history=%d script=%d rag=%s ai_pending=%s', historySuggestions.length, scriptSuggestions.length, ragEnabled, aiEnabled)

        let mergedSuggestions = merged
        if (ragEnabled) {
            const ctx = await this.context.collectContext(this.tab)
            const ragSuggestions = await this.rag.getAutocompleteSuggestions({
                tabKey: this.tabKey,
                partialCommand: partial,
                cwd: ctx.cwd,
                shell: ctx.shell,
                os: ctx.os,
                recentOutput: [],
                excludeCommands: mergedSuggestions.map(s => s.command),
            })
            if (fetchGeneration !== this.pendingFetchGeneration) {
                return
            }
            mergedSuggestions = this.mergeSuggestions(mergedSuggestions, ragSuggestions)
            this.suggestions = mergedSuggestions
            if (partialChanged) {
                this.selectedIndex = 0
            } else {
                this.preserveSelection(previousIndex, previousSuggestions)
            }
            this.refresh()
        }

        if (!aiEnabled) {
            if (!mergedSuggestions.length) {
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
                excludeCommands: mergedSuggestions.map(s => s.command),
            })
            if (fetchGeneration !== this.pendingFetchGeneration) {
                return
            }
            const existingSet = new Set(mergedSuggestions.map(s => s.command))
            const deduped = aiSuggestions.filter(s => !existingSet.has(s.command))
            const indexBeforeMerge = this.selectedIndex
            const suggestionsBeforeMerge = [...this.suggestions]
            this.suggestions = [...mergedSuggestions, ...deduped]
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
            if (!mergedSuggestions.length) {
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

    private isRAGAutocompleteEnabled (): boolean {
        return (this.config.store.llm.ragAutocompleteEnabled ?? false) && this.rag.isConfigured()
    }

    private isAIEnabledForCommands (): boolean {
        return (this.config.store.llm.aiAutocompleteEnabled ?? true) && this.llm.isConfigured()
    }

    private hasAnyAutocompleteSourceEnabled (): boolean {
        return this.isHistoryAutocompleteEnabled() ||
            this.isScriptAutocompleteEnabled() ||
            this.isRAGAutocompleteEnabled() ||
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
