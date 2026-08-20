import { Injectable } from '@angular/core'
import { ipcRenderer } from 'electron'
import { ConfigService } from 'issh-core'
import { Observable, Subject, filter } from 'rxjs'
import { HerdrPaneDescriptor, HerdrPaneEvent, HerdrPaneOptions } from '../herdrPane.api'

interface HerdrOptions {
    binaryPath?: string
    session?: string
}

/** @hidden */
@Injectable({ providedIn: 'root' })
export class HerdrAdapterService {
    private autoStartKey = ''
    private syncSequences = new Map<string, number>()
    private paneEvents = new Subject<HerdrPaneEvent>()

    constructor (private config: ConfigService) {
        ipcRenderer.on('herdr:pane-event', (_event, paneEvent: HerdrPaneEvent) => {
            if (paneEvent?.paneId && ['output', 'state'].includes(paneEvent.type)) {
                this.paneEvents.next(paneEvent)
            }
        })
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

    paneEventsFor (paneId: string): Observable<HerdrPaneEvent> {
        return this.paneEvents.pipe(filter(event => event.paneId === paneId))
    }

    attachPane (options: HerdrPaneOptions, columns: number, rows: number): Promise<any> {
        this.assertEnabled()
        return this.request('pane-attach', {
            paneId: options.paneId,
            target: options.target,
            workspaceId: options.isshWorkspaceId,
            ownerId: options.ownerId,
            title: options.title,
            columns,
            rows,
            takeover: true,
        })
    }

    writePane (paneId: string, ownerId: string, data: Buffer): Promise<any> {
        return this.request('pane-input', {
            paneId,
            ownerId,
            data: [...data],
        })
    }

    resizePane (paneId: string, ownerId: string, columns: number, rows: number): Promise<any> {
        return this.request('pane-resize', {
            paneId,
            ownerId,
            columns,
            rows,
        })
    }

    detachPane (paneId: string, ownerId: string): Promise<any> {
        return this.request('pane-detach', { paneId, ownerId })
    }

    paneDescriptors (snapshot: any, workspaceId?: string | null): HerdrPaneDescriptor[] {
        const panes = Array.isArray(snapshot?.panes) ? snapshot.panes : []
        return panes
            .filter(pane => !workspaceId || pane?.workspace_id === workspaceId)
            .filter(pane => typeof pane?.pane_id === 'string' && typeof pane?.terminal_id === 'string')
            .map(pane => ({
                paneId: pane.pane_id,
                terminalId: pane.terminal_id,
                workspaceId: String(pane.workspace_id ?? ''),
                tabId: String(pane.tab_id ?? ''),
                title: String(pane.title ?? pane.terminal_title_stripped ?? pane.label ?? pane.agent ?? pane.pane_id),
                cwd: typeof pane.foreground_cwd === 'string'
                    ? pane.foreground_cwd
                    : typeof pane.cwd === 'string' ? pane.cwd : null,
                focused: pane.focused === true,
                agent: typeof pane.agent === 'string' ? pane.agent : null,
            }))
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
