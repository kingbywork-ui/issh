import { Injectable } from '@angular/core'
import { ConfigService } from 'tabby-core'
import { BaseTerminalTabComponent, XTermFrontend } from 'tabby-terminal'
import { normalizeCommand } from './commandValidation'

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
        const sessionCwd = await tab.session?.getWorkingDirectory() ?? null
        const cwd = sessionCwd
            ?? this.detectCwdFromPrompt(tab)
            ?? tab.profile?.options?.cwd
            ?? (tab.profile?.type === 'local' ? process.cwd() : null)
        const shell = this.detectShell(tab)
        const os = process.platform
        const partialCommand = this.getPartialCommand(tab)
        const recentOutput = this.getRecentOutput(tab, this.config.store.llm?.maxContextLines ?? 20)

        return { cwd, shell, os, partialCommand, recentOutput }
    }

    getCurrentLine (tab: BaseTerminalTabComponent<any>, lineBuffer?: string): string {
        return this.getPartialCommand(tab, lineBuffer)
    }

    /** Command text on the current line, with shell prompt stripped */
    getPartialCommand (tab: BaseTerminalTabComponent<any>, lineBuffer?: string): string {
        if (lineBuffer !== undefined && lineBuffer.length > 0) {
            return lineBuffer
        }
        const xterm = this.getXterm(tab)
        if (!xterm) {
            return ''
        }
        return this.readInputFromBuffer(xterm, true)
    }

    /** Current line text in vim/nano alternate screen (no shell prompt stripping) */
    getEditorPartialText (tab: BaseTerminalTabComponent<any>): string {
        const xterm = this.getXterm(tab)
        if (!xterm) {
            return ''
        }
        return this.readInputFromBuffer(xterm, false).trimEnd()
    }

    stripPrompt (line: string): string {
        const trimmed = line.trimEnd()
        if (!trimmed) {
            return ''
        }

        // POSIX prompts: user@host:~/path$ command, root@host:/path# command
        const posixPromptMatch = /(?:^|\s)(?:[\w.-]+@[\w.-]+:\S+)\s*[#$%]\s*(.*)$/.exec(trimmed)
        if (posixPromptMatch) {
            return posixPromptMatch[1]
        }

        // Simple root/user prompt at line start: # command, $ command
        const simplePromptMatch = /^[#$]\s+(.*)$/.exec(trimmed)
        if (simplePromptMatch) {
            return simplePromptMatch[1]
        }

        // PowerShell: PS C:\path> command
        const psMatch = /^PS(?: [^>]+)?>\s*(.*)$/i.exec(trimmed)
        if (psMatch) {
            return psMatch[1]
        }

        // Windows CMD: C:\path> command, \\server\share> command
        const cmdMatch = /^(?:[A-Z]:[\\/]|\\\\)[^>\r\n]*>\s*(.*)$/i.exec(trimmed)
        if (cmdMatch) {
            return cmdMatch[1]
        }

        // history command output: "  988  wget http://..."
        const historyMatch = /^\s*\d+\s{2,}(.*)$/.exec(trimmed)
        if (historyMatch) {
            return historyMatch[1].trim()
        }

        // Find the last common prompt marker and take input after it
        const markers = ['$ ', '# ', '% ', '> ']
        let bestIndex = -1
        let bestLength = 0
        for (const marker of markers) {
            const idx = trimmed.lastIndexOf(marker)
            if (idx > bestIndex) {
                bestIndex = idx
                bestLength = marker.length
            }
        }
        if (bestIndex >= 0) {
            return trimmed.substring(bestIndex + bestLength)
        }

        return trimmed
    }

    getRecentOutput (tab: BaseTerminalTabComponent<any>, maxLines: number): string[] {
        const xterm = this.getXterm(tab)
        if (!xterm || maxLines <= 0) {
            return []
        }
        const buffer = xterm.buffer.active
        return this.readLogicalLines(buffer, Math.max(0, buffer.length - maxLines), buffer.length - 1)
            .map(line => line.trimEnd())
            .filter(Boolean)
    }

    extractCommandsFromTerminal (tab: BaseTerminalTabComponent<any>, maxLines: number): string[] {
        const lines = this.getRecentOutput(tab, maxLines)
        const commands: string[] = []
        let pendingMultiline: string[] = []

        const flushPending = () => {
            if (!pendingMultiline.length) {
                return
            }
            const normalized = normalizeCommand(pendingMultiline.join('\n'), { allowMultiline: true })
            if (normalized) {
                commands.push(normalized)
            }
            pendingMultiline = []
        }

        for (const line of lines) {
            const stripped = this.stripPrompt(line).trim()
            if (!stripped) {
                flushPending()
                continue
            }

            if (/^[>|.]{1,3}\s/.test(stripped) && pendingMultiline.length) {
                pendingMultiline.push(stripped.replace(/^[>|.]{1,3}\s*/, ''))
                continue
            }

            flushPending()
            if (/[|&\\]$/.test(stripped)) {
                pendingMultiline = [stripped]
                continue
            }

            const normalized = normalizeCommand(stripped, { allowMultiline: true })
            if (normalized) {
                commands.push(normalized)
            }
        }

        flushPending()
        return commands
    }

    getCursorPosition (
        tab: BaseTerminalTabComponent<any>,
        relativeTo?: HTMLElement,
    ): { x: number, y: number } | null {
        const xterm = this.getXterm(tab)
        if (!xterm?.element) {
            return null
        }
        const buffer = xterm.buffer.active
        const screen = xterm.element.querySelector<HTMLElement>('.xterm-screen')
        const screenRect = (screen ?? xterm.element).getBoundingClientRect()
        const originRect = (relativeTo ?? xterm.element).getBoundingClientRect()
        const measuredCellWidth = screenRect.width / Math.max(1, xterm.cols)
        const measuredCellHeight = screenRect.height / Math.max(1, xterm.rows)
        const cellWidth = measuredCellWidth > 0
            ? measuredCellWidth
            : (xterm.options.fontSize ? xterm.options.fontSize * 0.6 : 8)
        const cellHeight = measuredCellHeight > 0
            ? measuredCellHeight
            : (xterm.options.fontSize ?? 14) * (xterm.options.lineHeight ?? 1)
        const x = screenRect.left - originRect.left + buffer.cursorX * cellWidth
        const y = screenRect.top - originRect.top + (buffer.cursorY + 1) * cellHeight
        return { x, y }
    }

    private getXterm (tab: BaseTerminalTabComponent<any>): XTermFrontend['xterm'] | null {
        if (!(tab.frontend instanceof XTermFrontend)) {
            return null
        }
        return tab.frontend.xterm
    }

    private readInputFromBuffer (xterm: XTermFrontend['xterm'], stripShellPrompt: boolean): string {
        const buffer = xterm.buffer.active
        const cursorLineIndex = buffer.cursorY + buffer.viewportY
        const line = buffer.getLine(cursorLineIndex)
        if (!line) {
            return ''
        }

        let startLineIndex = cursorLineIndex
        while (startLineIndex > 0) {
            const current = buffer.getLine(startLineIndex) as any
            if (!current?.isWrapped) {
                break
            }
            startLineIndex--
        }

        let text = ''
        for (let lineIndex = startLineIndex; lineIndex <= cursorLineIndex; lineIndex++) {
            const currentLine = buffer.getLine(lineIndex)
            if (!currentLine) {
                continue
            }
            const endCol = lineIndex === cursorLineIndex
                ? Math.min(buffer.cursorX + 1, currentLine.length)
                : currentLine.length
            text += this.readTerminalLine(currentLine, endCol)
        }
        return stripShellPrompt ? this.stripPrompt(text) : text
    }

    private readLogicalLines (buffer: XTermFrontend['xterm']['buffer']['active'], start: number, end: number): string[] {
        const lines: string[] = []
        let current = ''

        for (let i = Math.max(0, start); i <= end; i++) {
            const line = buffer.getLine(i)
            if (!line) {
                continue
            }

            const text = this.readTerminalLine(line)
            const wrapped = !!(line as any).isWrapped

            if (!wrapped) {
                if (current.trimEnd()) {
                    lines.push(current)
                }
                current = text
            } else {
                current += text
            }
        }

        if (current.trimEnd()) {
            lines.push(current)
        }

        return lines
    }

    private readTerminalLine (line: ReturnType<XTermFrontend['xterm']['buffer']['active']['getLine']>, endCol?: number): string {
        if (!line) {
            return ''
        }

        let text = ''
        const limit = Math.min(endCol ?? line.length, line.length)
        for (let col = 0; col < limit; col++) {
            text += line.getCell(col)?.getChars() ?? ''
        }
        return text
    }

    private detectShell (tab: BaseTerminalTabComponent<any>): string {
        const profile = tab.profile
        if (profile?.type === 'ssh') {
            return profile.options?.runCommand ? 'custom' : 'bash'
        }
        if (profile?.type === 'local') {
            const shellType = profile.options?.shellType
            if (shellType === 'powershell' || shellType === 'cmd') {
                return shellType
            }
            if (shellType === 'unix') {
                return 'bash'
            }
            const shell = `${profile.options?.command ?? ''} ${profile.options?.shell ?? ''}`
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

    private detectCwdFromPrompt (tab: BaseTerminalTabComponent<any>): string | null {
        const xterm = this.getXterm(tab)
        if (!xterm) {
            return null
        }
        const currentLine = this.readInputFromBuffer(xterm, false).trimEnd()
        const match = /^(?:PS\s+)?((?:[A-Z]:[\\/]|\\\\)[^>\r\n]*)>\s*.*$/i.exec(currentLine)
        return match?.[1]?.trim() || null
    }
}
