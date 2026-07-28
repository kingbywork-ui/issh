import { loadConnection, rpc } from './client.mjs'
import { AGENT_BRIDGE_PROTOCOL_VERSION, getMcpTools } from './protocol.js'

const MAX_MESSAGE_BYTES = 1024 * 1024

export async function handleMcpMessage (message) {
    if (!message || typeof message !== 'object') {
        return makeError(null, -32600, 'Invalid JSON-RPC request')
    }
    if (message.method === 'notifications/initialized' || message.method === 'notifications/cancelled') {
        return null
    }
    if (message.method === 'initialize') {
        return makeResult(message.id, {
            protocolVersion: message.params?.protocolVersion ?? '2024-11-05',
            capabilities: { tools: {} },
            serverInfo: {
                name: 'tabby-agent-bridge',
                version: AGENT_BRIDGE_PROTOCOL_VERSION,
            },
        })
    }
    if (message.method === 'ping') {
        return makeResult(message.id, {})
    }
    if (message.method === 'tools/list') {
        return makeResult(message.id, { tools: getMcpTools() })
    }
    if (message.method === 'tools/call') {
        const name = message.params?.name
        const args = message.params?.arguments ?? {}
        if (!getMcpTools().some(tool => tool.name === name)) {
            return makeError(message.id, -32601, `Unknown tool: ${name ?? ''}`)
        }
        try {
            const connection = loadConnection()
            const result = await rpc(connection, name, args, getRpcTimeout(name, args))
            return makeResult(message.id, {
                content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
                isError: isRejectedResult(result, name),
            })
        } catch (error) {
            return makeResult(message.id, {
                content: [{
                    type: 'text',
                    text: JSON.stringify({
                        error: error instanceof Error ? error.message : String(error),
                        code: error?.code,
                    }, null, 2),
                }],
                isError: true,
            })
        }
    }
    if (message.id === undefined) {
        return null
    }
    return makeError(message.id, -32601, `Unknown method: ${message.method ?? ''}`)
}

export function runMcpServer (input = process.stdin, output = process.stdout, errorOutput = process.stderr) {
    if (output.isTTY !== true && output._handle?.setBlocking) {
        output._handle.setBlocking(true)
    }
    let buffer = Buffer.alloc(0)
    const processBuffer = () => {
        while (true) {
            const newline = buffer.indexOf('\n')
            if (newline < 0) {
                if (buffer.length > MAX_MESSAGE_BYTES) {
                    errorOutput.write('MCP message exceeded 1 MiB\n')
                    buffer = Buffer.alloc(0)
                }
                return
            }
            const line = buffer.subarray(0, newline).toString('utf8').replace(/\r$/, '')
            buffer = buffer.subarray(newline + 1)
            if (!line.trim()) {
                continue
            }
            let message
            try {
                message = JSON.parse(line)
            } catch {
                writeMessage(output, makeError(null, -32700, 'Parse error'))
                continue
            }
            void handleMcpMessage(message)
                .then(response => {
                    if (response) {
                        writeMessage(output, response)
                    }
                })
                .catch(error => {
                    writeMessage(output, makeError(message.id ?? null, -32603, error instanceof Error ? error.message : String(error)))
                })
        }
    }
    input.on('data', chunk => {
        buffer = Buffer.concat([buffer, Buffer.from(chunk)])
        processBuffer()
    })
    input.on('error', error => {
        errorOutput.write(`${error instanceof Error ? error.message : String(error)}\n`)
    })
}

function writeMessage (output, message) {
    output.write(`${JSON.stringify(message)}\n`)
}

function makeResult (id, result) {
    return { jsonrpc: '2.0', id, result }
}

function makeError (id, code, message) {
    return { jsonrpc: '2.0', id, error: { code, message } }
}

function getRpcTimeout (name, args) {
    if (name === 'tabby_health') {
        return 2000
    }
    if (name === 'tabby_exec_command' || name === 'tabby_batch_exec') {
        return Number(args.timeoutMs ?? 60000) + 5000
    }
    if (name.startsWith('tabby_sftp_') || name === 'tabby_connect_profile') {
        return Math.max(Number(args.timeoutMs ?? 30000), 30000)
    }
    return 10000
}

function isRejectedResult (result, method) {
    if (!result || typeof result !== 'object') {
        return false
    }
    if ((['tabby_run_command', 'tabby_exec_command'].includes(method) && result.executed === false)
        || result.cancelled === true
        || result.approved === false
        || typeof result.error === 'string') {
        return true
    }
    return Array.isArray(result.results)
        ? result.results.some(item => isRejectedResult(item, 'tabby_exec_command'))
        : false
}
