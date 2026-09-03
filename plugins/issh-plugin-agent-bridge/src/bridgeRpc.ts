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
    kind: string
    state: string
}

export function listSessions (): Promise<SessionInfo[]> {
    return runtimeRequest<SessionInfo[]>('session.list')
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

export function authorizeAgent (agentId: string, scope: string): Promise<Agent> {
    return runtimeRequest<Agent>('agent.authorize', { agentId, scope })
}
