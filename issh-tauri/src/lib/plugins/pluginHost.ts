import { Context, type Fiber } from 'cordis'
import { convertFileSrc } from '@tauri-apps/api/core'
import {
    getEntry,
    isEnabled,
    listEntries,
    markState,
    registerManifest,
    setEnabled,
    subscribe,
    unregisterManifest,
} from './registry'
import type {
    HomeCardDefinition,
    IsshPlugin,
    IsshPluginContext,
    IsshPluginManifest,
    PanelDefinition,
    PluginStorage,
    RegistryEntry,
    SandboxPanelDefinition,
    SettingsTabDefinition,
    TerminalDecoratorDefinition,
} from './types'

type Listener = () => void

const root = new Context()

const plugins = new Map<string, IsshPlugin>()
const installedMarketplaceIds = new Set<string>()
const fibers = new Map<string, Fiber>()
const settingsTabs = new Map<string, SettingsTabDefinition>()
const homeCards = new Map<string, HomeCardDefinition>()
const panels = new Map<string, PanelDefinition>()
const terminalDecorators = new Map<string, TerminalDecoratorDefinition>()
const sandboxPanels = new Map<string, { pluginId: string; definition: SandboxPanelDefinition }>()

const listeners = new Set<Listener>()

function notify (): void {
    for (const listener of listeners) listener()
}

export function subscribeUi (listener: Listener): () => void {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
}

export function getSettingsTabs (): SettingsTabDefinition[] {
    return [...settingsTabs.values()].sort((a, b) => (a.order ?? 100) - (b.order ?? 100))
}

export function getHomeCards (): HomeCardDefinition[] {
    return [...homeCards.values()].sort((a, b) => (a.order ?? 100) - (b.order ?? 100))
}

export function getPanels (placement: PanelDefinition['placement']): PanelDefinition[] {
    return [...panels.values()].filter((panel) => panel.placement === placement)
}

export function getSandboxPanels (placement: 'left' | 'bottom'): Array<{ pluginId: string; panel: SandboxPanelDefinition }> {
    return [...sandboxPanels.values()].filter((entry) => entry.definition.placement === placement).map((entry) => ({ pluginId: entry.pluginId, panel: entry.definition }))
}

export function getTerminalDecorators (): TerminalDecoratorDefinition[] {
    return [...terminalDecorators.values()]
}

function makeStorage (id: string): PluginStorage {
    const prefix = `issh.plugin.${id}.`
    return {
        get (key) {
            try { return localStorage.getItem(prefix + key) } catch { return null }
        },
        set (key, value) {
            try { localStorage.setItem(prefix + key, value) } catch {}
        },
        delete (key) {
            try { localStorage.removeItem(prefix + key) } catch {}
        },
        keys () {
            const result: string[] = []
            try {
                for (let i = 0; i < localStorage.length; i++) {
                    const key = localStorage.key(i)
                    if (key && key.startsWith(prefix)) result.push(key.slice(prefix.length))
                }
            } catch {}
            return result
        },
    }
}

function makePluginContext (manifest: IsshPluginManifest): IsshPluginContext {
    const requirePermission = (permission: string, api: string): boolean => {
        const declared = manifest.permissions ?? []
        if (declared.includes(permission)) return true
        console.warn(`[plugin ${manifest.id}] 未声明权限 ${permission}，拒绝 ${api}`)
        return false
    }
    return {
        manifest,
        registerSettingsTab (tab) {
            if (!requirePermission('settings:tab', 'registerSettingsTab')) return
            settingsTabs.set(`${manifest.id}:${tab.id}`, tab)
            notify()
        },
        registerHomeCard (card) {
            if (!requirePermission('home:card', 'registerHomeCard')) return
            homeCards.set(`${manifest.id}:${card.id}`, card)
            notify()
        },
        registerPanel (panel) {
            if (!requirePermission('panel:register', 'registerPanel')) return
            panels.set(`${manifest.id}:${panel.id}`, panel)
            notify()
        },
        registerSandboxPanel (panel) {
            if (!requirePermission('panel:register', 'registerSandboxPanel')) return
            sandboxPanels.set(`${manifest.id}:${panel.id}`, { pluginId: manifest.id, definition: panel })
            notify()
        },
        registerTerminalDecorator (decorator) {
            if (!requirePermission('terminal:decorate', 'registerTerminalDecorator')) return
            terminalDecorators.set(`${manifest.id}:${decorator.id}`, decorator)
            notify()
        },
        storage: makeStorage(manifest.id),
        log (level, message) {
            const line = `[plugin ${manifest.id}] ${message}`
            if (level === 'error') console.error(line)
            else if (level === 'warn') console.warn(line)
            else console.info(line)
        },
    }
}

