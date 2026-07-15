import { Injectable, NgZone } from '@angular/core'
import { ConfigService, HostAppService, Logger, LogService, Platform, VaultService } from 'tabby-core'

function getNodeModule (name: string): any {
    try {
        const runtimeRequire = eval('require') // eslint-disable-line no-eval
        return runtimeRequire(name)
    } catch {
        return null
    }
}

const https = getNodeModule('https')
const tls = getNodeModule('tls')
const crypto = getNodeModule('crypto')

export interface SyncServerStatus {
    running: boolean
    port: number
    hostname: string
    bindAddress?: string
    fingerprint?: string
}

export type SyncMode = 'full' | 'partial'

export interface SyncSection {
    key: string
    label: string
    icon: string
}

export const SYNC_SECTIONS: SyncSection[] = [
    { key: 'profiles', label: '主机连接', icon: 'fa-server' },
    { key: 'groups', label: '分组', icon: 'fa-folder' },
    { key: 'appearance', label: '外观设置', icon: 'fa-palette' },
    { key: 'hotkeys', label: '快捷键', icon: 'fa-keyboard' },
    { key: 'terminal', label: '终端设置', icon: 'fa-terminal' },
    { key: 'vault', label: 'Vault', icon: 'fa-key' },
]
const SYNCABLE_SECTION_KEYS = SYNC_SECTIONS.map(section => section.key)
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024

function normalizeFingerprint (fp: string): string {
    return (fp || '').replace(/[:\s]/g, '').toUpperCase()
}

function cloneStructured<T> (value: T): T {
    if (value === undefined) {
        return value
    }
    return JSON.parse(JSON.stringify(value))
}

@Injectable({ providedIn: 'root' })
export class ConfigSyncService {
    private logger: Logger

    constructor (
        log: LogService,
        private hostApp: HostAppService,
        private config: ConfigService,
        private vault: VaultService,
        private zone: NgZone,
    ) {
        this.logger = log.create('configSync')
        this.installRendererRequestHandler()
    }

    isAvailable (): boolean {
        return this.hostApp.platform !== Platform.Web
    }

    isVaultEnabled (): boolean {
        return this.vault.store !== null
    }

    isVaultOpen (): boolean {
        return this.vault.isOpen()
    }

    async unlockVault (): Promise<boolean> {
        try {
            await this.vault.getPassphrase()
            return this.vault.isOpen()
        } catch {
            return false
        }
    }

    private getElectron (): any {
        try {
            const runtimeRequire = eval('require') // eslint-disable-line no-eval
            return runtimeRequire('electron')
        } catch {
            this.logger.debug('Electron require not available')
            return null
        }
    }

    private installRendererRequestHandler (): void {
        const electron = this.getElectron()
        if (!electron) {
            return
        }
        electron.ipcRenderer.on('config-sync:renderer-request', (_event: any, request: any) => {
            this.zone.run(() => {
                void this.handleRendererRequest(request).then(
                    result => electron.ipcRenderer.send('config-sync:renderer-response', {
                        requestId: request?.requestId,
                        ok: true,
                        result,
                    }),
                    error => electron.ipcRenderer.send('config-sync:renderer-response', {
                        requestId: request?.requestId,
                        ok: false,
                        error: error?.message ?? String(error),
                    }),
                )
            })
        })
    }

    private async handleRendererRequest (request: any): Promise<any> {
        if (!request || typeof request.requestId !== 'string') {
            throw new Error('Invalid config sync renderer request')
        }
        if (request.action === 'export') {
            return this.exportSections(request.payload?.mode, request.payload?.sections)
        }
        if (request.action === 'apply') {
            await this.applySections(request.payload)
            return { ok: true }
        }
        throw new Error('Unknown config sync renderer action')
    }

    async startServer (): Promise<SyncServerStatus & { ok: true } | { ok: false, error: string }> {
        const electron = this.getElectron()
        if (!electron) {
            return { ok: false, error: 'Electron not available' }
        }
        const port = this.config.store.configSync.port
        const syncKey = this.config.store.configSync.syncKey
        const bindAddress = this.config.store.configSync.bindAddress || '127.0.0.1'
        if (!syncKey) {
            return { ok: false, error: 'Sync key not set' }
        }
        return electron.ipcRenderer.invoke('config-sync:start', port, syncKey, bindAddress)
    }

    async stopServer (): Promise<{ ok: boolean }> {
        const electron = this.getElectron()
        if (!electron) {
            return { ok: false }
        }
        return electron.ipcRenderer.invoke('config-sync:stop')
    }

    async getServerStatus (): Promise<SyncServerStatus> {
        const electron = this.getElectron()
        if (!electron) {
            return { running: false, port: 0, hostname: '', bindAddress: '127.0.0.1', fingerprint: '' }
        }
        return electron.ipcRenderer.invoke('config-sync:status')
    }

    private getSections (mode: SyncMode, sections: string[]): string[] {
        if (mode === 'full') {
            return [...SYNCABLE_SECTION_KEYS]
        }
        return (sections ?? []).filter((section, index) => (
            SYNCABLE_SECTION_KEYS.includes(section) && sections.indexOf(section) === index
        ))
    }

