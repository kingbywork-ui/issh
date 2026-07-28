import { Component, HostBinding } from '@angular/core'
import { BaseComponent, ConfigService, NotificationsService, TranslateService } from 'tabby-core'
import { LLMService } from '../services/llm.service'

/** @hidden */
@Component({
    standalone: false,
    selector: 'llm-settings-tab',
    templateUrl: './llmSettingsTab.component.pug',
    styleUrls: ['./llmSettingsTab.component.scss'],
})
export class LLMSettingsTabComponent extends BaseComponent {
    connectionSuccessful: boolean | null = null
    connectionError: string | null = null
    testing = false

    @HostBinding('class.content-box') true

    constructor (
        public config: ConfigService,
        private llm: LLMService,
        private notifications: NotificationsService,
        private translate: TranslateService,
    ) {
        super()
    }

    async testConnection (): Promise<void> {
        if (!this.config.store.llm.apiKey || !this.config.store.llm.baseUrl) {
            this.connectionSuccessful = null
            return
        }
        this.testing = true
        this.connectionSuccessful = null
        this.connectionError = null
        try {
            await this.llm.testConnection()
            this.connectionSuccessful = true
            this.notifications.notice(this.translate.instant('连接成功'))
        } catch (e) {
            this.connectionSuccessful = false
            this.connectionError = e instanceof Error ? e.message : String(e)
        } finally {
            this.testing = false
        }
    }

    async saveAndTest (): Promise<void> {
        await this.config.save()
        await this.testConnection()
    }

}
