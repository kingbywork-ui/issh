import { ApplicationRef, ComponentRef, createComponent, EnvironmentInjector } from '@angular/core'
import { Subject, Subscription, debounce, timer } from 'rxjs'
import {
    altKeyName,
    ConfigService,
    getKeyName,
    getKeystrokeName,
    KeyEventData,
    LogService,
    Logger,
    metaKeyName,
    NotificationsService,
    PlatformService,
    TranslateService,
} from 'tabby-core'
import { BaseTerminalTabComponent, XTermFrontend } from 'tabby-terminal'
import {
    AutocompleteSuggestion,
    autocompleteSuggestionHotkeyId,
    MAX_AUTOCOMPLETE_SUGGESTIONS,
} from './api'
import { LLMTerminalHostComponent } from './components/llmTerminalHost.component'
import { LLMService } from './services/llm.service'
import { TerminalContextService } from './services/terminalContext.service'
import { HistoryCommandService } from './services/historyCommand.service'
import { SensitiveInputService } from './services/sensitiveInput.service'
import { DangerousCommandGuard } from './services/dangerousCommandGuard'
import { normalizeCommand } from './services/commandValidation'
import { isKnownAgentProcess } from './services/agentProcessDetection'

/** @hidden */
export class TabLLMController {
    showAutocomplete = false
    aiLoading = false
    suggestions: AutocompleteSuggestion[] = []
    selectedIndex = 0
    panelPosition = { x: 8, y: 8 }
    panelMaxHeight = 320

    private lineBuffer = ''
    private inputSubscription?: Subscription
    private sessionChangedSubscription?: Subscription
    private alternateScreenSubscription?: Subscription
    private configSubscription?: Subscription
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
    private completedCommandCount = 0
    private predictedNextCommands: AutocompleteSuggestion[] = []
    private pendingPredictionCommand: string | null = null
    private predictionGeneration = 0
    private contentElement: HTMLElement | null = null
    private lastAgentProcessCheckAt = 0
    private lastAgentProcessActive = false
    private agentProcessCheckPromise: Promise<boolean> | null = null
    private agentCommandActive = false

    private logger: Logger
    private guard = new DangerousCommandGuard()

    constructor (
        private tab: BaseTerminalTabComponent<any>,
        private llm: LLMService,
        private context: TerminalContextService,
        private history: HistoryCommandService,
        private sensitiveInput: SensitiveInputService,
        private config: ConfigService,
        private notifications: NotificationsService,
        private translate: TranslateService,
        private injector: EnvironmentInjector,
        private appRef: ApplicationRef,
        log: LogService,
        private platform: PlatformService,
    ) {
        this.logger = log.create('llm-controller')
        this.tabKey = this.history.getTabKey(tab)
        this.debounceSubscription = this.debounceSubject.pipe(
            debounce(() => timer(this.config.store.llm.debounceMs ?? 600)),
        ).subscribe(() => {
            void this.fetchAutocomplete(false, true)
        })
    }

    mount (contentElement: HTMLElement): void {
        if (this.hostRef) {
            return
        }
        this.contentElement = contentElement
        this.hostRef = createComponent(LLMTerminalHostComponent, {
            environmentInjector: this.injector,
        })
        this.hostRef.instance.bindController(this)
        this.appRef.attachView(this.hostRef.hostView)
        contentElement.appendChild(this.hostRef.location.nativeElement)
    }

    destroy (): void {
        this.llm.cancelAutocompleteRequests(this.tabKey)
        this.llm.clearAutocompleteCache(this.tabKey)
        this.history.clearTabHistory(this.tabKey)
        this.inputSubscription?.unsubscribe()
        this.sessionChangedSubscription?.unsubscribe()
        this.alternateScreenSubscription?.unsubscribe()
        this.configSubscription?.unsubscribe()
        this.debounceSubscription?.unsubscribe()
        this.debounceSubject.complete()
        if (this.hostRef) {
            this.appRef.detachView(this.hostRef.hostView)
            this.hostRef.destroy()
            this.hostRef = null
        }
        this.contentElement = null
    }

    attachView (_host: LLMTerminalHostComponent, notify: () => void): void {
        this.notifyChange = notify
    }

    detachView (_host: LLMTerminalHostComponent): void {
        this.notifyChange = null
    }

