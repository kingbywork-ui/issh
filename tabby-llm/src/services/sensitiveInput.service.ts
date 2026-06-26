import { Injectable } from '@angular/core'
import { BaseTerminalTabComponent } from 'tabby-terminal'
import { TerminalContextService } from './terminalContext.service'

const SENSITIVE_PROMPT_PATTERNS = [
    /password(?:\s+for)?[\s:>]*$/i,
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
    /enter (?:your )?(?:password|passphrase|pin|token|secret)[\s:>]*$/i,
    /请输入(?:密码|口令|验证码|密钥口令)[\s:：>]*$/i,
]

const SENSITIVE_COMMAND_PATTERNS = [
    /(?:^|\s)(?:sudo\s+-S|doas\s+-S)(?:\s|$)/i,
    /(?:^|\s)(?:--password|--passphrase|--token|--secret)(?:=|\s+\S+)/i,
    /(?:^|\s)(?:password|passwd|passphrase|token|secret|api[_-]?key)\s*[:=]\s*\S+/i,
    /(?:^|\s)[A-Za-z_][A-Za-z0-9_]*(?:password|passwd|passphrase|token|secret|api[_-]?key)[A-Za-z0-9_]*=\S+/i,
    /(?:^|\s)sshpass(?:\s+-\w+)*\s+(?:-p|--password)\s*\S+/i,
]

/** @hidden */
@Injectable({ providedIn: 'root' })
export class SensitiveInputService {
    constructor (private context: TerminalContextService) {}

    isSensitiveInputActive (tab: BaseTerminalTabComponent<any>, lineBuffer = ''): boolean {
        const sshPrompt = (tab as any).activeKIPrompt
        if (sshPrompt?.prompts?.some((prompt: any, index: number) => sshPrompt.isAPasswordPrompt?.(index) && !prompt?.echo)) {
            return true
        }

        const candidates = [
            lineBuffer,
            this.context.getCurrentLine(tab, lineBuffer),
            ...this.context.getRecentOutput(tab, 5).slice(-3),
        ]
            .map(text => text?.trim())
            .filter(Boolean) as string[]

        return candidates.some(text => SENSITIVE_PROMPT_PATTERNS.some(pattern => pattern.test(text)))
    }

    shouldStoreCommand (command: string): boolean {
        const normalized = command.trim()
        if (!normalized) {
            return false
        }
        return !SENSITIVE_COMMAND_PATTERNS.some(pattern => pattern.test(normalized))
    }
}
