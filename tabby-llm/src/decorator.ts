import { ApplicationRef, EnvironmentInjector, Injectable } from '@angular/core'
import { ConfigService, HotkeysService, LogService, NotificationsService, PlatformService, TranslateService } from 'tabby-core'
import { BaseTerminalTabComponent, TerminalDecorator, XTermFrontend } from 'tabby-terminal'
import { TabLLMController } from './tabLLMController'
import { LLMService } from './services/llm.service'
import { TerminalContextService } from './services/terminalContext.service'
import { HistoryCommandService } from './services/historyCommand.service'
import { SensitiveInputService } from './services/sensitiveInput.service'
import { AgentBridgeService } from './services/agentBridge.service'

/** @hidden */
@Injectable()
export class LLMDecorator extends TerminalDecorator {
    private controllers = new Map<BaseTerminalTabComponent<any>, TabLLMController>()

    constructor (
        private llm: LLMService,
        private context: TerminalContextService,
        private history: HistoryCommandService,
        private sensitiveInput: SensitiveInputService,
        private config: ConfigService,
        private hotkeys: HotkeysService,
        private notifications: NotificationsService,
        private translate: TranslateService,
        private injector: EnvironmentInjector,
        private appRef: ApplicationRef,
        private log: LogService,
        private agentBridge: AgentBridgeService,
        private platform: PlatformService,
    ) {
        super()
    }

    attach (tab: BaseTerminalTabComponent<any>): void {
        if (!(tab.frontend instanceof XTermFrontend)) {
            return
        }

        const setup = () => {
            if (this.controllers.has(tab)) {
                return
            }
            const content = tab.content?.nativeElement
            if (!content) {
                return
            }

            const controller = new TabLLMController(
                tab,
                this.llm,
                this.context,
                this.history,
                this.sensitiveInput,
                this.config,
                this.notifications,
                this.translate,
                this.injector,
                this.appRef,
                this.log,
                this.platform,
            )
            controller.mount(content)
            controller.start()
            this.controllers.set(tab, controller)
            this.agentBridge.registerController(tab, controller)

            this.subscribeUntilDetached(tab, this.hotkeys.hotkey$.subscribe(hotkey => {
                if (!tab.hasFocus) {
                    return
                }
                controller.handleHotkey(hotkey)
            }))
        }

        if (tab.frontendIsReady) {
            setTimeout(() => {
                if (this.controllers.has(tab) || !tab.content?.nativeElement) {
                    return
                }
                setup()
            })
        } else {
            this.subscribeUntilDetached(tab, tab.frontendReady.subscribe(() => setTimeout(() => {
                if (this.controllers.has(tab) || !tab.content?.nativeElement) {
                    return
                }
                setup()
            })))
        }
    }

    detach (tab: BaseTerminalTabComponent<any>): void {
        const controller = this.controllers.get(tab)
        if (controller) {
            controller.destroy()
            this.agentBridge.unregisterController(tab)
            this.controllers.delete(tab)
        }
        super.detach(tab)
    }
}
