// issh plugin API type definitions
// Mirrors issh-tauri/src/lib/plugins/types.ts and sandboxBridge.ts protocol

export type PluginKind = 'feature' | 'appearance' | 'integration'

export interface IsshPluginManifest {
    id: string
    name: string
    version: string
    description: string
    kind: PluginKind
    minAppVersion?: string
    entry: string
    permissions?: string[]
    dependencies?: Array<string | { id: string; minVersion?: string }>
    author?: string
    homepage?: string
    repository?: string
}

export interface SettingsTabDefinition {
    id: string
    title: string
    order?: number
    component: unknown
}

export interface HomeCardDefinition {
    id: string
    title: string
    order?: number
    render: (target: HTMLElement) => void | (() => void)
}

export interface PanelDefinition {
    id: string
    title: string
    placement: 'left' | 'bottom'
    component: unknown
}

export interface SandboxPanelDefinition {
    id: string
    title: string
    placement: 'left' | 'bottom'
    sandboxUrl: string
    sandboxOrigin: string
    height?: number
}

export interface TerminalDecoratorOptions {
    terminal: {
        buffer: {
            active: {
                baseY: number
                cursorY: number
                cursorX: number
                getLine (y: number): { translateToString (trimRight?: boolean): string } | undefined
            }
        }
        attachCustomKeyEventHandler (handler: (event: KeyboardEvent) => boolean | undefined): (() => void) | undefined
        onData (listener: (data: string) => void): { dispose (): void }
        element: HTMLElement | undefined
    }
    write (data: string | Uint8Array): void
    dispose (callback: () => void): void
}

export interface TerminalDecoratorDefinition {
    id: string
    decorate (options: TerminalDecoratorOptions): void | Promise<void>
}

export interface PluginStorage {
    get (key: string): string | null
    set (key: string, value: string): void
    delete (key: string): void
    keys (): string[]
}

export interface IsshPluginContext {
    manifest: IsshPluginManifest
    registerSettingsTab (tab: SettingsTabDefinition): void
    registerHomeCard (card: HomeCardDefinition): void
    registerPanel (panel: PanelDefinition): void
    registerSandboxPanel (panel: SandboxPanelDefinition): void
    registerTerminalDecorator (decorator: TerminalDecoratorDefinition): void
    storage: PluginStorage
    log (level: 'info' | 'warn' | 'error', message: string): void
}

export interface IsshPlugin {
    manifest: IsshPluginManifest
    activate (ctx: IsshPluginContext): void | Promise<void>
}

// ---- Sandbox RPC protocol (iframe sandbox panels) ----

export const SANDBOX_RPC_CHANNEL = 'issh-plugin-rpc'
export const SANDBOX_EVENT_CHANNEL = 'issh-plugin-event'

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

export type SandboxRpcMethod =
    | 'storage.get'
    | 'storage.set'
    | 'storage.delete'
    | 'storage.keys'
    | 'manifest.get'
    | 'terminal.read'
    | 'terminal.write'
    | 'profiles.list'
    | 'profiles.write'

export interface TerminalReadResult {
    sessionId: string
    title: string
    lines: string[]
}

export interface ProfilesListResult {
    encrypted: boolean
    unlocked: boolean
    profiles: Array<{
        id: string
        name: string
        host: string
        port: number
        user: string
        favorite: boolean
        group: string | null
        tags: string[]
    }>
    groups: Array<{ id: string; name: string; parentGroupId: string | null }>
}

export interface ProfilesWriteResult {
    updated: boolean
    changes: string[]
}

/** 沙箱内调用宿主 RPC 的客户端辅助函数 */
export function createSandboxRpcClient (): {
    call<T = unknown> (method: SandboxRpcMethod, params?: Record<string, unknown>): Promise<T>
} {
    let rpcId = 0
    const pending = new Map<string, { resolve: (value: unknown) => void; reject: (cause: Error) => void; timer: ReturnType<typeof setTimeout> }>()
    window.addEventListener('message', (event: MessageEvent) => {
        const data = event.data as SandboxRpcResponse | undefined
        if (!data || data.channel !== SANDBOX_RPC_CHANNEL) return
        const entry = pending.get(data.id)
        if (!entry) return
        pending.delete(data.id)
        clearTimeout(entry.timer)
        if (data.ok) entry.resolve(data.result)
        else entry.reject(new Error(data.error ?? 'RPC 失败'))
    })
    return {
        call<T = unknown> (method: SandboxRpcMethod, params: Record<string, unknown> = {}): Promise<T> {
            const id = `rpc-${++rpcId}`
            return new Promise<T>((resolve, reject) => {
                const timer = setTimeout(() => {
                    pending.delete(id)
                    reject(new Error(`RPC 超时：${method}`))
                }, 5000)
                pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer })
                window.parent.postMessage({ channel: SANDBOX_RPC_CHANNEL, id, method, params }, '*')
            })
        },
    }
}

/** 沙箱内监听宿主事件 */
export function onSandboxEvent (eventName: string, handler: (params: Record<string, unknown>) => void): () => void {
    const listener = (event: MessageEvent) => {
        const data = event.data as SandboxEventMessage | undefined
        if (!data || data.channel !== SANDBOX_EVENT_CHANNEL) return
        if (data.event === eventName) handler(data.params)
    }
    window.addEventListener('message', listener)
    return () => window.removeEventListener('message', listener)
}
