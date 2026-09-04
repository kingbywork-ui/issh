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
import { createPluginGateway, normalizePluginPermission } from './gateway'
import { agentBridgePlugin } from './agentBridgePlugin'
import type {
    Disposable,
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

// 已内置进程序的功能（原插件形态）：禁止商城同名插件再安装/加载，避免重复注册
// 注意：商城 issh-plugin-agent-bridge（「Agent 桥接」，workspace/agent 管理）与本内置插件（CLI/MCP 外部 agent 接入）是两个不同产品，内置插件用独立 id
export const SUPERSEDED_PLUGIN_IDS = new Set(['issh-plugin-auto-sudo', 'issh-plugin-vault', 'issh-plugin-agent-bridge-rpc', 'issh-plugin-herdr'])

const root = new Context()

const plugins = new Map<string, IsshPlugin>()
const installedMarketplaceIds = new Set<string>()
const fibers = new Map<string, Fiber>()
const settingsTabs = new Map<string, SettingsTabDefinition>()
const homeCards = new Map<string, HomeCardDefinition>()
const panels = new Map<string, PanelDefinition>()
const terminalDecorators = new Map<string, TerminalDecoratorDefinition>()
const sandboxPanels = new Map<string, { pluginId: string; definition: SandboxPanelDefinition }>()
const pluginDirectories = new Map<string, string>()

const listeners = new Set<Listener>()
const pluginAudit: Array<{ timestamp: string; pluginId: string; method: string; ok: boolean; error?: string }> = []
const HOST_VERSION = '0.1.6'

function notify (): void {
    for (const listener of listeners) listener()
}

export function subscribeUi (listener: Listener): () => void {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
}

export function getSettingsTabs (): SettingsTabDefinition[] {
    return [...settingsTabs.entries()]
        .map(([key, tab]) => ({ ...tab, key }))
        .sort((a, b) => (a.order ?? 100) - (b.order ?? 100))
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

function recordPluginAudit (pluginId: string, event: { method: string; ok: boolean; error?: string }): void {
    pluginAudit.push({ timestamp: new Date().toISOString(), pluginId, ...event, error: event.error?.slice(0, 500) })
    if (pluginAudit.length > 1000) pluginAudit.splice(0, pluginAudit.length - 1000)
}

export function getPluginAudit (): Array<{ timestamp: string; pluginId: string; method: string; ok: boolean; error?: string }> {
    return pluginAudit.map((event) => ({ ...event }))
}

function makePluginContext (manifest: IsshPluginManifest, directory: string): IsshPluginContext {
    const hasPermission = (permission: string): boolean => {
        const declared = [...(manifest.permissions ?? []), ...(manifest.capabilities ?? [])]
        return declared.includes(permission) || declared.some((item) => normalizePluginPermission(item) === permission)
    }
    const denyLegacy = (permission: string, api: string): Disposable => {
        if (hasPermission(permission)) return () => {}
        const error = `插件 ${manifest.id} 未声明权限：${permission}`
        console.warn(`[plugin ${manifest.id}] ${error}，拒绝 ${api}`)
        recordPluginAudit(manifest.id, { method: api, ok: false, error })
        return () => {}
    }
    const register = <T> (map: Map<string, T>, key: string, value: T): Disposable => {
        map.set(key, value)
        notify()
        return () => {
            if (map.get(key) !== value) return
            map.delete(key)
            notify()
        }
    }
    const storage = makeStorage(manifest.id)
    const gateway = createPluginGateway(manifest, storage, {
        hasPermission,
        registerSettingsTab: (tab) => register(settingsTabs, `${manifest.id}:${tab.id}`, tab),
        registerHomeCard: (card) => register(homeCards, `${manifest.id}:${card.id}`, card),
        registerPanel: (panel) => register(panels, `${manifest.id}:${panel.id}`, panel),
        registerSandboxPanel: (panel) => {
            // 插件传相对文件名（如 sandbox.html），宿主用插件目录解析为 asset URL，
            // 避免插件直接依赖 @tauri-apps/api（convertFileSrc）。
            const isAbsolute = /^[a-z][a-z0-9+.-]*:\/\//i.test(panel.sandboxUrl) || panel.sandboxUrl.startsWith('//')
            const url = isAbsolute
                ? panel.sandboxUrl
                : convertFileSrc(`${directory.replace(/\\/g, '/')}/${panel.sandboxUrl.replace(/^\/+/, '')}`)
            const origin = panel.sandboxOrigin || new URL(url).origin
            return register(sandboxPanels, `${manifest.id}:${panel.id}`, { pluginId: manifest.id, definition: { ...panel, sandboxUrl: url, sandboxOrigin: origin } })
        },
        registerTerminalDecorator: (decorator) => register(terminalDecorators, `${manifest.id}:${decorator.id}`, decorator),
        audit: (event) => recordPluginAudit(manifest.id, event),
        confirm: async (message) => window.confirm(message),
    })
    return {
        manifest,
        gateway,
        registerSettingsTab: (tab) => hasPermission('ui.settings.register') || hasPermission('settings:tab') ? gateway.ui.registerSettingsTab(tab) : denyLegacy('ui.settings.register', 'registerSettingsTab'),
        registerHomeCard: (card) => hasPermission('ui.home.register') || hasPermission('home:card') ? gateway.ui.registerHomeCard(card) : denyLegacy('ui.home.register', 'registerHomeCard'),
        registerPanel: (panel) => hasPermission('ui.panel.register') || hasPermission('panel:register') ? gateway.ui.registerPanel(panel) : denyLegacy('ui.panel.register', 'registerPanel'),
        registerSandboxPanel: (panel) => hasPermission('ui.panel.register') || hasPermission('panel:register') ? gateway.ui.registerSandboxPanel(panel) : denyLegacy('ui.panel.register', 'registerSandboxPanel'),
        registerTerminalDecorator: (decorator) => hasPermission('terminal.decorate') || hasPermission('terminal:decorate') ? gateway.ui.registerTerminalDecorator(decorator) : denyLegacy('terminal.decorate', 'registerTerminalDecorator'),
        storage,
        log: gateway.log,
        directory,
    }
}

export function registerPlugin (plugin: IsshPlugin, source: 'builtin' | 'marketplace' = 'builtin'): RegistryEntry {
    const existing = plugins.get(plugin.manifest.id)
    if (existing) return getEntry(plugin.manifest.id) ?? registerManifest(plugin.manifest, source)
    plugins.set(plugin.manifest.id, plugin)
    const entry = registerManifest(plugin.manifest, source)
    const compatibilityError = checkManifestCompatibility(plugin.manifest)
    if (compatibilityError) markState(plugin.manifest.id, 'failed', compatibilityError)
    return entry
}

function compareVersions (a: string, b: string): number {
    const pa = a.split('.').map((part) => Number.parseInt(part, 10) || 0)
    const pb = b.split('.').map((part) => Number.parseInt(part, 10) || 0)
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const difference = (pa[i] ?? 0) - (pb[i] ?? 0)
        if (difference !== 0) return difference
    }
    return 0
}

function checkManifestCompatibility (manifest: IsshPluginManifest): string | null {
    if (manifest.gatewayApiVersion && manifest.gatewayApiVersion !== '1') {
        return `插件需要不兼容的网关 API 版本：${manifest.gatewayApiVersion}`
    }
    if (manifest.minAppVersion && compareVersions(HOST_VERSION, manifest.minAppVersion) < 0) {
        return `插件需要 issh ${manifest.minAppVersion} 或更高版本`
    }
    return null
}

interface MarketplacePluginModule {
    default?: IsshPlugin
    manifest?: IsshPluginManifest
    plugin?: IsshPlugin
}

export async function loadMarketplacePlugin (directory: string, entryFile: string, id: string): Promise<void> {
    if (SUPERSEDED_PLUGIN_IDS.has(id)) {
        throw new Error(`插件 ${id} 已内置进程序，无需安装`)
    }
    if (plugins.has(id)) return
    installedMarketplaceIds.add(id)
    pluginDirectories.set(id, directory.replace(/\\/g, '/'))
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
    const compatibilityError = checkManifestCompatibility(plugin.manifest)
    if (compatibilityError) {
        markState(id, 'failed', compatibilityError)
        throw new Error(compatibilityError)
    }
    if (!isEnabled(id)) return
    const entry = getEntry(id)
    if (entry && entry.state === 'failed' && !entry.enabled) return
    const dependencyError = checkDependencies(plugin.manifest)
    if (dependencyError) {
        markState(id, 'failed', dependencyError)
        return
    }
    const fiber = root.plugin((ctx) => {
        const directory = pluginDirectories.get(id) ?? ''
        void Promise.resolve(plugin.activate(makePluginContext(plugin.manifest, directory))).catch((cause: unknown) => {
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
    const plugin = plugins.get(id)
    if (plugin?.deactivate) {
        try {
            await plugin.deactivate()
        } catch (cause) {
            console.warn(`[plugin ${id}] deactivate 失败：`, cause)
        }
    }
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

/** 卸载后按新目录重新加载商城插件（用于插件更新流程：磁盘文件已被替换）。 */
export async function reloadMarketplacePlugin (directory: string, entryFile: string, id: string): Promise<void> {
    await deactivatePlugin(id)
    plugins.delete(id)
    unregisterManifest(id)
    await loadMarketplacePlugin(directory, entryFile, id)
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

/** 内置插件注册（保持插件接入形态，随程序发布、不可卸载）。 */
function registerBuiltinPlugins (): void {
    for (const plugin of [agentBridgePlugin]) {
        registerPlugin(plugin, 'builtin')
    }
}

export async function initPluginHost (): Promise<void> {
    registerBuiltinPlugins()
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
            if (SUPERSEDED_PLUGIN_IDS.has(record.id)) continue
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
