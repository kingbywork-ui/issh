// A2（R-012）SSH config 导入：解析 OpenSSH ~/.ssh/config 文本，提取可导入的主机条目。
// 支持：Host（含别名/通配符）、HostName、User、Port、IdentityFile、ProxyJump。
// 不支持：Include、Match 条件块（解析时忽略并计数，不报错）。

export interface SshConfigHost {
    alias: string
    patterns: string[]
    hostName: string
    user: string | null
    port: number | null
    identityFiles: string[]
    proxyJump: string | null
    hasWildcard: boolean
}

export interface SshConfigParseResult {
    hosts: SshConfigHost[]
    ignored: number
    matchSections: number
}

interface Block {
    patterns: string[]
    fields: Map<string, string[]>
}

function tokenize (line: string): string[] {
    const tokens: string[] = []
    let index = 0
    while (index < line.length) {
        while (index < line.length && (line[index] === ' ' || line[index] === '\t')) index += 1
        if (index >= line.length) break
        if (line[index] === '#') break
        if (line[index] === '"') {
            index += 1
            let value = ''
            while (index < line.length && line[index] !== '"') { value += line[index]; index += 1 }
            index += 1
            tokens.push(value)
            continue
        }
        let value = ''
        while (index < line.length && line[index] !== ' ' && line[index] !== '\t' && line[index] !== '#') { value += line[index]; index += 1 }
        tokens.push(value)
    }
    return tokens
}

function hasWildcard (pattern: string): boolean {
    return pattern.includes('*') || pattern.includes('?') || pattern.startsWith('!')
}

export function parseSshConfig (text: string): SshConfigParseResult {
    const blocks: Block[] = []
    let current: Block | null = null
    let ignored = 0
    let matchSections = 0
    let inMatch = false

    for (const raw of text.split(/\r?\n/)) {
        const tokens = tokenize(raw)
        if (tokens.length === 0) continue
        const keyword = tokens[0].toLowerCase()
        const value = tokens.slice(1)

        if (keyword === 'host') {
            inMatch = false
            if (value.length > 0) {
                current = { patterns: value, fields: new Map() }
                blocks.push(current)
            }
        } else if (keyword === 'match') {
            inMatch = true
            matchSections += 1
            current = null
        } else if (current && !inMatch) {
            const existing = current.fields.get(keyword) ?? []
            existing.push(value.join(' '))
            current.fields.set(keyword, existing)
        }
        // 其他关键字（Include、全局段、Match 内部）忽略
    }

    const hosts: SshConfigHost[] = []
    for (const block of blocks) {
        const first = block.patterns[0] ?? ''
        const wildcard = block.patterns.some(hasWildcard)
        if (wildcard) {
            ignored += 1
            continue
        }
        const hostName = block.fields.get('hostname')?.at(-1) ?? first
        const user = block.fields.get('user')?.at(-1) ?? null
        const portRaw = block.fields.get('port')?.at(-1)
        const port = portRaw && /^\d+$/.test(portRaw) ? Number(portRaw) : null
        const identityFiles = block.fields.get('identityfile') ?? []
        const proxyJump = block.fields.get('proxyjump')?.at(-1) ?? null
        hosts.push({ alias: first, patterns: block.patterns, hostName, user, port, identityFiles, proxyJump, hasWildcard: false })
    }

    return { hosts, ignored, matchSections }
}
