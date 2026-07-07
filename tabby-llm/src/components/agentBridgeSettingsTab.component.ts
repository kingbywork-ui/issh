import { ChangeDetectorRef, Component, HostBinding } from '@angular/core'
import { BaseComponent, ConfigService, NotificationsService } from 'tabby-core'
import { AgentBridgeService } from '../services/agentBridge.service'

/** @hidden */
@Component({
    selector: 'agent-bridge-settings-tab',
    templateUrl: './agentBridgeSettingsTab.component.pug',
    styleUrls: ['./llmSettingsTab.component.scss'],
})
export class AgentBridgeSettingsTabComponent extends BaseComponent {
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

    async copyBridgeToken (): Promise<void> {
        const token = this.agentBridge.accessToken
        if (!token) {
            return
        }
        await this.copyText(token, 'Agent Bridge token copied')
    }

    async rotateBridgeToken (): Promise<void> {
        await this.agentBridge.rotateToken()
        this.notifications.notice('Agent Bridge token rotated')
    }

    async copyCodexConfig (): Promise<void> {
        await this.copyText(this.agentBridge.codexConfigSnippet, 'Codex MCP config copied')
    }

    async copyCursorConfig (): Promise<void> {
        await this.copyText(this.agentBridge.cursorConfigSnippet, 'Cursor MCP config copied')
    }

    async copyAgentRulesTemplate (): Promise<void> {
        await this.copyText(this.agentBridge.agentRulesTemplate, 'Agent rules template copied')
    }

    async testBridgeConnection (): Promise<void> {
        this.bridgeTesting = true
        this.bridgeTestSuccessful = null
        this.bridgeTestError = null
        try {
            await this.agentBridge.testConnection()
            this.bridgeTestSuccessful = true
            this.notifications.notice('Agent Bridge is reachable')
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
            this.notifications.error('Copy failed', error instanceof Error ? error.message : String(error))
        }
    }
}
