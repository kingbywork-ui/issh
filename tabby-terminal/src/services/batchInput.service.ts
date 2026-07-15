import { Injectable } from '@angular/core'
import { NgbModal } from '@ng-bootstrap/ng-bootstrap'
import { AppService, BaseTabComponent, NotificationsService, SplitTabComponent, TranslateService } from 'tabby-core'
import { BaseTerminalTabComponent } from '../api/baseTerminalTab.component'
import { BatchInputModalComponent } from '../components/batchInputModal.component'

export interface BatchInputTarget {
    id: string
    title: string
    description: string
    icon?: string|null
    color?: string|null
    tab: BaseTerminalTabComponent<any>
}

/** @hidden */
@Injectable({ providedIn: 'root' })
export class BatchInputService {
    private readonly targetIds = new WeakMap<BaseTerminalTabComponent<any>, string>()
    private nextTargetId = 1

    constructor (
        private app: AppService,
        private ngbModal: NgbModal,
        private notifications: NotificationsService,
        private translate: TranslateService,
    ) { }

    open (currentTab: BaseTerminalTabComponent<any>): void {
        const targets = this.getTargets()
        if (!targets.length) {
            this.notifications.error(this.translate.instant('No terminal tabs are available'))
            return
        }

        const modal = this.ngbModal.open(BatchInputModalComponent, {
            size: 'lg',
        })
        const instance = modal.componentInstance as BatchInputModalComponent
        instance.currentTab = currentTab
        instance.targets = targets
    }

    getTargets (): BatchInputTarget[] {
        return this.flattenTabs(this.app.tabs)
            .filter(tab => !!tab.session?.open)
            .map((tab, index) => ({
                id: this.getTargetId(tab),
                title: tab.customTitle || tab.title,
                description: this.getDescription(tab, index),
                icon: tab.icon,
                color: tab.color,
                tab,
            }))
    }

    send (tabs: BaseTerminalTabComponent<any>[], text: string, appendNewline: boolean): number {
        const payload = appendNewline ? `${text}\r` : text
        for (const tab of tabs) {
            tab.sendInput(payload)
        }
        return tabs.length
    }

    private flattenTabs (tabs: BaseTabComponent[]): BaseTerminalTabComponent<any>[] {
        return tabs.flatMap(tab => {
            if (tab instanceof BaseTerminalTabComponent) {
                return [tab]
            }
            if (tab instanceof SplitTabComponent) {
                return tab.getAllTabs().filter(t => t instanceof BaseTerminalTabComponent) as BaseTerminalTabComponent<any>[]
            }
            return []
        })
    }

    private getTargetId (tab: BaseTerminalTabComponent<any>): string {
        let id = this.targetIds.get(tab)
        if (!id) {
            id = `terminal-${this.nextTargetId++}`
            this.targetIds.set(tab, id)
        }
        return id
    }

    private getDescription (tab: BaseTerminalTabComponent<any>, index: number): string {
        const topLevelIndex = this.getTopLevelIndex(tab)
        if (topLevelIndex !== null) {
            return this.translate.instant('Window tab {number}', { number: topLevelIndex + 1 })
        }
        return this.translate.instant('Terminal {number}', { number: index + 1 })
    }

    private getTopLevelIndex (tab: BaseTerminalTabComponent<any>): number|null {
        const top = tab.topmostParent
        if (!top) {
            return null
        }
        const index = this.app.tabs.indexOf(top)
        return index === -1 ? null : index
    }
}
