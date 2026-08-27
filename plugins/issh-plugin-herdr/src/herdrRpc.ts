import { invoke } from '@tauri-apps/api/core'

interface RuntimeResponse<T> {
    result?: T
    error?: {
        code: number
        message: string
    }
}

let requestId = 0

export async function runtimeRequest<T> (method: string, params?: unknown): Promise<T> {
    requestId += 1
    const response = await invoke<RuntimeResponse<T>>('runtime_request', {
        request: {
            jsonrpc: '2.0',
            id: `herdr-${requestId}`,
            method,
            ...(params === undefined ? {} : { params }),
        },
    })
    if (response.error || response.result === undefined) {
        throw new Error(response.error?.message ?? `${method} 未返回结果`)
    }
    return response.result
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
