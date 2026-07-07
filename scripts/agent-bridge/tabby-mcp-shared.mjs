import fs from 'fs'
import http from 'http'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'

export function candidateConnectionFiles () {
    const candidates = []
    if (process.env.TABBY_AGENT_BRIDGE_FILE) {
        candidates.push(process.env.TABBY_AGENT_BRIDGE_FILE)
    }
    if (process.env.TABBY_CONFIG_DIRECTORY) {
        candidates.push(path.join(process.env.TABBY_CONFIG_DIRECTORY, 'tabby-agent-bridge.json'))
    }
    candidates.push(...workspaceConnectionFiles())
    if (process.platform === 'win32') {
        candidates.push(path.join('C:\\tmp', 'tabby-agent-bridge.json'))
    }
    candidates.push(path.join(os.tmpdir(), 'tabby-agent-bridge.json'))
    if (process.env.APPDATA) {
        candidates.push(path.join(process.env.APPDATA, 'Tabby', 'tabby-agent-bridge.json'))
        candidates.push(path.join(process.env.APPDATA, 'tabby', 'tabby-agent-bridge.json'))
    }
    if (process.env.LOCALAPPDATA) {
        candidates.push(path.join(process.env.LOCALAPPDATA, 'Tabby', 'tabby-agent-bridge.json'))
        candidates.push(path.join(process.env.LOCALAPPDATA, 'tabby', 'tabby-agent-bridge.json'))
    }
    candidates.push(path.join(os.homedir(), '.tabby', 'tabby-agent-bridge.json'))
    return uniquePaths(candidates)
}

export function loadConnection (bridgeFile = undefined) {
    const candidates = bridgeFile ? [bridgeFile] : candidateConnectionFiles()
    const failures = []
    for (const candidate of candidates) {
        if (!candidate) {
            continue
        }
        try {
            if (fs.existsSync(candidate)) {
                return JSON.parse(fs.readFileSync(candidate, 'utf8').replace(/^\uFEFF/, ''))
            }
        } catch (error) {
            failures.push(`${candidate}: ${error instanceof Error ? error.message : String(error)}`)
        }
    }
    const details = failures.length ? `\nUnreadable candidates:\n${failures.join('\n')}` : ''
    throw new Error(`Tabby agent bridge file not found. Tried:\n${candidates.join('\n')}${details}`)
}

function workspaceConnectionFiles () {
    const candidates = []
    for (const start of [process.cwd(), path.dirname(fileURLToPath(import.meta.url))]) {
        let current = path.resolve(start)
        while (true) {
            candidates.push(path.join(current, '.tabby-agent-bridge.json'))
            const parent = path.dirname(current)
            if (parent === current) {
                break
            }
            current = parent
        }
    }
    return candidates
}

function uniquePaths (values) {
    const seen = new Set()
    const result = []
    for (const value of values) {
        if (!value) {
            continue
        }
        const key = path.resolve(value).toLowerCase()
        if (seen.has(key)) {
            continue
        }
        seen.add(key)
        result.push(value)
    }
    return result
}

export function rpc (connection, method, params, timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
        const body = JSON.stringify({ id: Date.now(), method, params })
        const request = http.request({
            host: connection.host,
            port: connection.port,
            path: '/rpc',
            method: 'POST',
            timeout: timeoutMs,
            headers: {
                authorization: `Bearer ${connection.token}`,
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
                    if (parsed.error) {
                        reject(new Error(parsed.error.message ?? String(parsed.error)))
                    } else {
                        resolve(parsed.result)
                    }
                } catch (error) {
                    reject(error)
                }
            })
        })
        request.on('timeout', () => {
            request.destroy(new Error('Tabby agent bridge request timed out'))
        })
        request.on('error', reject)
        request.write(body)
        request.end()
    })
}
