import { getEntry } from './registry'
import { getActiveTerminal, readTerminalBuffer } from './terminalRegistry'

export const SANDBOX_RPC_CHANNEL = 'issh-plugin-rpc'
export const SANDBOX_EVENT_CHANNEL = 'issh-plugin-event'
const RPC_TIMEOUT_MS = 5000

export interface SandboxRpcRequest {
    channel: typeof SANDBOX_RPC_CHANNEL
    id: string
    method: string
    params: Record<string, unknown>
}

export interface SandboxRpcResponse {
    channel: typeof SANDBOX_RPC_CHANNEL
    id: string
    ok: boolean
    result?: unknown
    error?: string
}

export interface SandboxEventMessage {
    channel: typeof SANDBOX_EVENT_CHANNEL
    event: string
    params: Record<string, unknown>
}

type PendingEntry = {
    resolve: (value: unknown) => void
    reject: (cause: Error) => void
    timer: ReturnType<typeof setTimeout>
}

const pending = new Map<string, PendingEntry>()
const pluginOrigins = new Map<string, string>()
let bridgeInstalled = false

if (typeof window !== 'undefined') {
    window.addEventListener('message', (event) => {
        const data = event.data as SandboxRpcResponse | undefined
        if (!data || typeof data !== 'object') return
        if (data.channel !== SANDBOX_RPC_CHANNEL) return
        const entry = pending.get(data.id)
        if (!entry) return
        pending.delete(data.id)
        clearTimeout(entry.timer)
        if (data.ok) entry.resolve(data.result)
        else entry.reject(new Error(data.error ?? 'RPC 失败'))
    })
}

function storagePrefix (pluginId: string): string {
    return `issh.plugin.${pluginId}.`
}

function requirePermission (pluginId: string, permission: string): boolean {
    const entry = getEntry(pluginId)
    if (!entry) return false
    return (entry.manifest.permissions ?? []).includes(permission)
}

const METHOD_PERMISSIONS: Record<string, string[]> = {
    'storage.get': [],
    'storage.set': [],
    'storage.delete': [],
    'storage.keys': [],
    'manifest.get': [],
    'terminal.read': ['terminal:decorate'],
    'terminal.write': ['terminal:decorate'],
    'profiles.list': ['profiles:read'],
}

export function registerSandboxOrigin (pluginId: string, origin: string): void {
    pluginOrigins.set(pluginId, origin)
}

export function unregisterSandboxOrigin (pluginId: string): void {
    pluginOrigins.delete(pluginId)
}

function handleStorageCall (pluginId: string, method: string, params: Record<string, unknown>): unknown {
    const prefix = storagePrefix(pluginId)
    const key = typeof params.key === 'string' ? params.key : ''
    if (key.includes('..') || key.startsWith('issh.')) {
        throw new Error(`非法 storage key：${key}`)
    }
    switch (method) {
        case 'storage.get': {
            try { return localStorage.getItem(prefix + key) } catch { return null }
        }
        case 'storage.set': {
            if (typeof params.value !== 'string') throw new Error('storage.set 需要 string value')
            try { localStorage.setItem(prefix + key, params.value) } catch {}
            return null
        }
        case 'storage.delete': {
            try { localStorage.removeItem(prefix + key) } catch {}
            return null
        }
        case 'storage.keys': {
            const keys: string[] = []
            try {
                for (let i = 0; i < localStorage.length; i++) {
                    const key = localStorage.key(i)
                    if (key && key.startsWith(prefix)) keys.push(key.slice(prefix.length))
                }
            } catch {}
            return keys
        }
        default:
            throw new Error(`未知 method：${method}`)
    }
}

function dispatchRpc (pluginId: string, request: SandboxRpcRequest): unknown {
    const requiredPermissions = METHOD_PERMISSIONS[request.method]
    if (!requiredPermissions) {
        throw new Error(`未知 method：${request.method}`)
    }
    for (const permission of requiredPermissions) {
        if (!requirePermission(pluginId, permission)) {
            throw new Error(`插件 ${pluginId} 未声明权限：${permission}`)
        }
    }
    if (request.method.startsWith('storage.') || request.method === 'manifest.get') {
        return handleStorageCall(pluginId, request.method, request.params)
    }
    if (request.method === 'terminal.read') {
        const lines = typeof request.params.lines === 'number' ? Math.min(Math.max(1, Math.floor(request.params.lines)), 200) : 20
        const record = getActiveTerminal()
        if (!record) throw new Error('当前无活动终端会话')
        return { sessionId: record.sessionId, title: record.title, lines: readTerminalBuffer(record, lines) }
    }
    if (request.method === 'terminal.write') {
        const data = typeof request.params.data === 'string' ? request.params.data : ''
        if (!data) throw new Error('terminal.write 需要 string data')
        const record = getActiveTerminal()
        if (!record) throw new Error('当前无活动终端会话')
        record.write(data)
        return null
    }
    if (request.method === 'profiles.list') {
        return handleProfilesList()
    }
    throw new Error(`method 暂未实现：${request.method}`)
}

