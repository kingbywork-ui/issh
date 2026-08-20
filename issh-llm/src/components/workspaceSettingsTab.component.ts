import { Component, HostBinding, OnInit } from '@angular/core'
import { BaseComponent, ConfigService, NotificationsService } from 'issh-core'
import { AgentBridgeService } from '../services/agentBridge.service'
import { HerdrPaneDescriptor } from '../herdrPane.api'
import { HerdrPaneService } from '../services/herdrPane.service'

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
    runs: any[] = []
    cordisHealth: any = null
    runtimeHealth: any = null
    herdrStatus: any = null
    herdrWorkspaces: any[] = []
    herdrPanes: HerdrPaneDescriptor[] = []
    private herdrSnapshot: any = null
    herdrLinkedWorkspaceId: string | null = null
    selectedHerdrWorkspaceId = ''
    workspaceName = ''
    selectedWorkspaceId = ''
    agentName = ''
    selectedSessionId = ''
    selectedAgentId = ''
    selectedAgentIds: string[] = []
    agentPrompt = ''
    multiAgentPrompt = ''
    agentCanExecute = false
    taskCommands: Record<string, string> = {}
    loading = false
    detailLoading = false
    prompting = false
    dispatching = false
    herdrBusy = false
    error: string | null = null

    constructor (
        private agentBridge: AgentBridgeService,
        private herdrPane: HerdrPaneService,
        public config: ConfigService,
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
            this.herdrStatus = await this.agentBridge.getHerdrStatus().catch(error => ({
                available: false,
                running: false,
                compatible: false,
                nativeOnly: true,
                lastError: error instanceof Error ? error.message : String(error),
            }))
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
            this.runs = []
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
            this.runs = this.agentBridge.getWorkspaceRuns(this.selectedWorkspaceId)
            this.cordisHealth = this.agentBridge.getCordisHealth()
            this.herdrLinkedWorkspaceId = this.agentBridge.linkedHerdrWorkspaceId(this.selectedWorkspaceId)
            if (this.herdrStatus?.running && this.herdrStatus?.compatible) {
                const snapshot = await this.agentBridge.getHerdrSnapshot()
                this.herdrSnapshot = snapshot
                this.herdrWorkspaces = snapshot?.workspaces ?? []
                if (!this.herdrWorkspaces.some(workspace => workspace.workspace_id === this.selectedHerdrWorkspaceId)) {
                    this.selectedHerdrWorkspaceId = this.herdrLinkedWorkspaceId ?? this.herdrWorkspaces[0]?.workspace_id ?? ''
                }
                this.refreshHerdrPanes()
            } else {
                this.herdrWorkspaces = []
                this.herdrPanes = []
                this.herdrSnapshot = null
            }
            if (!this.agents.some(agent => agent.id === this.selectedAgentId)) {
                this.selectedAgentId = this.agents[0]?.id ?? ''
            }
            this.selectedAgentIds = this.selectedAgentIds.filter(agentId =>
                this.agents.some(agent => agent.id === agentId),
            )
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
                scopes: [
                    'context.read',
                    'llm.prompt',
                    'command.propose',
                    ...(this.agentCanExecute ? ['command.execute'] : []),
                ],
            })
            this.agentName = ''
            this.agentCanExecute = false
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

    isAgentSelected (agentId: string): boolean {
        return this.selectedAgentIds.includes(agentId)
    }

    toggleAgentSelection (agentId: string): void {
        this.selectedAgentIds = this.isAgentSelected(agentId)
            ? this.selectedAgentIds.filter(id => id !== agentId)
            : [...this.selectedAgentIds, agentId]
    }

    async dispatchAgents (): Promise<void> {
        const prompt = this.multiAgentPrompt.trim()
        if (!this.selectedWorkspaceId || !this.selectedAgentIds.length || !prompt) {
            return
        }
        this.dispatching = true
        this.error = null
        try {
            const result = await this.agentBridge.dispatchWorkspaceAgents({
                workspaceId: this.selectedWorkspaceId,
                agentIds: this.selectedAgentIds,
                prompt,
            })
            this.multiAgentPrompt = ''
            await this.refreshWorkspaceDetails()
            await this.agentBridge.waitWorkspaceRun({ runId: result.run.id, timeoutMs: 60000 })
            await this.refreshWorkspaceDetails()
        } catch (error) {
            this.error = error instanceof Error ? error.message : String(error)
        } finally {
            this.dispatching = false
        }
    }

    async cancelRun (runId: string): Promise<void> {
        try {
            await this.agentBridge.cancelWorkspaceRun({ runId })
            await this.refreshWorkspaceDetails()
        } catch (error) {
            this.error = error instanceof Error ? error.message : String(error)
        }
    }

    async saveHerdrSettings (): Promise<void> {
        await this.config.save()
        this.herdrStatus = await this.agentBridge.getHerdrStatus()
    }

    async startHerdr (): Promise<void> {
        await this.runHerdrAction(async () => {
            await this.config.save()
            this.herdrStatus = await this.agentBridge.startHerdr()
            await this.refreshWorkspaceDetails()
            this.notifications.notice('Herdr sidecar 已连接')
        })
    }

    async stopHerdr (): Promise<void> {
        await this.runHerdrAction(async () => {
            const result = await this.agentBridge.stopHerdr()
            this.herdrStatus = result
            this.herdrWorkspaces = []
            this.herdrPanes = []
            this.notifications.notice(result.stopped ? 'Herdr sidecar 已停止' : '未停止外部管理的 Herdr server')
        })
    }

    async linkHerdrWorkspace (): Promise<void> {
        if (!this.selectedWorkspaceId || !this.selectedHerdrWorkspaceId) {
            return
        }
        await this.runHerdrAction(async () => {
            await this.agentBridge.linkHerdrWorkspace({
                workspaceId: this.selectedWorkspaceId,
                herdrWorkspaceId: this.selectedHerdrWorkspaceId,
            })
            this.herdrLinkedWorkspaceId = this.selectedHerdrWorkspaceId
            await this.agentBridge.syncHerdrWorkspace({ workspaceId: this.selectedWorkspaceId })
            this.notifications.notice('Herdr Workspace 已关联并同步')
        })
    }

    async unlinkHerdrWorkspace (): Promise<void> {
        if (!this.selectedWorkspaceId) {
            return
        }
        await this.runHerdrAction(async () => {
            await this.agentBridge.unlinkHerdrWorkspace({ workspaceId: this.selectedWorkspaceId })
            this.herdrLinkedWorkspaceId = null
            this.notifications.notice('Herdr Workspace 关联已移除')
        })
    }

    async syncHerdrWorkspace (): Promise<void> {
        if (!this.selectedWorkspaceId) {
            return
        }
        await this.runHerdrAction(async () => {
            await this.agentBridge.syncHerdrWorkspace({ workspaceId: this.selectedWorkspaceId })
            this.notifications.notice('Workspace 状态已同步到 Herdr')
        })
    }

    selectHerdrWorkspace (workspaceId: string): void {
        this.selectedHerdrWorkspaceId = workspaceId
        this.refreshHerdrPanes()
    }

    openHerdrPane (pane: HerdrPaneDescriptor): void {
        if (!this.selectedWorkspaceId) {
            return
        }
        this.herdrPane.open(pane, this.selectedWorkspaceId)
    }

    private refreshHerdrPanes (): void {
        this.herdrPanes = this.agentBridge.getHerdrPaneDescriptors(
            this.herdrSnapshot,
            this.selectedHerdrWorkspaceId || this.herdrLinkedWorkspaceId,
        )
    }

    private async runHerdrAction (action: () => Promise<void>): Promise<void> {
        this.herdrBusy = true
        this.error = null
        try {
            await action()
        } catch (error) {
            this.error = error instanceof Error ? error.message : String(error)
        } finally {
            this.herdrBusy = false
        }
    }

    agentCanRunCommands (agentId: string): boolean {
        return !!this.agents.find(agent => agent.id === agentId)?.scopes?.includes('command.execute')
    }

    async runTaskCommand (task: any, execute: boolean): Promise<void> {
        const command = (this.taskCommands[task.id] ?? '').trim()
        if (!command) {
            return
        }
        try {
            const result = await this.agentBridge.runWorkspaceTaskCommand({
                taskId: task.id,
                command,
                execute,
            })
            if (!execute) {
                const danger = result.preview?.dangerous ? `危险：${result.preview.dangerReason ?? '需要确认'}` : '安全检查通过'
                this.notifications.notice(`命令预览完成：${danger}`)
            }
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
