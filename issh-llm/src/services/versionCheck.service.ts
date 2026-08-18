import { Injectable } from '@angular/core'
import axios from 'axios'
import { PlatformService, Logger, LogService } from 'issh-core'

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

    async checkForUpdates (githubBaseUrl: string, githubRepo: string, githubToken?: string | null): Promise<VersionCheckResult> {
        const currentVersion = this.platform.getAppVersion()

        if (!githubBaseUrl || !githubRepo) {
            return {
                hasUpdate: false,
                currentVersion,
                latestVersion: '',
                releaseNotes: '',
                releaseUrl: '',
                publishedAt: '',
                error: '未配置 GitHub 仓库地址',
            }
        }

        const baseUrl = githubBaseUrl.replace(/\/+$/, '')
        const apiBaseUrl = this.getGitHubApiBaseUrl(baseUrl)
        const url = `${apiBaseUrl}/repos/${githubRepo}/releases/latest`
        const headers: Record<string, string> = { Accept: 'application/vnd.github+json' }
        if (githubToken) {
            headers.Authorization = `Bearer ${githubToken}`
        }

        try {
            const response = await axios.get(url, {
                headers,
                timeout: 15000,
            })
            const data = response.data
            const latestVersion = (data.tag_name || '').replace(/^v/, '')
            const releaseUrl = data.html_url || `${baseUrl}/${githubRepo}/releases`
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
            const status = axios.isAxiosError(e) ? e.response?.status : undefined
            const message = status === 404 && !githubToken
                ? '未找到 GitHub Release；如仓库为私有仓库，请配置 GitHub Token'
                : e instanceof Error ? e.message : String(e)
            this.logger.warn('Version check failed', status || message)
            return {
                hasUpdate: false,
                currentVersion,
                latestVersion: '',
                releaseNotes: '',
                releaseUrl: '',
                publishedAt: '',
                error: message,
            }
        }
    }

    private getGitHubApiBaseUrl (baseUrl: string): string {
        if (/^https:\/\/(?:www\.)?github\.com$/i.test(baseUrl)) {
            return 'https://api.github.com'
        }
        if (/^https:\/\/api\.github\.com$/i.test(baseUrl) || /\/api\/v3$/i.test(baseUrl)) {
            return baseUrl
        }
        return `${baseUrl}/api/v3`
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
