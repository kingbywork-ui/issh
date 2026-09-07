import type { IsshPluginContext } from './types'

let requestId = 0
let gateway: IsshPluginContext['gateway'] | null = null

export function setGateway (value: IsshPluginContext['gateway']): void { gateway = value }

async function request<T> (method: string): Promise<T> {
    requestId += 1
    if (!gateway) throw new Error('Agent Hub 网关尚未初始化')
    return gateway.request<T>(method, {}, { requestId: `agent-hub-${requestId}` })
}

export interface AgentHubStatus {
    installed: boolean
    running: boolean
    compatible: boolean
    url: string
    version?: string | null
    providerStatus?: string | null
    lastError?: string | null
}

export function agentHubStatus (): Promise<AgentHubStatus> {
    return request<AgentHubStatus>('agentHub.status')
}

export function openAgentHub (): Promise<{ opened: boolean }> {
    return request<{ opened: boolean }>('agentHub.open')
}
