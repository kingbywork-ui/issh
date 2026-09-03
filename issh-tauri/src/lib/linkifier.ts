// A8（R-011）linkifier：终端输出中的 http(s) URL 与绝对路径识别 + 点击激活。
// 对齐 issh 分支 issh-linkifier 插件能力（URL 打开浏览器；路径点击复制），
// 基于 xterm.js 5 的 registerLinkProvider 自实现，不引入 web-links addon。

import type { IBufferLine, ILink, Terminal } from '@xterm/xterm'

export type LinkKind = 'url' | 'path'

export interface TerminalLinkMatch {
    start: number
    end: number
    text: string
    kind: LinkKind
}

const URL_PATTERN = /https?:\/\/[^\s"'<>()[\]{}]+/gi

// 绝对路径：POSIX（/home/user/...）与 Windows（C:\...）形态；
// 行首或前置空白/引号起始，尾部剥离标点。
const PATH_PATTERN = /(?:^|[\s"'()])((?:[A-Za-z]:[\\/]|\/)[^\s"'<>()]+[^\s"'<>().,;:])/g

export function findTerminalLinks (line: IBufferLine): TerminalLinkMatch[] {
    const text = line.translateToString(true)
    if (!text) return []
    const matches: TerminalLinkMatch[] = []

    const push = (pattern: RegExp, kind: LinkKind): void => {
        pattern.lastIndex = 0
        let hit: RegExpExecArray | null
        while ((hit = pattern.exec(text)) !== null) {
            const groupIndex = kind === 'path' ? 1 : 0
            const value = hit[groupIndex]
            if (!value) continue
            const start = hit.index + (kind === 'path' ? hit[0].indexOf(value) : 0)
            matches.push({ start, end: start + value.length, text: value, kind })
            if (hit[0].length === 0) pattern.lastIndex += 1
        }
    }

    push(URL_PATTERN, 'url')
    push(PATH_PATTERN, 'path')
    matches.sort((a, b) => a.start - b.start)
    return matches
}

export function registerTerminalLinkifier (
    terminal: Terminal,
    onActivate: (match: TerminalLinkMatch) => void,
): void {
    terminal.registerLinkProvider({
        provideLinks (lineNumber, callback) {
            const line = terminal.buffer.active.getLine(lineNumber)
            if (!line) {
                callback(undefined)
                return
            }
            const matches = findTerminalLinks(line)
            if (matches.length === 0) {
                callback(undefined)
                return
            }
            const links: ILink[] = matches.map((match) => ({
                range: {
                    start: { x: match.start, y: lineNumber },
                    end: { x: match.end, y: lineNumber },
                },
                text: match.text,
                activate: (_event: MouseEvent, text: string) => {
                    onActivate({ ...match, text })
                },
            }))
            callback(links)
        },
    })
}
