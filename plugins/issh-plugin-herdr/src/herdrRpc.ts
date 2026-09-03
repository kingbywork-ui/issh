import type { IsshPluginContext } from './types'

let requestId = 0
let gateway: IsshPluginContext['gateway'] | null = null

export function setGateway (value: IsshPluginContext['gateway']): void { gateway = value }

export async function runtimeRequest<T> (method: string, params?: unknown): Promise<T> {
    requestId += 1
    if (!gateway) throw new Error('Herdr 网关尚未初始化')
    return gateway.request<T>(method === 'health' ? 'runtime.health' : method, params === undefined ? {} : params as Record<string, unknown>, { requestId: `herdr-${requestId}` })
}

export interface SessionInfo {
    id: string
    title: string
    kind: string
    state: string
}

export interface Workspace {
    id: string
    name: string
    createdAtUnixMs: number
    bindings: Array<{ workspaceId: string; sessionId: string; boundAtUnixMs: number }>
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

export function listSessions (): Promise<SessionInfo[]> {
    return runtimeRequest<SessionInfo[]>('session.list')
}

export interface RuntimeHealth {
    protocolVersion: string
    runtimeVersion: string
    pid: number
    capabilities: string[]
}

export async function runtimeHealth (): Promise<RuntimeHealth> {
    return runtimeRequest<RuntimeHealth>('health')
}