export function registerPlugin (plugin: IsshPlugin, source: 'builtin' | 'marketplace' = 'builtin'): RegistryEntry {
    const existing = plugins.get(plugin.manifest.id)
    if (existing) return getEntry(plugin.manifest.id) ?? registerManifest(plugin.manifest, source)
    plugins.set(plugin.manifest.id, plugin)
    return registerManifest(plugin.manifest, source)
}

interface MarketplacePluginModule {
    default?: IsshPlugin
    manifest?: IsshPluginManifest
    plugin?: IsshPlugin
}

export async function loadMarketplacePlugin (directory: string, entryFile: string, id: string): Promise<void> {
    if (plugins.has(id)) return
    installedMarketplaceIds.add(id)
    const url = convertFileSrc(`${directory.replace(/\\/g, '/')}/${entryFile}`)
    const module = await import(/* @vite-ignore */ url) as MarketplacePluginModule
    const plugin = module.default ?? module.plugin
    if (!plugin || !plugin.manifest) throw new Error(`插件入口未导出 default/plugin：${id}`)
    if (plugin.manifest.id !== id) {
        throw new Error(`插件 id 不匹配：期望 ${id}，实际 ${plugin.manifest.id}`)
    }
    registerPlugin(plugin, 'marketplace')
    await activatePlugin(id)
}

export async function activatePlugin (id: string): Promise<void> {
    const plugin = plugins.get(id)
    if (!plugin) throw new Error(`plugin not registered: ${id}`)
    if (fibers.has(id)) return
    if (!isEnabled(id)) return
    const entry = getEntry(id)
    if (entry && entry.state === 'failed' && !entry.enabled) return
    const dependencyError = checkDependencies(plugin.manifest)
    if (dependencyError) {
        markState(id, 'failed', dependencyError)
        return
    }
    const fiber = root.plugin((ctx) => {
        void Promise.resolve(plugin.activate(makePluginContext(plugin.manifest))).catch((cause: unknown) => {
            markState(id, 'failed', cause instanceof Error ? cause.message : String(cause))
        })
        return () => {
            for (const key of [...settingsTabs.keys()]) if (key.startsWith(`${id}:`)) settingsTabs.delete(key)
            for (const key of [...homeCards.keys()]) if (key.startsWith(`${id}:`)) homeCards.delete(key)
            for (const key of [...panels.keys()]) if (key.startsWith(`${id}:`)) panels.delete(key)
            for (const key of [...sandboxPanels.keys()]) if (key.startsWith(`${id}:`)) sandboxPanels.delete(key)
            for (const key of [...terminalDecorators.keys()]) if (key.startsWith(`${id}:`)) terminalDecorators.delete(key)
            notify()
        }
    })
    fibers.set(id, fiber)
    markState(id, 'active')
    notify()
}

export async function deactivatePlugin (id: string): Promise<void> {
    const fiber = fibers.get(id)
    if (!fiber) return
    fibers.delete(id)
    await fiber.dispose()
    markState(id, 'inactive')
    notify()
}

export async function enablePlugin (id: string): Promise<void> {
    setEnabled(id, true)
    await activatePlugin(id)
}

export async function disablePlugin (id: string): Promise<void> {
    setEnabled(id, false)
    await deactivatePlugin(id)
}

