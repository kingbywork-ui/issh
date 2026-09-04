import type { IsshPluginContext } from './types'

let requestId = 0
let gateway: IsshPluginContext['gateway'] | null = null

export function setGateway (value: IsshPluginContext['gateway']): void { gateway = value }

export async function runtimeRequest<T> (method: string, params?: unknown): Promise<T> {
    requestId += 1
    if (!gateway) throw new Error('Agent Bridge 网关尚未初始化')
    return gateway.request<T>(method, params === undefined ? {} : params as Record<string, unknown>, { requestId: `bridge-${requestId}` })
}

export interface SessionInfo {
    id: string
    title: string
    profileType: string | null
    connected: boolean
}

export function listSessions (): Promise<SessionInfo[]> {
    return runtimeRequest<SessionInfo[]>('session.list')
}

export interface SessionReadResult {
    events?: Array<{ data?: number[] }>
}

export async function readSessionOutput (sessionId: string, lines = 120): Promise<string> {
    const result = await runtimeRequest<SessionReadResult>('session.read', { sessionId, lines })
    const bytes = (result.events ?? []).flatMap((event) => event.data ?? [])
    return new TextDecoder().decode(Uint8Array.from(bytes))
}
export interface RemoteAgentProbeResult {
    output: string
}

export function probeRemoteAgents (sessionId: string): Promise<RemoteAgentProbeResult> {
    return runtimeRequest<RemoteAgentProbeResult>('ssh.execReadonly', {
        sessionId,
        command: 'sh -lc \'for name in pi omp codex claude opencode hermes hermes-agent; do path="$(command -v "$name" 2>/dev/null)" && printf "%s\t%s\n" "$name" "$path"; done\'',
        timeoutMs: 10000,
        maxOutputBytes: 16 * 1024,
    })
}

export interface RuntimeHealth {
    runtimeVersion: string
    capabilities: string[]
}

export function runtimeHealth (): Promise<RuntimeHealth> {
    return runtimeRequest<RuntimeHealth>('runtime.health')
}

export interface Workspace {
    id: string
    name: string
    createdAtUnixMs: number
    bindings: Array<{ sessionId: string; profileId?: string | null; host?: string | null; user?: string | null; status?: string }>
}

export function listWorkspaces (): Promise<Workspace[]> {
    return runtimeRequest<Workspace[]>('workspace.list')
}

export function createWorkspace (name: string): Promise<Workspace> {
    return runtimeRequest<Workspace>('workspace.create', { name })
}

export function bindSession (workspaceId: string, sessionId: string): Promise<unknown> {
    return runtimeRequest('workspace.bind', { workspaceId, sessionId })
}

export function unbindSession (workspaceId: string, sessionId: string): Promise<unknown> {
    return runtimeRequest('workspace.unbind', { workspaceId, sessionId })
}

export interface Agent {
    id: string
    workspaceId: string
    name: string
    adapter: string
    sessionId: string | null
    scopes: string[]
    status: string
    createdAtUnixMs: number
    updatedAtUnixMs: number
}

export function listAgents (workspaceId: string): Promise<Agent[]> {
    return runtimeRequest<Agent[]>('agent.list', { workspaceId })
}

export function registerAgent (params: { workspaceId: string; name: string; adapter?: string; sessionId?: string; scopes?: string[] }): Promise<Agent> {
    return runtimeRequest<Agent>('agent.register', params)
}
