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
const MAX_PANE_FRAME_BYTES = 2 * 1024 * 1024
const MAX_PANE_LINE_BYTES = Math.ceil(MAX_PANE_FRAME_BYTES * 4 / 3) + 4096
const MAX_PANE_WRITE_BYTES = 64 * 1024
// JSON-RPC represents pane bytes as decimal numbers. 12 KiB remains below the
// Runtime's 64 KiB message cap even when every byte serializes as `255,`.
const PANE_PUSH_CHUNK_BYTES = 12 * 1024
const MAX_PANE_RECONNECT_ATTEMPTS = 5

export type HerdrAction = 'status' | 'start' | 'stop' | 'snapshot' | 'sync-workspace'
    | 'pane-attach' | 'pane-input' | 'pane-resize' | 'pane-detach'

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
    paneId?: string
    target?: string
    title?: string
    ownerId?: string
    columns?: number
    rows?: number
    data?: number[]
    takeover?: boolean
}

export interface HerdrPaneEvent {
    paneId: string
    type: 'output' | 'state'
    data?: number[]
    full?: boolean
    width?: number
    height?: number
    state?: 'attached' | 'reconnecting' | 'closed' | 'error'
    reason?: string
    reconnectAttempt?: number
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

interface RuntimeResponse {
    result?: any
    error?: { code: number, message: string }
}

type RuntimeRequest = (request: {
    jsonrpc: '2.0'
    id: string
    method: string
    params?: unknown
}) => Promise<RuntimeResponse>

type PaneEventSink = (rendererId: number, event: HerdrPaneEvent) => void

interface PaneBridge {
    paneId: string
    target: string
    title: string
    workspaceId: string
    ownerId: string
    producerId: string
    rendererId: number
    columns: number
    rows: number
    request: HerdrRequest
    child?: ChildProcess
    closing: boolean
    stdoutBuffer: Buffer
    outputChain: Promise<void>
    lastHerdrSequence: number | null
    reconnectAttempts: number
    reconnectTimer?: NodeJS.Timeout
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
    private paneBridges = new Map<string, PaneBridge>()

    constructor (
        private runtimeRequest?: RuntimeRequest,
        private paneEventSink?: PaneEventSink,
    ) {}

