import { invoke } from '@tauri-apps/api/core'
import type {
    Disposable,
    GatewayRequestOptions,
    GatewayNetworkOptions,
    HomeCardDefinition,
    IsshPluginManifest,
    PanelDefinition,
    PluginGateway,
    PluginStorage,
    SandboxPanelDefinition,
    SettingsTabDefinition,
    TerminalDecoratorDefinition,
} from './types'

export interface PluginGatewayHooks {
    hasPermission (permission: string): boolean
    registerSettingsTab (tab: SettingsTabDefinition): Disposable
    registerHomeCard (card: HomeCardDefinition): Disposable
    registerPanel (panel: PanelDefinition): Disposable
    registerSandboxPanel (panel: SandboxPanelDefinition): Disposable
    registerTerminalDecorator (decorator: TerminalDecoratorDefinition): Disposable
    audit (event: { method: string; ok: boolean; error?: string }): void
    confirm? (message: string): Promise<boolean>
}

const LEGACY_PERMISSION_ALIASES: Record<string, string> = {
    'settings:tab': 'ui.settings.register',
    'home:card': 'ui.home.register',
    'panel:register': 'ui.panel.register',
    'terminal:decorate': 'terminal.decorate',
    'profiles:read': 'profiles.read',
    'profiles:write': 'profiles.write',
    'session:read': 'session.read',
    'session:write': 'session.write',
    'workspace:read': 'workspace.read',
    'workspace:write': 'workspace.write',
    'agent:read': 'agent.read',
    'agent:write': 'agent.write',
    'ssh:exec': 'ssh.exec',
    'sftp:read': 'sftp.read',
    'sftp:write': 'sftp.write',
    'fs:read': 'fs.read',
    'network:postJson': 'network.postJson',
}

const METHOD_PERMISSIONS: Record<string, string> = {
    'runtime.health': '',
    'session.list': 'session.read',
    'session.current': 'session.read',
    'session.read': 'session.read',
    'session.write': 'terminal.write',
    'terminal.read': 'terminal.read',
    'terminal.write': 'terminal.write',
    'profiles.read': 'profiles.read',
    'profiles.mutate': 'profiles.write',
    'vault.status': 'vault.read',
    'vault.unlock': 'vault.read',
    'vault.getSecret': 'vault.read',
    'ssh.exec': 'ssh.exec',
    'ssh.execReadonly': 'ssh.exec',
    'sftp.open': 'sftp.read',
    'sftp.list': 'sftp.read',
    'sftp.read': 'sftp.read',
    'sftp.stat': 'sftp.read',
    'sftp.close': 'sftp.read',
    'sftp.write': 'sftp.write',
    'sftp.mkdir': 'sftp.write',
    'sftp.remove': 'sftp.write',
    'sftp.removeDir': 'sftp.write',
    'sftp.rename': 'sftp.write',
    'sftp.chmod': 'sftp.write',
    'workspace.list': 'workspace.read',
    'workspace.create': 'workspace.write',
    'workspace.bind': 'workspace.write',
    'workspace.unbind': 'workspace.write',
    'agent.list': 'agent.read',
    'agent.register': 'agent.write',
    'agent.authorize': 'agent.write',
    'network.fetch': 'network.fetch',
    'http.postJson': 'network.postJson',
    'fs.userPaths': 'fs.read',
    'fs.readLocalText': 'fs.read',
}
const MAX_IN_FLIGHT_REQUESTS = 16
const CONFIRM_METHODS = new Set(['profiles.mutate', 'vault.unlock', 'vault.getSecret', 'ssh.exec', 'sftp.write', 'network.fetch'])

let requestSequence = 0

function normalizePermission (permission: string): string {
    return LEGACY_PERMISSION_ALIASES[permission] ?? permission
}

