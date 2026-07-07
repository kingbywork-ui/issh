#!/usr/bin/env node
import { rpc, loadConnection } from './tabby-mcp-shared.mjs'

// Cursor/MCP clients pipe stdio; disable block buffering so initialize replies immediately.
if (process.stdout.isTTY !== true && process.stdout._handle?.setBlocking) {
    process.stdout._handle.setBlocking(true)
}

const tools = [
    {
        name: 'tabby_health',
        description: 'Check whether the Tabby agent bridge is reachable and report basic bridge state.',
        inputSchema: { type: 'object', properties: {} },
    },
    {
        name: 'tabby_list_sessions',
        description: 'List terminal sessions currently registered in Tabby.',
        inputSchema: { type: 'object', properties: {} },
    },
    {
        name: 'tabby_list_profiles',
        description: 'List configured SSH profiles available for operations workflows.',
        inputSchema: { type: 'object', properties: {} },
    },
    {
        name: 'tabby_connect_profile',
        description: 'Open a new Tabby SSH session by profile id or profile name.',
        inputSchema: {
            type: 'object',
            properties: {
                id: { type: 'string', description: 'SSH profile id.' },
                name: { type: 'string', description: 'SSH profile name.' },
                timeoutMs: { type: 'number', description: 'How long to wait for the new session to appear.' },
            },
        },
    },
    {
        name: 'tabby_disconnect_session',
        description: 'Disconnect and close a Tabby terminal session by tab id.',
        inputSchema: {
            type: 'object',
            properties: { tab: { type: 'string', description: 'Tab id or active.' } },
        },
    },
    {
        name: 'tabby_get_context',
        description: 'Read cwd, shell, OS, partial command, and recent output from a Tabby terminal session.',
        inputSchema: {
            type: 'object',
            properties: { tab: { type: 'string', description: 'Tab id or active.' } },
        },
    },
    {
        name: 'tabby_read_buffer',
        description: 'Read recent terminal output lines from a Tabby terminal session.',
        inputSchema: {
            type: 'object',
            properties: {
                tab: { type: 'string', description: 'Tab id or active.' },
                lines: { type: 'number', description: 'Number of lines to read.' },
            },
        },
    },
    {
        name: 'tabby_select_session',
        description: 'Select a Tabby terminal session and make it active.',
        inputSchema: {
            type: 'object',
            properties: { tab: { type: 'string', description: 'Tab id or active.' } },
        },
    },
    {
        name: 'tabby_preview_command',
        description: 'Preview a command using Tabby normalization and dangerous-command checks.',
        inputSchema: {
            type: 'object',
            required: ['command'],
            properties: {
                tab: { type: 'string', description: 'Tab id or active.' },
                command: { type: 'string' },
                confirmDangerous: { type: 'boolean' },
            },
        },
    },
    {
        name: 'tabby_insert_command',
        description: 'Insert a shell command into a Tabby terminal session without pressing Enter.',
        inputSchema: {
            type: 'object',
            required: ['command'],
            properties: {
                tab: { type: 'string', description: 'Tab id or active.' },
                command: { type: 'string' },
            },
        },
    },
    {
        name: 'tabby_run_command',
        description: 'Inject an interactive shell command into a Tabby terminal session and press Enter. This does not wait for command output; prefer tabby_exec_command for operations work. Dangerous commands must be confirmed by the Agent with confirmDangerous=true.',
        inputSchema: {
            type: 'object',
            required: ['command'],
            properties: {
                tab: { type: 'string', description: 'Tab id or active.' },
                command: { type: 'string' },
                confirmDangerous: { type: 'boolean' },
            },
        },
    },
    {
        name: 'tabby_exec_command',
        description: 'Execute a command and wait for output. SSH sessions use a clean SSH exec channel and return stdout, exitCode, and timedOut; local sessions fall back to PTY polling. This is the preferred tool for operations workflows such as nginx, Docker, and deployment checks.',
        inputSchema: {
            type: 'object',
            required: ['command'],
            properties: {
                tab: { type: 'string', description: 'Tab id or active.' },
                command: { type: 'string' },
                timeoutMs: { type: 'number', description: 'Execution timeout in milliseconds.' },
                cwd: { type: 'string', description: 'Optional working directory for SSH exec sessions.' },
                confirmDangerous: { type: 'boolean' },
            },
        },
    },
    {
        name: 'tabby_batch_exec',
        description: 'Execute one command across multiple Tabby sessions. Use tabs=["tab-1","tab-2"] or tabs="all-ssh". Dangerous commands must be confirmed by the Agent with confirmDangerous=true.',
        inputSchema: {
            type: 'object',
            required: ['command'],
            properties: {
                tabs: {
                    oneOf: [
                        { type: 'array', items: { type: 'string' } },
                        { type: 'string' },
                    ],
                    description: 'Tab ids, active, or all-ssh.',
                },
                command: { type: 'string' },
                timeoutMs: { type: 'number' },
                cwd: { type: 'string' },
                parallel: { type: 'boolean' },
                confirmDangerous: { type: 'boolean' },
            },
        },
    },
    {
        name: 'tabby_sftp_list',
        description: 'List files in a directory over the selected SSH session SFTP channel.',
        inputSchema: {
            type: 'object',
            required: ['path'],
            properties: {
                tab: { type: 'string', description: 'Tab id or active.' },
                path: { type: 'string' },
            },
        },
    },
    {
        name: 'tabby_sftp_read',
        description: 'Read a remote file over SFTP. Text is returned as utf8 by default; use encoding=base64 for binary files.',
        inputSchema: {
            type: 'object',
            required: ['path'],
            properties: {
                tab: { type: 'string', description: 'Tab id or active.' },
                path: { type: 'string' },
                encoding: { type: 'string', enum: ['utf8', 'base64'] },
                maxBytes: { type: 'number' },
            },
        },
    },
    {
        name: 'tabby_sftp_write',
        description: 'Write a remote file over SFTP. Content is interpreted as utf8 by default; use encoding=base64 for binary files.',
        inputSchema: {
            type: 'object',
            required: ['path', 'content'],
            properties: {
                tab: { type: 'string', description: 'Tab id or active.' },
                path: { type: 'string' },
                content: { type: 'string' },
                encoding: { type: 'string', enum: ['utf8', 'base64'] },
            },
        },
    },
    {
        name: 'tabby_search_rag',
        description: 'Search the Tabby RAG command knowledge base.',
        inputSchema: {
            type: 'object',
            required: ['query'],
            properties: {
                tab: { type: 'string', description: 'Tab id or active.' },
                query: { type: 'string' },
                limit: { type: 'number' },
            },
        },
    },
]

