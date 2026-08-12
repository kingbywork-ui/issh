import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const MAX_RESPONSE_BYTES = 16 * 1024 * 1024
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])
const CONNECTION_FILE_NAME = 'issh-agent-bridge.json'
const LEGACY_CONNECTION_FILE_NAME = 'tabby-agent-bridge.json'
const warnedLegacyEnvironmentVariables = new Set()

function getEnvironmentVariable (primaryName, legacyName) {
    if (process.env[primaryName] !== undefined) {
        return process.env[primaryName]
    }
    const legacyValue = process.env[legacyName]
    if (legacyValue !== undefined && !warnedLegacyEnvironmentVariables.has(legacyName)) {
        warnedLegacyEnvironmentVariables.add(legacyName)
        process.stderr.write(`[deprecated] ${legacyName} is deprecated; use ${primaryName}.\n`)
    }
    return legacyValue
}

export function candidateConnectionFiles () {
    const explicitCandidates = []
    const primaryCandidates = []
    const legacyCandidates = []
    const bridgeFile = getEnvironmentVariable('ISSH_AGENT_BRIDGE_FILE', 'TABBY_AGENT_BRIDGE_FILE')
    if (bridgeFile) {
        explicitCandidates.push(bridgeFile)
    }
    const configDirectory = getEnvironmentVariable('ISSH_CONFIG_DIRECTORY', 'TABBY_CONFIG_DIRECTORY')
    if (configDirectory) {
        primaryCandidates.push(path.join(configDirectory, CONNECTION_FILE_NAME))
        legacyCandidates.push(path.join(configDirectory, LEGACY_CONNECTION_FILE_NAME))
    }
    const workspaceCandidates = workspaceConnectionFiles()
    primaryCandidates.push(...workspaceCandidates.primary)
    legacyCandidates.push(...workspaceCandidates.legacy)
    if (process.env.APPDATA) {
        primaryCandidates.push(path.join(process.env.APPDATA, 'issh', CONNECTION_FILE_NAME))
        legacyCandidates.push(path.join(process.env.APPDATA, 'issh', LEGACY_CONNECTION_FILE_NAME))
        legacyCandidates.push(path.join(process.env.APPDATA, 'Tabby', LEGACY_CONNECTION_FILE_NAME))
        legacyCandidates.push(path.join(process.env.APPDATA, 'tabby', LEGACY_CONNECTION_FILE_NAME))
    }
    if (process.env.LOCALAPPDATA) {
        primaryCandidates.push(path.join(process.env.LOCALAPPDATA, 'issh', CONNECTION_FILE_NAME))
        legacyCandidates.push(path.join(process.env.LOCALAPPDATA, 'issh', LEGACY_CONNECTION_FILE_NAME))
        legacyCandidates.push(path.join(process.env.LOCALAPPDATA, 'Tabby', LEGACY_CONNECTION_FILE_NAME))
    }
    primaryCandidates.push(path.join(os.homedir(), '.config', 'issh', CONNECTION_FILE_NAME))
    legacyCandidates.push(path.join(os.homedir(), '.config', 'issh', LEGACY_CONNECTION_FILE_NAME))
    legacyCandidates.push(path.join(os.homedir(), '.config', 'tabby', LEGACY_CONNECTION_FILE_NAME))
    legacyCandidates.push(path.join(os.homedir(), '.tabby', LEGACY_CONNECTION_FILE_NAME))
    return uniquePaths([...explicitCandidates, ...primaryCandidates, ...legacyCandidates])
}

export function loadConnection (bridgeFile = undefined) {
    const candidates = bridgeFile ? [bridgeFile] : candidateConnectionFiles()
    const failures = []
    for (const candidate of candidates) {
        if (!candidate) {
            continue
        }
        try {
            if (!fs.existsSync(candidate)) {
                continue
            }
            const connection = JSON.parse(fs.readFileSync(candidate, 'utf8').replace(/^\uFEFF/, ''))
            validateConnection(connection, candidate)
            return connection
        } catch (error) {
            failures.push(`${candidate}: ${error instanceof Error ? error.message : String(error)}`)
        }
    }
    const details = failures.length ? `\nUnreadable candidates:\n${failures.join('\n')}` : ''
    throw new Error(`issh Agent Bridge connection file not found. Tried:\n${candidates.join('\n')}${details}`)
}

