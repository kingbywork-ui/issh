import * as crypto from 'crypto'
import * as fs from 'fs'
import * as http from 'http'
import * as path from 'path'
import { execFile } from 'child_process'
import { Injectable, NgZone } from '@angular/core'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { BehaviorSubject } from 'rxjs'
import { AppService, BaseTabComponent, ConfigService, LogService, Logger, PlatformService, ProfilesService, SplitTabComponent } from 'issh-core'
import { BaseTerminalTabComponent } from 'issh-terminal'
import { TabLLMController } from '../tabLLMController'
import { TerminalContextService } from './terminalContext.service'
import { SensitiveInputService } from './sensitiveInput.service'
import { DangerousCommandGuard } from './dangerousCommandGuard'
import { normalizeCommand } from './commandValidation'
import { RuntimeBridgeService } from './runtimeBridge.service'
import { AgentPromptContext, LLMService } from './llm.service'
import { CordisOrchestratorService } from './cordisOrchestrator.service'
import { HerdrAdapterService } from './herdrAdapter.service'
import {
    buildCodexDesktopConfigFields,
    CodexDesktopConfigFields,
    formatCodexDesktopConfigGuide,
} from './codexDesktopConfig'
import {
    AGENT_BRIDGE_METHOD_SCOPES,
    AGENT_BRIDGE_PROTOCOL_VERSION,
    AGENT_BRIDGE_TOOLS,
    normalizeAgentBridgeMethod,
} from '../../../issh-agent/src/protocol'

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
    approvedBy?: 'user' | 'denied' | 'auto'
    reason?: string
    message?: string
}

type AgentBridgeScope = 'read' | 'write' | 'exec' | 'sftp'

const ALL_SCOPES: AgentBridgeScope[] = ['read', 'write', 'exec', 'sftp']
const METHOD_SCOPES = AGENT_BRIDGE_METHOD_SCOPES as Record<string, AgentBridgeScope>
const MCP_TOOLS = AGENT_BRIDGE_TOOLS.map(tool => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
}))

interface CachedOutput {
    outputId: string
    tabId: string
    command: string
    stdout: string
    createdAt: number
}

interface SseClient {
    id: string
    server: Server
    transport: SSEServerTransport
    createdAt: number
}

