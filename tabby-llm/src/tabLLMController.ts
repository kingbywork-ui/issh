import { ApplicationRef, ComponentRef, createComponent, EnvironmentInjector } from '@angular/core'
import { Subject, Subscription, debounce, timer } from 'rxjs'
import { ConfigService, NotificationsService, PlatformService, TranslateService } from 'tabby-core'
import { BaseTerminalTabComponent, XTermFrontend } from 'tabby-terminal'
import { AutocompleteSuggestion } from './api'
import { LLMTerminalHostComponent } from './components/llmTerminalHost.component'
import { LLMService } from './services/llm.service'
import { TerminalContextService } from './services/terminalContext.service'

/** @hidden */
export class TabLLMController {
    showAutocomplete = false
    showNL2 = false
    autocompleteLoading = false
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

    constructor (
        private tab: BaseTerminalTabComponent<any>,
        private llm: LLMService,
        private context: TerminalContextService,
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
        this.inputSubscription = this.tab.input$.subscribe(data => {
            this.handleInput(data)
        })
    }

    handleHotkey (hotkey: string): boolean {
        if (!this.llm.isConfigured()) {
            return false
        }
        switch (hotkey) {
            case 'llm-autocomplete':
                void this.triggerAutocomplete()
                return true
            case 'llm-nl2command':
                this.openNL2()
                return true
            case 'llm-accept-suggestion':
                if (this.showAutocomplete && this.suggestions[this.selectedIndex]) {
                    this.acceptSuggestion(this.suggestions[this.selectedIndex])
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
        if (this.showNL2 && !this.nl2ResultCommand) {
            return false
        }
        if (event.key === 'Escape') {
            this.hideAutocomplete()
            this.hideNL2()
            event.preventDefault()
            return true
        }
        if (this.showAutocomplete) {
            if (event.key === 'ArrowDown') {
                this.moveSelection(1)
                event.preventDefault()
                return true
            }
            if (event.key === 'ArrowUp') {
                this.moveSelection(-1)
                event.preventDefault()
                return true
            }
            if (event.key === 'Tab' || event.key === 'Enter') {
                const suggestion = this.suggestions[this.selectedIndex]
                if (suggestion) {
                    this.acceptSuggestion(suggestion)
                    event.preventDefault()
                    return true
                }
            }
        }
        return false
    }

    async triggerAutocomplete (): Promise<void> {
        if (!this.llm.isConfigured()) {
            this.notifications.notice(this.translate.instant('Configure AI assistant in Settings first'))
            return
        }
        await this.fetchAutocomplete(true)
    }

    hideAutocomplete (): void {
        this.showAutocomplete = false
        this.autocompleteLoading = false
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
        const partial = this.lineBuffer || this.context.getCurrentLine(this.tab)
        this.insertCommand(suggestion.command, false, partial)
        this.hideAutocomplete()
        this.lineBuffer = suggestion.command
        this.refresh()
    }

    private moveSelection (delta: number): void {
        if (!this.suggestions.length) {
            return
        }
        this.selectedIndex = (this.selectedIndex + delta + this.suggestions.length) % this.suggestions.length
        this.refresh()
    }

    private async fetchAutocomplete (force = false): Promise<void> {
        const partial = this.lineBuffer || this.context.getCurrentLine(this.tab)
        if (!partial.trim() || partial.trim().length < 2) {
            this.hideAutocomplete()
            return
        }
        if (!force && !this.config.store.llm.autoCompleteOnType) {
            return
        }
        this.updatePanelPosition()
        this.showAutocomplete = true
        this.autocompleteLoading = true
        this.refresh()

        try {
            const ctx = await this.context.collectContext(this.tab)
            const recentOutput = this.llm.redactOutput(
                this.context.getRecentOutput(this.tab, this.config.store.llm.maxContextLines ?? 20),
            )
            const suggestions = await this.llm.getAutocompleteSuggestions({
                partialCommand: partial,
                cwd: ctx.cwd,
                shell: ctx.shell,
                os: ctx.os,
                recentOutput,
            })
            this.suggestions = suggestions
            this.selectedIndex = 0
            if (!suggestions.length && !force) {
                this.showAutocomplete = false
            }
        } catch (e) {
            if (force) {
                this.notifications.error(this.translate.instant('AI request failed: {error}', {
                    error: e instanceof Error ? e.message : String(e),
                }))
            }
            this.showAutocomplete = false
        } finally {
            this.autocompleteLoading = false
            this.refresh()
        }
    }

    private handleInput (data: Buffer): void {
        const text = data.toString('utf-8')
        for (const char of text) {
            if (char === '\r' || char === '\n') {
                this.lineBuffer = ''
                this.hideAutocomplete()
                continue
            }
            if (char === '\x7f' || char === '\b') {
                this.lineBuffer = this.lineBuffer.slice(0, -1)
            } else if (char >= ' ' || char === '\t') {
                this.lineBuffer += char
            }
        }
        if (this.config.store.llm.enabled && this.config.store.llm.autoCompleteOnType && this.llm.isConfigured()) {
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