    private async requireOpenVault (): Promise<void> {
        if (!this.isVaultEnabled()) {
            throw new Error('Vault must be enabled to sync vault data')
        }
        if (!this.isVaultOpen() && !await this.unlockVault()) {
            throw new Error('Vault must be unlocked to sync vault data')
        }
    }

    private async exportSections (mode: SyncMode, requestedSections: string[]): Promise<Record<string, any>> {
        const sections = this.getSections(mode, requestedSections)
        const data: Record<string, any> = {}
        for (const section of sections) {
            if (section === 'vault') {
                await this.requireOpenVault()
                const vault = await this.vault.load()
                if (!vault) {
                    throw new Error('Vault is not configured')
                }
                data.vault = { secrets: cloneStructured(vault.secrets ?? []) }
            } else {
                data[section] = cloneStructured(this.config.store[section])
            }
        }
        return data
    }

    private async applySections (payload: any): Promise<void> {
        if (
            payload?.version !== 1 ||
            (payload.mode !== 'full' && payload.mode !== 'partial') ||
            !Array.isArray(payload.sections) ||
            !payload.data ||
            typeof payload.data !== 'object' ||
            Array.isArray(payload.data)
        ) {
            throw new Error('Invalid structured config payload')
        }
        const sections = this.getSections(payload.mode, payload.sections)
        if (
            sections.length !== payload.sections.length ||
            payload.sections.some((section: any, index: number) => section !== sections[index]) ||
            sections.some(section => !Object.prototype.hasOwnProperty.call(payload.data, section)) ||
            Object.keys(payload.data).some(section => !sections.includes(section))
        ) {
            throw new Error('Payload sections do not match syncable data')
        }

        let incomingVault: any = null
        let localVault: any = null
        if (sections.includes('vault')) {
            incomingVault = payload.data.vault
            if (!incomingVault || typeof incomingVault !== 'object' || !Array.isArray(incomingVault.secrets)) {
                throw new Error('Invalid decrypted Vault payload')
            }
            await this.requireOpenVault()
            localVault = await this.vault.load()
            if (!localVault) {
                throw new Error('Local Vault is not configured')
            }
        }

        const previousSections: Record<string, any> = {}
        for (const section of sections.filter(section => section !== 'vault')) {
            previousSections[section] = cloneStructured(this.config.store[section])
        }
        let vaultApplied = false
        try {
            for (const section of sections) {
                if (section !== 'vault') {
                    this.config.store[section] = cloneStructured(payload.data[section])
                }
            }
            if (sections.includes('vault')) {
                await this.vault.save({
                    config: localVault.config ?? {},
                    secrets: cloneStructured(incomingVault.secrets),
                })
                vaultApplied = true
                this.config.store.vault = this.vault.store
            }
            await this.config.save()
        } catch (error) {
            for (const [section, value] of Object.entries(previousSections)) {
                this.config.store[section] = value
            }
            if (vaultApplied && localVault) {
                try {
                    await this.vault.save(localVault)
                    this.config.store.vault = this.vault.store
                } catch (rollbackError) {
                    this.logger.error('Could not roll back Vault after config sync failure', rollbackError)
                }
            }
            throw error
        }
    }

    private connectPinned (ip: string, timeoutMs: number): Promise<{ socket: any, fingerprint: string }> {
        return new Promise((resolve, reject) => {
            if (!tls || !crypto) {
                reject(new Error('TLS modules not available'))
                return
            }
            const port = this.config.store.configSync.port
            const expected = normalizeFingerprint(this.config.store.configSync.peerFingerprint || '')
            if (!expected) {
                reject(new Error('Peer TLS fingerprint is required'))
                return
            }
            let settled = false
            const socket = tls.connect({
                host: ip,
                port,
                rejectUnauthorized: false,
            })
            const fail = (error: Error): void => {
                if (settled) {
                    return
                }
                settled = true
                socket.destroy()
                reject(error)
            }
            socket.setTimeout(timeoutMs)
            socket.once('timeout', () => fail(new Error('TLS fingerprint check timed out')))
            socket.once('error', fail)
            socket.once('secureConnect', () => {
                if (settled) {
                    return
                }
                const peerCert = socket.getPeerCertificate(true)
                let peerFingerprint = ''
                if (peerCert?.raw) {
                    const hex = crypto.createHash('sha256').update(peerCert.raw).digest('hex').toUpperCase()
                    peerFingerprint = (hex.match(/.{2}/g) ?? []).join(':')
                } else if (peerCert?.fingerprint256) {
                    peerFingerprint = peerCert.fingerprint256
                }
                if (!peerFingerprint || normalizeFingerprint(peerFingerprint) !== expected) {
                    fail(new Error('TLS fingerprint mismatch'))
                    return
                }
                settled = true
                socket.setTimeout(0)
                resolve({ socket, fingerprint: peerFingerprint })
            })
        })
    }

