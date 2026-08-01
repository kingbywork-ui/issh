import { ChangeDetectorRef, Component, HostBinding, OnInit } from '@angular/core'
import { BaseComponent, ConfigService, NotificationsService } from 'issh-core'
import { AgentBridgeService } from '../services/agentBridge.service'

type AgentConfigId = 'codex-desktop' | 'codex-cli' | 'cursor' | 'claude-desktop'

interface AgentConfigOption {
    id: AgentConfigId
    name: string
    description: string
}

interface AgentConfigItem {
    label: string
    value: string
    copyValue?: string
    multiline?: boolean
}

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
    selectedAgentConfig: AgentConfigId = 'codex-desktop'
    serviceSettingsExpanded = false

    readonly agentConfigOptions: AgentConfigOption[] = [
        {
            id: 'codex-desktop',
            name: 'Codex Desktop',
            description: '通过自定义 MCP 表单连接 STDIO 服务',
        },
        {
            id: 'codex-cli',
            name: 'Codex CLI',
            description: '在 config.toml 中添加 STDIO MCP 服务',
        },
        {
            id: 'cursor',
            name: 'Cursor',
            description: '通过 JSON 配置连接 STDIO MCP 服务',
        },
        {
            id: 'claude-desktop',
            name: 'Claude Desktop',
            description: '通过 JSON 配置连接本机 SSE MCP 服务',
        },
    ]

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

    get maskedAccessToken (): string {
        const token = this.agentBridge.accessToken
        if (!token) {
            return ''
        }
        if (token.length <= 8) {
            return '•'.repeat(token.length)
        }
        return `${token.slice(0, 4)}${'•'.repeat(Math.min(16, token.length - 8))}${token.slice(-4)}`
    }

    toggleServiceSettings (): void {
        this.serviceSettingsExpanded = !this.serviceSettingsExpanded
    }

    get primarySnippetItem (): AgentConfigItem | undefined {
        return this.selectedAgentConfigItems.find(item => item.multiline && item.label.startsWith('完整'))
    }

    async copyFullAgentConfig (): Promise<void> {
        const item = this.primarySnippetItem
        if (item) {
            await this.copyAgentConfigItem(item)
        }
    }

    async rotateBridgeToken (): Promise<void> {
        await this.agentBridge.rotateToken()
        this.notifications.notice('智能体桥接令牌已轮换')
    }

    get selectedAgentOption (): AgentConfigOption {
        return this.agentConfigOptions.find(option => option.id === this.selectedAgentConfig) ?? this.agentConfigOptions[0]
    }

    get selectedAgentConfigItems (): AgentConfigItem[] {
        const desktopFields = this.agentBridge.codexDesktopConfigFields
        const environmentVariable = desktopFields.environmentVariableName
        const environmentValue = desktopFields.environmentVariableValue

        switch (this.selectedAgentConfig) {
            case 'codex-desktop':
                return [
                    { label: '对接方式', value: '自定义 MCP / STDIO' },
                    { label: '名称', value: desktopFields.name },
                    { label: '类型', value: desktopFields.type },
                    { label: '启动命令', value: desktopFields.command },
                    { label: '参数', value: desktopFields.argument },
                    { label: '环境变量名称', value: environmentVariable },
                    { label: '环境变量值', value: environmentValue },
                    { label: '环境变量传递', value: '留空', copyValue: '' },
                    { label: '工作目录', value: '留空', copyValue: '' },
                    { label: '完整填写参数', value: this.agentBridge.codexDesktopConfigGuide, multiline: true },
                    { label: '智能体规则（可选）', value: this.agentBridge.agentRulesTemplate, multiline: true },
                ]
            case 'codex-cli':
                return [
                    { label: '对接方式', value: 'STDIO / TOML' },
                    { label: '配置文件', value: '%USERPROFILE%\\.codex\\config.toml' },
                    { label: 'MCP 服务名称', value: 'issh' },
                    { label: '启动命令', value: 'node' },
                    { label: '参数', value: this.agentBridge.mcpServerScriptPath },
                    { label: '环境变量名称', value: environmentVariable },
                    { label: '环境变量值', value: environmentValue },
                    { label: '完整 TOML 配置', value: this.agentBridge.codexConfigSnippet, multiline: true },
                    { label: '智能体规则（可选）', value: this.agentBridge.agentRulesTemplate, multiline: true },
                ]
            case 'cursor':
                return [
                    { label: '对接方式', value: 'STDIO / JSON' },
                    { label: '配置入口', value: 'Cursor MCP 设置' },
                    { label: 'MCP 服务名称', value: 'issh' },
                    { label: '启动命令', value: 'node' },
                    { label: '参数', value: this.agentBridge.mcpServerScriptPath },
                    { label: '环境变量名称', value: environmentVariable },
                    { label: '环境变量值', value: environmentValue },
                    { label: '完整 JSON 配置', value: this.agentBridge.cursorConfigSnippet, multiline: true },
                    { label: '智能体规则（可选）', value: this.agentBridge.agentRulesTemplate, multiline: true },
                ]
            case 'claude-desktop':
                return [
                    { label: '对接方式', value: 'SSE / JSON' },
                    { label: '配置入口', value: 'Claude Desktop MCP 配置' },
                    { label: 'MCP 服务名称', value: 'issh' },
                    { label: '传输类型', value: 'sse' },
                    { label: 'SSE 地址', value: this.agentBridge.sseUrl ?? 'http://127.0.0.1:<port>/sse' },
                    { label: 'Authorization', value: `Bearer ${this.agentBridge.accessToken ?? '<token>'}` },
                    { label: '完整 JSON 配置', value: this.agentBridge.claudeDesktopConfigSnippet, multiline: true },
                    { label: '智能体规则（可选）', value: this.agentBridge.agentRulesTemplate, multiline: true },
                ]
        }
    }

    selectAgentConfig (agent: AgentConfigId): void {
        this.selectedAgentConfig = agent
    }

    async copyAgentConfigItem (item: AgentConfigItem): Promise<void> {
        await this.copyText(item.copyValue ?? item.value, `${item.label}已复制`)
    }

    trackAgentConfigItem (_index: number, item: AgentConfigItem): string {
        return item.label
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
