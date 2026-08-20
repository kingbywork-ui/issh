import { Injectable } from '@angular/core'
import { createHash, randomUUID } from 'crypto'
import { AppService, ConfigService, SplitTabComponent } from 'issh-core'
import { HerdrPaneTabComponent } from '../components/herdrPaneTab.component'
import { HerdrPaneDescriptor, HerdrPaneProfile } from '../herdrPane.api'

/** @hidden */
@Injectable({ providedIn: 'root' })
export class HerdrPaneService {
    private openTabs = new Map<string, HerdrPaneTabComponent>()

    constructor (
        private app: AppService,
        private config: ConfigService,
    ) {}

    open (pane: HerdrPaneDescriptor, isshWorkspaceId: string): HerdrPaneTabComponent {
        const existing = this.openTabs.get(pane.paneId) ?? this.findOpenTab(pane.paneId)
        if (existing) {
            this.openTabs.set(pane.paneId, existing)
            this.app.selectTab(this.app.getParentTab(existing) ?? existing)
            return existing
        }
        const session = String(this.config.store.llm.herdrSession ?? 'issh').trim() || 'issh'
        const runtimePaneId = `herdr-${createHash('sha256')
            .update(`${session}\0${pane.paneId}`)
            .digest('hex')
            .slice(0, 32)}`
        const profile: HerdrPaneProfile = {
            id: runtimePaneId,
            type: 'herdr-pane',
            name: pane.title,
            group: 'Herdr',
            options: {
                paneId: runtimePaneId,
                target: pane.paneId,
                herdrWorkspaceId: pane.workspaceId,
                isshWorkspaceId,
                ownerId: `issh-ui-${randomUUID()}`,
                title: pane.title,
                cwd: pane.cwd,
            },
            icon: 'fas fa-terminal',
            color: null,
            disableDynamicTitle: false,
            behaviorOnSessionEnd: 'keep',
            weight: 0,
            isBuiltin: true,
            isTemplate: false,
            terminalColorScheme: null,
        }
        const tab = this.app.openNewTab({
            type: HerdrPaneTabComponent,
            inputs: { profile },
        })
        this.openTabs.set(pane.paneId, tab)
        tab.destroyed$.subscribe(() => {
            if (this.openTabs.get(pane.paneId) === tab) {
                this.openTabs.delete(pane.paneId)
            }
        })
        return tab
    }

    private findOpenTab (target: string): HerdrPaneTabComponent|null {
        for (const topLevelTab of this.app.tabs) {
            const tabs = topLevelTab instanceof SplitTabComponent ? topLevelTab.getAllTabs() : [topLevelTab]
            for (const tab of tabs) {
                if (tab instanceof HerdrPaneTabComponent && tab.profile.options.target === target) {
                    return tab
                }
            }
        }
        return null
    }
}
