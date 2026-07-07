#!/usr/bin/env node
import { loadConnection, rpc } from './tabby-mcp-shared.mjs'

function usage () {
    console.log(`Usage:
  tabby-agent sessions
  tabby-agent profiles
  tabby-agent connect (--id <profile-id> | --name <profile-name>) [--timeout-ms 15000]
  tabby-agent disconnect [--tab active|tab-1]
  tabby-agent health
  tabby-agent context [--tab active|tab-1]
  tabby-agent read [--tab active|tab-1] [--lines 80]
  tabby-agent select [--tab active|tab-1]
  tabby-agent preview [--tab active|tab-1] -- <command>
  tabby-agent insert [--tab active|tab-1] -- <command>
  tabby-agent run [--tab active|tab-1] [--confirm-dangerous] -- <command>
  tabby-agent exec [--tab active|tab-1] [--timeout-ms 60000] [--cwd /path] [--confirm-dangerous] -- <command>
  tabby-agent batch-exec [--tabs all-ssh|tab-1,tab-2] [--serial] [--timeout-ms 60000] [--confirm-dangerous] -- <command>
  tabby-agent sftp-list [--tab active|tab-1] --path /remote/path
  tabby-agent sftp-read [--tab active|tab-1] --path /remote/file [--encoding utf8|base64] [--max-bytes 1048576]
  tabby-agent sftp-write [--tab active|tab-1] --path /remote/file [--encoding utf8|base64] -- <content>
  tabby-agent rag [--tab active|tab-1] [--limit 10] -- <query>

Options:
  --bridge-file <path>  Path to tabby-agent-bridge.json
  --json                Print raw JSON
`)
}

function parseArgs (argv) {
    const args = [...argv]
    const command = args.shift()
    const options = { tab: 'active', tabs: 'all-ssh', lines: 80, limit: 10, timeoutMs: 60000, maxBytes: 1024 * 1024, encoding: 'utf8', json: false, confirmDangerous: false, parallel: true }
    const positionals = []
    const capturesRemainder = new Set(['preview', 'insert', 'run', 'exec', 'batch-exec', 'sftp-write', 'rag'])
    for (let i = 0; i < args.length; i++) {
        const arg = args[i]
        if (arg === '--') {
            positionals.push(...args.slice(i + 1))
            break
        }
        if (capturesRemainder.has(command) && positionals.length > 0) {
            positionals.push(...args.slice(i))
            break
        }
        if (arg === '--tab') {
            options.tab = args[++i]
        } else if (arg === '--tabs') {
            options.tabs = args[++i]
        } else if (arg === '--lines') {
            options.lines = Number(args[++i])
        } else if (arg === '--limit') {
            options.limit = Number(args[++i])
        } else if (arg === '--timeout-ms') {
            options.timeoutMs = Number(args[++i])
        } else if (arg === '--cwd') {
            options.cwd = args[++i]
        } else if (arg === '--path') {
            options.path = args[++i]
        } else if (arg === '--id') {
            options.id = args[++i]
        } else if (arg === '--name') {
            options.name = args[++i]
        } else if (arg === '--encoding') {
            options.encoding = args[++i]
        } else if (arg === '--max-bytes') {
            options.maxBytes = Number(args[++i])
        } else if (arg === '--bridge-file') {
            options.bridgeFile = args[++i]
        } else if (arg === '--json') {
            options.json = true
        } else if (arg === '--confirm-dangerous') {
            options.confirmDangerous = true
        } else if (arg === '--serial') {
            options.parallel = false
        } else {
            positionals.push(arg)
        }
    }
    return { command, options, positionals }
}

function printResult (result, rawJson) {
    if (rawJson) {
        console.log(JSON.stringify(result, null, 2))
        return
    }
    if (Array.isArray(result)) {
        for (const item of result) {
            console.log(`${item.active ? '*' : ' '} ${item.id}\t${item.profileType ?? ''}\t${item.title ?? item.profileName ?? ''}`)
        }
        return
    }
    if (result?.lines) {
        console.log(result.lines.join('\n'))
        return
    }
    console.log(JSON.stringify(result, null, 2))
}

async function main () {
    const { command, options, positionals } = parseArgs(process.argv.slice(2))
    if (!command || command === 'help' || command === '--help') {
        usage()
        return
    }
    const connection = loadConnection(options.bridgeFile)
    const joined = positionals.join(' ').trim()
    const baseParams = { tab: options.tab }
    const tabs = options.tabs === 'all-ssh' ? 'all-ssh' : String(options.tabs).split(',').map(x => x.trim()).filter(Boolean)
    const calls = {
        health: ['tabby_health', {}],
        sessions: ['tabby_list_sessions', {}],
        profiles: ['tabby_list_profiles', {}],
        connect: ['tabby_connect_profile', { id: options.id, name: options.name, timeoutMs: options.timeoutMs }],
        disconnect: ['tabby_disconnect_session', baseParams],
        context: ['tabby_get_context', baseParams],
        read: ['tabby_read_buffer', { ...baseParams, lines: options.lines }],
        select: ['tabby_select_session', baseParams],
        preview: ['tabby_preview_command', { ...baseParams, command: joined }],
        insert: ['tabby_insert_command', { ...baseParams, command: joined }],
        run: ['tabby_run_command', { ...baseParams, command: joined, confirmDangerous: options.confirmDangerous }],
        exec: ['tabby_exec_command', { ...baseParams, command: joined, timeoutMs: options.timeoutMs, cwd: options.cwd, confirmDangerous: options.confirmDangerous }],
        'batch-exec': ['tabby_batch_exec', { tabs, command: joined, timeoutMs: options.timeoutMs, cwd: options.cwd, parallel: options.parallel, confirmDangerous: options.confirmDangerous }],
        'sftp-list': ['tabby_sftp_list', { ...baseParams, path: options.path }],
        'sftp-read': ['tabby_sftp_read', { ...baseParams, path: options.path, encoding: options.encoding, maxBytes: options.maxBytes }],
        'sftp-write': ['tabby_sftp_write', { ...baseParams, path: options.path, encoding: options.encoding, content: joined }],
        rag: ['tabby_search_rag', { ...baseParams, query: joined, limit: options.limit }],
    }
    const call = calls[command]
    if (!call) {
        throw new Error(`Unknown command: ${command}`)
    }
    const result = await rpc(connection, call[0], call[1], getRpcTimeout(command, options))
    printResult(result, options.json)
}

function getRpcTimeout (command, options) {
    if (command === 'health') {
        return 2000
    }
    if (command === 'exec' || command === 'batch-exec') {
        return Number(options.timeoutMs ?? 120000) + 5000
    }
    if (command === 'connect' || command?.startsWith('sftp-')) {
        return Number(options.timeoutMs ?? 30000)
    }
    return 10000
}

main().catch(error => {
    console.error(error.message)
    process.exitCode = 1
})
