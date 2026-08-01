import { ApplicationRef, ComponentRef, createComponent, EnvironmentInjector, Injectable, OnDestroy } from '@angular/core'
import { Subscription } from 'rxjs'
import { AppPanelService, AppService, BaseTabComponent, SplitTabComponent } from 'issh-core'
import { BaseTerminalTabComponent, BatchInputPanelComponent } from 'issh-terminal'
import { SFTPPanelComponent } from '../components/sftpPanel.component'
import { SSHTabComponent } from '../components/sshTab.component'

/** @hidden */
@Injectable({ providedIn: 'root' })
export class SSHAppPanelService implements OnDestroy {
    private tabs = new Set<SSHTabComponent>()
    private sftpRef: ComponentRef<SFTPPanelComponent> | null = null
    private sendRef: ComponentRef<BatchInputPanelComponent> | null = null
    private activeTab: SSHTabComponent | null = null
    private sendPanelVisible = false
    private sendPanelTab: BaseTerminalTabComponent<any> | null = null
    private activeSplitSubscription?: Subscription
    private subscriptions = new Subscription()
    private sftpPanelSubscriptions = new Subscription()
    private retryTimers = new Set<ReturnType<typeof setTimeout>>()

    constructor (
        private appPanel: AppPanelService,
        private app: AppService,
        private injector: EnvironmentInjector,
        private appRef: ApplicationRef,
    ) {
        this.subscriptions.add(this.app.activeTabChange$.subscribe(tab => {
            this.watchActiveSplit(tab)
            const activeTerminal = this.resolveTerminalTab(tab)
            if (this.isSshTab(activeTerminal)) {
                this.activeTab = activeTerminal
            } else if (this.activeTab && activeTerminal !== this.activeTab) {
                this.activeTab = null
            }
            if (activeTerminal?.session?.open) {
                this.sendPanelTab = activeTerminal
                this.sendRef?.instance.setCurrentTab(activeTerminal)
            }
            this.syncPanels()
        }))
        this.subscriptions.add(this.appPanel.slotRegistered$.subscribe(() => {
            this.syncPanels()
        }))
        this.watchActiveSplit(this.app.activeTab)
    }

    registerTab (tab: SSHTabComponent): void {
        this.tabs.add(tab)
        if (this.resolveTerminalTab() === tab) {
            this.activeTab = tab
        }
        if (tab.sendPanelVisible) {
            this.sendPanelVisible = true
            this.sendPanelTab = tab
        }
        this.syncPanels()
    }

    unregisterTab (tab: SSHTabComponent): void {
        this.tabs.delete(tab)
        if (this.activeTab === tab) {
            this.activeTab = null
        }
        if (this.sendPanelTab === tab) {
            this.sendPanelTab = this.findCurrentTerminalTab()
        }
        this.sendPanelVisible = this.sendPanelVisible && !!this.sendPanelTab
        this.syncPanels()
    }

    syncFromTab (tab: SSHTabComponent): void {
        if (!this.tabs.has(tab) || this.resolveTerminalTab() !== tab) {
            return
        }
        this.activeTab = tab
        if (tab.sendPanelVisible) {
            this.sendPanelVisible = true
            this.sendPanelTab = tab
        } else if (this.sendPanelTab === tab) {
            this.sendPanelVisible = false
            for (const item of this.tabs) {
                item.sendPanelVisible = false
            }
        }
        this.syncPanels()
    }

    private isSshTab (tab: unknown): tab is SSHTabComponent {
        return !!tab && typeof tab === 'object' && 'toggleSendPanel' in tab && 'openSFTP' in tab
    }

    ngOnDestroy (): void {
        this.subscriptions.unsubscribe()
        this.activeSplitSubscription?.unsubscribe()
        for (const timer of this.retryTimers) {
            clearTimeout(timer)
        }
        this.retryTimers.clear()
        this.destroySftpPanel()
        this.destroySendPanel()
    }

    private watchActiveSplit (tab: BaseTabComponent | null): void {
        this.activeSplitSubscription?.unsubscribe()
        this.activeSplitSubscription = undefined
        if (!(tab instanceof SplitTabComponent)) {
            return
        }
        this.activeSplitSubscription = tab.focusChanged$.subscribe(() => {
            const activeTerminal = this.resolveTerminalTab(tab)
            this.activeTab = this.isSshTab(activeTerminal) ? activeTerminal : null
            if (activeTerminal?.session?.open) {
                this.sendPanelTab = activeTerminal
                this.sendRef?.instance.setCurrentTab(activeTerminal)
            }
            this.syncPanels()
        })
    }

