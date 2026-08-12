const AGENT_NAMES = new Set([
    'codex',
    'codex-cli',
    'hermes',
    'hermes-agent',
    'hermes-cli',
])

export function isKnownAgentProcess (command: string): boolean {
    const normalized = command.trim().toLowerCase()
    if (!normalized) {
        return false
    }

    if (/(?:^|[\\/])@openai[\\/]codex(?:[\\/]|$)/i.test(normalized)) {
        return true
    }

    const tokens = [normalized, ...normalized.split(/\s+/)]
    return tokens.some(token => {
        const unquoted = token.replace(/^["']|["',;]$/g, '')
        const basename = unquoted.split(/[\\/]/).pop() ?? ''
        const name = basename.replace(/\.(?:cmd|exe|js|mjs|cjs)$/i, '')
        return AGENT_NAMES.has(name)
    })
}
