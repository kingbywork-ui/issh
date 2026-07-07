import { ApplicationRef, ComponentRef, createComponent, EnvironmentInjector, Injectable } from '@angular/core'
import { Subscription } from 'rxjs'
import { AppPanelService, AppService, BaseTabComponent, SplitTabComponent } from 'tabby-core'
import { BaseTerminalTabComponent } from 'tabby-terminal'
import { LLMAppSidecarHostComponent } from '../components/llmAppSidecarHost.component'
import { TabLLMController } from '../tabLLMController'

/** @hidden */
@Injectable({ providedIn: 'root' })
export class LLMAppPanelService {
    private sidecarHostRef: ComponentRef<LLMAppSidecarHostComponent> | null = null
    private controllers = new Map<BaseTerminalTabComponent<any>, TabLLMController>()
    private activeController: TabLLMController | null = null
    private activeSplitSubscription?: Subscription

    constructor (
        private appPanel: AppPanelService,
        private app: AppService,
        private injector: EnvironmentInjector,
        private appRef: ApplicationRef,
    ) {
        this.app.activeTabChange$.subscribe(tab => {
            this.watchActiveSplit(tab)
            this.syncActiveController()
        })
        this.appPanel.slotRegistered$.subscribe(() => {
            this.syncActiveController()
        })
        this.watchActiveSplit(this.app.activeTab)
    }

    ensureSidecarHost (): LLMAppSidecarHostComponent | null {
        const slot = this.appPanel.getSlotElement('right')
        if (!slot) {
            return null
        }
        if (!this.sidecarHostRef) {
            this.sidecarHostRef = createComponent(LLMAppSidecarHostComponent, {
                environmentInjector: this.injector,
            })
            this.appRef.attachView(this.sidecarHostRef.hostView)
            slot.appendChild(this.sidecarHostRef.location.nativeElement)
        }
        return this.sidecarHostRef.instance
    }

    registerController (tab: BaseTerminalTabComponent<any>, controller: TabLLMController): void {
        this.controllers.set(tab, controller)
        controller.setAppPanelService(this)
        this.syncActiveController()
    }

    unregisterController (tab: BaseTerminalTabComponent<any>): void {
        const controller = this.controllers.get(tab)
        this.controllers.delete(tab)
        if (this.activeController === controller) {
            this.syncActiveController()
        }
    }

    onSidecarVisibilityChanged (controller: TabLLMController): void {
        this.syncActiveController()
        if (this.activeController !== controller) {
            return
        }
        this.ensureSidecarHost()
        this.appPanel.setPanelVisible('right', controller.sidecarVisible)
    }

    private syncActiveController (): void {
        const tab = this.resolveActiveTerminalTab()
        this.activeController = tab ? this.controllers.get(tab) ?? null : null
        this.bindActiveController()
    }

    private watchActiveSplit (tab: BaseTabComponent | null): void {
        this.activeSplitSubscription?.unsubscribe()
        this.activeSplitSubscription = undefined
        if (!(tab instanceof SplitTabComponent)) {
            return
        }
        this.activeSplitSubscription = tab.focusChanged$.subscribe(() => {
            this.syncActiveController()
        })
    }

    private resolveActiveTerminalTab (tab: BaseTabComponent | null = this.app.activeTab): BaseTerminalTabComponent<any> | null {
        if (tab instanceof BaseTerminalTabComponent) {
            return tab
        }
        if (tab instanceof SplitTabComponent) {
            const focused = this.resolveActiveTerminalTab(tab.getFocusedTab())
            if (focused) {
                return focused
            }
            return tab.getAllTabs().find(item => item instanceof BaseTerminalTabComponent) as BaseTerminalTabComponent<any> | undefined ?? null
        }
        return null
    }

    private bindActiveController (): void {
        const host = this.ensureSidecarHost()
        host?.bindController(this.activeController ?? undefined)
        this.appPanel.setPanelVisible('right', !!this.activeController?.sidecarVisible)
    }
}