async function handleProfilesList (): Promise<unknown> {
    const { hostProfiles } = await import('../runtime')
    const result = await hostProfiles()
    return {
        encrypted: result.encrypted,
        unlocked: result.unlocked,
        profiles: result.profiles.map((profile) => ({
            id: profile.id,
            name: profile.name,
            host: profile.host,
            port: profile.port,
            user: profile.user,
            favorite: profile.favorite,
            group: profile.group,
            tags: profile.tags,
        })),
        groups: result.groups.map((group) => ({ id: group.id, name: group.name, parentGroupId: group.parentGroupId })),
    }
}

function findPluginByOrigin (origin: string): string | null {
    for (const [pluginId, pluginOrigin] of pluginOrigins.entries()) {
        if (pluginOrigin === origin) return pluginId
    }
    return null
}

export function installSandboxBridge (): void {
    if (bridgeInstalled) return
    if (typeof window === 'undefined') return
    bridgeInstalled = true
    window.addEventListener('message', (event) => {
        const data = event.data as SandboxRpcRequest | undefined
        if (!data || typeof data !== 'object') return
        if (data.channel !== SANDBOX_RPC_CHANNEL) return
        const pluginId = findPluginByOrigin(event.origin)
        if (!pluginId) return
        const respond = (ok: boolean, payload: unknown, errorMessage?: string) => {
            const response: SandboxRpcResponse = {
                channel: SANDBOX_RPC_CHANNEL,
                id: data.id,
                ok,
            }
            if (ok) response.result = payload
            else response.error = errorMessage
            event.source?.postMessage(response, { targetOrigin: event.origin })
        }
        try {
            const result = dispatchRpc(pluginId, data)
            if (result instanceof Promise) {
                result.then(
                    (value) => respond(true, value),
                    (cause) => respond(false, undefined, cause instanceof Error ? cause.message : String(cause)),
                )
            } else {
                respond(true, result)
            }
        } catch (cause) {
            respond(false, undefined, cause instanceof Error ? cause.message : String(cause))
        }
    })
}

export function sendSandboxEvent (pluginId: string, eventName: string, params: Record<string, unknown>): void {
    const origin = pluginOrigins.get(pluginId)
    if (!origin) return
    const frame = findSandboxFrame(pluginId)
    if (!frame || !frame.contentWindow) return
    const message: SandboxEventMessage = {
        channel: SANDBOX_EVENT_CHANNEL,
        event: eventName,
        params,
    }
    frame.contentWindow.postMessage(message, origin)
}

export function broadcastSandboxEvent (eventName: string, params: Record<string, unknown>): void {
    for (const pluginId of pluginOrigins.keys()) {
        sendSandboxEvent(pluginId, eventName, params)
    }
}

export function rpcTimeoutMs (): number {
    return RPC_TIMEOUT_MS
}

export function createSandboxClient (pluginId: string): {
    call (method: string, params?: Record<string, unknown>): Promise<unknown>
} {
    return {
        async call (method: string, params: Record<string, unknown> = {}) {
            const id = `${pluginId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
            const request: SandboxRpcRequest = {
                channel: SANDBOX_RPC_CHANNEL,
                id,
                method,
                params,
            }
            const frame = findSandboxFrame(pluginId)
            if (!frame) throw new Error(`沙箱 iframe 未找到：${pluginId}`)
            const origin = pluginOrigins.get(pluginId)
            if (!origin) throw new Error(`沙箱 origin 未注册：${pluginId}`)
            return await new Promise((resolve, reject) => {
                const timer = setTimeout(() => {
                    pending.delete(id)
                    reject(new Error(`RPC 超时（${RPC_TIMEOUT_MS}ms）：${method}`))
                }, RPC_TIMEOUT_MS)
                pending.set(id, { resolve, reject, timer })
                frame.contentWindow?.postMessage(request, origin)
            })
        },
    }
}

function findSandboxFrame (pluginId: string): HTMLIFrameElement | null {
    return document.querySelector<HTMLIFrameElement>(`iframe[data-sandbox-plugin="${pluginId}"]`)
}
