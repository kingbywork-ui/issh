/* eslint-disable @typescript-eslint/explicit-module-boundary-types */
import { Component, HostBinding } from '@angular/core'
import { BaseComponent, ConfigService, PlatformService, NotificationsService, TranslateService } from 'tabby-core'
import { ConfigSyncService, SyncServerStatus, SyncMode, SYNC_SECTIONS } from '../services/configSync.service'


/** @hidden */
@Component({
    selector: 'config-sync-settings-tab',
    templateUrl: './configSyncSettingsTab.component.pug',
    styleUrls: ['./configSyncSettingsTab.component.scss'],
})
export class ConfigSyncSettingsTabComponent extends BaseComponent {
    serverStatus: SyncServerStatus = { running: false, port: 0, hostname: '', bindAddress: '127.0.0.1', fingerprint: '' }
    peerPingResult: { ok: boolean, hostname?: string, error?: string, fingerprint?: string } | null = null
    peerPinging = false

    syncMode: SyncMode = 'full'
    selectedSections: Set<string> = new Set(SYNC_SECTIONS.map(s => s.key))
    syncSections = SYNC_SECTIONS

    @HostBinding('class.content-box') true

    constructor (
        public config: ConfigService,
        public platform: PlatformService,
        private configSync: ConfigSyncService,
        private notifications: NotificationsService,
        private translate: TranslateService,
    ) {
        super()
    }

    get peerIP (): string {
        return this.config.store.configSync.peerIP || ''
    }

    set peerIP (value: string) {
        this.config.store.configSync.peerIP = value
    }

    get bindLan (): boolean {
        return this.config.store.configSync.bindAddress === '0.0.0.0'
    }

    set bindLan (value: boolean) {
        this.config.store.configSync.bindAddress = value ? '0.0.0.0' : '127.0.0.1'
        this.config.save()
    }

    async ngOnInit () {
        await this.refreshStatus()
    }

    async refreshStatus () {
        this.serverStatus = await this.configSync.getServerStatus()
    }

    hasPassword (): boolean {
        return this.configSync.isVaultEnabled()
    }

    isVaultOpen (): boolean {
        return this.configSync.isVaultOpen()
    }

    async copyFingerprint () {
        if (!this.serverStatus.fingerprint) {
            return
        }
        this.platform.setClipboard({ text: this.serverStatus.fingerprint })
        this.notifications.info(this.translate.instant('Fingerprint copied'))
    }

    async startServer () {
        if (!this.config.store.configSync.syncKey) {
            this.notifications.error(this.translate.instant('请先设置同步密钥'))
            return
        }
        if (!this.hasPassword()) {
            this.notifications.error(this.translate.instant('请先在 Vault 设置中启用保险库并设置主密码'))
            return
        }
        if (this.bindLan) {
            const confirmed = (await this.platform.showMessageBox({
                type: 'warning',
                message: this.translate.instant('Bind to all interfaces (0.0.0.0)?'),
                detail: this.translate.instant('Only use this on a trusted LAN. TLS fingerprint pairing is still required.'),
                buttons: [
                    this.translate.instant('Continue'),
                    this.translate.instant('Cancel'),
                ],
                defaultId: 1,
                cancelId: 1,
            })).response === 0
            if (!confirmed) {
                return
            }
        }
        const ok = await this.configSync.verifyAndUnlock()
        if (!ok) {
            this.notifications.error(this.translate.instant('保险库未解锁'))
            return
        }
        const result = await this.configSync.startServer()
        if (result.ok) {
            this.notifications.info(this.translate.instant('同步服务已启动'))
        } else {
            this.notifications.error(this.translate.instant('启动失败：{error}', { error: result.error }))
        }
        await this.refreshStatus()
    }

    async stopServer () {
        await this.configSync.stopServer()
        this.notifications.info(this.translate.instant('Sync service stopped'))
        await this.refreshStatus()
    }

    async pingPeer () {
        if (!this.peerIP) {
            return
        }
        if (!this.config.store.configSync.peerFingerprint) {
            this.notifications.error(this.translate.instant('请先粘贴对端 TLS 指纹'))
            return
        }
        this.peerPinging = true
        this.peerPingResult = null
        try {
            this.peerPingResult = await this.configSync.pingPeer(this.peerIP)
            this.config.save()
        } finally {
            this.peerPinging = false
        }
    }

    toggleSection (key: string) {
        if (this.selectedSections.has(key)) {
            this.selectedSections.delete(key)
        } else {
            this.selectedSections.add(key)
        }
    }

    isSectionSelected (key: string): boolean {
        return this.selectedSections.has(key)
    }

    private validatePartial (): boolean {
        if (this.syncMode === 'partial' && this.selectedSections.size === 0) {
            this.notifications.error(this.translate.instant('请至少勾选一个同步内容'))
            return false
        }
        return true
    }

    async pushToPeer () {
        if (!this.peerIP) {
            return
        }
        if (!this.validatePartial()) {
            return
        }
        const sections = Array.from(this.selectedSections)
        if (this.syncMode === 'partial' && this.selectedSections.has('vault') && !this.isVaultOpen()) {
            const unlocked = await this.configSync.unlockVault()
            if (!unlocked) {
                this.notifications.error(this.translate.instant('同步 Vault 前请先解锁保险库'))
                return
            }
        }
        const result = await this.configSync.pushToPeer(this.peerIP, this.syncMode, sections)
        if (result.ok) {
            this.notifications.info(
                this.translate.instant('推送完成'),
                this.translate.instant('配置已推送到 {ip}（对端需确认）', { ip: this.peerIP }),
            )
        } else {
            this.notifications.error(
                this.translate.instant('推送失败'),
                result.error,
            )
        }
    }

    async pullFromPeer () {
        if (!this.peerIP) {
            return
        }
        if (!this.validatePartial()) {
            return
        }
        const sections = Array.from(this.selectedSections)
        const sectionLabel = this.syncMode === 'partial' ? sections.join(', ') : 'full config'
        if ((await this.platform.showMessageBox({
            type: 'warning',
            message: this.translate.instant('Overwrite local config with the remote one?'),
            detail: this.translate.instant('Sections: {sections}', { sections: sectionLabel }),
            buttons: [
                this.translate.instant('Overwrite and apply'),
                this.translate.instant('Cancel'),
            ],
            defaultId: 1,
            cancelId: 1,
        })).response === 1) {
            return
        }
        if (this.syncMode === 'partial' && this.selectedSections.has('vault') && !this.isVaultOpen()) {
            const unlocked = await this.configSync.unlockVault()
            if (!unlocked) {
                this.notifications.error(this.translate.instant('同步 Vault 前请先解锁保险库'))
                return
            }
        }
        const result = await this.configSync.pullFromPeer(this.peerIP, this.syncMode, sections)
        if (result.ok) {
            this.notifications.info(
                this.translate.instant('拉取完成'),
                this.translate.instant('配置已从 {ip} 拉取并应用', { ip: this.peerIP }),
            )
        } else {
            this.notifications.error(
                this.translate.instant('拉取失败'),
                result.error,
            )
        }
    }

    generateSyncKey () {
        try {
            this.config.store.configSync.syncKey = this.configSync.generateSecureSyncKey()
            this.config.save()
        } catch (e) {
            this.notifications.error(this.translate.instant('Failed to generate sync key'), e.message)
        }
    }
}
