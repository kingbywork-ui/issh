export interface NormalizedCommandOptions {
    allowMultiline?: boolean
}

const OUTPUT_PREFIXES = [
    'warning:',
    'error:',
    'failed:',
    'success:',
    'total ',
    'http/',
    'https://',
]

const OUTPUT_PATTERNS = [
    /^(?:\[info|\[warn|\[error|\[debug)/i,
    /^(?:drwx|d---|lrwx|-rw|crw|brw)/,
    /^(?:\d{4}-\d{2}-\d{2}|\d{2}:\d{2}:\d{2})/,
    /^(?:directory|volume in drive|serial number is)/i,
    /^(?:bytes free|file\(s\)|dir\(s\))/i,
    /^(?:on branch|nothing to commit|your branch is)/i,
]

function stripInlineComment (line: string): string {
    const hashIndex = line.indexOf(' #')
    return hashIndex >= 0 ? line.substring(0, hashIndex).trimEnd() : line.trimEnd()
}

function firstExecutableToken (command: string): string {
    const tokens = command.trim().split(/\s+/)
    for (const token of tokens) {
        if (!token) {
            continue
        }
        if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) {
            continue
        }
        return token
    }
    return ''
}

function looksLikeOutput (command: string): boolean {
    const lower = command.toLowerCase()
    if (OUTPUT_PREFIXES.some(prefix => lower.startsWith(prefix))) {
        return true
    }
    return OUTPUT_PATTERNS.some(pattern => pattern.test(command))
}

function looksLikeExecutableToken (token: string): boolean {
    if (!token) {
        return false
    }
    if (token === '&&' || token === '||' || token === '|') {
        return false
    }
    if (/^[([{]/.test(token)) {
        return false
    }
    if (/^[><=]+$/.test(token)) {
        return false
    }
    return /^[A-Za-z0-9_./~@%:+\\-]+$/.test(token)
}

export function normalizeCommand (input: string, options: NormalizedCommandOptions = {}): string | null {
    if (!input) {
        return null
    }

    let normalized = input
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n')
        .replace(/\t+/g, ' ')
        .trim()

    if (!normalized) {
        return null
    }

    if (!options.allowMultiline && normalized.includes('\n')) {
        return null
    }

    if (options.allowMultiline) {
        normalized = normalized
            .split('\n')
            .map(line => stripInlineComment(line).trim())
            .filter(Boolean)
            .join(' && ')
    } else {
        normalized = stripInlineComment(normalized)
    }

    normalized = normalized.replace(/\s{2,}/g, ' ').trim()
    if (!normalized || normalized.length < 2 || normalized.length > 500) {
        return null
    }

    if (/^[\s\-_=.+#%$>]+$/.test(normalized)) {
        return null
    }
    if (normalized.startsWith('[') || normalized.startsWith('---')) {
        return null
    }
    if (/^(?:PS(?: [^>]+)?>|\$|#|>|%)/.test(normalized)) {
        return null
    }
    if (looksLikeOutput(normalized)) {
        return null
    }

    const token = firstExecutableToken(normalized)
    if (!looksLikeExecutableToken(token)) {
        return null
    }

    return normalized
}
