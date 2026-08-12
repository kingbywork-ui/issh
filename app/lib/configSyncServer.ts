import * as https from 'https'
import * as http from 'http'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import * as crypto from 'crypto'
import { generate } from 'selfsigned'
import { app, dialog, BrowserWindow } from 'electron'

export interface SyncServerStatus {
    running: boolean
    port: number
    hostname: string
    bindAddress: string
    fingerprint: string
}

const SYNCABLE_SECTIONS = ['profiles', 'groups', 'appearance', 'hotkeys', 'terminal', 'vault']
const MAX_BODY_BYTES = 2 * 1024 * 1024

export type ConfigSyncRendererAction = 'export' | 'apply'
export type ConfigSyncRendererRequest = (action: ConfigSyncRendererAction, payload: any) => Promise<any>

function timingSafeEqualString (a: string, b: string): boolean {
    const bufA = Buffer.from(a)
    const bufB = Buffer.from(b)
    if (bufA.length !== bufB.length) {
        return false
    }
    return crypto.timingSafeEqual(bufA, bufB)
}

async function generateSelfSignedCert (): Promise<{ key: string, cert: string, fingerprint: string }> {
    const certDir = path.join(app.getPath('userData'), 'config-sync-certs')
    if (!fs.existsSync(certDir)) {
        fs.mkdirSync(certDir, { recursive: true, mode: 0o700 })
    }
    const keyPath = path.join(certDir, 'server.key')
    const certPath = path.join(certDir, 'server.crt')
    const notBeforeDate = new Date()
    const notAfterDate = new Date(notBeforeDate)
    notAfterDate.setUTCDate(notAfterDate.getUTCDate() + 825)
    const pems = await generate(
        [{ name: 'commonName', value: 'issh-config-sync' }],
        {
            keyType: 'rsa',
            keySize: 2048,
            algorithm: 'sha256',
            notBeforeDate,
            notAfterDate,
            extensions: [
                { name: 'basicConstraints', cA: false },
                { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
                { name: 'extKeyUsage', serverAuth: true },
            ],
        },
    )
    const key = pems.private
    const cert = pems.cert
    fs.writeFileSync(keyPath, key, { encoding: 'utf8', mode: 0o600 })
    fs.writeFileSync(certPath, cert, { encoding: 'utf8', mode: 0o644 })
    const fingerprint = new crypto.X509Certificate(cert).fingerprint256
    return { key, cert, fingerprint }
}

async function loadOrCreateCert (): Promise<{ key: string, cert: string, fingerprint: string }> {
    const certDir = path.join(app.getPath('userData'), 'config-sync-certs')
    const keyPath = path.join(certDir, 'server.key')
    const certPath = path.join(certDir, 'server.crt')
    if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
        const key = fs.readFileSync(keyPath, 'utf8')
        const cert = fs.readFileSync(certPath, 'utf8')
        const fingerprint = new crypto.X509Certificate(cert).fingerprint256
        return { key, cert, fingerprint }
    }
    return await generateSelfSignedCert()
}

export class ConfigSyncServer {
    private server: https.Server | null = null
    private starting = false
    private syncKey = ''
    private port = 8765
    private bindAddress = '127.0.0.1'
    private fingerprint = ''
    private pendingWrite: Promise<boolean> | null = null

    constructor (private requestRenderer: ConfigSyncRendererRequest) { }

    isRunning (): boolean {
        return !!this.server && this.server.listening
    }

    getStatus (): SyncServerStatus {
        return {
            running: this.isRunning(),
            port: this.port,
            hostname: os.hostname(),
            bindAddress: this.bindAddress,
            fingerprint: this.fingerprint,
        }
    }

    async start (port: number, syncKey: string, bindAddress = '127.0.0.1'): Promise<void> {
        if (this.server || this.starting) {
            throw new Error('Server already running')
        }
        if (!syncKey) {
            throw new Error('Sync key is required')
        }
        this.starting = true
        try {
            this.port = port
            this.syncKey = syncKey
            this.bindAddress = bindAddress === '0.0.0.0' ? '0.0.0.0' : '127.0.0.1'

            const { key, cert, fingerprint } = await loadOrCreateCert()
            this.fingerprint = fingerprint

            const server = https.createServer({ key, cert }, (req, res) => {
                this.handleRequest(req, res)
            })
            this.server = server
            server.on('error', (err) => {
                console.error('[configSync] Server error:', err)
            })

            await new Promise<void>((resolve, reject) => {
                const onListening = (): void => {
                    server.removeListener('error', onStartError)
                    resolve()
                }
                const onStartError = (err: Error): void => {
                    server.removeListener('listening', onListening)
                    reject(err)
                }
                server.once('listening', onListening)
                server.once('error', onStartError)
                server.listen(port, this.bindAddress)
            })
        } catch (error) {
            const server = this.server
            this.server = null
            this.fingerprint = ''
            if (server) {
                try {
                    server.close()
                } catch {
                    // A failed listen may leave a non-running server.
                }
            }
            throw error
        } finally {
            this.starting = false
        }
    }

    stop (): void {
        if (this.server) {
            this.server.close()
            this.server = null
        }
        this.fingerprint = ''
    }

    private isAuthorized (req: http.IncomingMessage): boolean {
        const auth = req.headers['authorization']
        if (!auth || typeof auth !== 'string' || !auth.startsWith('Bearer ')) {
            return false
        }
        const token = auth.slice('Bearer '.length)
        return timingSafeEqualString(token, this.syncKey)
    }

