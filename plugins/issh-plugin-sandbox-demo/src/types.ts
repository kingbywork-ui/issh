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

export interface SandboxPanelDefinition {
    id: string
    title: string
    placement: 'left' | 'bottom'
    sandboxUrl: string
    sandboxOrigin: string
    height?: number
}

export interface IsshPluginContext {
    manifest: IsshPluginManifest
    gateway: { ui: { registerSandboxPanel (panel: SandboxPanelDefinition): () => void }; log (level: 'info' | 'warn' | 'error', message: string): void }
    registerSettingsTab (tab: unknown): void
    registerHomeCard (card: unknown): void
    registerPanel (panel: unknown): void
    registerSandboxPanel (panel: SandboxPanelDefinition): void
    registerTerminalDecorator (decorator: unknown): void
    storage: {
        get (key: string): string | null
        set (key: string, value: string): void
        delete (key: string): void
        keys (): string[]
    }
    log (level: 'info' | 'warn' | 'error', message: string): void
}

export interface IsshPlugin {
    manifest: IsshPluginManifest
    activate (ctx: IsshPluginContext): void | Promise<void>
}
