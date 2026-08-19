import { ChildProcess, execFile, spawn } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'

const EXPECTED_PROTOCOL = 20
const MINIMUM_VERSION = '0.8.1'
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024
const MAX_LOG_BYTES = 64 * 1024
const MAX_QUEUE_DEPTH = 32
const MAX_CONCURRENT_COMMANDS = 2
const COMMAND_TIMEOUT_MS = 10000

export type HerdrAction = 'status' | 'start' | 'stop' | 'snapshot' | 'sync-workspace'

export interface HerdrRequest {
    action: HerdrAction
    binaryPath?: string
    session?: string
    restartOnCrash?: boolean
    workspaceId?: string
    isshWorkspaceId?: string
    name?: string
    agentCount?: number
    taskCount?: number
    sequence?: number
}

interface HerdrStatus {
    available: boolean
    running: boolean
    compatible: boolean
    nativeOnly: boolean
    managed: boolean
    version: string | null
    protocol: number | null
    expectedProtocol: number
    minimumVersion: string
    session: string
    socket: string | null
    restartNeeded: boolean | null
    restartAttempts: number
    lastExitCode: number | null
    lastError: string | null
    recentLog: string
}

interface QueueEntry {
    run: () => Promise<unknown>
    resolve: (value: unknown) => void
    reject: (error: unknown) => void
}

export class HerdrManager {
    private child?: ChildProcess
    private desiredRunning = false
    private restartOnCrash = false
    private restartAttempts = 0
    private restartTimer?: NodeJS.Timeout
    private lastExitCode: number | null = null
    private lastError: string | null = null
    private recentLog = ''
    private activeCommands = 0
    private queue: QueueEntry[] = []
    private lastRequest?: HerdrRequest
    private workspaceSyncs = new Map<string, HerdrRequest>()

    request (request: HerdrRequest): Promise<unknown> {
        this.validateRequest(request)
        if (this.queue.length >= MAX_QUEUE_DEPTH) {
            return Promise.reject(new Error(`Herdr adapter queue is full (${MAX_QUEUE_DEPTH})`))
        }
        return new Promise((resolve, reject) => {
            this.queue.push({ run: () => this.perform(request), resolve, reject })
            this.drainQueue()
        })
    }

    shutdown (): void {
        this.desiredRunning = false
        if (this.restartTimer) {
            clearTimeout(this.restartTimer)
            this.restartTimer = undefined
        }
        const child = this.child
        this.child = undefined
        if (child && child.exitCode === null && child.signalCode === null) {
            child.kill()
        }
    }

    private validateRequest (request: HerdrRequest): void {
        if (!request || !['status', 'start', 'stop', 'snapshot', 'sync-workspace'].includes(request.action)) {
            throw new Error('Invalid Herdr adapter request')
        }
        this.validateSession(request.session)
        if (request.binaryPath) {
            const name = path.basename(request.binaryPath).toLowerCase()
            if (!['herdr', 'herdr.exe'].includes(name) || !fs.existsSync(request.binaryPath)) {
                throw new Error('Herdr binaryPath must point to an existing herdr executable')
            }
        }
    }

    private drainQueue (): void {
        while (this.activeCommands < MAX_CONCURRENT_COMMANDS && this.queue.length) {
            const entry = this.queue.shift()!
            this.activeCommands++
            void entry.run()
                .then(entry.resolve, entry.reject)
                .finally(() => {
                    this.activeCommands--
                    this.drainQueue()
                })
        }
    }

    private async perform (request: HerdrRequest): Promise<unknown> {
        this.lastRequest = { ...request }
        switch (request.action) {
            case 'status': return this.readStatus(request)
            case 'start': return this.start(request)
            case 'stop': return this.stop(request)
            case 'snapshot': return this.snapshot(request)
            case 'sync-workspace': return this.syncWorkspace(request)
        }
    }

    private async readStatus (request: HerdrRequest): Promise<HerdrStatus> {
        try {
            const result = await this.runCli(request, ['status', '--json'], 5000)
            const status = JSON.parse(result.stdout) as any
            const protocol = Number(status?.server?.protocol ?? status?.client?.protocol)
            const version = String(status?.server?.version ?? status?.client?.version ?? '') || null
            const available = !!status?.client
            const running = status?.server?.running === true
            const compatible = available
                && protocol === EXPECTED_PROTOCOL
                && this.versionAtLeast(String(status?.client?.version ?? ''), MINIMUM_VERSION)
                && (!running || status?.server?.compatible === true)
            this.lastError = compatible || !running ? null : `Herdr protocol/version contract mismatch (expected protocol ${EXPECTED_PROTOCOL}, >= ${MINIMUM_VERSION})`
            return this.statusSnapshot(request, {
                available,
                running,
                compatible,
                version,
                protocol: Number.isFinite(protocol) ? protocol : null,
                socket: status?.server?.socket ?? null,
                restartNeeded: status?.server?.restart_needed ?? null,
            })
        } catch (error: any) {
            this.lastError = error?.code === 'ENOENT'
                ? 'Herdr executable was not found'
                : error instanceof Error ? error.message : String(error)
            return this.statusSnapshot(request, {
                available: false,
                running: false,
                compatible: false,
                version: null,
                protocol: null,
                socket: null,
                restartNeeded: null,
            })
        }
    }

