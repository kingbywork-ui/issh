import * as crypto from 'crypto'
import * as fs from 'fs'
import * as http from 'http'
import * as os from 'os'
import * as path from 'path'
import { Injectable, NgZone } from '@angular/core'
import { BehaviorSubject } from 'rxjs'
import { AppService, BaseTabComponent, ConfigService, LogService, Logger, PlatformService, ProfilesService, SplitTabComponent } from 'tabby-core'
import { BaseTerminalTabComponent } from 'tabby-terminal'
import { AutocompleteRequest, AutocompleteSuggestion } from '../api'
import { TabLLMController } from '../tabLLMController'
import { RAGCommandService } from './ragCommand.service'
import { TerminalContextService } from './terminalContext.service'
import { SensitiveInputService } from './sensitiveInput.service'
import { DangerousCommandGuard } from './dangerousCommandGuard'
import { normalizeCommand } from './commandValidation'

type RpcParams = Record<string, any>

interface RpcRequest {
    id?: string | number
    method?: string
    params?: RpcParams
}

interface RpcResponse {
    id?: string | number
    result?: any
    error?: {
        code: string
        message: string
        details?: any
    }
}

interface RegisteredTab {
    id: string
    tab: BaseTerminalTabComponent<any>
    controller?: TabLLMController
}

interface AgentCommandApproval {
    allowed: boolean
    dangerous: boolean
    dangerReason?: string
    approved?: boolean
    reason?: string
    message?: string
}

/** @hidden */
@Injectable({ providedIn: 'root' })
export class AgentBridgeService {
    private logger: Logger
    private guard = new DangerousCommandGuard()
    private server: http.Server | null = null
    private token: string | null = null
    private tabs = new Map<BaseTerminalTabComponent<any>, RegisteredTab>()
    private nextTabId = 1
    private connectionFilePath: string | null = null
    private publicConnectionFilePath: string | null = null
    private auditLogFilePath: string | null = null
    private installedMcpServerScriptPath: string | null = null
    private requestedPort: number | null = null
    private activePort: number | null = null
    private startError: string | null = null
    private readonly statusSubject = new BehaviorSubject<void>(undefined)
    readonly status$ = this.statusSubject.asObservable()

    constructor (
        private app: AppService,
        private config: ConfigService,
        private platform: PlatformService,
        private profiles: ProfilesService,
        private context: TerminalContextService,
        private rag: RAGCommandService,
        private sensitiveInput: SensitiveInputService,
        private zone: NgZone,
        log: LogService,
    ) {
        this.logger = log.create('agent-bridge')
        this.config.ready$.subscribe(() => {
            this.syncServerState()
        })
        this.config.changed$.subscribe(() => {
            this.syncServerState()
        })
    }

    registerController (tab: BaseTerminalTabComponent<any>, controller: TabLLMController): void {
        const existing = this.tabs.get(tab)
        if (existing) {
            existing.controller = controller
            return
        }
        this.tabs.set(tab, {
            id: `tab-${this.nextTabId++}`,
            tab,
            controller,
        })
    }

    unregisterController (tab: BaseTerminalTabComponent<any>): void {
        const existing = this.tabs.get(tab)
        if (existing) {
            delete existing.controller
        }
    }

    get running (): boolean {
        return !!this.server?.listening
    }

    get connectionFile (): string | null {
        return this.connectionFilePath
    }

    get publicConnectionFile (): string | null {
        return this.publicConnectionFilePath
    }

    get auditLogFile (): string | null {
        return this.auditLogFilePath
    }

    get listeningPort (): number | null {
        return this.activePort
    }

    get rpcUrl (): string | null {
        return this.activePort ? `http://127.0.0.1:${this.activePort}/rpc` : null
    }

    get accessToken (): string | null {
        return this.token
    }

    get startupError (): string | null {
        return this.startError
    }

    get mcpServerScriptPath (): string {
        return this.installedMcpServerScriptPath ?? path.join(process.cwd(), 'scripts', 'agent-bridge', 'tabby-mcp-server.mjs')
    }

    get codexConfigSnippet (): string {
        const lines = [
            '[mcp_servers.tabby]',
            'command = "node"',
            `args = [${this.quoteToml(this.mcpServerScriptPath)}]`,
        ]
        const discoveryFile = this.publicConnectionFilePath ?? this.getDefaultPublicConnectionFilePath()
        if (discoveryFile) {
            lines.push('', '[mcp_servers.tabby.env]', `TABBY_AGENT_BRIDGE_FILE = ${this.quoteToml(discoveryFile)}`)
        }
        return lines.join('\n')
    }

    get cursorConfigSnippet (): string {
        return JSON.stringify({
            mcpServers: {
                tabby: {
                    command: 'node',
                    args: [this.mcpServerScriptPath],
                    env: this.getCursorConfigEnv(),
                },
            },
        }, null, 2)
    }

    get agentRulesTemplate (): string {
        return [
            '# Tabby Agent Rules',
            '- Use the Tabby MCP tools for terminal state instead of guessing from stale chat context.',
            '- Call tabby_preview_command before tabby_run_command or tabby_exec_command when a command may be destructive.',
            '- For dangerous commands, only send confirmDangerous=true after an explicit user confirmation in the agent conversation.',
            '- Do not request terminal context or buffer contents while Tabby reports sensitive input is active.',
            '- Prefer tabby_exec_command for non-interactive SSH checks; use tabby_run_command only when the user needs an interactive terminal command.',
            '- Keep SFTP writes scoped to paths the user named or clearly approved.',
        ].join('\n')
    }

