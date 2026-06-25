import { ApplicationRef, ComponentRef, createComponent, EnvironmentInjector } from '@angular/core'
import { Subject, Subscription, debounce, timer } from 'rxjs'
import { ConfigService, NotificationsService, PlatformService, TranslateService } from 'tabby-core'
import { BaseTerminalTabComponent, XTermFrontend } from 'tabby-terminal'
import { AutocompleteSuggestion } from './api'
import { LLMTerminalHostComponent } from './components/llmTerminalHost.component'
import { LLMService } from './services/llm.service'
import { TerminalContextService } from './services/terminalContext.service'
import { HistoryCommandService } from './services/historyCommand.service'

/** @hidden */
export class TabLLMController {
    showAutocomplete = false
    showNL2 = false
    autocompleteLoading = false
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

    constructor (
        private tab: BaseTerminalTabComponent<any>,
        private llm: LLMService,
        private context: TerminalContextService,
        private history: HistoryCommandService,
        private config: ConfigService,
        private notifications: NotificationsService,
        private translate: TranslateService,
        private platform: PlatformService,
        private injector: EnvironmentInjector,
        private appRef: ApplicationRef,
    ) {
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
                if (!this.llm.isConfigured()) {
                    this.notifications.notice(this.translate.instant('Configure AI assistant in Settings first'))
                    return false
                }
                this.openNL2()
                return true
            case 'llm-accept-suggestion':
                if (this.showAutocomplete && this.suggestions[this.selectedIndex]) {
                    this.acceptSuggestion(this.suggestions[this.selectedIndex])
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
                if (this.showAutocomplete || this.showNL2) {
                    this.hideAutocomplete()
                    this.hideNL2()
                    return true
                }
                return false
            default:
                return false
        }
    }

    handlePanelKeyEvent (event: KeyboardEvent): boolean {
        if (!this.showAutocomplete && !this.showNL2) {
            return false
        }
        if (event.type !== 'keydown') {
            return false
        }
        if (event.key === 'Escape') {
            this.hideAutocomplete()
            this.hideNL2()
            event.preventDefault()
            return true
        }
        if (this.showNL2) {
            return false
        }
        return false
    }

    async triggerAutocomplete (): Promise<void> {
        this.history.bootstrapFromTerminal(this.tab)
        await this.historyBootstrapPromise
        await this.fetchAutocomplete(true)
    }

    hideAutocomplete (): void {
        this.showAutocomplete = false
        this.autocompleteLoading = false
        this.aiLoading = false
        this.pendingFetchGeneration++
        this.llm.cancelPending()
        this.refresh()
    }

    openNL2 (): void {
        if (!this.llm.isConfigured()) {
            this.notifications.notice(this.translate.instant('Configure AI assistant in Settings first'))
            return
        }
        this.hideAutocomplete()
        this.showNL2 = true
        this.nl2Input = ''
        this.nl2ResultCommand = ''
        this.nl2ResultExplanation = ''
        this.nl2Dangerous = false
        this.nl2DangerReason = ''
        this.refresh()
    }

    hideNL2 (): void {
        this.showNL2 = false
        this.nl2Loading = false
        this.llm.cancelPending()
        this.refresh()
    }

    async convertNL2 (): Promise<void> {
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
    }

    acceptSuggestion (suggestion: AutocompleteSuggestion): void {
        const partial = this.getPartial()
        this.insertCommand(suggestion.command, false, partial)
        this.history.addCommand(suggestion.command)
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
        const partial = this.getPartial()
        if (!partial.trim() || partial.trim().length < 2) {
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

        this.updatePanelPosition()
        this.showAutocomplete = true
        this.aiLoading = this.llm.isConfigured()
        this.autocompleteLoading = false
        if (partialChanged) {
            this.selectedIndex = 0
        }

        const historyResults = this.history.search(partial, 3)
        const historySuggestions: AutocompleteSuggestion[] = historyResults.map((r, i) => ({
            id: `history-${i}`,
            command: r.command,
            description: 'History',
            category: 'history' as const,
            confidence: Math.min(1, r.score / 200),
        }))
        this.suggestions = historySuggestions
        if (!partialChanged) {
            this.preserveSelection(previousIndex, previousSuggestions)
        }
        this.refresh()

        if (!this.llm.isConfigured()) {
            if (!historySuggestions.length) {
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
                partialCommand: partial,
                cwd: ctx.cwd,
                shell: ctx.shell,
                os: ctx.os,
                recentOutput,
                excludeCommands: historySuggestions.map(s => s.command),
            })
            if (fetchGeneration !== this.pendingFetchGeneration) {
                return
            }
            const historySet = new Set(historySuggestions.map(s => s.command))
            const deduped = aiSuggestions.filter(s => !historySet.has(s.command))
            const indexBeforeMerge = this.selectedIndex
            const suggestionsBeforeMerge = [...this.suggestions]
            this.suggestions = [...historySuggestions, ...deduped]
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
            if (!historySuggestions.length) {
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

        if (text.startsWith('\x1b')) {
            this.lineBuffer = this.context.getPartialCommand(this.tab)
            if (!this.lineBuffer) {
                this.hideAutocomplete()
            }
            return
        }

        if (text === '\r' || text === '\n') {
            if (this.lineBuffer.trim()) {
                this.history.addCommand(this.lineBuffer.trim())
            }
            this.lineBuffer = ''
            this.hideAutocomplete()
            return
        }

        for (const char of text) {
            if (char === '\r' || char === '\n') {
                if (this.lineBuffer.trim()) {
                    this.history.addCommand(this.lineBuffer.trim())
                }
                this.lineBuffer = ''
                this.hideAutocomplete()
                continue
            }
            if (char === '\x7f' || char === '\b') {
                this.lineBuffer = this.lineBuffer.slice(0, -1)
            } else if (char === '\x1b') {
                this.lineBuffer = this.context.getPartialCommand(this.tab)
                return
            } else if (char >= ' ' || char === '\t') {
                this.lineBuffer += char
            }
        }
        if (this.config.store.llm.enabled && this.config.store.llm.autoCompleteOnType) {
            this.debounceSubject.next()
        }
    }

    private insertCommand (command: string, execute: boolean, partial?: string): void {
        const current = partial ?? this.lineBuffer
        let toSend = command
        if (current && command.startsWith(current)) {
            toSend = command.substring(current.length)
        } else if (current) {
            toSend = '\x7f'.repeat(current.length) + command
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
}