    private async start (request: HerdrRequest): Promise<HerdrStatus> {
        this.desiredRunning = true
        this.restartOnCrash = request.restartOnCrash === true
        const current = await this.readStatus(request)
        if (current.running) {
            if (!current.compatible) {
                throw new Error(this.lastError ?? 'Running Herdr server is incompatible')
            }
            return current
        }
        if (!current.available) {
            throw new Error(this.lastError ?? 'Herdr is unavailable')
        }

        this.spawnServer(request)
        let latest = current
        for (let attempt = 0; attempt < 50; attempt++) {
            await this.sleep(100)
            latest = await this.readStatus(request)
            if (latest.running) {
                if (!latest.compatible) {
                    this.shutdown()
                    throw new Error(this.lastError ?? 'Started Herdr server is incompatible')
                }
                this.restartAttempts = 0
                await this.replayWorkspaceSyncs(request)
                return latest
            }
            if (!this.child) {
                break
            }
        }
        this.shutdown()
        throw new Error(`Herdr sidecar did not become ready: ${this.lastError ?? 'unknown error'}`)
    }

    private async stop (request: HerdrRequest): Promise<HerdrStatus & { stopped: boolean, reason?: string }> {
        this.desiredRunning = false
        this.restartOnCrash = false
        if (this.restartTimer) {
            clearTimeout(this.restartTimer)
            this.restartTimer = undefined
        }
        const child = this.child
        if (!child) {
            return { ...await this.readStatus(request), stopped: false, reason: 'not_owned' }
        }
        try {
            await this.runCli(request, ['server', 'stop'], 3000)
        } catch {
            if (child.exitCode === null && child.signalCode === null) {
                child.kill()
            }
        }
        this.child = undefined
        for (let attempt = 0; attempt < 20; attempt++) {
            const status = await this.readStatus(request)
            if (!status.running) {
                return { ...status, stopped: true }
            }
            await this.sleep(100)
        }
        return { ...await this.readStatus(request), stopped: false, reason: 'timeout' }
    }

    private async snapshot (request: HerdrRequest): Promise<unknown> {
        await this.assertReady(request)
        const result = await this.runCli(request, ['api', 'snapshot'])
        return JSON.parse(result.stdout)
    }

    private async syncWorkspace (request: HerdrRequest): Promise<unknown> {
        await this.assertReady(request)
        const workspaceId = this.requiredId(request.workspaceId, 'workspaceId')
        const isshWorkspaceId = this.requiredId(request.isshWorkspaceId, 'isshWorkspaceId')
        const name = String(request.name ?? '').trim().slice(0, 80)
        const agentCount = this.safeCount(request.agentCount)
        const taskCount = this.safeCount(request.taskCount)
        const sequence = Math.max(1, Math.floor(Number(request.sequence ?? Date.now())))
        const args = [
            'workspace', 'report-metadata', workspaceId,
            '--source', 'issh:workspace',
            '--token', `issh_workspace_id=${isshWorkspaceId.slice(0, 80)}`,
            '--token', `issh_name=${name}`,
            '--token', `issh_agents=${agentCount}`,
            '--token', `issh_tasks=${taskCount}`,
            '--seq', String(sequence),
            '--ttl-ms', '60000',
        ]
        const result = await this.runCli(request, args)
        this.workspaceSyncs.set(isshWorkspaceId, { ...request })
        return JSON.parse(result.stdout)
    }

    private async replayWorkspaceSyncs (lifecycleRequest: HerdrRequest): Promise<void> {
        for (const sync of this.workspaceSyncs.values()) {
            await this.syncWorkspace({
                ...sync,
                binaryPath: lifecycleRequest.binaryPath,
                session: lifecycleRequest.session,
            }).catch(error => {
                this.lastError = `Herdr state replay failed: ${error instanceof Error ? error.message : String(error)}`
            })
        }
    }

