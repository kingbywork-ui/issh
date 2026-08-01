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
    'ssh connecting',
    'ssh host key',
    'ssh ecdsa-',
    'ssh ssh-rsa',
    'ssh ed25519',
    'ssh ssh-ed25519',
    'last login:',
    'authorized users',
    'activate the web console',
    'current passwo',
    '@@issh_history_file@@',
]

const OUTPUT_PATTERNS = [
    /^(?:\[info|\[warn|\[error|\[debug)/i,
    /^(?:drwx|d---|lrwx|-rw|crw|brw)/,
    /^(?:\d{4}-\d{2}-\d{2}|\d{2}:\d{2}:\d{2})/,
    /^(?:directory|volume in drive|serial number is)/i,
    /^(?:bytes free|file\(s\)|dir\(s\))/i,
    /^(?:on branch|nothing to commit|your branch is)/i,
    /^SSH\s+(?:Connecting|Host key|ecdsa-|ssh-rsa|ED25519|ssh-ed25519)/i,
    /^Last login:/i,
    /^@@ISSH_HISTORY_FILE@@\b/i,
    /^Activate the web console\b/i,
    /^Authorized users only\b/i,
    /^Current\s+passwo/i,
    /^fingerprints?\b/i,
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
    // Flags, editor commands, or pure numbers are not executable names.
    if (token.startsWith('-') || token.startsWith(':') || /^\d+$/.test(token)) {
        return false
    }
    if (/^[([{]/.test(token)) {
        return false
    }
    if (/^[><=]+$/.test(token)) {
        return false
    }
    // Allow command names and common path forms, but not free-form @ markers.
    if (token.includes('@@')) {
        return false
    }
    return /^(?:[A-Za-z0-9_~.\\/]|[A-Za-z]:\\|%\w+%)[A-Za-z0-9_./~%:+\\-]*$/.test(token)
}

function shellWords (command: string): string[] {
    const words: string[] = []
    let current = ''
    let quote: '"' | "'" | null = null
    let escaped = false

    for (const char of command) {
        if (escaped) {
            current += char
            escaped = false
            continue
        }
        if (char === '\\') {
            escaped = true
            current += char
            continue
        }
        if (quote) {
            current += char
            if (char === quote) {
                quote = null
            }
            continue
        }
        if (char === '"' || char === "'") {
            quote = char
            current += char
            continue
        }
        if (/\s/.test(char)) {
            if (current) {
                words.push(current)
                current = ''
            }
            continue
        }
        current += char
    }

    if (current) {
        words.push(current)
    }
    return words
}

const DOCKER_COMPOSE_SUBCOMMANDS = new Set([
    'attach',
    'build',
    'config',
    'cp',
    'create',
    'down',
    'events',
    'exec',
    'images',
    'kill',
    'logs',
    'ls',
    'pause',
    'port',
    'ps',
    'pull',
    'push',
    'restart',
    'rm',
    'run',
    'scale',
    'start',
    'stats',
    'stop',
    'top',
    'unpause',
    'up',
    'version',
    'wait',
    'watch',
])

function looksLikeIncompleteShellCommand (command: string): boolean {
    return /(?:&&|\|\||[|;\\])\s*$/.test(command)
}

const DOCKER_COMPOSE_OPTIONS_WITH_VALUE = new Set([
    '-f',
    '--file',
    '-p',
    '--project-name',
    '--profile',
    '--env-file',
    '--project-directory',
    '--ansi',
    '--parallel',
    '--progress',
])

function dockerComposeSubcommand (words: string[], startIndex: number): string | null {
    for (let i = startIndex; i < words.length; i++) {
        const word = words[i]
        if (word.startsWith('-')) {
            if (DOCKER_COMPOSE_OPTIONS_WITH_VALUE.has(word)) {
                i++
            }
            continue
        }
        return word
    }
    return null
}

function looksLikeCorruptedDockerComposeCommand (command: string): boolean {
    const words = shellWords(command.toLowerCase())
        .filter(word => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word))

    if (!words.length) {
        return false
    }

    const [first, second] = words
    if (first === 'docker-compose') {
        const subcommand = dockerComposeSubcommand(words, 1)
        return !!subcommand && !DOCKER_COMPOSE_SUBCOMMANDS.has(subcommand)
    }
    if (first === 'docker' && second === 'compose') {
        const subcommand = dockerComposeSubcommand(words, 2)
        return !!subcommand && !DOCKER_COMPOSE_SUBCOMMANDS.has(subcommand)
    }

    const compactPrefix = `${first ?? ''} ${second ?? ''}`
    // Catches truncated typing like "doc composlogs" / "doc cker".
    return /^(?:do|doc|dock)\s+(?:comp|cker|compos)/.test(compactPrefix)
}

export function isLikelyCompleteCommand (command: string): boolean {
    if (looksLikeIncompleteShellCommand(command)) {
        return false
    }
    if (looksLikeCorruptedDockerComposeCommand(command)) {
        return false
    }
    return true
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
    if (!isLikelyCompleteCommand(normalized)) {
        return null
    }

    return normalized
}
