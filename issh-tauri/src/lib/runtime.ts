import { invoke } from '@tauri-apps/api/core'

export interface RuntimeHealth {
    protocolVersion: string
    runtimeVersion: string
    pid: number
    startedAtUnixMs: number
    capabilities: string[]
}

export interface RuntimeSessionSnapshot {
    id: string
    title: string
    kind: string
    state: string
    columns: number
    rows: number
    pid: number | null
    nextSequence: number
    bufferedBytes: number
    droppedBytes: number
}

export interface RuntimeSessionEvent {
    sequence: number
    kind: string
    data: number[]
}

export interface RuntimeSessionSubscription {
    session: RuntimeSessionSnapshot
    events: RuntimeSessionEvent[]
    nextAfterSequence: number
    droppedBytes: number
}

export interface RuntimeSessionWriteResult {
    sessionId: string
    acceptedBytes: number
}

interface RuntimeResponse<T> {
    jsonrpc: '2.0'
    id: string | number | null
    result?: T
    error?: {
        code: number
        message: string
    }
}

export async function runtimeHealth (): Promise<RuntimeHealth> {
    const response = await invoke<RuntimeResponse<RuntimeHealth>>('runtime_health')
    if (response.error || !response.result) {
        throw new Error(response.error?.message ?? 'Runtime 未返回健康信息')
    }
    return response.result
}

let requestId = 0

export async function runtimeRequest<T> (method: string, params?: unknown): Promise<T> {
    requestId += 1
    const response = await invoke<RuntimeResponse<T>>('runtime_request', {
        request: {
            jsonrpc: '2.0',
            id: `tauri-${requestId}`,
            method,
            ...(params === undefined ? {} : { params }),
        },
    })
    if (response.error || response.result === undefined) {
        throw new Error(response.error?.message ?? `${method} 未返回结果`)
    }
    return response.result
}

export function openLocalSession (columns = 120, rows = 36): Promise<RuntimeSessionSnapshot> {
    return runtimeRequest<RuntimeSessionSnapshot>('session.openLocal', {
        title: '本地终端',
        columns,
        rows,
    })
}

export function writeSession (sessionId: string, data: Uint8Array): Promise<RuntimeSessionWriteResult> {
    return runtimeRequest<RuntimeSessionWriteResult>('session.write', {
        sessionId,
        data: Array.from(data),
    })
}

export function resizeSession (sessionId: string, columns: number, rows: number): Promise<RuntimeSessionSnapshot> {
    return runtimeRequest<RuntimeSessionSnapshot>('session.resize', {
        sessionId,
        columns,
        rows,
    })
}

export function subscribeSession (sessionId: string, afterSequence: number): Promise<RuntimeSessionSubscription> {
    return runtimeRequest<RuntimeSessionSubscription>('session.subscribe', {
        sessionId,
        afterSequence,
        maxEvents: 64,
        maxBytes: 12288,
    })
}

export function closeSession (sessionId: string): Promise<RuntimeSessionSnapshot> {
    return runtimeRequest<RuntimeSessionSnapshot>('session.close', { sessionId })
}
