import type { IsshPluginManifest, RegistryEntry } from './types'

const ENABLED_KEY = 'issh.plugins.enabled'
const FAILED_KEY = 'issh.plugins.failed'

type Listener = () => void

const listeners = new Set<Listener>()

function readEnabledMap (): Record<string, boolean> {
    try {
        const raw = localStorage.getItem(ENABLED_KEY)
        if (!raw) return {}
        const parsed = JSON.parse(raw) as Record<string, boolean>
        return typeof parsed === 'object' && parsed !== null ? parsed : {}
    } catch {
        return {}
    }
}

function writeEnabledMap (map: Record<string, boolean>): void {
    try { localStorage.setItem(ENABLED_KEY, JSON.stringify(map)) } catch {}
}

function readFailedMap (): Record<string, string> {
    try {
        const raw = localStorage.getItem(FAILED_KEY)
        if (!raw) return {}
        const parsed = JSON.parse(raw) as Record<string, string>
        return typeof parsed === 'object' && parsed !== null ? parsed : {}
    } catch {
        return {}
    }
}

function writeFailedMap (map: Record<string, string>): void {
    try { localStorage.setItem(FAILED_KEY, JSON.stringify(map)) } catch {}
}

const registered = new Map<string, RegistryEntry>()

export function registerManifest (manifest: IsshPluginManifest, source: 'builtin' | 'marketplace'): RegistryEntry {
    const enabledMap = readEnabledMap()
    const failedMap = readFailedMap()
    const entry: RegistryEntry = {
        manifest,
        source,
        enabled: manifest.id in enabledMap ? enabledMap[manifest.id] : true,
        state: 'inactive',
        error: failedMap[manifest.id],
    }
    registered.set(manifest.id, entry)
    notify()
    return entry
}

export function unregisterManifest (id: string): void {
    registered.delete(id)
    notify()
}

export function getEntry (id: string): RegistryEntry | undefined {
    return registered.get(id)
}

export function listEntries (): RegistryEntry[] {
    return [...registered.values()].sort((a, b) => a.manifest.name.localeCompare(b.manifest.name))
}

export function isEnabled (id: string): boolean {
    const entry = registered.get(id)
    if (entry) return entry.enabled
    const map = readEnabledMap()
    return id in map ? map[id] : true
}

export function setEnabled (id: string, enabled: boolean): void {
    const entry = registered.get(id)
    if (entry) entry.enabled = enabled
    const map = readEnabledMap()
    map[id] = enabled
    writeEnabledMap(map)
    if (enabled) {
        const failed = readFailedMap()
        delete failed[id]
        writeFailedMap(failed)
    }
    notify()
}

export function markState (id: string, state: RegistryEntry['state'], error?: string): void {
    const entry = registered.get(id)
    if (!entry) return
    entry.state = state
    entry.error = error
    if (state === 'failed') {
        const failed = readFailedMap()
        failed[id] = error ?? 'unknown error'
        writeFailedMap(failed)
    } else if (state === 'active') {
        const failed = readFailedMap()
        if (id in failed) {
            delete failed[id]
            writeFailedMap(failed)
        }
    }
    notify()
}

export function subscribe (listener: Listener): () => void {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
}

function notify (): void {
    for (const listener of listeners) listener()
}
