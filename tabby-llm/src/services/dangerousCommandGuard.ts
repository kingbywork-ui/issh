const DANGEROUS_PATTERNS: { pattern: RegExp, reason: string }[] = [
    { pattern: /\bdd\s+if=/i, reason: 'Direct disk write (dd)' },
    { pattern: /\bmkfs\b/i, reason: 'Filesystem format' },
    { pattern: /\b>:?\s*\/dev\/(sd|hd|nvme|vd)/i, reason: 'Write to block device' },
    { pattern: /\bchmod\s+(-R\s+)?777\b/i, reason: 'Overly permissive chmod' },
    { pattern: /\bchown\s+-R\s+.*\s+\/\s*$/i, reason: 'Recursive chown on root' },
    { pattern: /\b(curl|wget)\s+.*\|\s*(ba)?sh\b/i, reason: 'Pipe remote script to shell' },
    { pattern: /\b(bash|sh|zsh|dash)\s+<\s*\(/i, reason: 'Process-substitution shell input' },
    { pattern: /\bshutdown\b|\breboot\b|\bpoweroff\b|\bhalt\b/i, reason: 'System power control' },
    { pattern: /\bkill\s+-9\s+1\b|\bkillall\b/i, reason: 'Kill critical processes' },
    { pattern: /\bDROP\s+(DATABASE|TABLE)\b/i, reason: 'SQL destructive statement' },
    { pattern: /\bTRUNCATE\s+TABLE\b/i, reason: 'SQL truncate' },
    { pattern: /\bmkfs\.[a-z0-9]+\b/i, reason: 'Filesystem format utility' },
    { pattern: /\b:\(\)\s*\{\s*:\|:&\s*\}\s*;:/i, reason: 'Fork bomb' },
]

const REDACTION_PATTERNS: RegExp[] = [
    /Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi,
    /(?:api[_-]?key|token|password|secret|passwd|pwd)\s*[:=]\s*\S+/gi,
    /(?:--password|--passwd)\s+\S+/gi,
    /[A-Fa-f0-9]{32,}/g,
    /-----BEGIN [A-Z ]+-----[\s\S]*?-----END [A-Z ]+-----/g,
]

/** @hidden */
export class DangerousCommandGuard {
    isDangerous (command: string): { dangerous: boolean, reason?: string } {
        const trimmed = command.trim()
        const dangerousRm = this.inspectRm(trimmed)
        if (dangerousRm) {
            return dangerousRm
        }
        for (const { pattern, reason } of DANGEROUS_PATTERNS) {
            if (pattern.test(trimmed)) {
                return { dangerous: true, reason }
            }
        }
        return { dangerous: false }
    }

    redact (text: string): string {
        let result = text
        for (const pattern of REDACTION_PATTERNS) {
            result = result.replace(pattern, '[REDACTED]')
        }
        return result
    }

    redactLines (lines: string[]): string[] {
        return lines.map(line => this.redact(line))
    }

    private inspectRm (command: string): { dangerous: boolean, reason: string } | null {
        for (const segment of command.split(/(?:&&|\|\||[;|\n])/)) {
            const tokens = this.tokenize(segment.trim())
            let commandIndex = 0
            if (tokens[0] === 'sudo') {
                commandIndex = 1
                while (tokens[commandIndex]?.startsWith('-')) {
                    commandIndex++
                }
            }
            if (!/(?:^|\/)rm$/.test(tokens[commandIndex] ?? '')) {
                continue
            }

            const args = tokens.slice(commandIndex + 1)
            let recursive = false
            let force = false
            let optionsEnded = false
            const operands: string[] = []
            for (const arg of args) {
                if (!optionsEnded && arg === '--') {
                    optionsEnded = true
                    continue
                }
                if (!optionsEnded && arg.startsWith('--')) {
                    recursive = recursive || arg === '--recursive'
                    force = force || arg === '--force'
                    continue
                }
                if (!optionsEnded && /^-[^-]+/.test(arg)) {
                    const flags = arg.slice(1)
                    recursive = recursive || flags.includes('r') || flags.includes('R')
                    force = force || flags.includes('f')
                    continue
                }
                operands.push(arg)
            }

            if (recursive && force) {
                return { dangerous: true, reason: 'Recursive force delete' }
            }
            if (recursive && operands.some(operand => /^(?:\/|\/\*|\.|\.\.|~|~\/|\$HOME|\$HOME\/|\*)$/.test(operand))) {
                return { dangerous: true, reason: 'Recursive delete on broad path' }
            }
        }
        return null
    }

    private tokenize (command: string): string[] {
        const tokens: string[] = []
        const pattern = /"((?:\\.|[^"])*)"|'([^']*)'|([^\s]+)/g
        let match: RegExpExecArray | null
        while ((match = pattern.exec(command))) {
            tokens.push(match[1] ?? match[2] ?? match[3])
        }
        return tokens
    }
}