function withTimeout<T> (promise: Promise<T>, timeoutMs: number, signal?: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        let settled = false
        const finish = (callback: () => void): void => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            signal?.removeEventListener('abort', onAbort)
            callback()
        }
        const timer = setTimeout(() => finish(() => reject(new Error(`网关请求超时（${timeoutMs}ms）`))), timeoutMs)
        const onAbort = (): void => finish(() => reject(new DOMException('网关请求已取消', 'AbortError')))
        if (signal?.aborted) return onAbort()
        signal?.addEventListener('abort', onAbort, { once: true })
        promise.then((value) => finish(() => resolve(value)), (cause) => finish(() => reject(cause)))
    })
}

export function createPluginGateway (
    manifest: IsshPluginManifest,
    storage: PluginStorage,
    hooks: PluginGatewayHooks,
): PluginGateway {
    let inFlight = 0
    const hasPermission = (permission: string): boolean => {
        const declared = [...(manifest.permissions ?? []), ...(manifest.capabilities ?? [])]
        return declared.some((item) => item === permission || normalizePermission(item) === permission)
    }
    const requirePermission = (permission: string, method: string): void => {
        if (hasPermission(permission) || hooks.hasPermission(permission)) return
        const error = `插件 ${manifest.id} 未声明权限：${permission}`
        hooks.audit({ method, ok: false, error })
        throw new Error(error)
    }
    const request = async <T> (method: string, args: Record<string, unknown> = {}, options: GatewayRequestOptions = {}): Promise<T> => {
        const permission = METHOD_PERMISSIONS[method]
        if (permission === undefined) {
            const error = `未知网关 method：${method}`
            hooks.audit({ method, ok: false, error })
            throw new Error(error)
        }
        if (permission) requirePermission(permission, method)
        if (CONFIRM_METHODS.has(method) && hooks.confirm && !await hooks.confirm(`插件「${manifest.name}」请求执行 ${method}，是否继续？`)) {
            const error = '用户拒绝了网关请求'
            hooks.audit({ method, ok: false, error })
            throw new Error(error)
        }
        if (inFlight >= MAX_IN_FLIGHT_REQUESTS) {
            const error = `插件 ${manifest.id} 请求并发数超过上限（${MAX_IN_FLIGHT_REQUESTS}）`
            hooks.audit({ method, ok: false, error })
            throw new Error(error)
        }
        inFlight += 1
        requestSequence += 1
        const requestId = options.requestId ?? `${manifest.id}-${Date.now().toString(36)}-${requestSequence}`
        const requestPayload = {
            requestId,
            pluginId: manifest.id,
            apiVersion: '1',
            method,
            args,
            permissions: [...(manifest.permissions ?? []), ...(manifest.capabilities ?? [])].map(normalizePermission),
            deadlineMs: options.timeoutMs ?? 10000,
            traceId: requestId,
        }
        try {
            const response = await withTimeout(invoke<{ requestId: string; ok: boolean; data?: T; error?: { message?: string } }>('plugin_gateway_request', { request: requestPayload }), options.timeoutMs ?? 10000, options.signal)
            if (!response.ok) throw new Error(response.error?.message ?? `网关调用失败：${method}`)
            hooks.audit({ method, ok: true })
            return response.data as T
        } catch (cause) {
            const message = cause instanceof Error ? cause.message : String(cause)
            hooks.audit({ method, ok: false, error: message })
            throw cause
        } finally {
            inFlight -= 1
        }
    }
    const register = <T> (permission: string, method: string, callback: (value: T) => Disposable, value: T): Disposable => {
        requirePermission(permission, method)
        const dispose = callback(value)
        hooks.audit({ method, ok: true })
        return dispose
    }
    const log = (level: 'info' | 'warn' | 'error', message: string): void => {
        const safe = message.length > 2000 ? `${message.slice(0, 2000)}…` : message
        hooks.audit({ method: `log.${level}`, ok: true })
        const line = `[plugin ${manifest.id}] ${safe}`
        if (level === 'error') console.error(line)
        else if (level === 'warn') console.warn(line)
        else console.info(line)
    }
    const events = {
        on (eventName: string, handler: (params: unknown) => void): Disposable {
            const event = `issh:plugin-event:${manifest.id}:${eventName}`
            const listener = (input: Event): void => handler((input as CustomEvent).detail)
            window.addEventListener(event, listener)
            return () => window.removeEventListener(event, listener)
        },
    }
    return {
        apiVersion: '1',
        request,
        ui: {
            registerSettingsTab: (tab) => register('ui.settings.register', 'ui.settings.register', hooks.registerSettingsTab, tab),
            registerHomeCard: (card) => register('ui.home.register', 'ui.home.register', hooks.registerHomeCard, card),
            registerPanel: (panel) => register('ui.panel.register', 'ui.panel.register', hooks.registerPanel, panel),
            registerSandboxPanel: (panel) => register('ui.panel.register', 'ui.panel.registerSandboxPanel', hooks.registerSandboxPanel, panel),
            registerTerminalDecorator: (decorator) => register('terminal.decorate', 'terminal.decorate.register', hooks.registerTerminalDecorator, decorator),
        },
        sessions: {
            getCurrent: () => request('session.current'),
            read: (sessionId, lines, options) => request('session.read', { sessionId, lines }, options),
            write: (sessionId, data, options) => request('session.write', { sessionId, data: typeof data === 'string' ? data : Array.from(data) }, options),
        },
        terminal: {
            read: (sessionId, lines, options) => request('terminal.read', { sessionId, lines }, options),
            write: (sessionId, data, options) => request('terminal.write', { sessionId, data: typeof data === 'string' ? data : Array.from(data) }, options),
        },
        profiles: {
            read: (options) => request('profiles.read', {}, options),
            mutate: (mutation, options) => request('profiles.mutate', { mutation }, options),
        },
        vault: {
            status: (options) => request('vault.status', {}, options),
            unlock: (passphrase, options) => request('vault.unlock', { passphrase }, options),
            getSecret: (id, options) => request('vault.getSecret', { id }, options),
        },
        network: {
            fetch: (url, options?: GatewayNetworkOptions) => request('network.fetch', { url, method: options?.method, headers: options?.headers, body: options?.body }, options),
        },
        http: {
            postJson: (url, options) => request('http.postJson', { url, headers: options?.headers, body: options?.body }, options),
        },
        fs: {
            userPaths: (options) => request('fs.userPaths', {}, options),
            readLocalText: (path, options) => request('fs.readLocalText', { path }, options),
        },
        sftp: {
            open: (sessionId, sudoPassword, options) => request('sftp.open', { sessionId, sudoPassword }, options),
            read: (sessionId, path, offset, length, options) => request('sftp.read', { sessionId, path, offset, length }, options),
            write: (sessionId, path, dataBase64, offset, truncate, options) => request('sftp.write', { sessionId, path, offset, truncate, dataBase64 }, options),
            list: (sessionId, path, offset, limit, options) => request('sftp.list', { sessionId, path, offset, limit }, options),
            stat: (sessionId, path, options) => request('sftp.stat', { sessionId, path }, options),
            close: (sessionId, options) => request('sftp.close', { sessionId }, options),
            mkdir: (sessionId, path, options) => request('sftp.mkdir', { sessionId, path }, options),
            remove: (sessionId, path, options) => request('sftp.remove', { sessionId, path }, options),
            removeDir: (sessionId, path, options) => request('sftp.removeDir', { sessionId, path }, options),
            rename: (sessionId, oldPath, newPath, options) => request('sftp.rename', { sessionId, oldPath, newPath }, options),
            chmod: (sessionId, path, mode, options) => request('sftp.chmod', { sessionId, path, mode }, options),
        },
        events,
        storage,
        log,
    }
}

export function normalizePluginPermission (permission: string): string {
    return normalizePermission(permission)
}
