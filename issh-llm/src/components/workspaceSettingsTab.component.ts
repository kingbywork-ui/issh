import { Component, HostBinding, OnInit } from '@angular/core'
import { BaseComponent, NotificationsService } from 'issh-core'
import { AgentBridgeService } from '../services/agentBridge.service'

/** @hidden */
@Component({
    standalone: false,
    selector: 'workspace-settings-tab',
    templateUrl: './workspaceSettingsTab.component.pug',
    styleUrls: ['./llmSettingsTab.component.scss'],
})
export class WorkspaceSettingsTabComponent extends BaseComponent implements OnInit {
    @HostBinding('class.content-box') true

    sessions: any[] = []
    workspaces: any[] = []
    runtimeHealth: any = null
    workspaceName = ''
    selectedWorkspaceId = ''
    loading = false
    error: string | null = null

    constructor (
        private agentBridge: AgentBridgeService,
        private notifications: NotificationsService,
    ) {
        super()
    }

    ngOnInit (): void {
        void this.refresh()
    }

    async refresh (): Promise<void> {
        this.loading = true
        this.error = null
        try {
            const [health, workspaces] = await Promise.all([
                this.agentBridge.getRuntimeHealth(),
                this.agentBridge.getWorkspaces(),
            ])
            this.runtimeHealth = health
            this.workspaces = workspaces
            this.sessions = this.agentBridge.listSessions()
            if (!this.workspaces.some(workspace => workspace.id === this.selectedWorkspaceId)) {
                this.selectedWorkspaceId = this.workspaces[0]?.id ?? ''
            }
        } catch (error) {
            this.error = error instanceof Error ? error.message : String(error)
        } finally {
            this.loading = false
        }
    }

    async createWorkspace (): Promise<void> {
        const name = this.workspaceName.trim()
        if (!name) {
            return
        }
        try {
            const workspace = await this.agentBridge.createWorkspace(name)
            this.workspaceName = ''
            this.selectedWorkspaceId = workspace.id
            await this.refresh()
            this.notifications.notice('Workspace 已创建')
        } catch (error) {
            this.error = error instanceof Error ? error.message : String(error)
        }
    }

    isBound (sessionId: string): boolean {
        const workspace = this.workspaces.find(item => item.id === this.selectedWorkspaceId)
        return !!workspace?.bindings?.some(binding => binding.sessionId === sessionId)
    }

    async toggleBinding (sessionId: string): Promise<void> {
        if (!this.selectedWorkspaceId) {
            return
        }
        try {
            if (this.isBound(sessionId)) {
                await this.agentBridge.unbindWorkspaceSession(this.selectedWorkspaceId, sessionId)
            } else {
                await this.agentBridge.bindWorkspaceSession(this.selectedWorkspaceId, sessionId)
            }
            await this.refresh()
        } catch (error) {
            this.error = error instanceof Error ? error.message : String(error)
        }
    }

    focusSession (sessionId: string): void {
        this.agentBridge.selectSession({ tab: sessionId })
    }
}
