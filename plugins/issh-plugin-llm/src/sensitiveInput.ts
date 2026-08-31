// 移植自 issh 分支 sensitiveInput.service.ts（去 Angular 依赖，纯函数版）
const SENSITIVE_PROMPT_PATTERNS = [
    /(?:^|\s)password(?:\s+for)?[\s:>]*$/i,
    /passphrase[\s:>]*$/i,
    /pin[\s:>]*$/i,
    /token[\s:>]*$/i,
    /secret[\s:>]*$/i,
    /verification code[\s:>]*$/i,
    /one[- ]time (?:code|password)[\s:>]*$/i,
    /验证码[\s:：>]*$/i,
    /口令[\s:：>]*$/i,
    /密码[\s:：>]*$/i,
    /\[sudo\]\s+password\s+for\s+.+[\s:>]*$/i,
    /\[sudo(?::[^\]]+)?\]\s+password[\s:>]*$/i,
    /\[sudo(?::[^\]]+)?\][^\r\n]*password[\s:>]*$/i,
    /\bsu\b[^\r\n]*password[\s:>]*$/i,
    /enter (?:your )?(?:password|passphrase|pin|token|secret)[\s:>]*$/i,
    /请输入(?:密码|口令|验证码|密钥口令)[\s:：>]*$/i,
]

const SENSITIVE_COMMAND_PATTERNS = [
    /(?:^|\s)(?:sudo\s+-S|doas\s+-S)(?:\s|$)/i,
    /(?:^|\s)(?:--password|--passphrase|--token|--secret)(?:=|\s+\S+)/i,
    /(?:^|\s)(?:password|passwd|passphrase|token|secret|api[_-]?key)\s*[:=]\s*\S+/i,
    /(?:^|\s)[A-Za-z_][A-Za-z0-9_]*(?:password|passwd|passphrase|token|secret|api[_-]?key)[A-Za-z0-9_]*=\S+/i,
    /(?:^|\s)sshpass(?:\s+-\w+)*\s+(?:-p|--password)\s*\S+/i,
    /(?:^|\s)(?:-u|--user)(?:=|\s+)\S+:\S+/i,
    /(?:^|\s)-p(?=\S*[A-Za-z@#$%^&*!])\S+/,
    /\bAuthorization\s*:\s*(?:Basic|Bearer)\s+\S+/i,
    /\bCookie\s*:\s*\S+/i,
    /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/,
    /\b(?:gh[opusr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,})\b/,
    /\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/i,
]

export function looksLikeSensitivePrompt (text: string): boolean {
    const normalized = text.trim()
    if (!normalized) {
        return false
    }
    const maskedPrompt = normalized.replace(/\*+$/g, '').trimEnd()
    return [normalized, maskedPrompt]
        .filter(Boolean)
        .some(candidate => SENSITIVE_PROMPT_PATTERNS.some(pattern => pattern.test(candidate)))
}

function looksLikeBareSecret (command: string): boolean {
    // 密码 prompt 后直接输入的单 token 秘密（无 shell 结构）
    if (/\s/.test(command) || /[/\\|=]/.test(command)) {
        return false
    }
    if (/^(?:password|passwd|passphrase|secret|token|Current\s+passwo)/i.test(command)) {
        return true
    }
    if (command.length >= 6 && /[A-Za-z]/.test(command) && /\d/.test(command) && /[@#$%^&*!]/.test(command)) {
        return true
    }
    return false
}

export function shouldStoreCommand (command: string): boolean {
    const normalized = command.trim()
    if (!normalized) {
        return false
    }
    if (SENSITIVE_COMMAND_PATTERNS.some(pattern => pattern.test(normalized))) {
        return false
    }
    return !looksLikeBareSecret(normalized)
}
