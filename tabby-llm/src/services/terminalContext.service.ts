import { Injectable } from '@angular/core'
import { Terminal } from '@xterm/xterm'
import { ConfigService } from 'tabby-core'
import { BaseTerminalTabComponent, XTermFrontend } from 'tabby-terminal'

/** @hidden */
@Injectable({ providedIn: 'root' })
export class TerminalContextService {
    constructor (private config: ConfigService) {}
    async collectContext (tab: BaseTerminalTabComponent<any>): Promise<{
        cwd: string | null
        shell: string
        os: string
        partialCommand: string
        recentOutput: string[]
    }> {
        const cwd = await tab.session?.getWorkingDirectory() ?? null
        const shell = this.detectShell(tab)
        const os = process.platform
        const partialCommand = this.getCurrentLine(tab)
        const recentOutput = this.getRecentOutput(tab, this.config.store.llm?.maxContextLines ?? 20)

        return { cwd, shell, os, partialCommand, recentOutput }
    }

    getCurrentLine (tab: BaseTerminalTabComponent<any>, lineBuffer?: string): string {
        if (lineBuffer !== undefined && lineBuffer.length > 0) {
            return lineBuffer
        }
        const xterm = this.getXterm(tab)
        if (!xterm) {
            return ''
        }
        return this.readLineFromBuffer(xterm)
    }

    getRecentOutput (tab: BaseTerminalTabComponent<any>, maxLines: number): string[] {
        const xterm = this.getXterm(tab)
        if (!xterm || maxLines <= 0) {
            return []
        }
        const buffer = xterm.buffer.active
        const lines: string[] = []
        const start = Math.max(0, buffer.length - maxLines)
        for (let i = start; i < buffer.length; i++) {
            const line = buffer.getLine(i)
            if (!line) {
                continue
            }
            let text = ''
            for (let col = 0; col < line.length; col++) {
                text += line.getCell(col)?.getChars() ?? ''
            }
            const trimmed = text.trimEnd()
            if (trimmed) {
                lines.push(trimmed)
            }
        }
        return lines
    }

    getCursorPosition (tab: BaseTerminalTabComponent<any>): { x: number, y: number } | null {
        const xterm = this.getXterm(tab)
        if (!xterm?.element) {
            return null
        }
        const buffer = xterm.buffer.active
        const cellWidth = xterm.options.fontSize ? xterm.options.fontSize * 0.6 : 8
        const cellHeight = (xterm.options.fontSize ?? 14) * (xterm.options.lineHeight ?? 1)
        const x = buffer.cursorX * cellWidth
        const y = (buffer.cursorY + 1) * cellHeight
        return { x, y }
    }

    private getXterm (tab: BaseTerminalTabComponent<any>): Terminal | null {
        if (!(tab.frontend instanceof XTermFrontend)) {
            return null
        }
        return tab.frontend.xterm
    }

    private readLineFromBuffer (xterm: Terminal): string {
        const buffer = xterm.buffer.active
        const line = buffer.getLine(buffer.cursorY + buffer.viewportY)
        if (!line) {
            return ''
        }
        let text = ''
        for (let i = 0; i < line.length; i++) {
            text += line.getCell(i)?.getChars() ?? ''
        }
        return text.trimEnd()
    }

    private detectShell (tab: BaseTerminalTabComponent<any>): string {
        const profile = tab.profile as any
        if (profile?.type === 'ssh') {
            return profile.options?.runCommand ? 'custom' : 'bash'
        }
        if (profile?.type === 'local') {
            const shell = profile.options?.shell ?? ''
            if (/powershell|pwsh/i.test(shell)) {
                return 'powershell'
            }
            if (/cmd/i.test(shell)) {
                return 'cmd'
            }
            if (/fish/i.test(shell)) {
                return 'fish'
            }
            if (/zsh/i.test(shell)) {
                return 'zsh'
            }
            return 'bash'
        }
        return 'sh'
    }
}
