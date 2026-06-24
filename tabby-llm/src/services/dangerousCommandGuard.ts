const DANGEROUS_PATTERNS: { pattern: RegExp, reason: string }[] = [
    { pattern: /\brm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+.*-r|-[a-zA-Z]*r[a-zA-Z]*\s+.*-f|\s+-rf|\s+-fr)\b/i, reason: 'Recursive force delete' },
    { pattern: /\brm\s+(-[a-zA-Z]*r|--recursive)\s+(\/|\.\.|~|\$HOME|\*)/i, reason: 'Recursive delete on broad path' },
    { pattern: /\bdd\s+if=/i, reason: 'Direct disk write (dd)' },
    { pattern: /\bmkfs\b/i, reason: 'Filesystem format' },
    { pattern: /\b>:?\s*\/dev\/(sd|hd|nvme|vd)/i, reason: 'Write to block device' },
    { pattern: /\bchmod\s+(-R\s+)?777\b/i, reason: 'Overly permissive chmod' },
    { pattern: /\bchown\s+-R\s+.*\s+\/\s*$/i, reason: 'Recursive chown on root' },
    { pattern: /\b(curl|wget)\s+.*\|\s*(ba)?sh\b/i, reason: 'Pipe remote script to shell' },
    { pattern: /\bshutdown\b|\breboot\b|\bpoweroff\b|\bhalt\b/i, reason: 'System power control' },
    { pattern: /\bkill\s+-9\s+1\b|\bkillall\b/i, reason: 'Kill critical processes' },
    { pattern: /\bDROP\s+(DATABASE|TABLE)\b/i, reason: 'SQL destructive statement' },
    { pattern: /\bTRUNCATE\s+TABLE\b/i, reason: 'SQL truncate' },
]

const REDACTION_PATTERNS: RegExp[] = [
    /Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi,
    /(?:api[_-]?key|token|password|secret)\s*[:=]\s*\S+/gi,
    /-----BEGIN [A-Z ]+-----[\s\S]*?-----END [A-Z ]+-----/g,
]

/** @hidden */
export class DangerousCommandGuard {
    isDangerous (command: string): { dangerous: boolean, reason?: string } {
        const trimmed = command.trim()
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
}
