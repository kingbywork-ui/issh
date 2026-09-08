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
    component?: unknown
    mount?: (target: HTMLElement) => () => void
}

export interface PluginStorage {
    get(key: string): string | null
    set(key: string, value: string): void
    delete(key: string): void
    keys(): string[]
}

export interface IsshPluginContext {
    manifest: IsshPluginManifest
    gateway: { ui: { registerSettingsTab(tab: unknown): () => void; registerTerminalDecorator(d: unknown): () => void }; log(level: 'info' | 'warn' | 'error', message: string): void }
    registerSettingsTab(tab: SettingsTabDefinition): void
    registerHomeCard(card: { id: string; title: string; order?: number; component: unknown }): void
    registerPanel(panel: { id: string; title: string; placement: 'left' | 'bottom'; component: unknown }): void
    registerTerminalDecorator(decorator: { id: string; decorate(options: { sessionId: string; kind: 'local' | 'ssh'; title: string; terminal: import('@xterm/xterm').Terminal }): void | Promise<void> }): void
    storage: PluginStorage
    log(level: 'info' | 'warn' | 'error', message: string): void
    directory: string
}

export interface IsshPlugin {
    manifest: IsshPluginManifest
    activate(ctx: IsshPluginContext): void | Promise<void>
    deactivate?(): void | Promise<void>
}