    private async assertReady (request: HerdrRequest): Promise<void> {
        const status = await this.readStatus(request)
        if (!status.running || !status.compatible) {
            throw new Error(status.lastError ?? 'Compatible Herdr sidecar is not running')
        }
    }

    private spawnServer (request: HerdrRequest): void {
        if (this.child && this.child.exitCode === null && this.child.signalCode === null) {
            return
        }
        const binary = this.resolveBinary(request)
        const child = spawn(binary, [...this.sessionArgs(request), 'server'], {
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
        })
        this.child = child
        const capture = (chunk: Buffer): void => {
            this.recentLog = `${this.recentLog}${chunk.toString('utf8')}`.slice(-MAX_LOG_BYTES)
        }
        child.stdout?.on('data', capture)
        child.stderr?.on('data', capture)
        child.once('error', error => {
            this.lastError = error.message
        })
        child.once('exit', code => {
            if (this.child === child) {
                this.child = undefined
            }
            this.lastExitCode = code
            if (this.desiredRunning && this.restartOnCrash) {
                this.scheduleRestart()
            }
        })
    }

    private scheduleRestart (): void {
        if (this.restartTimer || !this.lastRequest || this.restartAttempts >= 5) {
            return
        }
        const delay = Math.min(1000 * (2 ** this.restartAttempts), 15000)
        this.restartAttempts++
        const request = { ...this.lastRequest, action: 'start' as HerdrAction, restartOnCrash: true }
        this.restartTimer = setTimeout(() => {
            this.restartTimer = undefined
            void this.request(request).catch(error => {
                this.lastError = error instanceof Error ? error.message : String(error)
                this.scheduleRestart()
            })
        }, delay)
    }

    private runCli (request: HerdrRequest, args: string[], timeoutMs = COMMAND_TIMEOUT_MS): Promise<{ stdout: string, stderr: string }> {
        const binary = this.resolveBinary(request)
        return new Promise((resolve, reject) => {
            execFile(binary, [...this.sessionArgs(request), ...args], {
                windowsHide: true,
                timeout: timeoutMs,
                maxBuffer: MAX_OUTPUT_BYTES,
                encoding: 'utf8',
            }, (error, stdout, stderr) => {
                if (error) {
                    const detail = String(stderr || stdout || error.message).trim()
                    const wrapped: any = new Error(detail || error.message)
                    wrapped.code = (error as any).code
                    reject(wrapped)
                    return
                }
                resolve({ stdout: String(stdout), stderr: String(stderr) })
            })
        })
    }

    private resolveBinary (request: HerdrRequest): string {
        return request.binaryPath || process.env.HERDR_BIN || (process.platform === 'win32' ? 'herdr.exe' : 'herdr')
    }

    private sessionArgs (request: HerdrRequest): string[] {
        const session = request.session?.trim()
        return session ? ['--session', session] : []
    }

    private validateSession (session?: string): void {
        if (session && !/^[A-Za-z0-9._-]{1,64}$/.test(session)) {
            throw new Error('Herdr session must contain only letters, numbers, dot, underscore, or hyphen')
        }
    }

    private requiredId (value: unknown, name: string): string {
        const normalized = String(value ?? '').trim()
        if (!/^[A-Za-z0-9:._-]{1,128}$/.test(normalized)) {
            throw new Error(`${name} is invalid`)
        }
        return normalized
    }

    private safeCount (value: unknown): number {
        const count = Math.floor(Number(value ?? 0))
        return Number.isFinite(count) ? Math.max(0, Math.min(count, 999999)) : 0
    }

    private versionAtLeast (actual: string, minimum: string): boolean {
        const parse = (value: string): number[] => value.replace(/^v/, '').split('.').slice(0, 3).map(part => Number.parseInt(part, 10) || 0)
        const left = parse(actual)
        const right = parse(minimum)
        for (let index = 0; index < 3; index++) {
            if (left[index] !== right[index]) {
                return left[index] > right[index]
            }
        }
        return true
    }

    private statusSnapshot (request: HerdrRequest, status: Pick<HerdrStatus, 'available' | 'running' | 'compatible' | 'version' | 'protocol' | 'socket' | 'restartNeeded'>): HerdrStatus {
        return {
            ...status,
            nativeOnly: !status.running || !status.compatible,
            managed: !!this.child,
            expectedProtocol: EXPECTED_PROTOCOL,
            minimumVersion: MINIMUM_VERSION,
            session: request.session?.trim() || 'default',
            restartAttempts: this.restartAttempts,
            lastExitCode: this.lastExitCode,
            lastError: this.lastError,
            recentLog: this.recentLog,
        }
    }

    private sleep (milliseconds: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, milliseconds))
    }
}
