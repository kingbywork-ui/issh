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
