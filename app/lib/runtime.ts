import { app } from 'electron'
import { ChildProcess, spawn } from 'child_process'
import { createHash } from 'crypto'
import * as fs from 'fs'
import * as net from 'net'
import * as path from 'path'

const MAX_MESSAGE_BYTES = 64 * 1024
const REQUEST_TIMEOUT_MS = 5000
const START_ATTEMPTS = 50
const PROTOCOL_VERSION = '0.4.0'

export interface RuntimeRequest {
    jsonrpc: '2.0'
    id: string | number
    method: string
    params?: unknown
}

export interface RuntimeResponse {
    jsonrpc: '2.0'
    id: string | number | null
    result?: unknown
    error?: {
        code: number
        message: string
    }
}

export class RuntimeManager {
    private child?: ChildProcess
    private starting?: Promise<void>
    private readonly pipeName: string
    private readonly databasePath: string

    constructor () {
        const userDataPath = app.getPath('userData')
        const instanceKey = createHash('sha256')
            .update(userDataPath)
            .digest('hex')
            .slice(0, 16)
        this.pipeName = `\\\\.\\pipe\\issh-runtime-${instanceKey}`
        this.databasePath = path.join(userDataPath, 'runtime', 'issh-runtime.sqlite3')
    }

    async request (request: RuntimeRequest): Promise<RuntimeResponse> {
        this.validateRequest(request)
        await this.ensureStarted()
        return this.send(request)
    }

    stop (): void {
        const child = this.child
        this.child = undefined
        if (child && child.exitCode === null && child.signalCode === null) {
            child.kill()
        }
    }

    private validateRequest (request: RuntimeRequest): void {
        if (request?.jsonrpc !== '2.0' || !['string', 'number'].includes(typeof request.id) || typeof request.method !== 'string' || !request.method) {
            throw new Error('Invalid runtime request')
        }
        const size = Buffer.byteLength(JSON.stringify(request), 'utf8')
        if (size > MAX_MESSAGE_BYTES) {
            throw new Error(`Runtime request exceeds ${MAX_MESSAGE_BYTES} bytes`)
        }
    }

    private async ensureStarted (): Promise<void> {
        if (this.starting) {
            return this.starting
        }
        this.starting = this.startOrConnect()
        try {
            await this.starting
        } finally {
            this.starting = undefined
        }
    }

    private async startOrConnect (): Promise<void> {
        let connected = false
        try {
            const health = await this.send({ jsonrpc: '2.0', id: 'startup-health', method: 'runtime.health' }, 500)
            connected = true
            this.assertCompatibleHealth(health)
            return
        } catch (error) {
            if (connected) {
                throw error
            }
            // No existing per-user runtime owns the pipe yet.
        }

        const binary = this.resolveBinary()
        const child = spawn(binary, [
            '--pipe', this.pipeName,
            '--database', this.databasePath,
        ], {
            cwd: path.dirname(binary),
            stdio: 'ignore',
            windowsHide: true,
        })
        this.child = child
        child.once('exit', () => {
            if (this.child === child) {
                this.child = undefined
            }
        })

        let lastError: Error | undefined
        for (let attempt = 0; attempt < START_ATTEMPTS; attempt++) {
            if (child.exitCode !== null) {
                throw new Error(`isshd exited during startup with code ${child.exitCode}`)
            }
            try {
                const health = await this.send({ jsonrpc: '2.0', id: 'startup-health', method: 'runtime.health' }, 500)
                this.assertCompatibleHealth(health)
                return
            } catch (error) {
                lastError = error as Error
                await new Promise(resolve => setTimeout(resolve, 50))
            }
        }
        this.stop()
        throw new Error(`isshd did not become ready: ${lastError?.message ?? 'unknown error'}`)
    }

    private assertCompatibleHealth (response: RuntimeResponse): void {
        const health = response.result as { protocolVersion?: string, capabilities?: unknown } | undefined
        if (health?.protocolVersion !== PROTOCOL_VERSION
            || !Array.isArray(health.capabilities)
            || !health.capabilities.includes('workspace.list')) {
            throw new Error(`Incompatible issh Runtime protocol; expected ${PROTOCOL_VERSION}`)
        }
    }

    private resolveBinary (): string {
        const executable = process.platform === 'win32' ? 'isshd.exe' : 'isshd'
        const candidates = [
            process.env.ISSH_RUNTIME_BIN,
            app.isPackaged ? path.join(process.resourcesPath, 'issh-runtime', executable) : undefined,
            path.resolve(app.getAppPath(), '..', 'issh-runtime', 'target', 'debug', executable),
            path.resolve(process.cwd(), 'issh-runtime', 'target', 'debug', executable),
        ].filter((candidate): candidate is string => !!candidate)
        const binary = candidates.find(candidate => fs.existsSync(candidate))
        if (!binary) {
            throw new Error(`isshd executable not found; checked: ${candidates.join(', ')}`)
        }
        return binary
    }

    private send (request: RuntimeRequest, timeoutMs = REQUEST_TIMEOUT_MS): Promise<RuntimeResponse> {
        return new Promise((resolve, reject) => {
            const socket = net.createConnection(this.pipeName)
            const chunks: Buffer[] = []
            let responseBytes = 0
            let settled = false
            const timer = setTimeout(() => finish(new Error(`Runtime request timed out after ${timeoutMs} ms`)), timeoutMs)
            const finish = (error?: Error): void => {
                if (settled) {
                    return
                }
                settled = true
                clearTimeout(timer)
                socket.destroy()
                if (error) {
                    reject(error)
                    return
                }
                try {
                    const response = JSON.parse(Buffer.concat(chunks).toString('utf8').trim()) as RuntimeResponse
                    if (response.jsonrpc !== '2.0' || response.id !== request.id) {
                        throw new Error('Invalid runtime response')
                    }
                    resolve(response)
                } catch (parseError) {
                    reject(parseError)
                }
            }

            socket.once('connect', () => socket.end(`${JSON.stringify(request)}\n`))
            socket.on('data', chunk => {
                responseBytes += chunk.length
                if (responseBytes > MAX_MESSAGE_BYTES) {
                    finish(new Error(`Runtime response exceeds ${MAX_MESSAGE_BYTES} bytes`))
                    return
                }
                chunks.push(chunk)
            })
            socket.once('error', error => finish(error))
            socket.once('close', () => finish())
        })
    }
}
