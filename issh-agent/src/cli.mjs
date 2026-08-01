import { loadConnection, rpc } from './client.mjs'

const COMMANDS_WITH_CONTENT = new Set(['preview', 'insert', 'run', 'exec', 'batch-exec', 'sftp-write'])

export function usage () {
    return `Usage:
  issh-agent health
  issh-agent sessions
  issh-agent profiles
  issh-agent connect (--id <profile-id> | --name <profile-name>) [--timeout-ms 15000]
  issh-agent disconnect [--tab active|tab-1]
  issh-agent context [--tab active|tab-1]
  issh-agent read [--tab active|tab-1] [--lines 80]
  issh-agent select [--tab active|tab-1]
  issh-agent preview [--tab active|tab-1] -- <command>
  issh-agent insert [--tab active|tab-1] -- <command>
  issh-agent run [--tab active|tab-1] [--confirm-dangerous] -- <command>
  issh-agent exec [--tab active|tab-1] [--timeout-ms 60000] [--cwd /path] [--confirm-dangerous] -- <command>
  issh-agent output --output-id <id> [--offset 0] [--limit 8000]
  issh-agent batch-exec [--tabs all-ssh|tab-1,tab-2] [--serial] [--timeout-ms 60000] -- <command>
  issh-agent sftp-list [--tab active|tab-1] --path /remote/path
  issh-agent sftp-read [--tab active|tab-1] --path /remote/file [--encoding utf8|base64] [--max-bytes 1048576]
  issh-agent sftp-write [--tab active|tab-1] --path /remote/file [--encoding utf8|base64] -- <content>

Options:
  --bridge-file <path>  Path to the Agent Bridge connection JSON file
  --json                Print JSON without friendly formatting
  --help                Show this help
`
}

export function parseAgentArgs (argv) {
    const args = [...argv]
    const command = args.shift()
    const options = {
        tab: 'active',
        tabs: 'active',
        lines: 80,
        timeoutMs: 60000,
        maxBytes: 1024 * 1024,
        encoding: 'utf8',
        offset: 0,
        limit: 8000,
        json: false,
        confirmDangerous: false,
        parallel: true,
    }
    if (command === '--help' || command === '-h') {
        options.help = true
        return { command: 'help', options, positionals: [] }
    }
    const positionals = []
    for (let index = 0; index < args.length; index++) {
        const arg = args[index]
        if (arg === '--') {
            positionals.push(...args.slice(index + 1))
            break
        }
        if (COMMANDS_WITH_CONTENT.has(command) && positionals.length) {
            positionals.push(...args.slice(index))
            break
        }
        switch (arg) {
            case '--tab': options.tab = requireValue(args, ++index, arg); break
            case '--tabs': options.tabs = requireValue(args, ++index, arg); break
            case '--lines': options.lines = numberValue(args, ++index, arg); break
            case '--timeout-ms': options.timeoutMs = numberValue(args, ++index, arg); break
            case '--cwd': options.cwd = requireValue(args, ++index, arg); break
            case '--path': options.path = requireValue(args, ++index, arg); break
            case '--id': options.id = requireValue(args, ++index, arg); break
            case '--name': options.name = requireValue(args, ++index, arg); break
            case '--encoding': options.encoding = requireValue(args, ++index, arg); break
            case '--max-bytes': options.maxBytes = numberValue(args, ++index, arg); break
            case '--output-id': options.outputId = requireValue(args, ++index, arg); break
            case '--offset': options.offset = numberValue(args, ++index, arg, true); break
            case '--limit': options.limit = numberValue(args, ++index, arg); break
            case '--bridge-file': options.bridgeFile = requireValue(args, ++index, arg); break
            case '--json': options.json = true; break
            case '--confirm-dangerous': options.confirmDangerous = true; break
            case '--serial': options.parallel = false; break
            case '--help':
            case '-h': options.help = true; break
            default:
                if (arg.startsWith('--')) {
                    throw new Error(`Unknown option: ${arg}`)
                }
                positionals.push(arg)
        }
    }
    return { command, options, positionals }
}