    request (request: HerdrRequest, rendererId = 0): Promise<unknown> {
        this.validateRequest(request)
        if (this.queue.length >= MAX_QUEUE_DEPTH) {
            return Promise.reject(new Error(`Herdr adapter queue is full (${MAX_QUEUE_DEPTH})`))
        }
        return new Promise((resolve, reject) => {
            this.queue.push({ run: () => this.perform(request, rendererId), resolve, reject })
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
        for (const bridge of this.paneBridges.values()) {
            bridge.closing = true
            if (bridge.reconnectTimer) {
                clearTimeout(bridge.reconnectTimer)
            }
            bridge.child?.stdin?.write(`${JSON.stringify({ type: 'terminal.release' })}\n`)
            if (bridge.child && bridge.child.exitCode === null && bridge.child.signalCode === null) {
                bridge.child.kill()
            }
        }
        this.paneBridges.clear()
    }

    detachRenderer (rendererId: number): void {
        for (const bridge of [...this.paneBridges.values()]) {
            if (bridge.rendererId === rendererId) {
                void this.detachPane(bridge.request, rendererId, true)
            }
        }
    }

    private validateRequest (request: HerdrRequest): void {
        if (!request || !['status', 'start', 'stop', 'snapshot', 'sync-workspace', 'pane-attach', 'pane-input', 'pane-resize', 'pane-detach'].includes(request.action)) {
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

    private async perform (request: HerdrRequest, rendererId: number): Promise<unknown> {
        this.lastRequest = { ...request }
        switch (request.action) {
            case 'status': return this.readStatus(request)
            case 'start': return this.start(request)
            case 'stop': return this.stop(request)
            case 'snapshot': return this.snapshot(request)
            case 'sync-workspace': return this.syncWorkspace(request)
            case 'pane-attach': return this.attachPane(request, rendererId)
            case 'pane-input': return this.writePane(request, rendererId)
            case 'pane-resize': return this.resizePane(request, rendererId)
            case 'pane-detach': return this.detachPane(request, rendererId)
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
        return result.stdout.trim()
            ? JSON.parse(result.stdout)
            : { ok: true, workspaceId, sequence }
    }

    private async attachPane (request: HerdrRequest, rendererId: number): Promise<unknown> {
        this.assertPaneRuntime()
        await this.assertReady(request)
        const paneId = this.requiredId(request.paneId, 'paneId')
        const target = this.requiredId(request.target, 'target')
        const workspaceId = this.requiredId(request.workspaceId, 'workspaceId')
        const ownerId = this.requiredId(request.ownerId, 'ownerId')
        const columns = this.safeDimension(request.columns, 'columns')
        const rows = this.safeDimension(request.rows, 'rows')
        const title = String(request.title ?? target).trim().slice(0, 160) || target
        const producerId = this.producerId(request, target)

        const existing = this.paneBridges.get(paneId)
        if (existing) {
            if (existing.target !== target || existing.ownerId !== ownerId) {
                throw new Error(`Herdr pane ${paneId} is already attached by another owner`)
            }
            existing.rendererId = rendererId
            existing.columns = columns
            existing.rows = rows
            existing.request = { ...request }
            if (!this.bridgeIsRunning(existing)) {
                existing.closing = false
                existing.reconnectAttempts = 0
                await this.spawnPaneController(existing)
            }
            return this.paneAttachment(existing)
        }

        await this.ensureRuntimePane({
            paneId,
            workspaceId,
            target,
            title,
            columns,
            rows,
            producerId,
        })
        await this.callRuntime('pane.claimInput', { paneId, ownerId })

        const bridge: PaneBridge = {
            paneId,
            target,
            title,
            workspaceId,
            ownerId,
            producerId,
            rendererId,
            columns,
            rows,
            request: { ...request },
            closing: false,
            stdoutBuffer: Buffer.alloc(0),
            outputChain: Promise.resolve(),
            lastHerdrSequence: null,
            reconnectAttempts: 0,
        }
        this.paneBridges.set(paneId, bridge)
        try {
            await this.spawnPaneController(bridge)
            return this.paneAttachment(bridge)
        } catch (error) {
            this.paneBridges.delete(paneId)
            await this.callRuntime('pane.releaseInput', { paneId, ownerId }).catch(() => undefined)
            await this.callRuntime('pane.close', { paneId, producerId }).catch(() => undefined)
            throw error
        }
    }

    private async writePane (request: HerdrRequest, rendererId: number): Promise<unknown> {
        const bridge = this.requirePaneBridge(request, rendererId)
        const ownerId = this.requiredId(request.ownerId, 'ownerId')
        const data = this.safeBytes(request.data)
        await this.callRuntime('pane.write', {
            paneId: bridge.paneId,
            ownerId,
            data,
        })
        await this.writePaneCommand(bridge, {
            type: 'terminal.input',
            bytes: Buffer.from(data).toString('base64'),
        })
        return { paneId: bridge.paneId, acceptedBytes: data.length }
    }

    private async resizePane (request: HerdrRequest, rendererId: number): Promise<unknown> {
        const bridge = this.requirePaneBridge(request, rendererId)
        const actorId = this.requiredId(request.ownerId, 'ownerId')
        const columns = this.safeDimension(request.columns, 'columns')
        const rows = this.safeDimension(request.rows, 'rows')
        await this.callRuntime('pane.resize', {
            paneId: bridge.paneId,
            actorId,
            columns,
            rows,
        })
        await this.writePaneCommand(bridge, {
            type: 'terminal.resize',
            cols: columns,
            rows,
            cell_width_px: 0,
            cell_height_px: 0,
        })
        bridge.columns = columns
        bridge.rows = rows
        return { paneId: bridge.paneId, columns, rows }
    }

    private async detachPane (request: HerdrRequest, rendererId: number, shutdown = false): Promise<unknown> {
        const paneId = this.requiredId(request.paneId, 'paneId')
        const bridge = this.paneBridges.get(paneId)
        if (!bridge) {
            return { paneId, detached: false, reason: 'not_attached' }
        }
        if (!shutdown && bridge.rendererId !== rendererId) {
            throw new Error(`Herdr pane ${paneId} belongs to another renderer`)
        }
        if (!shutdown && this.requiredId(request.ownerId, 'ownerId') !== bridge.ownerId) {
            throw new Error(`Herdr pane ${paneId} detach ownership mismatch`)
        }
        bridge.closing = true
        if (bridge.reconnectTimer) {
            clearTimeout(bridge.reconnectTimer)
            bridge.reconnectTimer = undefined
        }
        await this.writePaneCommand(bridge, { type: 'terminal.release' }).catch(() => undefined)
        const child = bridge.child
        bridge.child = undefined
        if (child && child.exitCode === null && child.signalCode === null) {
            child.kill()
        }
        this.paneBridges.delete(paneId)
        await this.callRuntime('pane.releaseInput', {
            paneId,
            ownerId: bridge.ownerId,
        }).catch(() => undefined)
        await this.callRuntime('pane.close', {
            paneId,
            producerId: bridge.producerId,
        }).catch(() => undefined)
        if (!shutdown) {
            this.emitPaneEvent(bridge, { paneId, type: 'state', state: 'closed', reason: 'detached' })
        }
        return { paneId, detached: true }
    }

    private async ensureRuntimePane (pane: {
        paneId: string
        workspaceId: string
        target: string
        title: string
        columns: number
        rows: number
        producerId: string
    }): Promise<void> {
        try {
            await this.callRuntime('pane.open', {
                id: pane.paneId,
                workspaceId: pane.workspaceId,
                sessionId: pane.target,
                title: pane.title,
                columns: pane.columns,
                rows: pane.rows,
                producerId: pane.producerId,
            })
        } catch (error) {
            const snapshot = await this.callRuntime('pane.snapshot', { paneId: pane.paneId })
            if (snapshot?.producerId !== pane.producerId) {
                throw error
            }
        }
    }

    private async spawnPaneController (bridge: PaneBridge): Promise<void> {
        if (bridge.closing || this.bridgeIsRunning(bridge)) {
            return
        }
        const binary = this.resolveBinary(bridge.request)
        const args = [
            ...this.sessionArgs(bridge.request),
            'terminal', 'session', 'control', bridge.target,
            ...(bridge.request.takeover === false ? [] : ['--takeover']),
            '--cols', String(bridge.columns),
            '--rows', String(bridge.rows),
        ]
        bridge.stdoutBuffer = Buffer.alloc(0)
        bridge.lastHerdrSequence = null
        const child = spawn(binary, args, {
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true,
        })
        bridge.child = child
        child.stdout?.on('data', (chunk: Buffer) => this.consumePaneStdout(bridge, chunk))
        child.stderr?.on('data', (chunk: Buffer) => {
            this.recentLog = `${this.recentLog}${chunk.toString('utf8')}`.slice(-MAX_LOG_BYTES)
        })
        child.once('exit', code => this.handlePaneExit(bridge, child, code))
        await new Promise<void>((resolve, reject) => {
            const onSpawn = (): void => {
                child.off('error', onError)
                resolve()
            }
            const onError = (error: Error): void => {
                child.off('spawn', onSpawn)
                reject(error)
            }
            child.once('spawn', onSpawn)
            child.once('error', onError)
        })
    }

    private consumePaneStdout (bridge: PaneBridge, chunk: Buffer): void {
        if (bridge.closing || bridge.child === undefined) {
            return
        }
        bridge.stdoutBuffer = Buffer.concat([bridge.stdoutBuffer, chunk])
        if (bridge.stdoutBuffer.length > MAX_PANE_LINE_BYTES && bridge.stdoutBuffer.indexOf(0x0a) === -1) {
            this.failPaneBridge(bridge, `Herdr terminal record exceeds ${MAX_PANE_LINE_BYTES} bytes`)
            return
        }
        while (true) {
            const newline = bridge.stdoutBuffer.indexOf(0x0a)
            if (newline === -1) {
                return
            }
            const line = bridge.stdoutBuffer.subarray(0, newline)
            bridge.stdoutBuffer = bridge.stdoutBuffer.subarray(newline + 1)
            if (!line.length) {
                continue
            }
            if (line.length > MAX_PANE_LINE_BYTES) {
                this.failPaneBridge(bridge, `Herdr terminal record exceeds ${MAX_PANE_LINE_BYTES} bytes`)
                return
            }
            bridge.outputChain = bridge.outputChain
                .then(() => this.handlePaneRecord(bridge, line.toString('utf8')))
                .catch(error => this.failPaneBridge(bridge, error instanceof Error ? error.message : String(error)))
        }
    }

    private async handlePaneRecord (bridge: PaneBridge, line: string): Promise<void> {
        const record = JSON.parse(line) as any
        if (record?.type === 'terminal.closed') {
            this.emitPaneEvent(bridge, {
                paneId: bridge.paneId,
                type: 'state',
                state: 'reconnecting',
                reason: String(record.reason ?? 'Herdr terminal stream closed'),
                reconnectAttempt: bridge.reconnectAttempts + 1,
            })
            return
        }
        if (record?.type !== 'terminal.frame' || record.encoding !== 'ansi') {
            throw new Error('Invalid Herdr terminal record')
        }
        const sequence = Number(record.seq)
        const width = this.safeDimension(record.width, 'frame width')
        const height = this.safeDimension(record.height, 'frame height')
        if (!Number.isSafeInteger(sequence) || sequence < 0
            || bridge.lastHerdrSequence !== null && sequence <= bridge.lastHerdrSequence) {
            throw new Error('Herdr terminal frame sequence is invalid or out of order')
        }
        const data = this.decodeBase64(record.bytes)
        if (data.length > MAX_PANE_FRAME_BYTES) {
            throw new Error(`Herdr terminal frame exceeds ${MAX_PANE_FRAME_BYTES} decoded bytes`)
        }
        const firstFrame = bridge.lastHerdrSequence === null
        bridge.lastHerdrSequence = sequence
        if (firstFrame) {
            bridge.reconnectAttempts = 0
            this.emitPaneEvent(bridge, {
                paneId: bridge.paneId,
                type: 'state',
                state: 'attached',
            })
        }
        for (let offset = 0; offset < data.length; offset += PANE_PUSH_CHUNK_BYTES) {
            const chunk = data.subarray(offset, offset + PANE_PUSH_CHUNK_BYTES)
            await this.callRuntime('pane.pushOutput', {
                paneId: bridge.paneId,
                producerId: bridge.producerId,
                data: [...chunk],
            })
            this.emitPaneEvent(bridge, {
                paneId: bridge.paneId,
                type: 'output',
                data: [...chunk],
                full: record.full === true && offset === 0,
                width,
                height,
            })
        }
    }

    private handlePaneExit (bridge: PaneBridge, child: ChildProcess, code: number | null): void {
        if (bridge.child !== child) {
            return
        }
        bridge.child = undefined
        if (bridge.closing) {
            return
        }
        this.schedulePaneReconnect(bridge, `Herdr terminal controller exited with code ${code ?? 'unknown'}`)
    }

    private schedulePaneReconnect (bridge: PaneBridge, reason: string): void {
        if (bridge.closing || bridge.reconnectTimer) {
            return
        }
        if (bridge.reconnectAttempts >= MAX_PANE_RECONNECT_ATTEMPTS) {
            this.emitPaneEvent(bridge, {
                paneId: bridge.paneId,
                type: 'state',
                state: 'error',
                reason,
                reconnectAttempt: bridge.reconnectAttempts,
            })
            return
        }
        const delay = Math.min(500 * (2 ** bridge.reconnectAttempts), 8000)
        bridge.reconnectAttempts++
        this.emitPaneEvent(bridge, {
            paneId: bridge.paneId,
            type: 'state',
            state: 'reconnecting',
            reason,
            reconnectAttempt: bridge.reconnectAttempts,
        })
        bridge.reconnectTimer = setTimeout(() => {
            bridge.reconnectTimer = undefined
            void this.spawnPaneController(bridge).catch(error => {
                this.schedulePaneReconnect(bridge, error instanceof Error ? error.message : String(error))
            })
        }, delay)
    }

    private failPaneBridge (bridge: PaneBridge, reason: string): void {
        this.lastError = `Herdr pane ${bridge.target}: ${reason}`
        const child = bridge.child
        bridge.child = undefined
        if (child && child.exitCode === null && child.signalCode === null) {
            child.kill()
        }
        this.schedulePaneReconnect(bridge, reason)
    }

    private writePaneCommand (bridge: PaneBridge, command: Record<string, unknown>): Promise<void> {
        const stdin = bridge.child?.stdin
        if (!stdin || stdin.destroyed || !stdin.writable) {
            return Promise.reject(new Error(`Herdr pane ${bridge.paneId} is not connected`))
        }
        const payload = `${JSON.stringify(command)}\n`
        return new Promise((resolve, reject) => {
            const onError = (error: Error): void => {
                stdin.off('drain', onDrain)
                reject(error)
            }
            const onDrain = (): void => {
                stdin.off('error', onError)
                resolve()
            }
            stdin.once('error', onError)
            if (stdin.write(payload)) {
                stdin.off('error', onError)
                resolve()
            } else {
                stdin.once('drain', onDrain)
            }
        })
    }

    private requirePaneBridge (request: HerdrRequest, rendererId: number): PaneBridge {
        const paneId = this.requiredId(request.paneId, 'paneId')
        const bridge = this.paneBridges.get(paneId)
        if (!bridge || bridge.closing) {
            throw new Error(`Herdr pane ${paneId} is not attached`)
        }
        if (bridge.rendererId !== rendererId) {
            throw new Error(`Herdr pane ${paneId} belongs to another renderer`)
        }
        return bridge
    }

    private paneAttachment (bridge: PaneBridge): unknown {
        return {
            paneId: bridge.paneId,
            target: bridge.target,
            title: bridge.title,
            workspaceId: bridge.workspaceId,
            ownerId: bridge.ownerId,
            columns: bridge.columns,
            rows: bridge.rows,
            attached: this.bridgeIsRunning(bridge),
        }
    }

    private bridgeIsRunning (bridge: PaneBridge): boolean {
        return !!bridge.child && bridge.child.exitCode === null && bridge.child.signalCode === null
    }

    private producerId (request: HerdrRequest, target: string): string {
        const session = request.session?.trim() || 'default'
        return `herdr:${session}:${target}`.slice(0, 128)
    }

    private assertPaneRuntime (): void {
        if (!this.runtimeRequest || !this.paneEventSink) {
            throw new Error('Herdr pane transport is unavailable in this host')
        }
    }

    private async callRuntime (method: string, params: unknown): Promise<any> {
        if (!this.runtimeRequest) {
            throw new Error('issh Runtime is unavailable')
        }
        const response = await this.runtimeRequest({
            jsonrpc: '2.0',
            id: `herdr-pane-${Date.now()}-${Math.random().toString(16).slice(2)}`,
            method,
            params,
        })
        if (response.error) {
            throw new Error(response.error.message)
        }
        return response.result
    }

    private emitPaneEvent (bridge: PaneBridge, event: HerdrPaneEvent): void {
        this.paneEventSink?.(bridge.rendererId, event)
    }

    private safeDimension (value: unknown, name: string): number {
        const dimension = Math.floor(Number(value))
        if (!Number.isFinite(dimension) || dimension < 1 || dimension > 65535) {
            throw new Error(`${name} must be an integer between 1 and 65535`)
        }
        return dimension
    }

    private safeBytes (value: unknown): number[] {
        if (!Array.isArray(value) || value.length > MAX_PANE_WRITE_BYTES
            || value.some(byte => !Number.isInteger(byte) || byte < 0 || byte > 255)) {
            throw new Error(`data must be an unsigned byte array no larger than ${MAX_PANE_WRITE_BYTES} bytes`)
        }
        return value
    }

    private decodeBase64 (value: unknown): Buffer {
        if (typeof value !== 'string' || value.length > Math.ceil(MAX_PANE_FRAME_BYTES * 4 / 3) + 4
            || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
            throw new Error('Herdr terminal frame contains invalid base64 bytes')
        }
        return Buffer.from(value, 'base64')
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