    private readBody (req: http.IncomingMessage): Promise<string> {
        return new Promise((resolve, reject) => {
            const chunks: Buffer[] = []
            let size = 0
            req.on('data', (chunk: Buffer) => {
                size += chunk.length
                if (size > MAX_BODY_BYTES) {
                    reject(Object.assign(new Error('Payload too large'), { statusCode: 413 }))
                    req.destroy()
                    return
                }
                chunks.push(chunk)
            })
            req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
            req.on('error', reject)
        })
    }

    private async confirmInboundWrite (summary: string): Promise<boolean> {
        if (this.pendingWrite) {
            return false
        }
        this.pendingWrite = (async () => {
            const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
            const options = {
                type: 'warning' as const,
                title: 'issh config sync',
                message: 'Accept inbound config sync write?',
                detail: `${summary}\n\nThis may overwrite profiles, terminal settings, and Vault data.`,
                buttons: ['Accept and apply', 'Reject'],
                defaultId: 1,
                cancelId: 1,
                noLink: true,
            }
            const result = win
                ? await dialog.showMessageBox(win, options)
                : await dialog.showMessageBox(options)
            return result.response === 0
        })()
        try {
            return await this.pendingWrite
        } finally {
            this.pendingWrite = null
        }
    }

    private handleRequest (req: http.IncomingMessage, res: http.ServerResponse): void {
        if (!this.isAuthorized(req)) {
            res.writeHead(401, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'Unauthorized' }))
            return
        }

        const url = new URL(req.url ?? '', `https://localhost:${this.port}`)

        if (req.method === 'GET' && url.pathname === '/api/ping') {
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({
                hostname: os.hostname(),
                ok: true,
                fingerprint: this.fingerprint,
            }))
            return
        }

        if (req.method === 'GET' && url.pathname === '/api/config') {
            void this.handleOutboundRead(url, res)
            return
        }

        if (req.method === 'POST' && url.pathname === '/api/config') {
            void this.handleInboundWrite(req, res)
            return
        }

        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Not found' }))
    }

    private async handleOutboundRead (url: URL, res: http.ServerResponse): Promise<void> {
        try {
            const mode = url.searchParams.get('mode') === 'partial' ? 'partial' : 'full'
            const requestedSections = (url.searchParams.get('sections') ?? '').split(',')
            const sections = mode === 'full'
                ? [...SYNCABLE_SECTIONS]
                : requestedSections.filter((section, index) => SYNCABLE_SECTIONS.includes(section) && requestedSections.indexOf(section) === index)
            const data = await this.requestRenderer('export', { mode, sections })
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ version: 1, mode, sections, data }))
        } catch (err: any) {
            res.writeHead(500, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: err?.message ?? 'Failed to export config' }))
        }
    }

    private async handleInboundWrite (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        try {
            const contentType = req.headers['content-type'] ?? ''
            if (!contentType.includes('application/json')) {
                throw Object.assign(new Error('Config sync requires a structured JSON payload'), { statusCode: 400 })
            }
            const body = await this.readBody(req)
            let payload: any
            try {
                payload = JSON.parse(body)
            } catch {
                throw Object.assign(new Error('Invalid JSON payload'), { statusCode: 400 })
            }
            if (
                payload?.version !== 1 ||
                (payload.mode !== 'full' && payload.mode !== 'partial') ||
                !Array.isArray(payload.sections) ||
                !payload.data ||
                typeof payload.data !== 'object' ||
                Array.isArray(payload.data)
            ) {
                throw Object.assign(new Error('Invalid structured config payload'), { statusCode: 400 })
            }
            const sections = payload.mode === 'full'
                ? [...SYNCABLE_SECTIONS]
                : payload.sections.filter((section: any, index: number) => (
                    typeof section === 'string' &&
                    SYNCABLE_SECTIONS.includes(section) &&
                    payload.sections.indexOf(section) === index
                ))
            if (
                sections.length !== payload.sections.length ||
                payload.sections.some((section: any, index: number) => section !== sections[index]) ||
                sections.some(section => !Object.prototype.hasOwnProperty.call(payload.data, section)) ||
                Object.keys(payload.data).some(section => !sections.includes(section))
            ) {
                throw Object.assign(new Error('Payload sections do not match syncable data'), { statusCode: 400 })
            }

            let summary = payload.mode === 'full'
                ? `Full sync sections: ${sections.join(', ')}`
                : `Partial sync sections: ${sections.join(', ') || '(none)'}`
            if (sections.includes('vault')) {
                summary += '\nIncludes decrypted Vault data that will be re-encrypted locally.'
            }

            const accepted = await this.confirmInboundWrite(summary)
            if (!accepted) {
                res.writeHead(403, { 'Content-Type': 'application/json' })
                res.end(JSON.stringify({ error: 'Rejected by local user' }))
                return
            }

            await this.requestRenderer('apply', {
                version: 1,
                mode: payload.mode,
                sections,
                data: payload.data,
            })

            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ ok: true }))
        } catch (err: any) {
            const status = err?.statusCode === 413 ? 413 : err?.statusCode === 400 ? 400 : 500
            res.writeHead(status, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({
                error: status === 413
                    ? 'Payload too large'
                    : status === 400
                        ? err.message
                        : err?.message ?? 'Failed to apply config',
            }))
        }
    }
}
