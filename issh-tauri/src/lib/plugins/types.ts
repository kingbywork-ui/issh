import type { Component } from 'svelte'
import type { Terminal } from '@xterm/xterm'

export const PLUGIN_GATEWAY_API_VERSION = '1'
export type PluginPermission = string
export type Disposable = () => void

export interface GatewayRequestOptions {
    signal?: AbortSignal
    timeoutMs?: number
    requestId?: string
}

export interface GatewayNetworkOptions extends GatewayRequestOptions {
    method?: 'GET' | 'POST' | 'PATCH'
    headers?: Record<string, string>
    body?: string
}

export interface PluginGateway {
    apiVersion: typeof PLUGIN_GATEWAY_API_VERSION
    request<T = unknown> (method: string, args?: Record<string, unknown>, options?: GatewayRequestOptions): Promise<T>
    ui: {
        registerSettingsTab (tab: SettingsTabDefinition): Disposable
        registerHomeCard (card: HomeCardDefinition): Disposable
        registerPanel (panel: PanelDefinition): Disposable
        registerSandboxPanel (panel: SandboxPanelDefinition): Disposable
        registerTerminalDecorator (decorator: TerminalDecoratorDefinition): Disposable
    }
    sessions: {
        getCurrent (): Promise<unknown>
        read (sessionId: string, lines?: number, options?: GatewayRequestOptions): Promise<unknown>
        write (sessionId: string, data: string | Uint8Array, options?: GatewayRequestOptions): Promise<unknown>
    }
    terminal: {
        read (sessionId: string, lines?: number, options?: GatewayRequestOptions): Promise<unknown>
        write (sessionId: string, data: string | Uint8Array, options?: GatewayRequestOptions): Promise<unknown>
    }
    profiles: {
        read (options?: GatewayRequestOptions): Promise<unknown>
        mutate (mutation: unknown, options?: GatewayRequestOptions): Promise<unknown>
    }
    vault: {
        status (options?: GatewayRequestOptions): Promise<unknown>
        unlock (passphrase: string, options?: GatewayRequestOptions): Promise<unknown>
        getSecret (id: string, options?: GatewayRequestOptions): Promise<unknown>
    }
    network: {
        fetch (url: string, options?: GatewayNetworkOptions): Promise<{ status: number; ok: boolean; body: string }>
    }
    events: {
        on (eventName: string, handler: (params: unknown) => void): Disposable
    }
    storage: PluginStorage
    log (level: 'info' | 'warn' | 'error', message: string): void
}

export interface IsshPluginManifest {
    id: string
    name: string
    version: string
    description: string
    kind: 'feature' | 'appearance' | 'integration'
    minAppVersion?: string
    entry: string
    permissions?: string[]
    dependencies?: Array<string | { id: string; minVersion?: string }>
    author?: string
    homepage?: string
    repository?: string
    gatewayApiVersion?: string
    capabilities?: string[]
    signature?: string
}

export interface SettingsTabDefinition {
    id: string
    title: string
    order?: number
    component: Component<Record<string, unknown>>
}

export interface HomeCardDefinition {
    id: string
    title: string
    order?: number
    component: Component<Record<string, unknown>>
}

export interface PanelDefinition {
    id: string
    title: string
    placement: 'left' | 'bottom'
    component: Component<Record<string, unknown>>
}

export interface SandboxPanelDefinition {
    id: string
    title: string
    placement: 'left' | 'bottom'
    sandboxUrl: string
    sandboxOrigin: string
    height?: number
}

export interface TerminalDecoratorDefinition {
    id: string
    decorate (options: TerminalDecoratorOptions): void | Promise<void>
}

export interface TerminalDecoratorProfileInfo {
    name: string
    host: string
    port: number
    user: string
    loginScript: string | null
}

export interface TerminalDecoratorOptions {
    sessionId: string
    kind: 'local' | 'ssh'
    title: string
    terminal: Terminal
    /** SSH 会话关联的主机 profile 摘要（本地会话为 null） */
    profile: TerminalDecoratorProfileInfo | null
    write (data: Uint8Array | string): void
    /** 为当前终端暴露一个可选的上下文操作（例如填充 sudo 密码）。 */
    setAction? (action: { label: string, invoke: () => void } | null): void
    /** 需要临时读取已锁 Vault 中的终端凭据时，请求用户输入主口令。 */
    requestVaultPassphrase? (): Promise<string | null>
    dispose (callback: () => void): void
}

export interface PluginStorage {
    get (key: string): string | null
    set (key: string, value: string): void
    delete (key: string): void
    keys (): string[]
}

export interface IsshPluginContext {
    manifest: IsshPluginManifest
    gateway: PluginGateway
    registerSettingsTab (tab: SettingsTabDefinition): void
    registerHomeCard (card: HomeCardDefinition): void
    registerPanel (panel: PanelDefinition): void
    registerSandboxPanel (panel: SandboxPanelDefinition): void
    registerTerminalDecorator (decorator: TerminalDecoratorDefinition): void
    storage: PluginStorage
    log (level: 'info' | 'warn' | 'error', message: string): void
    /** 插件安装目录（正斜杠分隔）；sandbox.html 等静态资源位于该目录下 */
    directory: string
}

export interface IsshPlugin {
    manifest: IsshPluginManifest
    activate (ctx: IsshPluginContext): void | Promise<void>
    /** 插件停用/卸载时的清理钩子（可选），用于停止后台服务、释放资源等。 */
    deactivate? (): void | Promise<void>
}

export interface InstalledPluginRecord {
    manifest: IsshPluginManifest
    source: 'builtin' | 'marketplace'
    enabled: boolean
}

export interface RegistryEntry {
    manifest: IsshPluginManifest
    source: 'builtin' | 'marketplace'
    enabled: boolean
    state: 'inactive' | 'active' | 'failed'
    error?: string
}