export function buildCall (command, options, positionals) {
    const content = positionals.join(' ').trim()
    const baseParams = { tab: options.tab }
    const tabs = options.tabs === 'all-ssh'
        ? 'all-ssh'
        : String(options.tabs).split(',').map(value => value.trim()).filter(Boolean)
    const calls = {
        health: ['issh_health', {}],
        sessions: ['issh_list_sessions', {}],
        profiles: ['issh_list_profiles', {}],
        connect: ['issh_connect_profile', compact({ id: options.id, name: options.name, timeoutMs: options.timeoutMs })],
        disconnect: ['issh_disconnect_session', baseParams],
        context: ['issh_get_context', baseParams],
        read: ['issh_read_buffer', { ...baseParams, lines: options.lines }],
        select: ['issh_select_session', baseParams],
        preview: ['issh_preview_command', { ...baseParams, command: content }],
        insert: ['issh_insert_command', { ...baseParams, command: content }],
        run: ['issh_run_command', { ...baseParams, command: content, confirmDangerous: options.confirmDangerous }],
        exec: ['issh_exec_command', compact({ ...baseParams, command: content, timeoutMs: options.timeoutMs, cwd: options.cwd, confirmDangerous: options.confirmDangerous })],
        output: ['issh_get_output', { outputId: options.outputId, offset: options.offset, limit: options.limit }],
        'batch-exec': ['issh_batch_exec', compact({ tabs: tabs.length === 1 ? tabs[0] : tabs, command: content, timeoutMs: options.timeoutMs, cwd: options.cwd, parallel: options.parallel, confirmDangerous: options.confirmDangerous })],
        'sftp-list': ['issh_sftp_list', { ...baseParams, path: options.path }],
        'sftp-read': ['issh_sftp_read', { ...baseParams, path: options.path, encoding: options.encoding, maxBytes: options.maxBytes }],
        'sftp-write': ['issh_sftp_write', { ...baseParams, path: options.path, encoding: options.encoding, content }],
    }
    const call = calls[command]
    if (!call) {
        throw new Error(`Unknown command: ${command ?? ''}`)
    }
    validateCall(command, call[1])
    return call
}

export async function main (argv = process.argv.slice(2), output = console) {
    const { command, options, positionals } = parseAgentArgs(argv)
    if (!command || command === 'help' || options.help) {
        output.log(usage())
        return
    }
    const [method, params] = buildCall(command, options, positionals)
    const connection = loadConnection(options.bridgeFile)
    const result = await rpc(connection, method, params, getRpcTimeout(command, options))
    printResult(result, options.json, output)
}

function validateCall (command, params) {
    if (COMMANDS_WITH_CONTENT.has(command) && !params.command && command !== 'sftp-write') {
        throw new Error(`${command} requires content after --`)
    }
    if (command === 'sftp-write' && params.content === '') {
        throw new Error('sftp-write requires content after --')
    }
    if (command === 'connect' && !params.id && !params.name) {
        throw new Error('connect requires --id or --name')
    }
    if (command === 'output' && !params.outputId) {
        throw new Error('output requires --output-id')
    }
    if (command.startsWith('sftp-') && !params.path) {
        throw new Error(`${command} requires --path`)
    }
    if (!['utf8', 'base64'].includes(params.encoding) && (command === 'sftp-read' || command === 'sftp-write')) {
        throw new Error('--encoding must be utf8 or base64')
    }
}

function printResult (result, rawJson, output) {
    if (rawJson) {
        output.log(JSON.stringify(result, null, 2))
        return
    }
    if (Array.isArray(result)) {
        for (const item of result) {
            output.log(`${item.active ? '*' : ' '} ${item.id ?? item.profileId ?? ''}\t${item.profileType ?? item.type ?? ''}\t${item.title ?? item.name ?? item.profileName ?? ''}`)
        }
        return
    }
    if (Array.isArray(result?.lines)) {
        output.log(result.lines.join('\n'))
        return
    }
    if (typeof result?.content === 'string' && result.outputId) {
        output.log(result.content)
        return
    }
    output.log(JSON.stringify(result, null, 2))
}

function getRpcTimeout (command, options) {
    if (command === 'health') {
        return 2000
    }
    if (command === 'exec' || command === 'batch-exec') {
        return Number(options.timeoutMs) + 5000
    }
    if (command === 'connect' || command?.startsWith('sftp-')) {
        return Math.max(Number(options.timeoutMs), 30000)
    }
    return 10000
}

function requireValue (args, index, option) {
    const value = args[index]
    if (value === undefined || value.startsWith('--')) {
        throw new Error(`${option} requires a value`)
    }
    return value
}

function numberValue (args, index, option, allowZero = false) {
    const raw = requireValue(args, index, option)
    const value = Number(raw)
    if (!Number.isFinite(value) || (allowZero ? value < 0 : value <= 0)) {
        throw new Error(`${option} requires ${allowZero ? 'a non-negative' : 'a positive'} number`)
    }
    return Math.floor(value)
}

function compact (value) {
    return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined))
}
