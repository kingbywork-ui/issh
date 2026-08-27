import type { Component } from 'svelte'
import type { Terminal } from '@xterm/xterm'

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

export interface TerminalDecoratorDefinition {
    id: string
    decorate (options: TerminalDecoratorOptions): void | Promise<void>
}

export interface TerminalDecoratorOptions {
    sessionId: string
    kind: 'local' | 'ssh'
    title: string
    terminal: Terminal
    write (data: Uint8Array | string): void
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
    registerSettingsTab (tab: SettingsTabDefinition): void
    registerHomeCard (card: HomeCardDefinition): void
    registerPanel (panel: PanelDefinition): void
    registerTerminalDecorator (decorator: TerminalDecoratorDefinition): void
    storage: PluginStorage
    log (level: 'info' | 'warn' | 'error', message: string): void
}

export interface IsshPlugin {
    manifest: IsshPluginManifest
    activate (ctx: IsshPluginContext): void | Promise<void>
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