export function rpc (connection, method, params = {}, timeoutMs = 10000) {
    const endpoint = getRpcEndpoint(connection)
    const body = JSON.stringify({ id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, method, params })
    return new Promise((resolve, reject) => {
        const request = http.request(endpoint, {
            method: 'POST',
            timeout: normalizeTimeout(timeoutMs),
            headers: {
                authorization: `Bearer ${connection.token}`,
                'content-type': 'application/json',
                'content-length': Buffer.byteLength(body),
            },
        }, response => {
            const chunks = []
            let totalBytes = 0
            response.on('data', chunk => {
                totalBytes += chunk.length
                if (totalBytes > MAX_RESPONSE_BYTES) {
                    request.destroy(new Error('issh Agent Bridge response exceeded 16 MiB'))
                    return
                }
                chunks.push(Buffer.from(chunk))
            })
            response.on('end', () => {
                try {
                    const text = Buffer.concat(chunks).toString('utf8')
                    const parsed = JSON.parse(text)
                    if (parsed.error) {
                        const error = new Error(parsed.error.message ?? String(parsed.error))
                        error.code = parsed.error.code
                        reject(error)
                        return
                    }
                    if ((response.statusCode ?? 500) >= 400) {
                        reject(new Error(`issh Agent Bridge returned HTTP ${response.statusCode}`))
                        return
                    }
                    resolve(parsed.result)
                } catch (error) {
                    reject(error)
                }
            })
        })
        request.on('timeout', () => request.destroy(new Error('issh Agent Bridge request timed out')))
        request.on('error', reject)
        request.end(body)
    })
}

function validateConnection (connection, source) {
    if (!connection || typeof connection !== 'object') {
        throw new Error(`Invalid connection file: ${source}`)
    }
    if (typeof connection.token !== 'string' || !connection.token.trim()) {
        throw new Error(`Connection file has no access token: ${source}`)
    }
    getRpcEndpoint(connection)
}

function getRpcEndpoint (connection) {
    const endpoint = connection.rpcUrl
        ? new URL(connection.rpcUrl)
        : new URL(`http://${connection.host ?? '127.0.0.1'}:${connection.port}/rpc`)
    if (endpoint.protocol !== 'http:') {
        throw new Error(`Unsupported Agent Bridge protocol: ${endpoint.protocol}`)
    }
    if (!LOOPBACK_HOSTS.has(endpoint.hostname)) {
        throw new Error(`Agent Bridge must use a loopback host, received: ${endpoint.hostname}`)
    }
    endpoint.pathname = '/rpc'
    endpoint.search = ''
    endpoint.hash = ''
    return endpoint
}

function normalizeTimeout (value) {
    const parsed = Number(value)
    if (!Number.isFinite(parsed) || parsed <= 0) {
        return 10000
    }
    return Math.min(Math.floor(parsed), 3600000)
}

function workspaceConnectionFiles () {
    const primary = []
    const legacy = []
    for (const start of [process.cwd(), path.dirname(fileURLToPath(import.meta.url))]) {
        let current = path.resolve(start)
        while (true) {
            primary.push(path.join(current, '.issh-agent-bridge.json'))
            legacy.push(path.join(current, '.tabby-agent-bridge.json'))
            const parent = path.dirname(current)
            if (parent === current) {
                break
            }
            current = parent
        }
    }
    return { primary, legacy }
}

function uniquePaths (values) {
    const seen = new Set()
    const result = []
    for (const value of values) {
        if (!value) {
            continue
        }
        const resolved = path.resolve(value)
        const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved
        if (!seen.has(key)) {
            seen.add(key)
            result.push(resolved)
        }
    }
    return result
}