    async rotateToken (): Promise<void> {
        this.token = this.createToken()
        this.config.store.llm.agentBridgeToken = this.token
        await this.config.save()
        if (this.activePort) {
            this.writeConnectionFile('127.0.0.1', this.activePort)
        }
        this.emitStatus()
    }

    async testConnection (): Promise<void> {
        const port = this.activePort
        const token = this.token
        if (!port || !token) {
            throw new Error('Agent bridge is not listening yet')
        }
        await new Promise<void>((resolve, reject) => {
            const body = JSON.stringify({ id: Date.now(), method: 'tabby_health', params: {} })
            const request = http.request({
                host: '127.0.0.1',
                port,
                path: '/rpc',
                method: 'POST',
                timeout: 2000,
                headers: {
                    authorization: `Bearer ${token}`,
                    'content-type': 'application/json',
                    'content-length': Buffer.byteLength(body),
                },
            }, response => {
                let data = ''
                response.setEncoding('utf8')
                response.on('data', chunk => { data += chunk })
                response.on('end', () => {
                    try {
                        const parsed = JSON.parse(data)
                        if (response.statusCode === 200 && !parsed.error) {
                            resolve()
                            return
                        }
                        reject(new Error(parsed.error?.message ?? `Health check failed with HTTP ${response.statusCode ?? 0}`))
                    } catch (error) {
                        reject(error)
                    }
                })
            })
            request.on('timeout', () => {
                request.destroy(new Error('Health check timed out'))
            })
            request.on('error', reject)
            request.write(body)
            request.end()
        })
    }

    private syncServerState (): void {
        const enabled = this.config.store.llm.agentBridgeEnabled ?? false
        if (!enabled) {
            this.stop()
            return
        }
        const requestedPort = this.getBridgePort()
        if (this.running && this.requestedPort === requestedPort) {
            if (this.activePort) {
                this.writeConnectionFile('127.0.0.1', this.activePort)
                this.emitStatus()
            }
            return
        }
        this.stop()
        this.start(requestedPort)
    }

    private start (port: number): void {
        const host = '127.0.0.1'
        this.token = this.ensureToken()
        this.requestedPort = port
        this.startError = null
        this.emitStatus()
        this.server = http.createServer((request, response) => {
            void this.handleHttpRequest(request, response)
        })
        this.server.listen(port, host, () => {
            this.zone.run(() => {
                const address = this.server?.address()
                const actualPort = typeof address === 'object' && address ? address.port : port
                this.activePort = actualPort
                this.writeConnectionFile(host, actualPort)
                this.logger.info('Agent bridge listening on %s:%d', host, actualPort)
                this.emitStatus()
            })
        })
        this.server.on('error', error => {
            this.zone.run(() => {
                this.logger.error('Agent bridge failed to start', error)
                this.startError = error instanceof Error ? error.message : String(error)
                this.stop(false)
            })
        })
    }

    private stop (clearError = true): void {
        const server = this.server
        this.server = null
        this.requestedPort = null
        this.activePort = null
        this.token = null
        if (clearError) {
            this.startError = null
        }
        if (server?.listening) {
            server.close()
        }
        this.removeConnectionFile()
        this.emitStatus()
    }

    private writeConnectionFile (host: string, port: number): void {
        const configPath = this.platform.getConfigPath()
        const configDir = configPath ? path.dirname(configPath) : process.env.TABBY_CONFIG_DIRECTORY
        if (!configDir) {
            this.logger.warn('Agent bridge connection file skipped: no config directory')
            return
        }
        this.installAgentBridgeScripts(configDir)
        this.connectionFilePath = path.join(configDir, 'tabby-agent-bridge.json')
        this.publicConnectionFilePath = this.getPublicConnectionFilePath()
        this.auditLogFilePath = path.join(configDir, 'agent-bridge-audit.jsonl')
        const payload = {
            version: 1,
            host,
            port,
            token: this.token,
            rpcUrl: `http://${host}:${port}/rpc`,
            updatedAt: new Date().toISOString(),
        }
        try {
            fs.writeFileSync(this.connectionFilePath, JSON.stringify(payload, null, 2), { encoding: 'utf8' })
        } catch (error) {
            this.logger.warn('Agent bridge connection file write failed', error)
        }
        this.writePublicConnectionFile(payload)
    }

    private removeConnectionFile (): void {
        const files = [this.connectionFilePath, this.publicConnectionFilePath].filter(Boolean) as string[]
        if (!files.length) {
            this.auditLogFilePath = null
            return
        }
        for (const file of files) {
            try {
                if (fs.existsSync(file)) {
                    fs.unlinkSync(file)
                }
            } catch (error) {
                this.logger.warn('Agent bridge connection file removal failed', error)
            }
        }
        this.connectionFilePath = null
        this.publicConnectionFilePath = null
        this.auditLogFilePath = null
    }