    private syncPanels (): void {
        const tab = this.activeTab
        if (!tab || !this.tabs.has(tab)) {
            this.appPanel.setPanelVisible('left', false)
            this.destroySftpPanel()
            this.syncSendPanel()
            this.appPanel.notifyResize()
            return
        }

        if (tab.sftpPanelVisible && tab.sshSession) {
            this.mountSftpPanel(tab)
            this.appPanel.setPanelVisible('left', true)
        } else {
            this.destroySftpPanel()
            this.appPanel.setPanelVisible('left', false)
        }

        this.syncSendPanel()
        this.appPanel.notifyResize()
    }

    private syncSendPanel (): void {
        if (this.sendPanelVisible && !this.sendPanelTab) {
            this.sendPanelTab = this.findCurrentTerminalTab()
        }
        if (this.sendPanelVisible && this.sendPanelTab) {
            this.mountSendPanel(this.sendPanelTab)
            this.appPanel.setPanelVisible('bottom', true)
        } else {
            this.destroySendPanel()
            this.appPanel.setPanelVisible('bottom', false)
        }
    }

    private mountSftpPanel (tab: SSHTabComponent): void {
        const slot = this.appPanel.getSlotElement('left')
        if (!slot || !tab.sshSession) {
            this.scheduleSync()
            return
        }

        if (this.sftpRef) {
            const inst = this.sftpRef.instance
            if (inst.session === tab.sshSession) {
                inst.path = tab.sftpPath
                inst.cwdDetectionAvailable = tab.session?.supportsWorkingDirectory() ?? false
                return
            }
            this.destroySftpPanel()
        }

        this.sftpRef = createComponent(SFTPPanelComponent, {
            environmentInjector: this.injector,
        })
        const inst = this.sftpRef.instance
        inst.session = tab.sshSession
        inst.path = tab.sftpPath
        inst.cwdDetectionAvailable = tab.session?.supportsWorkingDirectory() ?? false
        this.sftpPanelSubscriptions.add(inst.pathChange.subscribe(path => {
            tab.sftpPath = path
        }))
        this.sftpPanelSubscriptions.add(inst.closed.subscribe(() => {
            tab.onSftpPanelClosed()
        }))
        this.appRef.attachView(this.sftpRef.hostView)
        slot.appendChild(this.sftpRef.location.nativeElement)
    }

    private mountSendPanel (tab: BaseTerminalTabComponent<any>): void {
        const slot = this.appPanel.getSlotElement('bottom')
        if (!slot) {
            this.scheduleSync()
            return
        }

        if (this.sendRef) {
            if (this.sendRef.instance.tab === tab) {
                this.sendRef.instance.refreshTargets()
                return
            }
            this.sendRef.instance.setCurrentTab(tab)
            return
        }

        this.sendRef = createComponent(BatchInputPanelComponent, {
            environmentInjector: this.injector,
        })
        this.sendRef.instance.tab = tab
        this.sendRef.instance.closed.subscribe(() => {
            this.closeSendPanel()
        })
        this.appRef.attachView(this.sendRef.hostView)
        slot.appendChild(this.sendRef.location.nativeElement)
    }

    private closeSendPanel (): void {
        this.sendPanelVisible = false
        for (const tab of this.tabs) {
            tab.sendPanelVisible = false
        }
        this.syncPanels()
    }

    private destroySftpPanel (): void {
        if (!this.sftpRef) {
            return
        }
        this.sftpPanelSubscriptions.unsubscribe()
        this.sftpPanelSubscriptions = new Subscription()
        void this.sftpRef.instance.sftp?.close().catch(() => null)
        this.appRef.detachView(this.sftpRef.hostView)
        this.sftpRef.destroy()
        this.sftpRef = null
    }

    private destroySendPanel (): void {
        if (!this.sendRef) {
            return
        }
        this.appRef.detachView(this.sendRef.hostView)
        this.sendRef.destroy()
        this.sendRef = null
    }

    private findCurrentTerminalTab (): BaseTerminalTabComponent<any> | null {
        const active = this.resolveTerminalTab()
        if (active?.session?.open) {
            return active
        }
        for (const tab of this.tabs) {
            if (tab.session?.open) {
                return tab
            }
        }
        return null
    }

    private resolveTerminalTab (tab: BaseTabComponent | null = this.app.activeTab): BaseTerminalTabComponent<any> | null {
        if (tab instanceof BaseTerminalTabComponent) {
            return tab
        }
        if (tab instanceof SplitTabComponent) {
            const focused = this.resolveTerminalTab(tab.getFocusedTab())
            if (focused) {
                return focused
            }
            return tab.getAllTabs().find(item => item instanceof BaseTerminalTabComponent) as BaseTerminalTabComponent<any> | undefined ?? null
        }
        return null
    }

    private scheduleSync (): void {
        const timer = setTimeout(() => {
            this.retryTimers.delete(timer)
            this.syncPanels()
        }, 100)
        this.retryTimers.add(timer)
    }
}