export async function uninstallPlugin (id: string): Promise<void> {
    await deactivatePlugin(id)
    plugins.delete(id)
    unregisterManifest(id)
    clearPluginStorage(id)
}

function clearPluginStorage (id: string): void {
    try {
        const prefix = `issh.plugin.${id}.`
        const keys: string[] = []
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i)
            if (key && key.startsWith(prefix)) keys.push(key)
        }
        for (const key of keys) localStorage.removeItem(key)
    } catch {}
}

export function listPlugins (): RegistryEntry[] {
    return listEntries()
}

export async function initPluginHost (): Promise<void> {
    for (const entry of listEntries()) {
        if (!entry.enabled) continue
        await activatePlugin(entry.manifest.id).catch(() => {})
    }
    await loadInstalledMarketplacePlugins().catch(() => {})
}

export async function loadInstalledMarketplacePlugins (): Promise<void> {
    try {
        const { invoke } = await import('@tauri-apps/api/core')
        const installed = await invoke<Array<{ id: string; directory: string; entry: string }>>('plugin_list_installed')
        for (const record of installed) {
            installedMarketplaceIds.add(record.id)
        }
        for (const record of installed) {
            if (plugins.has(record.id)) continue
            if (!isEnabled(record.id)) continue
            await loadMarketplacePlugin(record.directory, record.entry, record.id).catch((cause: unknown) => {
                console.warn(`[plugin ${record.id}] 加载失败：`, cause)
            })
        }
    } catch (cause) {
        console.warn('[plugins] 读取已安装商城插件失败：', cause)
    }
}

export interface PluginUpdateInfo {
    id: string
    name: string
    installedVersion: string
    latestVersion: string
}

function compareVersions (a: string, b: string): number {
    const pa = a.split('.').map((n) => Number.parseInt(n, 10) || 0)
    const pb = b.split('.').map((n) => Number.parseInt(n, 10) || 0)
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const diff = (pa[i] ?? 0) - (pb[i] ?? 0)
        if (diff !== 0) return diff
    }
    return 0
}

function normalizeDependency (dep: string | { id: string; minVersion?: string }): { id: string; minVersion?: string } {
    return typeof dep === 'string' ? { id: dep } : dep
}

function checkDependencies (manifest: IsshPluginManifest): string | null {
    const deps = manifest.dependencies ?? []
    if (deps.length === 0) return null
    for (const dep of deps) {
        const { id, minVersion } = normalizeDependency(dep)
        const target = plugins.get(id)
        if (!target) {
            const installed = installedMarketplaceIds.has(id)
            if (!installed) return `缺少依赖插件：${id}`
        } else if (minVersion && compareVersions(target.manifest.version, minVersion) < 0) {
            return `依赖插件 ${id} 版本过低（需 ≥ ${minVersion}，当前 ${target.manifest.version}）`
        }
    }
    return null
}

export async function checkPluginUpdates (registryUrl: string): Promise<PluginUpdateInfo[]> {
    try {
        const { invoke } = await import('@tauri-apps/api/core')
        const installed = await invoke<Array<{ id: string; directory: string; entry: string; version?: string }>>('plugin_list_installed')
        if (installed.length === 0) return []
        const registry = await invoke<{ plugins: Array<{ id: string; name: string; version: string }> }>('plugin_fetch_registry', { url: registryUrl })
        const updates: PluginUpdateInfo[] = []
        for (const record of installed) {
            const entry = registry.plugins.find((candidate) => candidate.id === record.id)
            if (!entry) continue
            const installedVersion = record.version ?? readInstalledVersion(record.id)
            if (installedVersion && compareVersions(entry.version, installedVersion) > 0) {
                updates.push({ id: entry.id, name: entry.name, installedVersion, latestVersion: entry.version })
            }
        }
        return updates
    } catch (cause) {
        console.warn('[plugins] 检查插件更新失败：', cause)
        return []
    }
}

function readInstalledVersion (id: string): string {
    const manifest = plugins.get(id)?.manifest
    return manifest?.version ?? ''
}

export { subscribe as subscribeRegistry }
