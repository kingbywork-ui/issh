import { Component, HostBinding } from '@angular/core'
import { BaseComponent, ConfigService, PlatformService } from 'issh-core'
import { VersionCheckService, VersionCheckResult } from '../services/versionCheck.service'

@Component({
    standalone: false,
    selector: 'about-settings-tab',
    templateUrl: './aboutSettingsTab.component.pug',
})
export class AboutSettingsTabComponent extends BaseComponent {
    @HostBinding('class.content-box') true

    checking = false
    checkResult: VersionCheckResult | null = null

    constructor (
        public config: ConfigService,
        private platform: PlatformService,
        private versionCheck: VersionCheckService,
    ) {
        super()
    }

    get appVersion (): string {
        return this.platform.getAppVersion()
    }

    get osRelease (): string {
        return this.platform.getOSRelease()
    }

    get electronVersion (): string {
        return (process as any).versions?.electron || ''
    }

    get chromeVersion (): string {
        return (process as any).versions?.chrome || ''
    }

    get nodeVersion (): string {
        return (process as any).versions?.node || ''
    }

    get githubBaseUrl (): string {
        return this.config.store.about?.githubBaseUrl || this.config.store.about?.giteaBaseUrl || ''
    }

    set githubBaseUrl (value: string) {
        this.config.store.about.githubBaseUrl = value
        this.config.store.about.giteaBaseUrl = ''
    }

    get githubRepo (): string {
        return this.config.store.about?.githubRepo || this.config.store.about?.giteaRepo || ''
    }

    set githubRepo (value: string) {
        this.config.store.about.githubRepo = value
        this.config.store.about.giteaRepo = ''
    }

    async checkForUpdates (): Promise<void> {
        this.checking = true
        this.checkResult = null
        try {
            this.checkResult = await this.versionCheck.checkForUpdates(
                this.githubBaseUrl || this.config.store.llm?.giteaBaseUrl,
                this.githubRepo || this.config.store.llm?.giteaRepo,
                this.config.store.about?.githubToken,
            )
        } finally {
            this.checking = false
        }
    }

    openReleaseUrl (): void {
        if (this.checkResult?.releaseUrl) {
            this.platform.openExternal(this.checkResult.releaseUrl)
        }
    }
}