const OUTPUT_TRUNCATE_THRESHOLD = 4000
const OUTPUT_MAX_ENTRIES = 50
const OUTPUT_MAX_AGE_MS = 10 * 60 * 1000
const AUDIT_LOG_MAX_BYTES = 5 * 1024 * 1024
const CONNECTION_FILE_NAME = 'issh-agent-bridge.json'
const LEGACY_CONNECTION_FILE_NAME = 'tabby-agent-bridge.json'
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
    private clientInstallError: string | null = null
    private readonly statusSubject = new BehaviorSubject<void>(undefined)
    readonly status$ = this.statusSubject.asObservable()
    private outputCache = new Map<string, CachedOutput>()
    private sseClients = new Map<string, SseClient>()

    constructor (
        private app: AppService,
        private config: ConfigService,
        private platform: PlatformService,
        private profiles: ProfilesService,
        private context: TerminalContextService,
        private sensitiveInput: SensitiveInputService,
        private runtime: RuntimeBridgeService,
        private llm: LLMService,
        private cordis: CordisOrchestratorService,
        private herdr: HerdrAdapterService,
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
            this.tabs.delete(tab)
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

    get sseUrl (): string | null {
        return this.activePort ? `http://127.0.0.1:${this.activePort}/sse` : null
    }

    get accessToken (): string | null {
        return this.token
    }

    get startupError (): string | null {
        return this.startError
    }

    get clientError (): string | null {
        return this.clientInstallError
    }

    get mcpServerScriptPath (): string {
        return this.installedMcpServerScriptPath ?? path.join(process.cwd(), 'issh-agent', 'bin', 'issh-mcp-server.mjs')
    }

    get codexConfigSnippet (): string {
        const lines = [
            '[mcp_servers.issh]',
            'command = "node"',
            `args = [${this.quoteToml(this.mcpServerScriptPath)}]`,
        ]
        const discoveryFile = this.getDiscoveryFileForSnippet()
        if (discoveryFile) {
            lines.push('', '[mcp_servers.issh.env]', `ISSH_AGENT_BRIDGE_FILE = ${this.quoteToml(discoveryFile)}`)
        }
        return lines.join('\n')
    }

    get codexDesktopConfigFields (): CodexDesktopConfigFields {
        return buildCodexDesktopConfigFields(this.mcpServerScriptPath, this.getDiscoveryFileForSnippet())
    }

    get codexDesktopConfigGuide (): string {
        return formatCodexDesktopConfigGuide(this.codexDesktopConfigFields)
    }

    get cursorConfigSnippet (): string {
        return JSON.stringify({
            mcpServers: {
                issh: {
                    command: 'node',
                    args: [this.mcpServerScriptPath],
                    env: this.getCursorConfigEnv(),
                },
            },
        }, null, 2)
    }

    get agentRulesTemplate (): string {
        return [
            '# issh Agent Rules',
            '- Use the issh MCP tools for terminal state instead of guessing from stale chat context.',
            '- Call issh_preview_command before issh_run_command or issh_exec_command when a command may be destructive.',
            '- For dangerous commands, issh will show a native confirmation dialog; do not rely on confirmDangerous alone.',
            '- Do not request terminal context or buffer contents while issh reports sensitive input is active.',
            '- Prefer issh_exec_command for non-interactive SSH checks; use issh_run_command only when the user needs an interactive terminal command.',
            '- Keep SFTP writes scoped to paths the user named or clearly approved.',
            '- Prefer a single active session for batch_exec; all-ssh requires extra confirmation.',
        ].join('\n')
    }

    get claudeDesktopConfigSnippet (): string {
        const url = this.sseUrl ?? 'http://127.0.0.1:<port>/sse'
        return JSON.stringify({
            mcpServers: {
                issh: {
                    type: 'sse',
                    url,
                    headers: { Authorization: `Bearer ${this.token ?? '<token>'}` },
                },
            },
        }, null, 2)
    }

    async rotateToken (): Promise<void> {
        this.token = this.createToken()
        this.config.store.llm.agentBridgeToken = this.token
        this.config.store.llm.agentBridgeTokenScopes = ['read']
        await this.config.save()
        if (this.activePort) {
            this.writeConnectionFile('127.0.0.1', this.activePort)
        }
        this.emitStatus()
    }

    async testConnection (): Promise<void> {
        const port = this.activePort
        const token = this.token
        const connectionFile = this.connectionFilePath
        const cliScript = this.installedMcpServerScriptPath
            ? path.join(path.dirname(this.installedMcpServerScriptPath), 'issh-agent.mjs')
            : null
        if (!port || !token || !connectionFile) {
            throw new Error('Agent bridge is not listening yet')
        }
        if (this.clientInstallError || !cliScript || !fs.existsSync(cliScript)) {
            throw new Error(this.clientInstallError ?? 'Agent Bridge CLI client is not installed')
        }
        await new Promise<void>((resolve, reject) => {
            const body = JSON.stringify({ id: Date.now(), method: 'issh_health', params: {} })
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
        await this.testCliClient(cliScript, connectionFile)
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
        const sseClients = [...this.sseClients.values()]
        this.sseClients.clear()
        for (const client of sseClients) {
            void client.server.close().catch(error => {
                this.logger.warn('Agent bridge SSE session close failed', error)
            })
        }
        this.outputCache.clear()
        if (server?.listening) {
            server.close()
        }
        this.removeConnectionFile()
        this.emitStatus()
    }

    private writeConnectionFile (host: string, port: number): void {
        const configPath = this.platform.getConfigPath()
        const configDir = configPath ? path.dirname(configPath) : process.env.ISSH_CONFIG_DIRECTORY
        if (!configDir) {
            this.logger.warn('Agent bridge connection file skipped: no config directory')
            return
        }
        this.installAgentBridgeScripts(configDir)
        this.connectionFilePath = path.join(configDir, CONNECTION_FILE_NAME)
        const legacyConnectionFilePath = path.join(configDir, LEGACY_CONNECTION_FILE_NAME)
        const previousPublicConnectionFilePath = this.publicConnectionFilePath
        const nextPublicConnectionFilePath = this.getPublicConnectionFilePath()
        if (previousPublicConnectionFilePath && previousPublicConnectionFilePath !== nextPublicConnectionFilePath) {
            this.removeFile(previousPublicConnectionFilePath, 'previous public discovery file')
        }
        this.publicConnectionFilePath = nextPublicConnectionFilePath
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
            fs.writeFileSync(this.connectionFilePath, JSON.stringify(payload, null, 2), {
                encoding: 'utf8',
                mode: 0o600,
            })
            this.restrictFilePermissions(this.connectionFilePath)
            this.removeFile(legacyConnectionFilePath, 'legacy connection file')
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
            this.removeFile(file, 'connection file')
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
            fs.writeFileSync(this.publicConnectionFilePath, JSON.stringify(payload, null, 2), {
                encoding: 'utf8',
                mode: 0o600,
            })
            this.restrictFilePermissions(this.publicConnectionFilePath)
        } catch (error) {
            this.logger.warn('Agent bridge public discovery file write failed', error)
            this.publicConnectionFilePath = null
        }
    }

    private getPublicConnectionFilePath (): string | null {
        if (this.config.store.llm.agentBridgePublicDiscoveryEnabled !== true) {
            return null
        }
        const configured = this.getString(this.config.store.llm.agentBridgePublicDiscoveryFile)
            ?? this.getString(process.env.ISSH_AGENT_BRIDGE_PUBLIC_FILE)
        return configured ?? this.getDefaultPublicConnectionFilePath()
    }

    private getDefaultPublicConnectionFilePath (): string | null {
        const configPath = this.platform.getConfigPath()
        const configDir = configPath ? path.dirname(configPath) : process.env.ISSH_CONFIG_DIRECTORY
        if (!configDir) {
            return null
        }
        return path.join(configDir, 'agent-bridge-public.json')
    }

    private getCursorConfigEnv (): Record<string, string> | undefined {
        const discoveryFile = this.getDiscoveryFileForSnippet()
        return discoveryFile ? { ISSH_AGENT_BRIDGE_FILE: discoveryFile } : undefined
    }

    private getDiscoveryFileForSnippet (): string | null {
        if (this.config.store.llm.agentBridgePublicDiscoveryEnabled === true) {
            return this.publicConnectionFilePath ?? this.getPublicConnectionFilePath()
        }
        return this.connectionFilePath ?? this.getPrivateConnectionFilePath()
    }

    private getPrivateConnectionFilePath (): string | null {
        const configPath = this.platform.getConfigPath()
        const configDir = configPath ? path.dirname(configPath) : process.env.ISSH_CONFIG_DIRECTORY
        return configDir ? path.join(configDir, CONNECTION_FILE_NAME) : null
    }

    private installAgentBridgeScripts (configDir: string): void {
        const targetDir = path.join(configDir, 'agent-bridge')
        const sourceDir = this.findAgentBridgePackage()
        this.installedMcpServerScriptPath = null
        this.clientInstallError = null
        if (!sourceDir) {
            this.clientInstallError = 'Bundled Agent Bridge CLI package was not found'
            this.logger.warn(this.clientInstallError)
            return
        }
        try {
            const runtimeFiles = [
                'package.json',
                path.join('bin', 'issh-agent.mjs'),
                path.join('bin', 'issh-mcp-server.mjs'),
                path.join('bin', 'tabby-agent.mjs'),
                path.join('bin', 'tabby-mcp-server.mjs'),
                path.join('src', 'client.mjs'),
                path.join('src', 'cli.mjs'),
                path.join('src', 'mcp-server.mjs'),
                path.join('src', 'protocol.js'),
            ]
            for (const relativePath of runtimeFiles) {
                const source = path.join(sourceDir, relativePath)
                if (!fs.existsSync(source)) {
                    throw new Error(`Agent Bridge client file is missing: ${relativePath}`)
                }
                const target = path.join(targetDir, relativePath)
                fs.mkdirSync(path.dirname(target), { recursive: true })
                fs.copyFileSync(source, target)
            }
            const installedPath = path.join(targetDir, 'bin', 'issh-mcp-server.mjs')
            if (!fs.existsSync(installedPath)) {
                throw new Error('Agent Bridge MCP client installation did not produce an executable script')
            }
            this.installedMcpServerScriptPath = installedPath
        } catch (error) {
            this.installedMcpServerScriptPath = null
            this.clientInstallError = error instanceof Error ? error.message : String(error)
            this.logger.warn('Agent bridge script install failed', error)
        }
    }

    private findAgentBridgePackage (): string | null {
        const resourcesPath = (process as any).resourcesPath
        const candidates = [
            path.join(process.cwd(), 'issh-agent'),
            resourcesPath ? path.join(resourcesPath, 'issh-agent') : null,
            resourcesPath ? path.join(resourcesPath, 'app.asar', 'issh-agent') : null,
            resourcesPath ? path.join(resourcesPath, 'app', 'issh-agent') : null,
            path.join(path.dirname(process.execPath), 'resources', 'issh-agent'),
            path.join(path.dirname(process.execPath), 'resources', 'app.asar', 'issh-agent'),
            resourcesPath ? path.join(resourcesPath, 'tabby-agent') : null,
            resourcesPath ? path.join(resourcesPath, 'app.asar', 'tabby-agent') : null,
            resourcesPath ? path.join(resourcesPath, 'app', 'tabby-agent') : null,
            path.join(path.dirname(process.execPath), 'resources', 'tabby-agent'),
            path.join(path.dirname(process.execPath), 'resources', 'app.asar', 'tabby-agent'),
        ]
        for (const candidate of candidates) {
            if (candidate && fs.existsSync(path.join(candidate, 'package.json'))) {
                return candidate
            }
        }
        return null
    }

    private testCliClient (cliScript: string, connectionFile: string): Promise<void> {
        return new Promise((resolve, reject) => {
            execFile('node', [
                cliScript,
                'health',
                '--json',
                '--bridge-file',
                connectionFile,
            ], {
                timeout: 5000,
                windowsHide: true,
            }, (error, stdout) => {
                if (error) {
                    reject(new Error(`Agent Bridge CLI check failed: ${error.message}`))
                    return
                }
                try {
                    const result = JSON.parse(stdout)
                    if (result?.ok !== true) {
                        reject(new Error('Agent Bridge CLI health response was invalid'))
                        return
                    }
                    resolve()
                } catch (parseError) {
                    reject(new Error(`Agent Bridge CLI returned invalid JSON: ${parseError instanceof Error ? parseError.message : String(parseError)}`))
                }
            })
        })
    }

    private restrictFilePermissions (file: string): void {
        try {
            fs.chmodSync(file, 0o600)
        } catch (error) {
            this.logger.warn('Agent bridge could not restrict file permissions: %s', file, error)
        }
    }

    private removeFile (file: string, description: string): void {
        try {
            if (fs.existsSync(file)) {
                fs.unlinkSync(file)
            }
        } catch (error) {
            this.logger.warn('Agent bridge %s removal failed: %s', description, file, error)
        }
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
        const url = new URL(request.url ?? '/', `http://127.0.0.1:${this.activePort ?? 0}`)
        const sseEnabled = this.config.store.llm.agentBridgeSseEnabled ?? true
        if (sseEnabled && request.method === 'GET' && url.pathname === '/sse') {
            if (!this.isAuthorized(request)) {
                this.writeJson(response, 401, { error: 'Unauthorized' })
                return
            }
            await this.handleSseConnect(response)
            return
        }
        if (sseEnabled && request.method === 'POST' && url.pathname === '/messages') {
            if (!this.isAuthorized(request)) {
                this.writeJson(response, 401, { error: 'Unauthorized' })
                return
            }
            const sessionId = url.searchParams.get('sessionId') ?? ''
            await this.handleSseMessage(request, response, sessionId)
            return
        }
        if (request.method !== 'POST' || url.pathname !== '/rpc') {
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

    private async handleSseConnect (response: http.ServerResponse): Promise<void> {
        const transport = new SSEServerTransport('/messages', response)
        const server = this.createMcpServer()
        const client: SseClient = {
            id: transport.sessionId,
            server,
            transport,
            createdAt: Date.now(),
        }
        this.sseClients.set(client.id, client)
        server.onclose = () => {
            this.sseClients.delete(client.id)
        }
        server.onerror = error => {
            this.logger.warn('Agent bridge MCP SSE server error', error)
        }
        try {
            await server.connect(transport)
        } catch (error) {
            this.sseClients.delete(client.id)
            await server.close().catch(() => undefined)
            if (!response.headersSent) {
                this.writeJson(response, 500, { error: 'Failed to establish MCP SSE session' })
            }
            this.logger.warn('Agent bridge MCP SSE session failed to start', error)
        }
    }

    private async handleSseMessage (request: http.IncomingMessage, response: http.ServerResponse, sessionId: string): Promise<void> {
        const client = this.sseClients.get(sessionId)
        if (!client) {
            this.writeJson(response, 404, { error: 'SSE session not found' })
            return
        }
        try {
            await client.transport.handlePostMessage(request, response)
        } catch (error) {
            this.logger.warn('Agent bridge MCP SSE message failed', error)
        }
    }

    private createMcpServer (): Server {
        const server = new Server(
            { name: 'issh-agent-bridge', version: AGENT_BRIDGE_PROTOCOL_VERSION },
            { capabilities: { tools: {} } },
        )
        server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: MCP_TOOLS }))
        server.setRequestHandler(CallToolRequestSchema, async request => {
            const name = normalizeAgentBridgeMethod(request.params.name)
            const args = request.params.arguments ?? {}
            const rpcResponse = await this.handleRpc({
                id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                method: name,
                params: args,
            })
            if (rpcResponse.error) {
                return {
                    content: [{
                        type: 'text',
                        text: JSON.stringify({
                            error: rpcResponse.error.message,
                            code: rpcResponse.error.code,
                            details: rpcResponse.error.details,
                        }, null, 2),
                    }],
                    isError: true,
                }
            }
            return {
                content: [{ type: 'text', text: JSON.stringify(rpcResponse.result, null, 2) }],
                isError: this.isRejectedRpcResult(rpcResponse.result, name),
            }
        })
        return server
    }

    private isAuthorized (request: http.IncomingMessage): boolean {
        const authorization = request.headers.authorization ?? ''
        if (!this.token || !authorization.startsWith('Bearer ')) {
            return false
        }
        const supplied = Buffer.from(authorization.slice('Bearer '.length))
        const expected = Buffer.from(this.token)
        return supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected)
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
        const normalizedRequest = {
            ...request,
            method: normalizeAgentBridgeMethod(request.method),
        }
        if (request.method && request.method !== normalizedRequest.method) {
            this.logger.warn(`Deprecated Agent Bridge method ${request.method}; use ${normalizedRequest.method}`)
        }
        let rpcResponse: RpcResponse
        try {
            this.ensureScopesMigrated()
            this.assertMethodScope(normalizedRequest.method)
            this.assertRequiredRpcParams(normalizedRequest.method, normalizedRequest.params ?? {})
            this.syncRegisteredTabs()
            switch (normalizedRequest.method) {
                case 'issh_health':
                    rpcResponse = { id, result: this.health() }
                    break
                case 'issh_list_sessions':
                    rpcResponse = { id, result: this.listSessions() }
                    break
                case 'issh_runtime_health':
                    rpcResponse = { id, result: await this.runtime.call('runtime.health') }
                    break
                case 'issh_workspace_list':
                    rpcResponse = { id, result: await this.callWorkspaceRuntime('workspace.list') }
                    break
                case 'issh_workspace_create':
                    rpcResponse = { id, result: await this.callWorkspaceRuntime('workspace.create', normalizedRequest.params ?? {}) }
                    break
                case 'issh_workspace_bind':
                    rpcResponse = { id, result: await this.callWorkspaceRuntime('workspace.bind', normalizedRequest.params ?? {}) }
                    break
                case 'issh_workspace_unbind':
                    rpcResponse = { id, result: await this.callWorkspaceRuntime('workspace.unbind', normalizedRequest.params ?? {}) }
                    break
                case 'issh_agent_register':
                    rpcResponse = { id, result: await this.registerWorkspaceAgent(normalizedRequest.params ?? {}) }
                    break
                case 'issh_agent_list':
                    rpcResponse = { id, result: await this.listWorkspaceAgents(normalizedRequest.params ?? {}) }
                    break
                case 'issh_agent_prompt':
                    rpcResponse = { id, result: await this.promptWorkspaceAgent(normalizedRequest.params ?? {}) }
                    break
                case 'issh_task_wait':
                    rpcResponse = { id, result: await this.waitWorkspaceTask(normalizedRequest.params ?? {}) }
                    break
                case 'issh_task_read':
                    rpcResponse = { id, result: await this.runtime.call('task.read', normalizedRequest.params ?? {}) }
                    break
                case 'issh_task_list':
                    rpcResponse = { id, result: await this.listWorkspaceTasks(normalizedRequest.params ?? {}) }
                    break
                case 'issh_task_cancel':
                    rpcResponse = { id, result: await this.cancelWorkspaceTask(normalizedRequest.params ?? {}) }
                    break
                case 'issh_workspace_events':
                    rpcResponse = { id, result: await this.runtime.call('event.list', normalizedRequest.params ?? {}) }
                    break
                case 'issh_cordis_health':
                    rpcResponse = { id, result: this.cordis.health() }
                    break
                case 'issh_agent_dispatch':
                    rpcResponse = { id, result: await this.dispatchWorkspaceAgents(normalizedRequest.params ?? {}) }
                    break
                case 'issh_run_wait':
                    rpcResponse = { id, result: await this.waitWorkspaceRun(normalizedRequest.params ?? {}) }
                    break
                case 'issh_run_collect':
                    rpcResponse = { id, result: await this.collectWorkspaceRun(normalizedRequest.params ?? {}) }
                    break
                case 'issh_run_cancel':
                    rpcResponse = { id, result: await this.cancelWorkspaceRun(normalizedRequest.params ?? {}) }
                    break
                case 'issh_task_run_command':
                    rpcResponse = { id, result: await this.runWorkspaceTaskCommand(normalizedRequest.params ?? {}) }
                    break
                case 'issh_herdr_status':
                    rpcResponse = { id, result: await this.herdr.status() }
                    break
                case 'issh_herdr_start':
                    rpcResponse = { id, result: await this.herdr.start() }
                    break
                case 'issh_herdr_stop':
                    rpcResponse = { id, result: await this.herdr.stop() }
                    break
                case 'issh_herdr_snapshot':
                    rpcResponse = { id, result: await this.herdr.snapshot() }
                    break
                case 'issh_herdr_link':
                    rpcResponse = { id, result: await this.linkHerdrWorkspace(normalizedRequest.params ?? {}) }
                    break
                case 'issh_herdr_unlink':
                    rpcResponse = { id, result: await this.unlinkHerdrWorkspace(normalizedRequest.params ?? {}) }
                    break
                case 'issh_herdr_sync':
                    rpcResponse = { id, result: await this.syncHerdrWorkspace(normalizedRequest.params ?? {}) }
                    break
                case 'issh_list_profiles':
                    rpcResponse = { id, result: await this.listProfiles() }
                    break
                case 'issh_connect_profile':
                    rpcResponse = { id, result: await this.connectProfile(normalizedRequest.params ?? {}) }
                    break
                case 'issh_disconnect_session':
                    rpcResponse = { id, result: await this.disconnectSession(normalizedRequest.params ?? {}) }
                    break
                case 'issh_get_context':
                    rpcResponse = { id, result: await this.getContext(normalizedRequest.params ?? {}) }
                    break
                case 'issh_read_buffer':
                    rpcResponse = { id, result: this.readBuffer(normalizedRequest.params ?? {}) }
                    break
                case 'issh_select_session':
                    rpcResponse = { id, result: this.selectSession(normalizedRequest.params ?? {}) }
                    break
                case 'issh_preview_command':
                    rpcResponse = { id, result: this.previewCommand(normalizedRequest.params ?? {}) }
                    break
                case 'issh_insert_command':
                    rpcResponse = { id, result: await this.insertCommand(normalizedRequest.params ?? {}, false) }
                    break
                case 'issh_run_command':
                    rpcResponse = { id, result: await this.insertCommand(normalizedRequest.params ?? {}, true) }
                    break
                case 'issh_exec_command':
                    rpcResponse = { id, result: await this.execCommand(normalizedRequest.params ?? {}) }
                    break
                case 'issh_get_output':
                    rpcResponse = { id, result: this.getOutput(normalizedRequest.params ?? {}) }
                    break
                case 'issh_batch_exec':
                    rpcResponse = { id, result: await this.batchExec(normalizedRequest.params ?? {}) }
                    break
                case 'issh_sftp_list':
                    rpcResponse = { id, result: await this.sftpList(normalizedRequest.params ?? {}) }
                    break
                case 'issh_sftp_read':
                    rpcResponse = { id, result: await this.sftpRead(normalizedRequest.params ?? {}) }
                    break
                case 'issh_sftp_write':
                    rpcResponse = { id, result: await this.sftpWrite(normalizedRequest.params ?? {}) }
                    break
                default:
                    rpcResponse = this.error(id, 'method_not_found', `Unknown method: ${request.method ?? ''}`)
            }
        } catch (error: any) {
            rpcResponse = this.error(
                id,
                error?.code === 'forbidden'
                    ? 'forbidden'
                    : error?.code === 'invalid_params' ? 'invalid_params' : 'request_failed',
                error instanceof Error ? error.message : String(error),
            )
        }
        this.writeAuditEntry(normalizedRequest, rpcResponse)
        return rpcResponse
    }

    private error (id: string | number | undefined, code: string, message: string, details?: any): RpcResponse {
        return { id, error: { code, message, details } }
    }

    private assertRequiredRpcParams (method: string | undefined, params: RpcParams): void {
        const commandMethods = new Set([
            'issh_preview_command',
            'issh_insert_command',
            'issh_run_command',
            'issh_exec_command',
            'issh_batch_exec',
        ])
        if (!commandMethods.has(method ?? '')) {
            const requiredTextParams: Record<string, string[]> = {
                issh_workspace_create: ['name'],
                issh_workspace_bind: ['workspaceId', 'sessionId'],
                issh_workspace_unbind: ['workspaceId', 'sessionId'],
                issh_agent_register: ['workspaceId', 'name'],
                issh_agent_list: ['workspaceId'],
                issh_agent_prompt: ['agentId', 'prompt'],
                issh_task_wait: ['taskId'],
                issh_task_read: ['taskId'],
                issh_task_list: ['workspaceId'],
                issh_task_cancel: ['taskId'],
                issh_workspace_events: ['workspaceId'],
                issh_agent_dispatch: ['workspaceId', 'prompt'],
                issh_run_wait: ['runId'],
                issh_run_collect: ['runId'],
                issh_run_cancel: ['runId'],
                issh_task_run_command: ['taskId', 'command'],
                issh_herdr_link: ['workspaceId', 'herdrWorkspaceId'],
                issh_herdr_unlink: ['workspaceId'],
                issh_herdr_sync: ['workspaceId'],
            }
            for (const name of requiredTextParams[method ?? ''] ?? []) {
                if (typeof params[name] !== 'string' || !params[name].trim()) {
                    const error: any = new Error(`The ${name} argument is required and must be a non-empty string.`)
                    error.code = 'invalid_params'
                    throw error
                }
            }
            return
        }
        if (typeof params.command !== 'string' || !params.command.trim()) {
            const error: any = new Error('The command argument is required and must be a non-empty string.')
            error.code = 'invalid_params'
            throw error
        }
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

    listSessions (): any[] {
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

    private async callWorkspaceRuntime (method: string, params?: RpcParams): Promise<any> {
        const sessions = this.listSessions().map(session => ({
            ...session,
            title: String(session.title ?? ''),
            port: this.normalizeRuntimePort(session.port),
        }))
        await this.runtime.call('session.sync', { sessions })
        return this.runtime.call(method, params)
    }

    getRuntimeHealth (): Promise<any> {
        return this.runtime.call('runtime.health')
    }

    getWorkspaces (): Promise<any[]> {
        return this.callWorkspaceRuntime('workspace.list')
    }

    createWorkspace (name: string): Promise<any> {
        return this.callWorkspaceRuntime('workspace.create', { name })
    }

    bindWorkspaceSession (workspaceId: string, sessionId: string): Promise<any> {
        return this.callWorkspaceRuntime('workspace.bind', { workspaceId, sessionId })
    }

    unbindWorkspaceSession (workspaceId: string, sessionId: string): Promise<any> {
        return this.callWorkspaceRuntime('workspace.unbind', { workspaceId, sessionId })
    }

    registerWorkspaceAgent (params: RpcParams): Promise<any> {
        return this.callWorkspaceRuntime('agent.register', {
            workspaceId: params.workspaceId,
            name: params.name,
            adapter: 'llm',
            sessionId: params.sessionId ?? null,
            scopes: params.scopes,
        })
    }

    listWorkspaceAgents (params: RpcParams): Promise<any[]> {
        return this.callWorkspaceRuntime('agent.list', { workspaceId: params.workspaceId })
    }

    async promptWorkspaceAgent (params: RpcParams): Promise<any> {
        const task = await this.callWorkspaceRuntime('task.prompt', {
            agentId: params.agentId,
            prompt: params.prompt,
        })
        void this.executeWorkspaceTask(task).catch(error => {
            this.logger.error(`Workspace task ${task.id} execution failed`, error)
        })
        return task
    }

    async waitWorkspaceTask (params: RpcParams): Promise<any> {
        const timeoutMs = this.getDuration(params.timeoutMs, 60000)
        const startedAt = Date.now()
        while (true) {
            const result = await this.runtime.call<any>('task.wait', { taskId: params.taskId })
            if (result.terminal) {
                return { ...result, timedOut: false }
            }
            if (Date.now() - startedAt >= timeoutMs) {
                return { ...result, timedOut: true }
            }
            await this.sleep(Math.min(result.retryAfterMs ?? 250, 1000))
        }
    }

    listWorkspaceTasks (params: RpcParams): Promise<any[]> {
        return this.runtime.call('task.list', { workspaceId: params.workspaceId })
    }

    async cancelWorkspaceTask (params: RpcParams): Promise<any> {
        this.llm.cancelAgentPrompt(String(params.taskId))
        return this.runtime.call('task.cancel', { taskId: params.taskId })
    }

    listWorkspaceEvents (workspaceId: string, afterSequence = 0, limit = 100): Promise<any[]> {
        return this.runtime.call('event.list', { workspaceId, afterSequence, limit })
    }

    getCordisHealth (): any {
        return this.cordis.health()
    }

    getHerdrStatus (): Promise<any> {
        return this.herdr.status()
    }

    startHerdr (): Promise<any> {
        return this.herdr.start()
    }

    stopHerdr (): Promise<any> {
        return this.herdr.stop()
    }

    async getHerdrSnapshot (): Promise<any> {
        return this.herdr.remoteSnapshot(await this.herdr.snapshot())
    }

    async linkHerdrWorkspace (params: RpcParams): Promise<any> {
        const workspaceId = String(params.workspaceId ?? '').trim()
        const herdrWorkspaceId = String(params.herdrWorkspaceId ?? '').trim()
        const workspaces = await this.getWorkspaces()
        if (!workspaces.some(workspace => workspace.id === workspaceId)) {
            throw new Error(`Workspace not found: ${workspaceId}`)
        }
        const snapshot = await this.getHerdrSnapshot()
        if (!snapshot?.workspaces?.some((workspace: any) => workspace.workspace_id === herdrWorkspaceId)) {
            throw new Error(`Herdr Workspace not found: ${herdrWorkspaceId}`)
        }
        await this.herdr.linkWorkspace(workspaceId, herdrWorkspaceId)
        return { workspaceId, herdrWorkspaceId, linked: true }
    }

    async unlinkHerdrWorkspace (params: RpcParams): Promise<any> {
        const workspaceId = String(params.workspaceId ?? '').trim()
        await this.herdr.unlinkWorkspace(workspaceId)
        return { workspaceId, linked: false }
    }

    async syncHerdrWorkspace (params: RpcParams): Promise<any> {
        const workspaceId = String(params.workspaceId ?? '').trim()
        const workspaces = await this.getWorkspaces()
        const workspace = workspaces.find(item => item.id === workspaceId)
        if (!workspace) {
            throw new Error(`Workspace not found: ${workspaceId}`)
        }
        const [agents, tasks] = await Promise.all([
            this.listWorkspaceAgents({ workspaceId }),
            this.listWorkspaceTasks({ workspaceId }),
        ])
        const result = await this.herdr.syncWorkspace(workspace, agents, tasks)
        return {
            workspaceId,
            herdrWorkspaceId: this.herdr.linkedWorkspaceId(workspaceId),
            synced: true,
            result,
        }
    }

    linkedHerdrWorkspaceId (workspaceId: string): string | null {
        return this.herdr.linkedWorkspaceId(workspaceId)
    }

    getWorkspaceRuns (workspaceId: string): any[] {
        return this.cordis.list(workspaceId)
    }

    async dispatchWorkspaceAgents (params: RpcParams): Promise<any> {
        const workspaceId = String(params.workspaceId ?? '')
        const prompt = String(params.prompt ?? '').trim()
        const agentIds = Array.isArray(params.agentIds)
            ? [...new Set(params.agentIds.map((id: any) => String(id).trim()).filter(Boolean))]
            : []
        if (!agentIds.length || agentIds.length > 16) {
            throw new Error('agentIds must contain 1-16 unique agents')
        }
        if (!prompt || prompt.length > 16000) {
            throw new Error('prompt must contain 1-16000 characters')
        }

        const agents = await this.callWorkspaceRuntime('agent.list', { workspaceId }) as any[]
        for (const agentId of agentIds) {
            const agent = agents.find(item => item.id === agentId)
            if (!agent) {
                throw new Error(`Agent ${agentId} does not belong to Workspace ${workspaceId}`)
            }
        }
        const tasks = await Promise.all(agentIds.map(agentId => this.runtime.call<any>('task.prompt', {
            agentId,
            prompt,
        })))
        const runId = `run-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`
        const run = this.cordis.start(
            runId,
            workspaceId,
            tasks.map(task => task.id),
            async taskId => {
                const task = tasks.find(candidate => candidate.id === taskId)
                if (task) {
                    await this.executeWorkspaceTask(task)
                }
            },
            async taskId => {
                this.llm.cancelAgentPrompt(taskId)
                await this.runtime.call('task.cancel', { taskId })
            },
        )
        return { run, tasks }
    }

    async collectWorkspaceRun (params: RpcParams): Promise<any> {
        const runId = String(params.runId ?? '')
        const run = this.cordis.get(runId)
        if (!run) {
            throw new Error(`Cordis run not found: ${runId}`)
        }
        const tasks = await Promise.all(run.taskIds.map(taskId => this.runtime.call('task.read', { taskId })))
        return { run, tasks }
    }

    async waitWorkspaceRun (params: RpcParams): Promise<any> {
        const timeoutMs = this.getDuration(params.timeoutMs, 60000)
        const startedAt = Date.now()
        while (true) {
            const result = await this.collectWorkspaceRun(params)
            if (result.run.status !== 'running') {
                return { ...result, timedOut: false }
            }
            if (Date.now() - startedAt >= timeoutMs) {
                return { ...result, timedOut: true }
            }
            await this.sleep(250)
        }
    }

    async cancelWorkspaceRun (params: RpcParams): Promise<any> {
        const run = await this.cordis.cancel(String(params.runId ?? ''))
        return this.collectWorkspaceRun({ runId: run.id })
    }

    async runWorkspaceTaskCommand (params: RpcParams): Promise<any> {
        const task = await this.runtime.call<any>('task.read', { taskId: params.taskId })
        const agent = await this.runtime.call<any>('agent.authorize', {
            agentId: task.agentId,
            scope: 'command.execute',
        })
        if (!agent.sessionId) {
            throw new Error('Agent has no bound terminal session')
        }
        const command = String(params.command ?? '').trim()
        if (!task.output || !task.output.includes(command)) {
            throw new Error('Command must be present in the persisted task result')
        }
        const preview = this.previewCommand({ command })
        if (params.execute !== true) {
            return { taskId: task.id, tabId: agent.sessionId, preview, executed: false }
        }
        return this.execCommand({
            tab: agent.sessionId,
            command,
            confirmDangerous: true,
        })
    }

    private async executeWorkspaceTask (task: any): Promise<void> {
        try {
            await this.runtime.call('task.start', { taskId: task.id })
            const agents = await this.runtime.call<any[]>('agent.list', { workspaceId: task.workspaceId })
            const agent = agents.find(item => item.id === task.agentId)
            const context = agent ? await this.collectAgentPromptContext(agent) : undefined
            const output = await this.llm.runAgentPrompt(task.id, task.prompt, context)
            await this.runtime.call('task.complete', { taskId: task.id, output })
        } catch (error) {
            await this.runtime.call('task.fail', {
                taskId: task.id,
                error: error instanceof Error ? error.message : String(error),
            }).catch(() => {})
            throw error
        }
    }

    private async collectAgentPromptContext (agent: any): Promise<AgentPromptContext | undefined> {
        const allowCommandProposals = !!agent.scopes?.includes('command.propose')
        if (!agent.sessionId || !agent.scopes?.includes('context.read')) {
            return { allowCommandProposals }
        }
        let entry: RegisteredTab
        try {
            entry = this.resolveTab(agent.sessionId)
        } catch {
            return { allowCommandProposals }
        }
        this.assertNotSensitive(entry.tab)
        const context = await this.context.collectContext(entry.tab)
        return {
            title: entry.tab.title,
            cwd: context.cwd,
            shell: context.shell,
            os: context.os,
            recentOutput: this.config.store.llm.sendContextToCloud
                ? this.guard.redactLines(context.recentOutput)
                : undefined,
            allowCommandProposals,
        }
    }

    private normalizeRuntimePort (value: any): number | null {
        const port = Number(value)
        return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null
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
        const timeoutMs = this.getDuration(params.timeoutMs, 15000)
        const startedAt = Date.now()
        await this.profiles.launchProfile(profile)
        const entry = await this.waitForProfileSession(profile, before, timeoutMs)
        if (entry) {
            this.selectSession({ tab: entry.id })
            const remainingMs = Math.max(0, timeoutMs - (Date.now() - startedAt))
            await this.waitForConnectedSession(entry, remainingMs)
        }
        const connected = !!entry && this.isConnected(entry.tab)
        return {
            connected,
            timedOut: !connected,
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

    selectSession (params: RpcParams): any {
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
            wouldExecute: !danger.dangerous,
            requiresUserConfirmation: danger.dangerous,
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
                approvedBy: approval.approvedBy,
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
            approvedBy: approval.approvedBy,
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
            approvedBy: approval.approvedBy,
            ...this.getTabMetadata(entry.tab),
        }
        if (!approval.allowed) {
            return {
                ...baseResult,
                executed: false,
                timedOut: false,
                stdout: '',
                outputId: null,
                stdoutTruncated: false,
                outputTotalSize: 0,
                reason: approval.reason,
                message: approval.message,
            }
        }

        const timeoutMs = this.getDuration(params.timeoutMs, this.getDefaultExecTimeoutMs())
        const cwd = typeof params.cwd === 'string' ? params.cwd.trim() : ''
        const sshResult = await this.trySshExec(entry, normalized, timeoutMs, cwd)
        if (sshResult) {
            return this.maybeTruncateOutput({
                ...baseResult,
                executed: true,
                mode: 'ssh-exec',
                stdout: sshResult.stdout,
                exitCode: sshResult.exitCode,
                timedOut: sshResult.timedOut,
            }, entry.id, command)
        }
        const localResult = await this.tryLocalExec(entry, normalized, timeoutMs, cwd)
        if (localResult) {
            return this.maybeTruncateOutput({
                ...baseResult,
                executed: true,
                mode: 'local-exec',
                stdout: localResult.stdout,
                exitCode: localResult.exitCode,
                timedOut: localResult.timedOut,
            }, entry.id, command)
        }
        const ptyResult = await this.execViaPty(entry, normalized, timeoutMs)
        return this.maybeTruncateOutput({
            ...baseResult,
            executed: true,
            mode: 'pty',
            stdout: ptyResult.stdout,
            exitCode: null,
            timedOut: ptyResult.timedOut,
        }, entry.id, command)
    }

    private maybeTruncateOutput (result: any, tabId: string, command: string): any {
        const stdout = result.stdout ?? ''
        if (stdout.length <= OUTPUT_TRUNCATE_THRESHOLD) {
            return { ...result, outputId: null, stdoutTruncated: false, outputTotalSize: stdout.length }
        }
        const outputId = this.storeOutput(tabId, command, stdout)
        return {
            ...result,
            stdout: stdout.slice(0, OUTPUT_TRUNCATE_THRESHOLD),
            outputId,
            stdoutTruncated: true,
            outputTotalSize: stdout.length,
        }
    }

    private storeOutput (tabId: string, command: string, stdout: string): string {
        this.pruneOutputCache()
        const outputId = `out-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
        this.outputCache.set(outputId, { outputId, tabId, command, stdout, createdAt: Date.now() })
        return outputId
    }

    private getOutput (params: RpcParams): any {
        const outputId = String(params.outputId ?? '')
        if (!outputId) {
            throw new Error('Missing outputId')
        }
        const cached = this.outputCache.get(outputId)
        if (!cached) {
            throw new Error(`Output not found or expired: ${outputId}`)
        }
        const offset = Math.max(0, Number(params.offset ?? 0))
        const limit = Math.min(65536, Math.max(1, Number(params.limit ?? 8000)))
        const content = cached.stdout.slice(offset, offset + limit)
        return {
            outputId,
            offset,
            limit,
            content,
            contentSize: content.length,
            totalSize: cached.stdout.length,
            hasMore: offset + limit < cached.stdout.length,
            command: cached.command,
            tabId: cached.tabId,
        }
    }

    private pruneOutputCache (): void {
        const now = Date.now()
        for (const [key, entry] of this.outputCache) {
            if (now - entry.createdAt > OUTPUT_MAX_AGE_MS) {
                this.outputCache.delete(key)
            }
        }
        while (this.outputCache.size > OUTPUT_MAX_ENTRIES) {
            const oldest = [...this.outputCache.values()].sort((a, b) => a.createdAt - b.createdAt)[0]
            if (oldest) {
                this.outputCache.delete(oldest.outputId)
            } else {
                break
            }
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

    private async tryLocalExec (
        entry: RegisteredTab,
        command: string,
        timeoutMs: number,
        cwd: string,
    ): Promise<{ stdout: string, exitCode: number | null, timedOut: boolean } | null> {
        if (entry.tab.profile?.type !== 'local') {
            return null
        }

        const options = (entry.tab.profile as any)?.options ?? {}
        const configuredCommand = String(options.command ?? '').trim()
        const shellType = this.detectLocalShellType(options)
        if (!shellType) {
            return null
        }
        const executable = configuredCommand || (
            shellType === 'cmd'
                ? (process.env.ComSpec ?? 'cmd.exe')
                : shellType === 'powershell'
                    ? 'powershell.exe'
                    : (process.env.SHELL ?? '/bin/sh')
        )
        const args = this.getLocalExecArgs(executable, shellType, options.args, command)
        const sessionCwd = await entry.tab.session?.getWorkingDirectory() ?? null
        const executionCwd = cwd || sessionCwd || (typeof options.cwd === 'string' ? options.cwd : '') || undefined
        const environment = {
            ...process.env,
            ...(this.config.store.terminal?.environment ?? {}),
            ...(options.env ?? {}),
        }
        delete environment.__nonStructural

        return new Promise((resolve, reject) => {
            execFile(executable, args, {
                cwd: executionCwd,
                env: environment,
                encoding: 'utf8',
                maxBuffer: 64 * 1024 * 1024,
                timeout: timeoutMs,
                windowsHide: true,
                windowsVerbatimArguments: shellType === 'cmd',
            }, (error, stdout, stderr) => {
                const timedOut = !!error?.killed
                if (error && typeof error.code !== 'number' && !timedOut) {
                    reject(new Error(`Local command execution failed: ${error.message}`))
                    return
                }
                const standardOutput = String(stdout ?? '')
                const standardError = String(stderr ?? '')
                const separator = standardOutput && standardError && !standardOutput.endsWith('\n') ? '\n' : ''
                resolve({
                    stdout: `${standardOutput}${separator}${standardError}`,
                    exitCode: typeof error?.code === 'number' ? error.code : error ? null : 0,
                    timedOut,
                })
            })
        })
    }

    private detectLocalShellType (options: any): 'cmd' | 'powershell' | 'unix' | null {
        if (options.shellType === 'cmd' || options.shellType === 'powershell' || options.shellType === 'unix') {
            return options.shellType
        }
        const command = String(options.command ?? '')
        if (!command) {
            return process.platform === 'win32'
                ? 'cmd'
                : 'unix'
        }
        if (/(?:^|[\\/])(?:powershell|pwsh)(?:\.exe)?$/i.test(command)) {
            return 'powershell'
        }
        if (/(?:^|[\\/])cmd(?:\.exe)?$/i.test(command)) {
            return 'cmd'
        }
        if (/(?:^|[\\/])(?:ba|z|da)?sh(?:\.exe)?$/i.test(command)
            || /(?:^|[\\/])fish(?:\.exe)?$/i.test(command)
            || /(?:^|[\\/])wsl(?:\.exe)?$/i.test(command)) {
            return 'unix'
        }
        return null
    }

    private getLocalExecArgs (
        executable: string,
        shellType: 'cmd' | 'powershell' | 'unix',
        configuredArgs: unknown,
        command: string,
    ): string[] {
        if (shellType === 'cmd') {
            return ['/d', '/s', '/c', command]
        }
        if (shellType === 'powershell') {
            return ['-NoLogo', '-NonInteractive', '-Command', command]
        }
        const args = Array.isArray(configuredArgs)
            ? configuredArgs.filter(arg => typeof arg === 'string' && !/^(?:-i|--interactive)$/.test(arg))
            : []
        if (/(?:^|[\\/])wsl(?:\.exe)?$/i.test(executable)) {
            return [...args, '--exec', 'sh', '-lc', command]
        }
        return [...args, '-lc', command]
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
        const tabRefs = params.tabs === undefined || params.tabs === null || params.tabs === ''
            ? 'active'
            : params.tabs
        const targets = this.resolveBatchTargets(tabRefs)
        if (tabRefs === 'all-ssh' || (Array.isArray(tabRefs) && tabRefs.length > 1) || targets.length > 1) {
            const confirmed = await this.platform.showMessageBox({
                type: 'warning',
                message: 'Run batch command on multiple sessions?',
                detail: `Targets: ${targets.length}\nCommand: ${command}`,
                buttons: ['Run', 'Cancel'],
                defaultId: 1,
                cancelId: 1,
            })
            if (confirmed.response !== 0) {
                return {
                    command,
                    count: 0,
                    results: [],
                    cancelled: true,
                    reason: 'user_cancelled_batch',
                }
            }
        }
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
        const remotePath = await this.resolveSftpPath(sftp, params.path, '.', false)
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
        const remotePath = await this.resolveSftpPath(sftp, params.path, '', false)
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
        const remotePath = await this.resolveSftpPath(sftp, params.path, '', true)
        const content = String(params.content ?? '')
        const buffer = Buffer.from(content, params.encoding === 'base64' ? 'base64' : 'utf8')
        const maxBytes = this.getSftpMaxWriteBytes()
        if (buffer.length > maxBytes) {
            throw new Error(`SFTP write exceeds maxBytes=${maxBytes}`)
        }
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
            approved: true,
            approvedBy: 'auto',
        }
    }

    private async ensureCommandExecutionAllowed (entry: RegisteredTab, command: string, params: RpcParams): Promise<AgentCommandApproval> {
        const danger = this.guard.isDangerous(command)
        if (!danger.dangerous) {
            return { allowed: true, dangerous: false, approved: true, approvedBy: 'auto' }
        }
        const agentRequested = params.confirmDangerous === true
        const result = await this.platform.showMessageBox({
            type: 'warning',
            message: 'Dangerous command requires confirmation',
            detail: [
                `Session: ${entry.id}`,
                `Reason: ${danger.reason ?? 'dangerous'}`,
                agentRequested ? 'Agent requested confirmation.' : 'Agent did not set confirmDangerous.',
                '',
                command,
            ].join('\n'),
            buttons: ['Allow once', 'Deny'],
            defaultId: 1,
            cancelId: 1,
        })
        const allowed = result.response === 0
        return {
            allowed,
            dangerous: true,
            dangerReason: danger.reason,
            approved: allowed,
            approvedBy: allowed ? 'user' : 'denied',
            reason: allowed ? undefined : 'confirmation_required',
            message: allowed ? undefined : 'Dangerous command denied by issh user confirmation',
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
            throw new Error('Command was rejected by issh command validation')
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

    private async waitForConnectedSession (entry: RegisteredTab, timeoutMs: number): Promise<void> {
        const startedAt = Date.now()
        while (!this.isConnected(entry.tab) && Date.now() - startedAt < timeoutMs) {
            await this.sleep(250)
        }
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
        if (remotePath.split('/').includes('..')) {
            throw new Error('Path traversal is not allowed')
        }
        const root = this.getString(this.config.store.llm.agentBridgeSftpRoot)
        if (root) {
            const normalizedRoot = path.posix.normalize(root)
            const candidate = path.posix.normalize(remotePath.startsWith('/')
                ? remotePath
                : path.posix.join(normalizedRoot, remotePath))
            if (!this.isPathWithinRoot(candidate, normalizedRoot)) {
                throw new Error(`Path must be under agentBridgeSftpRoot (${normalizedRoot})`)
            }
            return candidate
        }
        return path.posix.normalize(remotePath)
    }

    private async resolveSftpPath (sftp: any, value: any, fallback: string, forWrite: boolean): Promise<string> {
        const candidate = this.getRemotePath(value, fallback)
        const configuredRoot = this.getString(this.config.store.llm.agentBridgeSftpRoot)
        if (!configuredRoot) {
            return candidate
        }

        const canonicalize = typeof sftp.canonicalize === 'function'
            ? sftp.canonicalize.bind(sftp)
            : typeof sftp.realpath === 'function'
                ? sftp.realpath.bind(sftp)
                : null
        if (!canonicalize) {
            return candidate
        }

        const canonicalRoot = path.posix.normalize(String(await canonicalize(path.posix.normalize(configuredRoot))))
        let canonicalCandidate: string
        if (forWrite) {
            try {
                canonicalCandidate = path.posix.normalize(String(await canonicalize(candidate)))
            } catch {
                const parent = path.posix.dirname(candidate)
                const canonicalParent = path.posix.normalize(String(await canonicalize(parent)))
                canonicalCandidate = path.posix.join(canonicalParent, path.posix.basename(candidate))
            }
        } else {
            canonicalCandidate = path.posix.normalize(String(await canonicalize(candidate)))
        }
        if (!this.isPathWithinRoot(canonicalCandidate, canonicalRoot)) {
            throw new Error(`Resolved path escapes agentBridgeSftpRoot (${canonicalRoot})`)
        }
        return canonicalCandidate
    }

    private isPathWithinRoot (candidate: string, root: string): boolean {
        return candidate === root || candidate.startsWith(root.endsWith('/') ? root : `${root}/`)
    }

    private getSftpMaxWriteBytes (): number {
        const configured = Number(this.config.store.llm.agentBridgeSftpMaxWriteBytes ?? 1024 * 1024)
        if (!Number.isFinite(configured) || configured <= 0) {
            return 1024 * 1024
        }
        return Math.floor(configured)
    }

    private getProfileOption (tab: BaseTerminalTabComponent<any>, name: string): any {
        return (tab.profile as any)?.options?.[name] ?? null
    }

    private isConnected (tab: BaseTerminalTabComponent<any>): boolean {
        const sshSession = (tab as any).sshSession
        if (tab.profile?.type === 'ssh') {
            if (!sshSession || !tab.session) {
                return false
            }
            if (typeof sshSession.isConnected === 'boolean') {
                return sshSession.isConnected && !!tab.session.open
            }
            if (typeof sshSession.connected === 'boolean') {
                return sshSession.connected && !!tab.session.open
            }
            return !!sshSession.open && !!tab.session.open
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
        const parsed = Number(process.env.ISSH_AGENT_BRIDGE_PORT ?? configured ?? 0)
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
            // A token that predates scope storage is a genuine legacy token and
            // keeps its historical full access during one-time migration.
            this.ensureScopesMigrated()
            return stored
        }
        const token = this.createToken()
        this.config.store.llm.agentBridgeToken = token
        this.config.store.llm.agentBridgeTokenScopes = ['read']
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
        const result = response.result
        const rejected = this.isRejectedRpcResult(result, request.method)
        const auditErrorMessage = response.error?.message ?? result?.message ?? result?.error ?? null
        const entry = {
            timestamp: new Date().toISOString(),
            method: request.method ?? null,
            ok: !response.error && !rejected,
            errorCode: response.error?.code ?? null,
            errorMessage: typeof auditErrorMessage === 'string' ? this.redactAuditValue(auditErrorMessage) : null,
            executed: typeof result?.executed === 'boolean' ? result.executed : null,
            approved: typeof result?.approved === 'boolean' ? result.approved : null,
            approvedBy: result?.approvedBy ?? null,
            reason: result?.reason ?? (rejected ? 'rejected' : null),
            params: this.redactAuditValue(request.params ?? {}),
        }
        try {
            const line = `${JSON.stringify(entry)}\n`
            this.rotateAuditLogIfNeeded(Buffer.byteLength(line, 'utf8'))
            fs.appendFileSync(this.auditLogFilePath, line, { encoding: 'utf8', mode: 0o600 })
            this.restrictFilePermissions(this.auditLogFilePath)
        } catch (error) {
            this.logger.warn('Agent bridge audit write failed', error)
        }
    }

    private rotateAuditLogIfNeeded (nextEntryBytes: number): void {
        if (!this.auditLogFilePath || !fs.existsSync(this.auditLogFilePath)) {
            return
        }
        if (fs.statSync(this.auditLogFilePath).size + nextEntryBytes <= AUDIT_LOG_MAX_BYTES) {
            return
        }
        const rotatedPath = `${this.auditLogFilePath}.1`
        if (fs.existsSync(rotatedPath)) {
            fs.unlinkSync(rotatedPath)
        }
        fs.renameSync(this.auditLogFilePath, rotatedPath)
        this.restrictFilePermissions(rotatedPath)
    }

    private isRejectedRpcResult (result: any, method?: string): boolean {
        if (!result || typeof result !== 'object') {
            return false
        }
        const executionMethod = method === 'issh_run_command'
            || method === 'issh_exec_command'
            || method === 'issh_batch_exec'
        if ((executionMethod && result.executed === false)
            || result.cancelled === true
            || result.approved === false
            || typeof result.error === 'string') {
            return true
        }
        if (Array.isArray(result.results)) {
            return result.results.some((item: any) => this.isRejectedRpcResult(item, 'issh_exec_command'))
        }
        return false
    }

    private redactAuditValue (value: any): any {
        if (typeof value === 'string') {
            return this.guard.redact(value)
        }
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
            if (lower === 'command' || lower === 'path' || lower === 'cwd') {
                result[key] = typeof item === 'string' ? this.guard.redact(item) : this.redactAuditValue(item)
                continue
            }
            result[key] = this.redactAuditValue(item)
        }
        return result
    }

    private ensureScopesMigrated (): void {
        const scopes = this.config.store.llm.agentBridgeTokenScopes
        if (Array.isArray(scopes)) {
            return
        }
        const hasToken = typeof this.config.store.llm.agentBridgeToken === 'string' && !!this.config.store.llm.agentBridgeToken.trim()
        if (hasToken) {
            this.config.store.llm.agentBridgeTokenScopes = [...ALL_SCOPES]
            void this.config.save()
            this.logger.info('Migrated legacy Agent Bridge token to full scopes; consider tightening scopes in settings')
            return
        }
        this.config.store.llm.agentBridgeTokenScopes = ['read']
    }

    private getTokenScopes (): AgentBridgeScope[] {
        this.ensureScopesMigrated()
        const scopes = this.config.store.llm.agentBridgeTokenScopes
        if (!Array.isArray(scopes) || !scopes.length) {
            return ['read']
        }
        return scopes.filter((scope): scope is AgentBridgeScope => ALL_SCOPES.includes(scope as AgentBridgeScope))
    }

    private assertMethodScope (method?: string): void {
        if (!method) {
            throw new Error('Missing RPC method')
        }
        const required = METHOD_SCOPES[method]
        if (!required) {
            throw new Error(`Unknown method: ${method}`)
        }
        if (!this.getTokenScopes().includes(required)) {
            const error: any = new Error(`Token scope '${required}' is required for ${method}`)
            error.code = 'forbidden'
            throw error
        }
    }

    readAuditLog (limit = 100, offset = 0, filter?: string): { entries: any[], total: number } {
        if (!this.auditLogFilePath || !fs.existsSync(this.auditLogFilePath)) {
            return { entries: [], total: 0 }
        }
        try {
            const raw = fs.readFileSync(this.auditLogFilePath, 'utf8')
            const lines = raw.split('\n').filter(line => line.trim())
            let parsed: any[] = []
            for (const line of lines) {
                try {
                    parsed.push(JSON.parse(line))
                } catch {
                    /* skip invalid lines */
                }
            }
            if (filter) {
                const lower = filter.toLowerCase()
                parsed = parsed.filter(entry =>
                    String(entry.method ?? '').toLowerCase().includes(lower) ||
                    String(entry.errorCode ?? '').toLowerCase().includes(lower) ||
                    String(entry.errorMessage ?? '').toLowerCase().includes(lower),
                )
            }
            const total = parsed.length
            const reversed = parsed.reverse()
            const page = reversed.slice(offset, offset + limit)
            return { entries: page, total }
        } catch (error) {
            this.logger.warn('Agent bridge audit read failed', error)
            return { entries: [], total: 0 }
        }
    }

    clearAuditLog (): void {
        if (!this.auditLogFilePath) {
            return
        }
        try {
            fs.writeFileSync(this.auditLogFilePath, '', 'utf8')
        } catch (error) {
            this.logger.warn('Agent bridge audit clear failed', error)
        }
    }

    private emitStatus (): void {
        this.statusSubject.next()
    }

    private quoteToml (value: string): string {
        return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
    }
}
