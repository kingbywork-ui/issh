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
    agents: any[] = []
    tasks: any[] = []
    events: any[] = []
    runtimeHealth: any = null
    workspaceName = ''
    selectedWorkspaceId = ''
    agentName = ''
    selectedSessionId = ''
    selectedAgentId = ''
    agentPrompt = ''
    loading = false
    detailLoading = false
    prompting = false
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
            await this.refreshWorkspaceDetails()
        } catch (error) {
            this.error = error instanceof Error ? error.message : String(error)
        } finally {
            this.loading = false
        }
    }

    async refreshWorkspaceDetails (): Promise<void> {
        if (!this.selectedWorkspaceId) {
            this.agents = []
            this.tasks = []
            this.events = []
            this.selectedAgentId = ''
            return
        }
        this.detailLoading = true
        try {
            const [agents, tasks, events] = await Promise.all([
                this.agentBridge.listWorkspaceAgents({ workspaceId: this.selectedWorkspaceId }),
                this.agentBridge.listWorkspaceTasks({ workspaceId: this.selectedWorkspaceId }),
                this.agentBridge.listWorkspaceEvents(this.selectedWorkspaceId, 0, 50),
            ])
            this.agents = agents
            this.tasks = tasks
            this.events = [...events].reverse()
            if (!this.agents.some(agent => agent.id === this.selectedAgentId)) {
                this.selectedAgentId = this.agents[0]?.id ?? ''
            }
        } catch (error) {
            this.error = error instanceof Error ? error.message : String(error)
        } finally {
            this.detailLoading = false
        }
    }

    async selectWorkspace (): Promise<void> {
        this.error = null
        await this.refreshWorkspaceDetails()
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

    async registerAgent (): Promise<void> {
        const name = this.agentName.trim()
        if (!this.selectedWorkspaceId || !name) {
            return
        }
        try {
            const agent = await this.agentBridge.registerWorkspaceAgent({
                workspaceId: this.selectedWorkspaceId,
                name,
                sessionId: this.selectedSessionId || null,
            })
            this.agentName = ''
            this.selectedAgentId = agent.id
            await this.refreshWorkspaceDetails()
            this.notifications.notice('Agent 已注册')
        } catch (error) {
            this.error = error instanceof Error ? error.message : String(error)
        }
    }

    async promptAgent (): Promise<void> {
        const prompt = this.agentPrompt.trim()
        if (!this.selectedAgentId || !prompt) {
            return
        }
        this.prompting = true
        this.error = null
        try {
            const task = await this.agentBridge.promptWorkspaceAgent({
                agentId: this.selectedAgentId,
                prompt,
            })
            this.agentPrompt = ''
            await this.refreshWorkspaceDetails()
            await this.agentBridge.waitWorkspaceTask({ taskId: task.id, timeoutMs: 60000 })
            await this.refreshWorkspaceDetails()
        } catch (error) {
            this.error = error instanceof Error ? error.message : String(error)
        } finally {
            this.prompting = false
        }
    }

    async cancelTask (taskId: string): Promise<void> {
        try {
            await this.agentBridge.cancelWorkspaceTask({ taskId })
            await this.refreshWorkspaceDetails()
        } catch (error) {
            this.error = error instanceof Error ? error.message : String(error)
        }
    }

    isTaskTerminal (task: any): boolean {
        return ['completed', 'failed', 'cancelled', 'interrupted'].includes(task.status)
    }

    taskStatusText (status: string): string {
        return ({
            queued: '排队中',
            running: '处理中',
            completed: '已完成',
            failed: '失败',
            cancelled: '已取消',
            interrupted: 'Runtime 重启中断',
        } as Record<string, string>)[status] ?? status
    }
}
