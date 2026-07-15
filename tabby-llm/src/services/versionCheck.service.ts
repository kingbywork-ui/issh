import { Injectable } from '@angular/core'
import axios from 'axios'
import { PlatformService, Logger, LogService } from 'tabby-core'

export interface VersionCheckResult {
    hasUpdate: boolean
    currentVersion: string
    latestVersion: string
    releaseNotes: string
    releaseUrl: string
    publishedAt: string
    error: string | null
}

@Injectable({ providedIn: 'root' })
export class VersionCheckService {
    private logger: Logger

    constructor (
        log: LogService,
        private platform: PlatformService,
    ) {
        this.logger = log.create('versionCheck')
    }

    async checkForUpdates (giteaBaseUrl: string, giteaRepo: string): Promise<VersionCheckResult> {
        const currentVersion = this.platform.getAppVersion()

        if (!giteaBaseUrl || !giteaRepo) {
            return {
                hasUpdate: false,
                currentVersion,
                latestVersion: '',
                releaseNotes: '',
                releaseUrl: '',
                publishedAt: '',
                error: '未配置 Gitea 仓库地址',
            }
        }

        const baseUrl = giteaBaseUrl.replace(/\/+$/, '')
        const url = `${baseUrl}/api/v1/repos/${giteaRepo}/releases/latest`

        try {
            const response = await axios.get(url, {
                headers: { Accept: 'application/json' },
                timeout: 15000,
            })
            const data = response.data
            const latestVersion = (data.tag_name || '').replace(/^v/, '')
            const releaseUrl = data.html_url || data.url || `${baseUrl}/${giteaRepo}/releases`
            const releaseNotes = data.body || ''
            const publishedAt = data.created_at || data.published_at || ''

            const hasUpdate = this.compareVersions(latestVersion, currentVersion) > 0

            return {
                hasUpdate,
                currentVersion,
                latestVersion,
                releaseNotes,
                releaseUrl,
                publishedAt,
                error: null,
            }
        } catch (e) {
            this.logger.warn('Version check failed', e)
            return {
                hasUpdate: false,
                currentVersion,
                latestVersion: '',
                releaseNotes: '',
                releaseUrl: '',
                publishedAt: '',
                error: e instanceof Error ? e.message : String(e),
            }
        }
    }

    private compareVersions (a: string, b: string): number {
        const partsA = a.split('.').map(x => parseInt(x, 10) || 0)
        const partsB = b.split('.').map(x => parseInt(x, 10) || 0)
        const len = Math.max(partsA.length, partsB.length)
        for (let i = 0; i < len; i++) {
            const va = partsA[i] || 0
            const vb = partsB[i] || 0
            if (va > vb) return 1
            if (va < vb) return -1
        }
        return 0
    }
}
