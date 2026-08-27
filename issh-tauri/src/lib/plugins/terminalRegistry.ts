import type { Terminal } from '@xterm/xterm'

interface TerminalRecord {
    terminal: Terminal
    sessionId: string
    title: string
    write: (data: string | Uint8Array) => void
}

const terminals = new Map<string, TerminalRecord>()
let activeSessionId = ''

export function registerTerminal (sessionId: string, record: Omit<TerminalRecord, 'sessionId'>): void {
    terminals.set(sessionId, { ...record, sessionId })
}

export function unregisterTerminal (sessionId: string): void {
    terminals.delete(sessionId)
    if (activeSessionId === sessionId) activeSessionId = ''
}

export function setActiveTerminal (sessionId: string): void {
    activeSessionId = sessionId
}

export function getActiveTerminal (): TerminalRecord | null {
    if (activeSessionId) return terminals.get(activeSessionId) ?? null
    return [...terminals.values()][0] ?? null
}

export function getTerminal (sessionId: string): TerminalRecord | null {
    return terminals.get(sessionId) ?? null
}

export function readTerminalBuffer (record: TerminalRecord, lines: number): string[] {
    const buffer = record.terminal.buffer.active
    const end = buffer.baseY + buffer.cursorY
    const start = Math.max(0, end - lines)
    const result: string[] = []
    for (let y = start; y <= end; y++) {
        const line = buffer.getLine(y)
        if (line) result.push(line.translateToString(true))
    }
    return result
}