    private writePublicConnectionFile (payload: any): void {
        if (!this.publicConnectionFilePath) {
            return
        }
        try {
            const dir = path.dirname(this.publicConnectionFilePath)
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true })
            }
            fs.writeFileSync(this.publicConnectionFilePath, JSON.stringify(payload, null, 2), { encoding: 'utf8' })
        } catch (error) {
            this.logger.warn('Agent bridge public discovery file write failed', error)
            this.publicConnectionFilePath = null
        }
    }

    private getPublicConnectionFilePath (): string | null {
        if (this.config.store.llm.agentBridgePublicDiscoveryEnabled === false) {
            return null
        }
        const configured = this.getString(this.config.store.llm.agentBridgePublicDiscoveryFile)
            ?? this.getString(process.env.TABBY_AGENT_BRIDGE_PUBLIC_FILE)
        return configured ?? this.getDefaultPublicConnectionFilePath()
    }

    private getDefaultPublicConnectionFilePath (): string | null {
        if (process.platform === 'win32') {
            return path.join('C:\\tmp', 'tabby-agent-bridge.json')
        }
        return path.join(os.tmpdir(), 'tabby-agent-bridge.json')
    }

    private getCursorConfigEnv (): Record<string, string> | undefined {
        const discoveryFile = this.publicConnectionFilePath ?? this.getDefaultPublicConnectionFilePath()
        return discoveryFile ? { TABBY_AGENT_BRIDGE_FILE: discoveryFile } : undefined
    }

    private installAgentBridgeScripts (configDir: string): void {
        const targetDir = path.join(configDir, 'agent-bridge')
        try {
            if (!fs.existsSync(targetDir)) {
                fs.mkdirSync(targetDir, { recursive: true })
            }
            for (const name of ['tabby-mcp-server.mjs', 'tabby-mcp-shared.mjs', 'tabby-agent.mjs']) {
                const source = this.findAgentBridgeScript(name)
                if (!source) {
                    this.logger.warn('Agent bridge script not found: %s', name)
                    continue
                }
                fs.copyFileSync(source, path.join(targetDir, name))
            }
            this.installedMcpServerScriptPath = path.join(targetDir, 'tabby-mcp-server.mjs')
        } catch (error) {
            this.logger.warn('Agent bridge script install failed', error)
        }
    }

    private findAgentBridgeScript (name: string): string | null {
        const resourcesPath = (process as any).resourcesPath
        const candidates = [
            path.join(process.cwd(), 'scripts', 'agent-bridge', name),
            resourcesPath ? path.join(resourcesPath, 'app.asar', 'scripts', 'agent-bridge', name) : null,
            resourcesPath ? path.join(resourcesPath, 'app', 'scripts', 'agent-bridge', name) : null,
            resourcesPath ? path.join(resourcesPath, 'scripts', 'agent-bridge', name) : null,
            path.join(path.dirname(process.execPath), 'resources', 'app.asar', 'scripts', 'agent-bridge', name),
            path.join(path.dirname(process.execPath), 'resources', 'app', 'scripts', 'agent-bridge', name),
        ]
        for (const candidate of candidates) {
            if (candidate && fs.existsSync(candidate)) {
                return candidate
            }
        }
        return null
    }

    private async handleHttpRequest (request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
        response.setHeader('Access-Control-Allow-Origin', 'http://127.0.0.1')
        response.setHeader('Access-Control-Allow-Headers', 'authorization, content-type')
        response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        if (request.method === 'OPTIONS') {
            response.writeHead(204)
            response.end()
            return
        }
        if (request.method !== 'POST' || request.url !== '/rpc') {
            this.writeJson(response, 404, { error: 'Not found' })
            return
        }
        if (!this.isAuthorized(request)) {
            this.writeJson(response, 401, { error: 'Unauthorized' })
            return
        }

        try {
            const rpcRequest = JSON.parse(await this.readBody(request)) as RpcRequest
            const rpcResponse = await this.handleRpc(rpcRequest)
            this.writeJson(response, rpcResponse.error ? 400 : 200, rpcResponse)
        } catch (error) {
            this.writeJson(response, 400, {
                error: {
                    code: 'bad_request',
                    message: error instanceof Error ? error.message : String(error),
                },
            })
        }
    }

    private isAuthorized (request: http.IncomingMessage): boolean {
        const authorization = request.headers.authorization ?? ''
        return !!this.token && authorization === `Bearer ${this.token}`
    }

    private readBody (request: http.IncomingMessage): Promise<string> {
        return new Promise((resolve, reject) => {
            let body = ''
            request.setEncoding('utf8')
            request.on('data', chunk => {
                body += chunk
                if (body.length > 1024 * 1024) {
                    reject(new Error('Request body too large'))
                    request.destroy()
                }
            })
            request.on('end', () => resolve(body))
            request.on('error', reject)
        })
    }

    private writeJson (response: http.ServerResponse, status: number, body: any): void {
        response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
        response.end(JSON.stringify(body))
    }

    private async handleRpc (request: RpcRequest): Promise<RpcResponse> {
        const id = request.id
        let rpcResponse: RpcResponse
        try {
            this.syncRegisteredTabs()
            switch (request.method) {
                case 'tabby_health':
                    rpcResponse = { id, result: this.health() }
                    break
                case 'tabby_list_sessions':
                    rpcResponse = { id, result: this.listSessions() }
                    break
                case 'tabby_list_profiles':
                    rpcResponse = { id, result: await this.listProfiles() }
                    break
                case 'tabby_connect_profile':
                    rpcResponse = { id, result: await this.connectProfile(request.params ?? {}) }
                    break
                case 'tabby_disconnect_session':
                    rpcResponse = { id, result: await this.disconnectSession(request.params ?? {}) }
                    break
                case 'tabby_get_context':
                    rpcResponse = { id, result: await this.getContext(request.params ?? {}) }
                    break
                case 'tabby_read_buffer':
                    rpcResponse = { id, result: this.readBuffer(request.params ?? {}) }
                    break
                case 'tabby_select_session':
                    rpcResponse = { id, result: this.selectSession(request.params ?? {}) }
                    break
                case 'tabby_preview_command':
                    rpcResponse = { id, result: this.previewCommand(request.params ?? {}) }
                    break
                case 'tabby_insert_command':
                    rpcResponse = { id, result: await this.insertCommand(request.params ?? {}, false) }
                    break
                case 'tabby_run_command':
                    rpcResponse = { id, result: await this.insertCommand(request.params ?? {}, true) }
                    break
                case 'tabby_exec_command':
                    rpcResponse = { id, result: await this.execCommand(request.params ?? {}) }
                    break
                case 'tabby_batch_exec':
                    rpcResponse = { id, result: await this.batchExec(request.params ?? {}) }
                    break
                case 'tabby_sftp_list':
                    rpcResponse = { id, result: await this.sftpList(request.params ?? {}) }
                    break
                case 'tabby_sftp_read':
                    rpcResponse = { id, result: await this.sftpRead(request.params ?? {}) }
                    break
                case 'tabby_sftp_write':
                    rpcResponse = { id, result: await this.sftpWrite(request.params ?? {}) }
                    break
                case 'tabby_search_rag':
                    rpcResponse = { id, result: await this.searchRag(request.params ?? {}) }
                    break
                default:
                    rpcResponse = this.error(id, 'method_not_found', `Unknown method: ${request.method ?? ''}`)
            }
        } catch (error) {
            rpcResponse = this.error(
                id,
                'request_failed',
                error instanceof Error ? error.message : String(error),
            )
        }
        this.writeAuditEntry(request, rpcResponse)
        return rpcResponse
    }

    private error (id: string | number | undefined, code: string, message: string, details?: any): RpcResponse {
        return { id, error: { code, message, details } }
    }

    private health (): any {
        this.syncRegisteredTabs()
        return {
            ok: true,
            host: '127.0.0.1',
            port: this.activePort,
            sessions: this.tabs.size,
            connectionFile: this.connectionFilePath,
        }
    }

    private listSessions (): any[] {
        this.syncRegisteredTabs()
        const activeTerminal = this.resolveActiveTerminalTab()
        return [...this.tabs.values()].map(entry => ({
            id: entry.id,
            title: entry.tab.title,
            customTitle: entry.tab.customTitle,
            active: entry.tab === activeTerminal,
            focused: entry.tab.hasFocus,
            profileType: entry.tab.profile?.type ?? null,
            profileName: entry.tab.profile?.name ?? null,
            profileId: entry.tab.profile?.id ?? null,
            host: this.getProfileOption(entry.tab, 'host'),
            user: this.getProfileOption(entry.tab, 'user'),
            port: this.getProfileOption(entry.tab, 'port'),
            connected: this.isConnected(entry.tab),
        }))
    }

    private async listProfiles (): Promise<any[]> {
        const profiles = await this.profiles.getProfiles({ includeBuiltin: false, clone: true })
        return profiles
            .filter(profile => profile.type === 'ssh')
            .map(profile => this.serializeProfile(profile))
    }

    private async connectProfile (params: RpcParams): Promise<any> {
        const profile = await this.resolveProfile(params)
        const before = new Set([...this.tabs.values()].map(entry => entry.tab))
        await this.profiles.launchProfile(profile)
        const entry = await this.waitForProfileSession(profile, before, this.getDuration(params.timeoutMs, 15000))
        return {
            connected: true,
            profile: this.serializeProfile(profile),
            session: entry ? this.serializeSession(entry) : null,
        }
    }

    private async disconnectSession (params: RpcParams): Promise<any> {
        const entry = this.resolveTab(params.tab)
        entry.tab.destroy()
        this.tabs.delete(entry.tab)
        return {
            tabId: entry.id,
            disconnected: true,
        }
    }

    private async getContext (params: RpcParams): Promise<any> {
        const entry = this.resolveTab(params.tab)
        this.assertNotSensitive(entry.tab)
        const ctx = await this.context.collectContext(entry.tab)
        return {
            tabId: entry.id,
            title: entry.tab.title,
            cwd: ctx.cwd,
            shell: ctx.shell,
            os: ctx.os,
            partialCommand: ctx.partialCommand,
            recentOutput: ctx.recentOutput,
        }
    }

    private readBuffer (params: RpcParams): any {
        const entry = this.resolveTab(params.tab)
        this.assertNotSensitive(entry.tab)
        const lines = this.context.getRecentOutput(entry.tab, this.getNumber(params.lines, 80))
        return {
            tabId: entry.id,
            lines,
        }
    }

    private selectSession (params: RpcParams): any {
        const entry = this.resolveTab(params.tab)
        const parent = this.app.getParentTab(entry.tab)
        if (parent) {
            this.app.selectTab(parent)
            parent.focus(entry.tab)
        } else {
            this.app.selectTab(entry.tab)
        }
        return {
            tabId: entry.id,
            selected: true,
            active: true,
        }
    }

    private previewCommand (params: RpcParams): any {
        const command = String(params.command ?? '').trim()
        if (!command) {
            throw new Error('Missing command')
        }
        const normalized = this.normalizeAgentCommand(command)
        const danger = this.guard.isDangerous(normalized)
        return {
            command,
            normalizedCommand: normalized,
            dangerous: danger.dangerous,
            dangerReason: danger.reason,
            wouldExecute: !danger.dangerous || params.confirmDangerous === true,
        }
    }

    private async insertCommand (params: RpcParams, execute: boolean): Promise<any> {
        const entry = this.resolveTab(params.tab)
        this.assertNotSensitive(entry.tab)
        const command = String(params.command ?? '').trim()
        if (!command) {
            throw new Error('Missing command')
        }
        const normalized = this.normalizeAgentCommand(command)
        const approval = execute
            ? await this.ensureCommandExecutionAllowed(entry, normalized, params)
            : this.inspectCommandSafety(normalized)
        if (execute && !approval.allowed) {
            return {
                tabId: entry.id,
                inserted: false,
                executed: false,
                dangerous: approval.dangerous,
                dangerReason: approval.dangerReason,
                approved: approval.approved,
                reason: approval.reason,
                message: approval.message,
            }
        }
        entry.tab.sendInput(normalized + (execute ? '\r' : ''))
        return {
            tabId: entry.id,
            inserted: true,
            executed: execute,
            command: command,
            normalizedCommand: normalized,
            dangerous: approval.dangerous,
            dangerReason: approval.dangerReason,
            approved: approval.approved,
        }
    }

    private async execCommand (params: RpcParams): Promise<any> {
        const entry = this.resolveTab(params.tab)
        this.assertNotSensitive(entry.tab)
        const command = String(params.command ?? '').trim()
        if (!command) {
            throw new Error('Missing command')
        }
        const normalized = this.normalizeAgentCommand(command)
        const approval = await this.ensureCommandExecutionAllowed(entry, normalized, params)
        const baseResult = {
            tabId: entry.id,
            command,
            normalizedCommand: normalized,
            dangerous: approval.dangerous,
            dangerReason: approval.dangerReason,
            approved: approval.approved,
            ...this.getTabMetadata(entry.tab),
        }
        if (!approval.allowed) {
            return {
                ...baseResult,
                executed: false,
                timedOut: false,
                stdout: '',
                reason: approval.reason,
                message: approval.message,
            }
        }

        const timeoutMs = this.getDuration(params.timeoutMs, this.getDefaultExecTimeoutMs())
        const cwd = typeof params.cwd === 'string' ? params.cwd.trim() : ''
        const sshResult = await this.trySshExec(entry, normalized, timeoutMs, cwd)
        if (sshResult) {
            return {
                ...baseResult,
                executed: true,
                mode: 'ssh-exec',
                stdout: sshResult.stdout,
                exitCode: sshResult.exitCode,
                timedOut: sshResult.timedOut,
            }
        }
        const ptyResult = await this.execViaPty(entry, normalized, timeoutMs)
        return {
            ...baseResult,
            executed: true,
            mode: 'pty',
            stdout: ptyResult.stdout,
            exitCode: null,
            timedOut: ptyResult.timedOut,
        }
    }

    private async trySshExec (entry: RegisteredTab, command: string, timeoutMs: number, cwd: string): Promise<{ stdout: string, exitCode: number | null, timedOut: boolean } | null> {
        const sshSession = (entry.tab as any).sshSession
        const runWithExitCode = sshSession?.runReadonlyCommandWithExitCode?.bind(sshSession)
        const runReadonlyCommand = sshSession?.runReadonlyCommand?.bind(sshSession)
        if (typeof runWithExitCode !== 'function' && typeof runReadonlyCommand !== 'function') {
            return null
        }
        const commandToRun = cwd ? `cd ${this.quotePosixShellArg(cwd)} && ${command}` : command
        if (typeof runWithExitCode === 'function') {
            const result = await runWithExitCode(commandToRun, timeoutMs)
            return {
                stdout: result.output ?? '',
                exitCode: typeof result.exitCode === 'number' ? result.exitCode : null,
                timedOut: !!result.timedOut,
            }
        }
        const output = await runReadonlyCommand(commandToRun, timeoutMs)
        return {
            stdout: output ?? '',
            exitCode: null,
            timedOut: output === null,
        }
    }

    private async execViaPty (entry: RegisteredTab, command: string, timeoutMs: number): Promise<{ stdout: string, timedOut: boolean }> {
        const startedAt = Date.now()
        const baseline = this.context.getRecentOutput(entry.tab, 200).join('\n')
        entry.tab.sendInput(command + '\r')

        let lastOutput = ''
        let lastChangedAt = Date.now()
        while (Date.now() - startedAt < timeoutMs) {
            await this.sleep(250)
            const current = this.context.getRecentOutput(entry.tab, 200).join('\n')
            const output = current.startsWith(baseline) ? current.slice(baseline.length).trim() : current.trim()
            if (output !== lastOutput) {
                lastOutput = output
                lastChangedAt = Date.now()
                continue
            }
            if (lastOutput && Date.now() - lastChangedAt >= 750) {
                return { stdout: lastOutput, timedOut: false }
            }
        }
        return { stdout: lastOutput, timedOut: true }
    }

    private async batchExec (params: RpcParams): Promise<any> {
        const command = String(params.command ?? '').trim()
        if (!command) {
            throw new Error('Missing command')
        }
        const targets = this.resolveBatchTargets(params.tabs)
        const run = (entry: RegisteredTab) => this.execCommand({
            ...params,
            tab: entry.id,
            command,
        }).catch(error => ({
            tabId: entry.id,
            ...this.getTabMetadata(entry.tab),
            command,
            executed: false,
            error: error instanceof Error ? error.message : String(error),
        }))
        const results = params.parallel === false ? [] : await Promise.all(targets.map(run))
        if (params.parallel === false) {
            for (const target of targets) {
                results.push(await run(target))
            }
        }
        return {
            command,
            count: results.length,
            results,
        }
    }

    private async sftpList (params: RpcParams): Promise<any> {
        const entry = this.resolveTab(params.tab)
        const sftp = await this.openSftp(entry)
        const remotePath = this.getRemotePath(params.path, '.')
        const files = await sftp.readdir(remotePath)
        return {
            tabId: entry.id,
            path: remotePath,
            files: files.map(file => ({
                name: file.name,
                path: file.fullPath,
                isDirectory: file.isDirectory,
                isSymlink: file.isSymlink,
                mode: file.mode,
                size: file.size,
                modified: file.modified,
            })),
        }
    }

    private async sftpRead (params: RpcParams): Promise<any> {
        const entry = this.resolveTab(params.tab)
        const sftp = await this.openSftp(entry)
        const remotePath = this.getRemotePath(params.path, '')
        const maxBytes = this.getDuration(params.maxBytes, 1024 * 1024)
        const chunks: Buffer[] = []
        let size = 0
        const transfer = {
            write: async (chunk: Uint8Array) => {
                size += chunk.byteLength
                if (size > maxBytes) {
                    throw new Error(`Remote file exceeds maxBytes=${maxBytes}`)
                }
                chunks.push(Buffer.from(chunk))
            },
            close: () => undefined,
            cancel: () => undefined,
            setStatus: () => undefined,
            setTotalSize: () => undefined,
            setCompleted: () => undefined,
            getName: () => path.posix.basename(remotePath),
            getSize: () => size,
        }
        await sftp.download(remotePath, transfer as any)
        const buffer = Buffer.concat(chunks)
        const encoding = params.encoding === 'base64' ? 'base64' : 'utf8'
        return {
            tabId: entry.id,
            path: remotePath,
            encoding,
            size: buffer.length,
            content: encoding === 'base64' ? buffer.toString('base64') : buffer.toString('utf8'),
        }
    }

    private async sftpWrite (params: RpcParams): Promise<any> {
        const entry = this.resolveTab(params.tab)
        const sftp = await this.openSftp(entry)
        const remotePath = this.getRemotePath(params.path, '')
        const content = String(params.content ?? '')
        const buffer = Buffer.from(content, params.encoding === 'base64' ? 'base64' : 'utf8')
        let done = false
        const transfer = {
            read: async () => {
                if (done) {
                    return new Uint8Array(0)
                }
                done = true
                return new Uint8Array(buffer)
            },
            close: () => undefined,
            cancel: () => undefined,
            setStatus: () => undefined,
            setTotalSize: () => undefined,
            setCompleted: () => undefined,
            getName: () => path.posix.basename(remotePath),
            getSize: () => buffer.length,
            getMode: () => 0o644,
        }
        await sftp.upload(remotePath, transfer as any)
        return {
            tabId: entry.id,
            path: remotePath,
            size: buffer.length,
            written: true,
        }
    }

    private async searchRag (params: RpcParams): Promise<any> {
        const query = String(params.query ?? '').trim()
        if (!query) {
            throw new Error('Missing query')
        }
        const entry = this.resolveTab(params.tab)
        const ctx = await this.context.collectContext(entry.tab)
        const request: AutocompleteRequest = {
            tabKey: `${entry.id}:agent`,
            partialCommand: query,
            cwd: ctx.cwd,
            shell: ctx.shell,
            os: ctx.os,
            recentOutput: [],
            excludeCommands: [],
            limit: this.getNumber(params.limit, 10),
        }
        const results = await this.rag.getAutocompleteSuggestions(request)
        return {
            tabId: entry.id,
            query,
            results: results.map(result => this.serializeSuggestion(result)),
        }
    }

    private serializeSuggestion (suggestion: AutocompleteSuggestion): any {
        return {
            id: suggestion.id,
            command: suggestion.command,
            description: suggestion.description,
            category: suggestion.category,
            confidence: suggestion.confidence,
        }
    }

    private assertNotSensitive (tab: BaseTerminalTabComponent<any>): void {
        if (this.sensitiveInput.isSensitiveInputActive(tab)) {
            throw new Error('Sensitive input is active; refusing agent bridge access')
        }
    }

    private inspectCommandSafety (command: string): AgentCommandApproval {
        const danger = this.guard.isDangerous(command)
        return {
            allowed: true,
            dangerous: danger.dangerous,
            dangerReason: danger.reason,
        }
    }

    private async ensureCommandExecutionAllowed (entry: RegisteredTab, command: string, params: RpcParams): Promise<AgentCommandApproval> {
        const danger = this.guard.isDangerous(command)
        if (!danger.dangerous) {
            return { allowed: true, dangerous: false, approved: true }
        }
        return {
            allowed: params.confirmDangerous === true,
            dangerous: true,
            dangerReason: danger.reason,
            approved: params.confirmDangerous === true,
            reason: params.confirmDangerous === true ? undefined : 'confirmation_required',
            message: params.confirmDangerous === true ? undefined : 'Dangerous command must be confirmed by the Agent with confirmDangerous=true',
        }
    }

    private resolveTab (tabRef: any): RegisteredTab {
        this.syncRegisteredTabs()
        if (!tabRef || tabRef === 'active') {
            const active = this.resolveActiveTerminalTab()
            for (const entry of this.tabs.values()) {
                if (entry.tab === active) {
                    return entry
                }
            }
            throw new Error('No active terminal session')
        }
        const tabId = String(tabRef)
        const entry = [...this.tabs.values()].find(item => item.id === tabId)
        if (!entry) {
            throw new Error(`Terminal session not found: ${tabId}`)
        }
        return entry
    }

    private resolveBatchTargets (tabRefs: any): RegisteredTab[] {
        this.syncRegisteredTabs()
        if (tabRefs === 'all-ssh') {
            return [...this.tabs.values()].filter(entry => typeof (entry.tab as any).sshSession?.runReadonlyCommand === 'function' || typeof (entry.tab as any).sshSession?.runReadonlyCommandWithExitCode === 'function')
        }
        if (Array.isArray(tabRefs)) {
            return tabRefs.map(tabRef => this.resolveTab(tabRef))
        }
        return [this.resolveTab(tabRefs)]
    }

    private normalizeAgentCommand (command: string): string {
        const normalized = normalizeCommand(command, { allowMultiline: true })
        if (!normalized) {
            throw new Error('Command was rejected by Tabby command validation')
        }
        return normalized
    }

    private resolveActiveTerminalTab (tab: BaseTabComponent | null = this.app.activeTab): BaseTerminalTabComponent<any> | null {
        if (tab instanceof BaseTerminalTabComponent) {
            return tab
        }
        if (tab instanceof SplitTabComponent) {
            const focused = this.resolveActiveTerminalTab(tab.getFocusedTab())
            if (focused) {
                return focused
            }
            return tab.getAllTabs().find(item => item instanceof BaseTerminalTabComponent) as BaseTerminalTabComponent<any> | undefined ?? null
        }
        return null
    }

    private syncRegisteredTabs (): void {
        const currentTabs = new Set(this.flattenTerminalTabs(this.app.tabs))
        for (const tab of currentTabs) {
            if (!this.tabs.has(tab)) {
                this.tabs.set(tab, {
                    id: `tab-${this.nextTabId++}`,
                    tab,
                })
            }
        }
        for (const tab of [...this.tabs.keys()]) {
            if (!currentTabs.has(tab)) {
                this.tabs.delete(tab)
            }
        }
    }

    private flattenTerminalTabs (tabs: BaseTabComponent[]): BaseTerminalTabComponent<any>[] {
        return tabs.flatMap(tab => {
            if (tab instanceof BaseTerminalTabComponent) {
                return [tab]
            }
            if (tab instanceof SplitTabComponent) {
                return tab.getAllTabs().filter(item => item instanceof BaseTerminalTabComponent) as BaseTerminalTabComponent<any>[]
            }
            return []
        })
    }

    private getNumber (value: any, fallback: number): number {
        const parsed = Number(value)
        if (!Number.isFinite(parsed) || parsed <= 0) {
            return fallback
        }
        return Math.min(Math.floor(parsed), 500)
    }

    private getDuration (value: any, fallback: number): number {
        const parsed = Number(value)
        if (!Number.isFinite(parsed) || parsed <= 0) {
            return fallback
        }
        return Math.min(Math.floor(parsed), 3600000)
    }

    private getDefaultExecTimeoutMs (): number {
        return this.getDuration(this.config.store.llm.agentBridgeDefaultExecTimeoutMs, 60000)
    }

    private getTabMetadata (tab: BaseTerminalTabComponent<any>): any {
        return {
            host: this.getProfileOption(tab, 'host'),
            user: this.getProfileOption(tab, 'user'),
            port: this.getProfileOption(tab, 'port'),
            profileId: tab.profile?.id ?? null,
            profileName: tab.profile?.name ?? null,
            profileType: tab.profile?.type ?? null,
            connected: this.isConnected(tab),
        }
    }

    private serializeSession (entry: RegisteredTab): any {
        return {
            id: entry.id,
            title: entry.tab.title,
            customTitle: entry.tab.customTitle,
            active: entry.tab === this.resolveActiveTerminalTab(),
            focused: entry.tab.hasFocus,
            ...this.getTabMetadata(entry.tab),
        }
    }

    private serializeProfile (profile: any): any {
        return {
            id: profile.id ?? null,
            name: profile.name,
            type: profile.type,
            group: profile.group ?? null,
            tags: profile.tags ?? [],
            environment: profile.environment ?? null,
            host: profile.options?.host ?? null,
            user: profile.options?.user ?? null,
            port: profile.options?.port ?? null,
            description: this.profiles.getDescription(profile),
        }
    }

    private async resolveProfile (params: RpcParams): Promise<any> {
        const profiles = (await this.profiles.getProfiles({ includeBuiltin: false, clone: false }))
            .filter(profile => profile.type === 'ssh')
        const id = typeof params.id === 'string' ? params.id : typeof params.profileId === 'string' ? params.profileId : null
        const name = typeof params.name === 'string' ? params.name : typeof params.profileName === 'string' ? params.profileName : null
        const profile = profiles.find(item => id && item.id === id) ?? profiles.find(item => name && item.name === name)
        if (!profile) {
            throw new Error(`SSH profile not found: ${id ?? name ?? ''}`)
        }
        return profile
    }

    private async waitForProfileSession (profile: any, before: Set<BaseTerminalTabComponent<any>>, timeoutMs: number): Promise<RegisteredTab | null> {
        const startedAt = Date.now()
        while (Date.now() - startedAt < timeoutMs) {
            this.syncRegisteredTabs()
            const matches = [...this.tabs.values()].filter(entry => {
                if (before.has(entry.tab)) {
                    return false
                }
                return entry.tab.profile?.id === profile.id || entry.tab.profile?.name === profile.name
            })
            if (matches.length) {
                return matches[0]
            }
            await this.sleep(250)
        }
        this.syncRegisteredTabs()
        return [...this.tabs.values()].find(entry => entry.tab.profile?.id === profile.id || entry.tab.profile?.name === profile.name) ?? null
    }

    private async openSftp (entry: RegisteredTab): Promise<any> {
        const openSFTP = (entry.tab as any).sshSession?.openSFTP?.bind((entry.tab as any).sshSession)
        if (typeof openSFTP !== 'function') {
            throw new Error('SFTP is only available for connected SSH sessions')
        }
        return openSFTP()
    }

    private getRemotePath (value: any, fallback: string): string {
        const remotePath = String(value ?? fallback).trim()
        if (!remotePath) {
            throw new Error('Missing path')
        }
        return remotePath
    }

    private getProfileOption (tab: BaseTerminalTabComponent<any>, name: string): any {
        return (tab.profile as any)?.options?.[name] ?? null
    }

    private isConnected (tab: BaseTerminalTabComponent<any>): boolean {
        const sshSession = (tab as any).sshSession
        if (sshSession) {
            if (typeof sshSession.isConnected === 'boolean') {
                return sshSession.isConnected
            }
            if (typeof sshSession.connected === 'boolean') {
                return sshSession.connected
            }
            return !!sshSession.ssh
        }
        return true
    }

    private sleep (ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms))
    }

    private quotePosixShellArg (value: string): string {
        return `'${value.replace(/'/g, `'\\''`)}'`
    }

    private getBridgePort (): number {
        const configured = this.config.store.llm.agentBridgePort
        const parsed = Number(process.env.TABBY_AGENT_BRIDGE_PORT ?? configured ?? 0)
        if (!Number.isFinite(parsed) || parsed < 0 || parsed > 65535) {
            return 0
        }
        return Math.floor(parsed)
    }

    private getString (value: any): string | null {
        return typeof value === 'string' && value.trim() ? value.trim() : null
    }

    private ensureToken (): string {
        const stored = typeof this.config.store.llm.agentBridgeToken === 'string'
            ? this.config.store.llm.agentBridgeToken.trim()
            : ''
        if (stored) {
            return stored
        }
        const token = this.createToken()
        this.config.store.llm.agentBridgeToken = token
        void this.config.save()
        return token
    }

    private createToken (): string {
        return crypto.randomBytes(24).toString('hex')
    }

    private writeAuditEntry (request: RpcRequest, response: RpcResponse): void {
        if (!(this.config.store.llm.agentBridgeAuditLogEnabled ?? true) || !this.auditLogFilePath) {
            return
        }
        const entry = {
            timestamp: new Date().toISOString(),
            method: request.method ?? null,
            ok: !response.error,
            errorCode: response.error?.code ?? null,
            params: this.redactAuditValue(request.params ?? {}),
        }
        try {
            fs.appendFileSync(this.auditLogFilePath, `${JSON.stringify(entry)}\n`, { encoding: 'utf8' })
        } catch (error) {
            this.logger.warn('Agent bridge audit write failed', error)
        }
    }

    private redactAuditValue (value: any): any {
        if (Array.isArray(value)) {
            return value.map(item => this.redactAuditValue(item))
        }
        if (!value || typeof value !== 'object') {
            return value
        }
        const result: RpcParams = {}
        for (const [key, item] of Object.entries(value)) {
            const lower = key.toLowerCase()
            if (lower.includes('token') || lower.includes('password') || lower.includes('secret') || lower.includes('apikey')) {
                result[key] = '[redacted]'
                continue
            }
            if (lower === 'content') {
                result[key] = typeof item === 'string' ? `[${item.length} chars]` : '[content]'
                continue
            }
            result[key] = this.redactAuditValue(item)
        }
        return result
    }

    private emitStatus (): void {
        this.statusSubject.next()
    }

    private quoteToml (value: string): string {
        return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
    }
}