    private async httpsRequest (ip: string, requestPath: string, options: {
        method?: string
        headers?: Record<string, string>
        body?: string
        timeoutMs?: number
    } = {}): Promise<{ status: number, body: string, peerFingerprint: string }> {
        if (!https) {
            throw new Error('https module not available')
        }
        const timeoutMs = options.timeoutMs ?? 10000
        const pinned = await this.connectPinned(ip, timeoutMs)
        const agent = new https.Agent({
            keepAlive: false,
            maxSockets: 1,
            rejectUnauthorized: false,
        })
        agent.createConnection = (_options: any, callback: (error: Error|null, socket?: any) => void): any => {
            callback(null, pinned.socket)
        }

        return new Promise((resolve, reject) => {
            const req = https.request({
                host: ip,
                port: this.config.store.configSync.port,
                path: requestPath,
                method: options.method ?? 'GET',
                headers: options.headers ?? {},
                rejectUnauthorized: false,
                timeout: timeoutMs,
                agent,
            }, (res: any) => {
                const chunks: Buffer[] = []
                let size = 0
                res.on('data', (c: Buffer) => {
                    size += c.length
                    if (size > MAX_RESPONSE_BYTES) {
                        req.destroy(new Error('Response payload too large'))
                        return
                    }
                    chunks.push(c)
                })
                res.on('end', () => {
                    agent.destroy()
                    resolve({
                        status: res.statusCode ?? 0,
                        body: Buffer.concat(chunks).toString('utf8'),
                        peerFingerprint: pinned.fingerprint,
                    })
                })
            })
            req.on('timeout', () => {
                req.destroy()
                reject(new Error('Request timed out'))
            })
            req.on('error', (err: Error) => {
                agent.destroy()
                reject(err)
            })
            if (options.body) {
                req.write(options.body)
            }
            req.end()
        })
    }

    async pingPeer (ip: string): Promise<{ ok: boolean, hostname?: string, error?: string, fingerprint?: string }> {
        const syncKey = this.config.store.configSync.syncKey
        try {
            const resp = await this.httpsRequest(ip, '/api/ping', {
                headers: { 'Authorization': `Bearer ${syncKey}` },
                timeoutMs: 5000,
            })
            if (resp.status < 200 || resp.status >= 300) {
                return { ok: false, error: `HTTP ${resp.status}` }
            }
            const data = JSON.parse(resp.body)
            return { ok: true, hostname: data.hostname, fingerprint: resp.peerFingerprint }
        } catch (e) {
            return { ok: false, error: e.message }
        }
    }

    async pushToPeer (ip: string, mode: SyncMode, sections: string[]): Promise<{ ok: boolean, error?: string }> {
        const syncKey = this.config.store.configSync.syncKey
        try {
            const selectedSections = this.getSections(mode, sections)
            const payload = JSON.stringify({
                version: 1,
                mode,
                sections: selectedSections,
                data: await this.exportSections(mode, selectedSections),
            })
            const resp = await this.httpsRequest(ip, '/api/config', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${syncKey}`,
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(payload).toString(),
                },
                body: payload,
            })
            if (resp.status === 403) {
                return { ok: false, error: 'Remote user rejected the write' }
            }
            if (resp.status < 200 || resp.status >= 300) {
                return { ok: false, error: `HTTP ${resp.status}` }
            }
            return { ok: true }
        } catch (e) {
            return { ok: false, error: e.message }
        }
    }

    async pullFromPeer (ip: string, mode: SyncMode, sections: string[]): Promise<{ ok: boolean, error?: string, summary?: string }> {
        const syncKey = this.config.store.configSync.syncKey
        try {
            const selectedSections = this.getSections(mode, sections)
            const requestPath = mode === 'partial'
                ? `/api/config?mode=partial&sections=${encodeURIComponent(selectedSections.join(','))}`
                : '/api/config?mode=full'
            const resp = await this.httpsRequest(ip, requestPath, {
                headers: { 'Authorization': `Bearer ${syncKey}` },
            })
            if (resp.status < 200 || resp.status >= 300) {
                return { ok: false, error: `HTTP ${resp.status}` }
            }
            const payload = JSON.parse(resp.body)
            await this.applySections(payload)
            return {
                ok: true,
                summary: mode === 'full' ? 'full config' : selectedSections.join(', '),
            }
        } catch (e) {
            return { ok: false, error: e.message }
        }
    }

    hasPassword (): boolean {
        return this.isVaultEnabled()
    }

    async verifyAndUnlock (): Promise<boolean> {
        if (!this.isVaultEnabled()) {
            return false
        }
        if (this.isVaultOpen()) {
            return true
        }
        return await this.unlockVault()
    }

    generateSecureSyncKey (): string {
        if (crypto?.randomBytes) {
            return crypto.randomBytes(24).toString('base64url')
        }
        const arr = new Uint8Array(24)
        if (typeof globalThis.crypto?.getRandomValues === 'function') {
            globalThis.crypto.getRandomValues(arr)
        } else {
            throw new Error('Secure random generator unavailable')
        }
        let out = ''
        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
        for (const b of arr) {
            out += chars[b % chars.length]
        }
        return out
    }
}