let connection = null
let buffer = Buffer.alloc(0)

function send (message) {
    const body = Buffer.from(JSON.stringify(message), 'utf8')
    process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`)
    process.stdout.write(body)
}

function makeResult (id, result) {
    return { jsonrpc: '2.0', id, result }
}

function makeError (id, code, message) {
    return { jsonrpc: '2.0', id, error: { code, message } }
}

async function handleMessage (message) {
    if (!message.id && !message.method) {
        return
    }
    try {
        if (message.method === 'initialize') {
            connection = null
            send(makeResult(message.id, {
                protocolVersion: message.params?.protocolVersion ?? '2024-11-05',
                capabilities: { tools: {} },
                serverInfo: { name: 'tabby-agent-bridge', version: '0.1.0' },
            }))
            return
        }
        if (message.method === 'tools/list') {
            send(makeResult(message.id, { tools }))
            return
        }
        if (message.method === 'tools/call') {
            const name = message.params?.name
            const args = message.params?.arguments ?? {}
            if (!tools.some(tool => tool.name === name)) {
                send(makeError(message.id, -32601, `Unknown tool: ${name}`))
                return
            }
            connection = loadConnection()
            const timeoutMs = getRpcTimeout(name, args)
            const result = await rpc(connection, name, args, timeoutMs)
            send(makeResult(message.id, {
                content: [
                    { type: 'text', text: JSON.stringify(result, null, 2) },
                ],
            }))
            return
        }
        if (message.id) {
            send(makeError(message.id, -32601, `Unknown method: ${message.method}`))
        }
    } catch (error) {
        send(makeError(message.id, -32000, error instanceof Error ? error.message : String(error)))
    }
}

function getRpcTimeout (name, args) {
    if (name === 'tabby_health') {
        return 2000
    }
    if (name === 'tabby_exec_command' || name === 'tabby_batch_exec') {
        return Number(args.timeoutMs ?? 120000) + 5000
    }
    if (name.startsWith('tabby_sftp_') || name === 'tabby_connect_profile') {
        return Number(args.timeoutMs ?? 30000)
    }
    return 10000
}

function drain () {
    while (true) {
        const headerEnd = buffer.indexOf('\r\n\r\n')
        if (headerEnd < 0) {
            return
        }
        const header = buffer.slice(0, headerEnd).toString('utf8')
        const match = /Content-Length:\s*(\d+)/i.exec(header)
        if (!match) {
            buffer = buffer.slice(headerEnd + 4)
            continue
        }
        const length = Number(match[1])
        const bodyStart = headerEnd + 4
        const bodyEnd = bodyStart + length
        if (buffer.length < bodyEnd) {
            return
        }
        const body = buffer.slice(bodyStart, bodyEnd).toString('utf8')
        buffer = buffer.slice(bodyEnd)
        void handleMessage(JSON.parse(body))
    }
}

process.stdin.on('data', chunk => {
    buffer = Buffer.concat([buffer, chunk])
    drain()
})