    start (): void {
        this.attachKeyHandler()
        this.configSubscription = this.config.changed$.subscribe(() => this.refresh())
        this.sessionChangedSubscription = this.tab.sessionChanged$.subscribe(() => {
            this.llm.cancelAutocompleteRequests(this.tabKey)
            this.llm.clearAutocompleteCache(this.tabKey)
            this.history.clearTabHistory(this.tabKey)
            this.lineBuffer = ''
            this.lastAutocompletePartial = ''
            this.inputWasSensitive = false
            this.sensitiveInputLatched = false
            this.completedCommandCount = 0
            this.predictedNextCommands = []
            this.pendingPredictionCommand = null
            this.predictionGeneration++
            this.lastAgentProcessCheckAt = 0
            this.lastAgentProcessActive = false
            this.agentCommandActive = false
            this.hideAutocomplete()
        })
        this.alternateScreenSubscription = this.tab.alternateScreenActive$.subscribe(() => {
            this.lineBuffer = ''
            this.lastAutocompletePartial = ''
            this.hideAutocomplete()
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
        const suggestionPosition = this.getSuggestionPositionForHotkey(hotkey)
        if (suggestionPosition !== null) {
            return this.acceptSuggestionAt(suggestionPosition - 1)
        }
        switch (hotkey) {
            case 'llm-autocomplete':
                void this.triggerAutocomplete()
                return true
            case 'llm-accept-suggestion':
                if (this.showAutocomplete && this.suggestions[this.selectedIndex]) {
                    void this.acceptSuggestion(this.suggestions[this.selectedIndex])
                    return true
                }
                return false
            case 'llm-next-suggestion':
                if (this.showAutocomplete) {
                    this.moveSelection(1)
                    return true
                }
                return false
            case 'llm-prev-suggestion':
                if (this.showAutocomplete) {
                    this.moveSelection(-1)
                    return true
                }
                return false
            case 'llm-dismiss':
                if (this.showAutocomplete) {
                    this.hideAutocomplete()
                    return true
                }
                return false
            default:
                return false
        }
    }

    handlePanelKeyEvent (event: KeyboardEvent): boolean {
        if (!this.showAutocomplete) {
            return false
        }
        if (event.type !== 'keydown') {
            return false
        }
        const directSuggestionIndex = this.getDirectSuggestionIndex(event)
        if (directSuggestionIndex !== null) {
            this.acceptSuggestionAt(directSuggestionIndex)
            this.consumePanelKeyEvent(event)
            return true
        }
        if (event.key === 'Escape') {
            this.hideAutocomplete()
            this.consumePanelKeyEvent(event)
            return true
        }
        if (event.ctrlKey && !event.altKey && !event.metaKey) {
            const key = event.key.toLowerCase()
            if (key === 'n') {
                this.moveSelection(1)
                this.consumePanelKeyEvent(event)
                return true
            }
            if (key === 'u') {
                this.moveSelection(-1)
                this.consumePanelKeyEvent(event)
                return true
            }
            if (key === 'y' && this.suggestions[this.selectedIndex]) {
                void this.acceptSuggestion(this.suggestions[this.selectedIndex])
                this.consumePanelKeyEvent(event)
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
        this.llm.cancelAutocompleteRequests(this.tabKey, 'live')
        this.refresh()
    }

    isLightweightHintEnabled (): boolean {
        return this.config.store.llm.lightweightHintEnabled ?? false
    }

    get panelOpacity (): number {
        const raw = this.config.store.llm.autocompletePanelOpacity ?? 20
        return Math.max(5, Math.min(100, Math.round(raw)))
    }

    shouldUseLightweightHint (): boolean {
        return this.isLightweightHintEnabled() && (!!this.getAutocompleteHintText() || this.aiLoading)
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
        return ''
    }

    getAutocompleteStatusText (): string {
        if (this.aiLoading && !this.suggestions.length) {
            return '正在匹配命令…'
        }
        if (!this.suggestions.length) {
            if (!this.hasAnyAutocompleteSourceEnabled()) {
                return '未启用任何补全来源。'
            }
            if (!this.llm.isConfigured() && this.config.store.llm.aiAutocompleteEnabled) {
                return '没有本地匹配项。配置 AI 后可获取生成的建议。'
            }
            return '当前输入没有候选建议。'
        }
        return ''
    }

    async acceptSuggestion (suggestion: AutocompleteSuggestion): Promise<void> {
        const editorMode = this.isEditorMode()
        const execute = !editorMode && !!this.config.store.llm.executeOnConfirm
        if (!editorMode) {
            const allowed = await this.ensureCommandAllowed(suggestion.command, execute)
            if (!allowed) {
                return
            }
        }
        const partial = this.getPartial()
        this.insertCommand(suggestion.command, execute, partial)
        this.hideAutocomplete()
        if (!editorMode) {
            if (execute) {
                const submittedCommand = suggestion.command.trim()
                this.recordSubmittedCommand(submittedCommand)
                this.lineBuffer = ''
                this.inputWasSensitive = false
                this.sensitiveInputLatched = false
                this.startNextCommandPrediction(submittedCommand)
            } else {
                this.lineBuffer = suggestion.command
            }
        }
        this.refresh()
    }

    private async ensureCommandAllowed (command: string, execute: boolean): Promise<boolean> {
        const normalized = normalizeCommand(command) ?? command
        const danger = this.guard.isDangerous(normalized)
        if (!danger.dangerous) {
            return true
        }
        if (!execute && !this.config.store.llm.executeOnConfirm) {
            // Still confirm before inserting known-dangerous suggestions.
        }
        const result = await this.platform.showMessageBox({
            type: 'warning',
            message: this.translate.instant('危险命令需要确认'),
            detail: `${danger.reason ?? 'dangerous'}\n\n${normalized}`,
            buttons: [
                this.translate.instant('仅允许本次'),
                this.translate.instant('拒绝'),
            ],
            defaultId: 1,
            cancelId: 1,
        })
        return result.response === 0
    }

    private moveSelection (delta: number): void {
        if (!this.suggestions.length) {
            return
        }
        const next = this.selectedIndex + delta
        this.selectedIndex = Math.max(0, Math.min(this.suggestions.length - 1, next))
        this.refresh()
    }

    private acceptSuggestionAt (index: number): boolean {
        const suggestion = this.suggestions[index]
        if (!this.showAutocomplete || !suggestion) {
            return false
        }
        this.selectedIndex = index
        this.refresh()
        void this.acceptSuggestion(suggestion)
        return true
    }

    private getSuggestionPositionForHotkey (hotkey: string): number | null {
        const match = /^llm-select-suggestion-([1-9])$/.exec(hotkey)
        return match ? Number(match[1]) : null
    }

    private getDirectSuggestionIndex (event: KeyboardEvent): number | null {
        const stroke = this.getKeyboardEventStroke(event)
        for (let position = 1; position <= MAX_AUTOCOMPLETE_SUGGESTIONS; position++) {
            if (this.hasSingleStrokeHotkey(autocompleteSuggestionHotkeyId(position), stroke)) {
                return position - 1
            }
        }
        return null
    }

    private getKeyboardEventStroke (event: KeyboardEvent): string {
        const eventData: KeyEventData = {
            ctrlKey: event.ctrlKey,
            metaKey: event.metaKey,
            altKey: event.altKey,
            shiftKey: event.shiftKey,
            key: event.key,
            code: event.code,
            eventName: event.type,
            time: event.timeStamp,
            registrationTime: performance.now(),
        }
        const keys = [getKeyName(eventData)]
        if (event.ctrlKey) {
            keys.push('Ctrl')
        }
        if (event.metaKey) {
            keys.push(metaKeyName)
        }
        if (event.altKey) {
            keys.push(altKeyName)
        }
        if (event.shiftKey) {
            keys.push('Shift')
        }
        return getKeystrokeName([...new Set(keys)])
    }

    private hasSingleStrokeHotkey (hotkeyId: string, stroke: string): boolean {
        const configured = this.config.store.hotkeys?.[hotkeyId]
        if (typeof configured === 'string') {
            return configured.toLowerCase() === stroke.toLowerCase()
        }
        if (!Array.isArray(configured)) {
            return false
        }
        return configured.some(binding => {
            if (typeof binding === 'string') {
                return binding.toLowerCase() === stroke.toLowerCase()
            }
            return Array.isArray(binding) && binding.length === 1 &&
                typeof binding[0] === 'string' &&
                binding[0].toLowerCase() === stroke.toLowerCase()
        })
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
        if (this.isEditorMode()) {
            return this.context.getEditorPartialText(this.tab)
        }
        const fromBuffer = this.lineBuffer.trim()
        if (fromBuffer) {
            return fromBuffer
        }
        return this.context.getPartialCommand(this.tab)
    }

    private isEditorMode (): boolean {
        return !!this.tab.alternateScreenActive
    }

    private async fetchAutocomplete (force = false, requestAI = true): Promise<void> {
        if (this.isSensitiveInputActive()) {
            this.lastAutocompletePartial = ''
            this.hideAutocomplete()
            return
        }

        const editorMode = this.isEditorMode()
        const aiEnabled = this.isAIEnabledForCommands() && (editorMode || this.completedCommandCount > 0)
        if (editorMode && (!aiEnabled || !this.isEditorAutocompleteEnabled())) {
            this.lastAutocompletePartial = ''
            this.hideAutocomplete()
            return
        }
        if (!editorMode && !this.hasAnyAutocompleteSourceEnabled()) {
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
        if (await this.isAgentSessionActive()) {
            this.pendingPredictionCommand = null
            this.predictedNextCommands = []
            this.llm.cancelAutocompleteRequests(this.tabKey)
            this.lastAutocompletePartial = ''
            this.hideAutocomplete()
            return
        }
        if (!force && !this.config.store.llm.autoCompleteOnType) {
            return
        }
        if (!editorMode) {
            this.startDeferredNextCommandPrediction(partial)
        }
        if (this.historyBootstrapPromise) {
            await this.historyBootstrapPromise
        }
        const partialChanged = partial !== this.lastAutocompletePartial
        this.lastAutocompletePartial = partial
        const previousIndex = this.selectedIndex
        const previousSuggestions = [...this.suggestions]
        const fetchGeneration = ++this.pendingFetchGeneration
        // Full-screen editors (vim/nano): never use history/script candidates.
        const historyEnabled = !editorMode && this.isHistoryAutocompleteEnabled()
        const scriptEnabled = !editorMode && this.isScriptAutocompleteEnabled()

        this.updatePanelPosition()
        this.showAutocomplete = historyEnabled || scriptEnabled || (requestAI && aiEnabled)
        this.aiLoading = false
        if (partialChanged) {
            this.selectedIndex = 0
        }

        if (historyEnabled && requestAI && this.history.usesRemoteHistory(this.tab)) {
            await this.history.refreshRemoteHistory(this.tab, this.tabKey)
            if (fetchGeneration !== this.pendingFetchGeneration) {
                return
            }
        }

        const historyResults = historyEnabled
            ? this.history.search(partial, this.getHistoryAutocompleteLimit(), this.tabKey, {
                includeGlobal: !this.history.usesRemoteHistory(this.tab),
            })
            : []
        const historySuggestions: AutocompleteSuggestion[] = historyResults.map((r, i) => ({
            id: `history-${i}`,
            command: r.command,
            description: '历史',
            category: 'history' as const,
            confidence: Math.min(1, r.score / 200),
        }))

        const scriptSuggestions = scriptEnabled
            ? this.getScriptSuggestions(partial)
            : []

        const predictedSuggestions = !editorMode
            ? this.filterPredictedSuggestions(partial)
            : []
        const merged = this.rankSuggestions(
            partial,
            ...historySuggestions,
            ...scriptSuggestions,
            ...predictedSuggestions,
        )
        const shouldRequestAI = requestAI && aiEnabled &&
            (force || editorMode || predictedSuggestions.length === 0)
        this.suggestions = merged
        this.showAutocomplete = merged.length > 0 || shouldRequestAI
        this.aiLoading = shouldRequestAI
        if (!partialChanged) {
            this.preserveSelection(previousIndex, previousSuggestions)
        }
        this.refresh()
        this.logger.debug(
            'fetchAutocomplete: editor=%s history=%d script=%d ai_pending=%s',
            editorMode,
            historySuggestions.length,
            scriptSuggestions.length,
            shouldRequestAI,
        )

        if (!shouldRequestAI) {
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
                requestKind: 'live',
                mode: editorMode ? 'editor' : 'shell',
            })
            if (fetchGeneration !== this.pendingFetchGeneration) {
                return
            }
            const indexBeforeMerge = this.selectedIndex
            const suggestionsBeforeMerge = [...this.suggestions]
            const latestPredictedSuggestions = !editorMode
                ? this.filterPredictedSuggestions(partial)
                : []
            this.suggestions = this.rankSuggestions(
                partial,
                ...merged,
                ...latestPredictedSuggestions,
                ...aiSuggestions,
            )
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
                this.notifications.error(this.translate.instant('AI 请求失败：{error}', {
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
        const editorMode = this.isEditorMode()
        const isSensitive = this.isSensitiveInputActive()
        if (isSensitive) {
            this.llm.cancelAutocompleteRequests(this.tabKey)
            this.inputWasSensitive = true
            this.sensitiveInputLatched = true
            this.lineBuffer = ''
            this.lastAutocompletePartial = ''
            this.hideAutocomplete()
        }

        // In vim/nano, do not treat keystrokes as shell lineBuffer / history.
        if (editorMode) {
            this.lineBuffer = ''
            if (isSensitive) {
                return
            }
            if (text === '\r' || text === '\n') {
                this.hideAutocomplete()
                return
            }
            if (this.isAIEnabledForCommands() && this.config.store.llm.autoCompleteOnType) {
                if (!this.isEditorAutocompleteEnabled()) {
                    return
                }
                this.debounceSubject.next()
            }
            return
        }

        if (text.startsWith('\x1b')) {
            this.lineBuffer = this.context.getPartialCommand(this.tab)
            if (!this.lineBuffer) {
                this.hideAutocomplete()
            } else if (this.hasAnyAutocompleteSourceEnabled() && this.config.store.llm.autoCompleteOnType) {
                void this.fetchAutocomplete(false, false)
                this.debounceSubject.next()
            }
            return
        }

        if (text === '\r' || text === '\n') {
            const submittedCommand = this.shouldRecordInputHistory() ? this.lineBuffer.trim() : ''
            this.recordSubmittedCommand(submittedCommand)
            this.lineBuffer = ''
            this.inputWasSensitive = false
            this.sensitiveInputLatched = false
            this.hideAutocomplete()
            this.startNextCommandPrediction(submittedCommand)
            return
        }

        for (const char of text) {
            if (char === '\r' || char === '\n') {
                const submittedCommand = this.shouldRecordInputHistory() ? this.lineBuffer.trim() : ''
                this.recordSubmittedCommand(submittedCommand)
                this.lineBuffer = ''
                this.inputWasSensitive = false
                this.sensitiveInputLatched = false
                this.hideAutocomplete()
                this.startNextCommandPrediction(submittedCommand)
                continue
            }
            if (char === '\x7f' || char === '\b') {
                const chars = Array.from(this.lineBuffer)
                chars.pop()
                this.lineBuffer = chars.join('')
            } else if (char === '\x1b') {
                this.lineBuffer = this.context.getPartialCommand(this.tab)
                return
            } else if (char >= ' ' && !isSensitive) {
                this.lineBuffer += char
            }
        }
        if (!isSensitive && this.hasAnyAutocompleteSourceEnabled() && this.config.store.llm.autoCompleteOnType) {
            void this.fetchAutocomplete(false, false)
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
        const container = this.contentElement
        const pos = this.context.getCursorPosition(this.tab, container ?? undefined)
        if (!pos) {
            return
        }
        const margin = 8
        const containerWidth = container?.clientWidth ?? window.innerWidth
        const containerHeight = container?.clientHeight ?? window.innerHeight
        const offsetX = Math.max(0, this.config.store.llm.autocompletePanelOffsetX ?? 32)
        const offsetY = Math.max(0, this.config.store.llm.autocompletePanelOffsetY ?? 52)
        const preferredBelowY = pos.y + offsetY
        const compactBelowY = pos.y + margin
        const preferredBelowSpace = containerHeight - margin - preferredBelowY
        const compactBelowSpace = containerHeight - margin - compactBelowY
        const minimumUsefulHeight = 112
        const belowY = preferredBelowSpace >= minimumUsefulHeight
            ? preferredBelowY
            : compactBelowY
        const belowSpace = preferredBelowSpace >= minimumUsefulHeight
            ? preferredBelowSpace
            : compactBelowSpace
        const aboveBottom = pos.y - margin
        const aboveSpace = aboveBottom - margin
        const useAbove = belowSpace < minimumUsefulHeight && aboveSpace > belowSpace
        const availableHeight = Math.max(0, useAbove ? aboveSpace : belowSpace)
        this.panelMaxHeight = Math.min(320, availableHeight)
        this.panelPosition = {
            x: Math.max(margin, Math.min(pos.x + offsetX, containerWidth - margin)),
            y: useAbove
                ? Math.max(margin, aboveBottom - this.panelMaxHeight)
                : Math.max(margin, belowY),
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

    private consumePanelKeyEvent (event: KeyboardEvent): void {
        event.preventDefault()
        // xterm's custom handler runs before the event bubbles to document, where
        // HotkeysService would otherwise emit the same panel action again.
        event.stopPropagation()
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
        return !!this.lineBuffer.trim() && !this.inputWasSensitive
    }

    private recordSubmittedCommand (command: string): void {
        if (!command) {
            return
        }
        if (isKnownAgentProcess(command)) {
            this.agentCommandActive = true
            this.lastAgentProcessActive = true
            this.lastAgentProcessCheckAt = Date.now()
        }
        this.history.addCommand(command, {
            tabKey: this.tabKey,
            persistGlobal: !this.history.usesRemoteHistory(this.tab),
        })
        this.completedCommandCount++
        this.predictedNextCommands = []
    }

    private startNextCommandPrediction (previousCommand: string): void {
        this.llm.cancelAutocompleteRequests(this.tabKey, 'prediction')
        this.predictedNextCommands = []
        this.predictionGeneration++
        if (!previousCommand || !this.isAIEnabledForCommands() || isKnownAgentProcess(previousCommand)) {
            this.pendingPredictionCommand = null
            return
        }
        this.pendingPredictionCommand = previousCommand
    }

    private startDeferredNextCommandPrediction (partial: string): void {
        if (!this.pendingPredictionCommand || !this.shouldTriggerForPartial(partial, false)) {
            return
        }
        const previousCommand = this.pendingPredictionCommand
        this.pendingPredictionCommand = null
        const generation = ++this.predictionGeneration
        void this.prefetchNextCommands(previousCommand, generation)
    }

    private async prefetchNextCommands (previousCommand: string, generation: number): Promise<void> {
        try {
            if (await this.isAgentSessionActive()) {
                return
            }
            const ctx = await this.context.collectContext(this.tab)
            if (generation !== this.predictionGeneration) {
                return
            }
            const recentOutput = this.llm.redactOutput(
                this.context.getRecentOutput(this.tab, this.config.store.llm.maxContextLines ?? 20),
            )
            const suggestions = await this.llm.getAutocompleteSuggestions({
                tabKey: this.tabKey,
                partialCommand: '',
                previousCommand,
                cwd: ctx.cwd,
                shell: ctx.shell,
                os: ctx.os,
                recentOutput,
                excludeCommands: [previousCommand],
                requestKind: 'prediction',
                mode: 'shell',
            })
            if (generation === this.predictionGeneration) {
                this.predictedNextCommands = suggestions.map((suggestion, index) => ({
                    ...suggestion,
                    id: `prediction-${generation}-${index}`,
                }))
                this.mergeMatchingPredictionsIntoCurrentAutocomplete()
            }
        } catch (e) {
            this.logger.debug('Next-command prediction failed:', e)
        }
    }

    private mergeMatchingPredictionsIntoCurrentAutocomplete (): void {
        if (this.isEditorMode() || this.isSensitiveInputActive() || !this.config.store.llm.autoCompleteOnType) {
            return
        }
        const partial = this.getPartial()
        if (partial !== this.lastAutocompletePartial || !this.shouldTriggerForPartial(partial, false)) {
            return
        }
        const matchingPredictions = this.filterPredictedSuggestions(partial)
        if (!matchingPredictions.length) {
            return
        }
        const previousIndex = this.selectedIndex
        const previousSuggestions = [...this.suggestions]
        this.suggestions = this.rankSuggestions(partial, ...this.suggestions, ...matchingPredictions)
        this.preserveSelection(previousIndex, previousSuggestions)
        this.showAutocomplete = this.suggestions.length > 0
        this.updatePanelPosition()
        this.refresh()
    }

    private isHistoryAutocompleteEnabled (): boolean {
        return this.config.store.llm.historyAutocompleteEnabled ?? true
    }

    private getHistoryAutocompleteLimit (): number {
        const limit = this.config.store.llm.historyAutocompleteLimit ?? 10
        return Math.max(1, Math.min(50, limit))
    }

    private isEditorAutocompleteEnabled (): boolean {
        return this.config.store.llm.editorAutocompleteEnabled ?? false
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
        const minLen = Math.max(2, this.config.store.llm.minTriggerLength ?? 2)
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

    private async isAgentSessionActive (): Promise<boolean> {
        const now = Date.now()
        if (now - this.lastAgentProcessCheckAt < 750) {
            return this.lastAgentProcessActive
        }
        if (this.agentProcessCheckPromise) {
            return this.agentProcessCheckPromise
        }

        const session = this.tab.session as any
        const getChildProcesses = session?.getChildProcesses
        if (typeof getChildProcesses !== 'function') {
            this.lastAgentProcessCheckAt = now
            this.lastAgentProcessActive = false
            return false
        }

        this.agentProcessCheckPromise = Promise.resolve(getChildProcesses.call(session))
            .then((processes: unknown) => {
                const processList = Array.isArray(processes) ? processes : []
                const active = processList.some(
                    process => isKnownAgentProcess(String(process?.command ?? process?.name ?? '')),
                ) || (this.agentCommandActive && processList.length > 0)
                this.lastAgentProcessCheckAt = Date.now()
                this.lastAgentProcessActive = active
                this.agentCommandActive = active
                return active
            })
            .catch(error => {
                this.logger.debug('Agent process detection failed:', error)
                this.lastAgentProcessCheckAt = Date.now()
                this.lastAgentProcessActive = this.agentCommandActive
                return this.agentCommandActive
            })
            .finally(() => {
                this.agentProcessCheckPromise = null
            })
        return this.agentProcessCheckPromise
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
                description: '登录脚本',
                category: 'script' as const,
                confidence: 0.5,
            })
            if (results.length >= 5) {
                break
            }
        }
        return results
    }

    private wordStartsWith (command: string, partial: string): boolean {
        return command
            .split(/[\s/._-]+/)
            .some(word => word.startsWith(partial))
    }

    private filterPredictedSuggestions (partial: string): AutocompleteSuggestion[] {
        const lower = partial.trim().toLowerCase()
        return this.predictedNextCommands.filter(suggestion => this.matchScore(suggestion.command, lower) > 0)
    }

    private rankSuggestions (partial: string, ...suggestions: AutocompleteSuggestion[]): AutocompleteSuggestion[] {
        const lower = partial.trim().toLowerCase()
        const best = new Map<string, { suggestion: AutocompleteSuggestion, score: number }>()
        for (const suggestion of suggestions) {
            const key = this.suggestionKey(suggestion.command)
            const match = this.matchScore(suggestion.command, lower)
            if (!key || match <= 0) {
                continue
            }
            const confidence = Math.max(0, Math.min(1, suggestion.confidence ?? 0.65))
            const score = confidence * match
            const existing = best.get(key)
            if (!existing || score > existing.score) {
                best.set(key, { suggestion, score })
            }
        }
        return Array.from(best.values())
            .sort((a, b) => b.score - a.score)
            .map(item => item.suggestion)
            .slice(0, MAX_AUTOCOMPLETE_SUGGESTIONS)
    }

    private matchScore (command: string, partial: string): number {
        if (!partial) {
            return 1
        }
        const lower = command.toLowerCase()
        if (lower === partial) {
            return 1
        }
        if (lower.startsWith(partial)) {
            return 0.9 + Math.min(0.1, partial.length / Math.max(lower.length, 1) * 0.1)
        }
        if (this.wordStartsWith(lower, partial)) {
            return 0.75
        }
        return lower.includes(partial) ? 0.55 : 0
    }

    private suggestionKey (command: string): string {
        const normalized = normalizeCommand(command, { allowMultiline: true }) ?? command.trim()
        return normalized.replace(/\s+/g, ' ').toLowerCase()
    }
}
