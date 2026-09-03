export interface IsshPluginManifest {
    id: string
    name: string
    version: string
    description: string
    kind: 'feature' | 'appearance' | 'integration'
    minAppVersion?: string
    entry: string
    permissions?: string[]
    author?: string
    homepage?: string
    repository?: string
    gatewayApiVersion?: string
    capabilities?: string[]
}

export interface SettingsTabDefinition {
    id: string
    title: string
    order?: number
    component: unknown
}

export interface PluginStorage {
    get (key: string): string | null
    set (key: string, value: string): void
    delete (key: string): void
    keys (): string[]
}

export interface TerminalDecoratorProfileInfo {
    name: string
    loginScript: string | null
}

export interface TerminalDecoratorOptions {
    sessionId: string
    kind: 'local' | 'ssh'
    title: string
    terminal: unknown
    /** SSH 会话关联的主机 profile 摘要（本地会话为 null） */
    profile: TerminalDecoratorProfileInfo | null
    write (data: Uint8Array | string): void
    dispose (callback: () => void): void
}

export interface TerminalDecoratorDefinition {
    id: string
    decorate (options: TerminalDecoratorOptions): void | Promise<void>
}

export interface IsshPluginContext {
    manifest: IsshPluginManifest
    gateway: { ui: { registerSettingsTab (tab: SettingsTabDefinition): () => void; registerTerminalDecorator (decorator: TerminalDecoratorDefinition): () => void }; log (level: 'info' | 'warn' | 'error', message: string): void }
    registerSettingsTab (tab: SettingsTabDefinition): void
    registerHomeCard (card: { id: string; title: string; order?: number; component: unknown }): void
    registerPanel (panel: { id: string; title: string; placement: 'left' | 'bottom'; component: unknown }): void
    registerTerminalDecorator (decorator: TerminalDecoratorDefinition): void
    storage: PluginStorage
    log (level: 'info' | 'warn' | 'error', message: string): void
}

export interface IsshPlugin {
    manifest: IsshPluginManifest
    activate (ctx: IsshPluginContext): void | Promise<void>
}
