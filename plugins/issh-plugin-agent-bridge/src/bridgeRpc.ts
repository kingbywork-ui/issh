import type { IsshPluginContext } from './types'

let requestId = 0
let gateway: IsshPluginContext['gateway'] | null = null

export function setGateway (value: IsshPluginContext['gateway']): void { gateway = value }

export async function runtimeRequest<T> (method: string, params?: unknown): Promise<T> {
    requestId += 1
    if (!gateway) throw new Error('Agent Bridge 网关尚未初始化')
    return gateway.request<T>(method, params === undefined ? {} : params as Record<string, unknown>, { requestId: `bridge-${requestId}` })
}

export interface ManagementStatus {
    enabled: boolean
    running: boolean
    port: number
    url: string
    tokenConfigured: boolean
    lastError?: string | null
}

export interface RuntimeHealth {
    runtimeVersion: string
    capabilities: string[]
}

export function managementStatus (): Promise<ManagementStatus> {
    return runtimeRequest<ManagementStatus>('management.status')
}

export function openManagement (): Promise<{ opened: boolean }> {
    return runtimeRequest<{ opened: boolean }>('management.open')
}

export function runtimeHealth (): Promise<RuntimeHealth> {
    return runtimeRequest<RuntimeHealth>('runtime.health')
}
