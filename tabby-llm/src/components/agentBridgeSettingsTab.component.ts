import { ChangeDetectorRef, Component, HostBinding, OnInit } from '@angular/core'
import { BaseComponent, ConfigService, NotificationsService } from 'tabby-core'
import { AgentBridgeService } from '../services/agentBridge.service'

/** @hidden */
@Component({
    standalone: false,
    selector: 'agent-bridge-settings-tab',
    templateUrl: './agentBridgeSettingsTab.component.pug',
    styleUrls: ['./llmSettingsTab.component.scss'],
})
export class AgentBridgeSettingsTabComponent extends BaseComponent implements OnInit {
    bridgeStatusVersion = 0
    bridgeTesting = false
    bridgeTestSuccessful: boolean | null = null
    bridgeTestError: string | null = null

    @HostBinding('class.content-box') true

    constructor (
        public config: ConfigService,
        public agentBridge: AgentBridgeService,
        private notifications: NotificationsService,
        private changeDetector: ChangeDetectorRef,
    ) {
        super()
        this.subscribeUntilDestroyed(this.agentBridge.status$, () => {
            this.bridgeStatusVersion++
            this.changeDetector.markForCheck()
        })
    }

    ngOnInit (): void {
        void this.loadAuditLog(false)
    }

    async copyBridgeToken (): Promise<void> {
        const token = this.agentBridge.accessToken
        if (!token) {
            return
        }
        await this.copyText(token, '智能体桥接令牌已复制')
    }

    async rotateBridgeToken (): Promise<void> {
        await this.agentBridge.rotateToken()
        this.notifications.notice('智能体桥接令牌已轮换')
    }

    async copyCodexConfig (): Promise<void> {
        await this.copyText(this.agentBridge.codexConfigSnippet, 'Codex MCP 配置已复制')
    }

    async copyCursorConfig (): Promise<void> {
        await this.copyText(this.agentBridge.cursorConfigSnippet, 'Cursor MCP 配置已复制')
    }

    async copyAgentRulesTemplate (): Promise<void> {
        await this.copyText(this.agentBridge.agentRulesTemplate, '智能体规则模板已复制')
    }

    async copyClaudeDesktopConfig (): Promise<void> {
        await this.copyText(this.agentBridge.claudeDesktopConfigSnippet, 'Claude Desktop MCP 配置已复制')
    }

    auditEntries: any[] = []
    auditLoading = false
    auditTotalCount = 0
    auditOffset = 0
    auditFilter = ''
    private auditPageSize = 50

    async loadAuditLog (append = false): Promise<void> {
        this.auditLoading = true
        try {
            const offset = append ? this.auditOffset : 0
            const result = this.agentBridge.readAuditLog(this.auditPageSize, offset, this.auditFilter || undefined)
            if (append) {
                this.auditEntries = [...this.auditEntries, ...result.entries]
            } else {
                this.auditEntries = result.entries
            }
            this.auditTotalCount = result.total
            this.auditOffset = offset + result.entries.length
        } finally {
            this.auditLoading = false
        }
    }

    async refreshAuditLog (): Promise<void> {
        await this.loadAuditLog(false)
    }

    async loadMoreAuditLog (): Promise<void> {
        await this.loadAuditLog(true)
    }

    async clearAuditLog (): Promise<void> {
        this.agentBridge.clearAuditLog()
        this.auditEntries = []
        this.auditTotalCount = 0
        this.auditOffset = 0
    }

    async testBridgeConnection (): Promise<void> {
        this.bridgeTesting = true
        this.bridgeTestSuccessful = null
        this.bridgeTestError = null
        try {
            await this.agentBridge.testConnection()
            this.bridgeTestSuccessful = true
            this.notifications.notice('智能体桥接连接正常')
        } catch (error) {
            this.bridgeTestSuccessful = false
            this.bridgeTestError = error instanceof Error ? error.message : String(error)
        } finally {
            this.bridgeTesting = false
        }
    }

    private async copyText (text: string, successMessage: string): Promise<void> {
        try {
            await navigator.clipboard.writeText(text)
            this.notifications.notice(successMessage)
        } catch (error) {
            this.notifications.error('复制失败', error instanceof Error ? error.message : String(error))
        }
    }

    readonly scopeOptions = ['read', 'write', 'exec', 'sftp']

    hasScope (scope: string): boolean {
        const scopes = this.config.store.llm.agentBridgeTokenScopes
        if (!Array.isArray(scopes)) {
            return true
        }
        return scopes.includes(scope)
    }

    toggleScope (scope: string): void {
        let scopes = Array.isArray(this.config.store.llm.agentBridgeTokenScopes)
            ? [...this.config.store.llm.agentBridgeTokenScopes]
            : [...this.scopeOptions]
        if (scopes.includes(scope)) {
            scopes = scopes.filter(item => item !== scope)
        } else {
            scopes.push(scope)
        }
        if (!scopes.includes('read')) {
            scopes.unshift('read')
        }
        this.config.store.llm.agentBridgeTokenScopes = scopes
        this.config.save()
    }
}
