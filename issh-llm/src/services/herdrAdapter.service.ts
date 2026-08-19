import { Injectable } from '@angular/core'
import { ipcRenderer } from 'electron'
import { ConfigService } from 'issh-core'

interface HerdrOptions {
    binaryPath?: string
    session?: string
}

/** @hidden */
@Injectable({ providedIn: 'root' })
export class HerdrAdapterService {
    private autoStartKey = ''
    private syncSequences = new Map<string, number>()

    constructor (private config: ConfigService) {
        this.config.ready$.subscribe(() => this.syncAutoStart())
        this.config.changed$.subscribe(() => this.syncAutoStart())
    }

    status (): Promise<any> {
        return this.request('status')
    }

    start (): Promise<any> {
        this.assertEnabled()
        return this.request('start', { restartOnCrash: true })
    }

    stop (): Promise<any> {
        return this.request('stop')
    }

    snapshot (): Promise<any> {
        this.assertEnabled()
        return this.request('snapshot')
    }

    async linkWorkspace (isshWorkspaceId: string, herdrWorkspaceId: string): Promise<void> {
        this.assertEnabled()
        const links = this.links()
        links[isshWorkspaceId] = herdrWorkspaceId
        this.config.store.llm.herdrWorkspaceLinks = links
        await this.config.save()
    }

    async unlinkWorkspace (isshWorkspaceId: string): Promise<void> {
        const links = this.links()
        delete links[isshWorkspaceId]
        this.config.store.llm.herdrWorkspaceLinks = links
        await this.config.save()
    }

    linkedWorkspaceId (isshWorkspaceId: string): string | null {
        return this.links()[isshWorkspaceId] ?? null
    }

    async syncWorkspace (workspace: any, agents: any[], tasks: any[]): Promise<any> {
        this.assertEnabled()
        const herdrWorkspaceId = this.linkedWorkspaceId(String(workspace?.id ?? ''))
        if (!herdrWorkspaceId) {
            throw new Error('当前 issh Workspace 尚未关联 Herdr Workspace')
        }
        const previousSequence = this.syncSequences.get(String(workspace.id)) ?? 0
        const sequence = Math.max(Date.now(), previousSequence + 1)
        this.syncSequences.set(String(workspace.id), sequence)
        return this.request('sync-workspace', {
            workspaceId: herdrWorkspaceId,
            isshWorkspaceId: workspace.id,
            name: workspace.name,
            agentCount: agents.length,
            taskCount: tasks.length,
            sequence,
        })
    }

    remoteSnapshot (response: any): any {
        return response?.result?.snapshot ?? null
    }

    private links (): Record<string, string> {
        const links = this.config.store.llm.herdrWorkspaceLinks
        return links && typeof links === 'object' && !Array.isArray(links) ? { ...links } : {}
    }

    private options (): HerdrOptions {
        const binaryPath = String(this.config.store.llm.herdrBinaryPath ?? '').trim()
        const session = String(this.config.store.llm.herdrSession ?? 'issh').trim() || 'issh'
        return {
            ...(binaryPath ? { binaryPath } : {}),
            session,
        }
    }

    private request (action: string, params: Record<string, unknown> = {}): Promise<any> {
        return ipcRenderer.invoke('herdr:request', {
            action,
            ...this.options(),
            ...params,
        })
    }

    private syncAutoStart (): void {
        const enabled = this.config.store.llm.herdrEnabled === true
        const autoStart = this.config.store.llm.herdrAutoStart === true
        const options = this.options()
        const key = enabled && autoStart ? JSON.stringify(options) : ''
        if (!key || key === this.autoStartKey) {
            return
        }
        this.autoStartKey = key
        void this.start().catch(() => {
            // Optional integration: native Workspace remains available when Herdr is absent.
        })
    }

    private assertEnabled (): void {
        if (this.config.store.llm.herdrEnabled !== true) {
            throw new Error('Herdr integration is disabled in issh settings')
        }
    }
}
