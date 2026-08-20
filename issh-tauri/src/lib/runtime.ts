import { invoke } from '@tauri-apps/api/core'

export interface RuntimeHealth {
    protocolVersion: string
    runtimeVersion: string
    pid: number
    startedAtUnixMs: number
    capabilities: string[]
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
