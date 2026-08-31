import type { Terminal } from '@xterm/xterm'
import { normalizeCommand } from './commandValidation'

// 移植自 issh 分支 terminalContext.service.ts（去 Angular/tab 依赖，直接面向 xterm v5 Terminal）
// dev 端 xterm 为 @xterm/xterm v5 API（buffer.baseY/cursorY），行号计算按 v5 调整。

export function stripPrompt (line: string): string {
    const trimmed = line.trimEnd()
    if (!trimmed) {
        return ''
    }

    // POSIX prompts: user@host:~/path$ command
    const posixPromptMatch = /(?:^|\s)(?:[\w.-]+@[\w.-]+:\S+)\s*[#$%]\s*(.*)$/.exec(trimmed)
    if (posixPromptMatch) {
        return posixPromptMatch[1]
    }

    // 简单提示符：# command, $ command
    const simplePromptMatch = /^[#$]\s+(.*)$/.exec(trimmed)
    if (simplePromptMatch) {
        return simplePromptMatch[1]
    }

    // PowerShell: PS C:\path> command
    const psMatch = /^PS(?: [^>]+)?>\s*(.*)$/i.exec(trimmed)
    if (psMatch) {
        return psMatch[1]
    }

    // Windows CMD: C:\path> command
    const cmdMatch = /^(?:[A-Z]:[\\/]|\\\\)[^>\r\n]*>\s*(.*)$/i.exec(trimmed)
    if (cmdMatch) {
        return cmdMatch[1]
    }

    // history 输出行："  988  wget http://..."
    const historyMatch = /^\s*\d+\s{2,}(.*)$/.exec(trimmed)
    if (historyMatch) {
        return historyMatch[1].trim()
    }

    // 兜底：最后一个常见提示符标记之后的内容
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

/** 当前输入行（含 wrapped 拼接），stripShellPrompt=true 时剥离提示符 */
export function getPartialCommand (terminal: Terminal, lineBuffer?: string): string {
    if (lineBuffer !== undefined && lineBuffer.length > 0) {
        return lineBuffer
    }
    return readInputFromBuffer(terminal, true)
}

/** 最近输出行（逻辑行，合并 wrapped 行），用于 LLM 上下文与 history 输出提取 */
export function getRecentOutput (terminal: Terminal, maxLines: number): string[] {
    const buffer = terminal.buffer.active
    const end = buffer.baseY + buffer.cursorY
    const start = Math.max(0, end - maxLines)
    return readLogicalLines(terminal, start, end)
        .map(line => line.trimEnd())
        .filter(Boolean)
}

/** 从最近输出中提取 "  42  command" 形式的 history 输出命令 */
export function extractHistoryOutputCommands (terminal: Terminal, maxLines: number): string[] {
    const commands: string[] = []
    for (const line of getRecentOutput(terminal, maxLines)) {
        const historyMatch = /^\s*\d+\s+(.*)$/.exec(line)
        if (historyMatch) {
            const normalized = normalizeCommand(historyMatch[1].trim(), { allowMultiline: true })
            if (normalized) {
                commands.push(normalized)
            }
        }
    }
    return Array.from(new Set(commands))
}

function readInputFromBuffer (terminal: Terminal, stripShellPrompt: boolean): string {
    const buffer = terminal.buffer.active
    const cursorLineIndex = buffer.baseY + buffer.cursorY
    const line = buffer.getLine(cursorLineIndex)
    if (!line) {
        return ''
    }

    // 向上合并 wrapped 行
    let startLineIndex = cursorLineIndex
    while (startLineIndex > 0) {
        const current = buffer.getLine(startLineIndex)
        if (!current || !current.isWrapped) {
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
        text += readTerminalLine(currentLine, endCol)
    }
    return stripShellPrompt ? stripPrompt(text) : text
}

function readLogicalLines (terminal: Terminal, start: number, end: number): string[] {
    const buffer = terminal.buffer.active
    const lines: string[] = []
    let current = ''
    for (let i = Math.max(0, start); i <= end; i++) {
        const line = buffer.getLine(i)
        if (!line) {
            continue
        }
        const text = readTerminalLine(line)
        const wrapped = !!line.isWrapped
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

function readTerminalLine (line: { getCell (col: number): { getChars (): string } | undefined, length: number }, endCol?: number): string {
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
