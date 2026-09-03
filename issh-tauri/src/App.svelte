<script lang="ts">
    import { onMount } from 'svelte'
    import { FitAddon } from '@xterm/addon-fit'
    import { Terminal } from '@xterm/xterm'
    import '@xterm/xterm/css/xterm.css'
    import { listen } from '@tauri-apps/api/event'
    import HostManager from './lib/HostManager.svelte'
    import WelcomeHome from './lib/WelcomeHome.svelte'
    import SftpBrowser from './lib/SftpBrowser.svelte'
    import BatchInputPanel from './lib/BatchInputPanel.svelte'
    import ProfileSelector from './lib/ProfileSelector.svelte'
    import Settings from './lib/Settings.svelte'
    import SandboxPanel from './lib/SandboxPanel.svelte'
    import { getTerminalDecorators, getSandboxPanels, subscribeUi } from './lib/plugins/pluginHost'
    import { autoSudoDecorator } from './lib/autoSudo'
    import { registerTerminal, unregisterTerminal, setActiveTerminal } from './lib/plugins/terminalRegistry'
    import { broadcastSandboxEvent, setProfileWriteConfirm } from './lib/plugins/sandboxBridge'
    import ConfirmDialog from './lib/ConfirmDialog.svelte'
    import ContextMenu, { type ContextMenuItem } from './lib/ContextMenu.svelte'
    import SplitLayout, { type SplitLayoutNode } from './lib/SplitLayout.svelte'
    import { focusOnMount } from './lib/a11y'
    import { checkPluginUpdates, type PluginUpdateInfo } from './lib/plugins/pluginHost'
    import { findScheme } from './lib/terminalSchemes'
    import {
        appQuit,
        clipboardReadText,
        clipboardWriteText,
        closeSession,
        discoverSshHostKey,
        hostProfiles,
        minimizeToTray,
        openLocalSession,
        openSshSession,
        resolveKeyPassphrase,
        resolveSshPassword,
        startLocalForward,
        startDynamicForward,
        startRemoteForward,
        resizeSession,
        runtimeHealth,
        setActiveSession,
        subscribeSession,
        vaultListSecrets,
        vaultStatus,
        writeSession,
        pickSavePath,
        writeLocalChunk,
        type RuntimeHealth,
        type RuntimeSessionSnapshot,
        type SshHostProfile,
        type OpenSshSessionOptions,
        type VaultSecretKey,
    } from './lib/runtime'

    interface SshTabInfo {
        host: string
        port: number
        user: string
        hostKeyFingerprint: string
        profile: SshHostProfile | null
        keyPath: string
        jump?: OpenSshSessionOptions
    }

    interface TerminalTab {
        session: RuntimeSessionSnapshot
        terminal: Terminal | null
        fitAddon: FitAddon | null
        host: HTMLDivElement | null
        resizeObserver: ResizeObserver | null
        sequence: number
        ssh: SshTabInfo | null
        decoratorCleanups: Array<() => void> | null
        sudoAction: { label: string, invoke: () => void } | null
    }

    const splitLayoutKey = 'issh.splitLayout'
    const tabRecoveryKey = 'issh.tabRecovery'
    interface TabRecoveryState { layout: SplitLayoutNode | null, tabs: Array<{ oldId: string, kind: 'ssh' | 'local', profileId?: string }> }
    function readSplitLayout (): SplitLayoutNode | null {
        try {
            const value = JSON.parse(localStorage.getItem(splitLayoutKey) ?? 'null') as SplitLayoutNode | null
            return value?.type === 'pane' || value?.type === 'split' ? value : null
        } catch { return null }
    }
    function layoutLeaves (node: SplitLayoutNode | null): string[] {
        if (!node) return []
        return node.type === 'pane' ? [node.id] : node.children.flatMap(layoutLeaves)
    }
    function persistSplitLayout (node: SplitLayoutNode | null): void {
        try { node ? localStorage.setItem(splitLayoutKey, JSON.stringify(node)) : localStorage.removeItem(splitLayoutKey) } catch {}
    }
    function persistTabRecovery (): void {
        try {
            const state: TabRecoveryState = {
                layout: splitLayout,
                tabs: tabs.map((tab) => tab.ssh?.profile?.id
                    ? { oldId: tab.session.id, kind: 'ssh' as const, profileId: tab.ssh.profile.id }
                    : { oldId: tab.session.id, kind: 'local' as const }),
            }
            if (state.tabs.length) localStorage.setItem(tabRecoveryKey, JSON.stringify(state))
            else localStorage.removeItem(tabRecoveryKey)
        } catch {}
    }

    let health: RuntimeHealth | null = $state(null)
    let loading = $state(true)
    let error = $state('')
    let tabs = $state<TerminalTab[]>([])
    let activeId = $state('')
    // Agent Bridge：tab 切换时上报当前 active 会话（供外部 agent 的 "active" 引用）
    $effect(() => {
        void setActiveSession(activeId || null)
    })
    let splitDirection = $state<'vertical' | 'horizontal' | null>((localStorage.getItem('issh.splitDirection') as 'vertical' | 'horizontal' | null) ?? null)
    let splitPaneIds = $state<string[]>([])
    let splitRatio = $state(Number.parseInt(localStorage.getItem('issh.splitRatio') ?? '', 10) || 50)
    let maximizedPaneId = $state<string | null>(null)
    let draggedPaneId = $state<string | null>(null)
    let splitLayout = $state<SplitLayoutNode | null>(readSplitLayout())
    let showHome = $state(false)
    let showSftp = $state(false)
    let sftpInitialPath = $state('/')
    let sftpSudoMode = $state(false)
    let sftpSudoPassword = $state('')
    let sftpPrompt = $state<{ tab: TerminalTab, path: string } | null>(null)
    let vaultPassphrase = $state('')
    let vaultPassphrasePrompt = $state<{ resolve: (value: string | null) => void } | null>(null)
    let showSend = $state(false)
    let showConnect = $state(false)
    let showSelector = $state(false)
    let tabMenu = $state<{ x: number, y: number, items: ContextMenuItem[] } | null>(null)
    let vaultLocked = $state(false)
    let showWelcome = $state(false)
    let showSettings = $state(false)
    let showCloseDialog = $state(false)
    let closeRemember = $state(false)

    // R-046：窗口关闭行为选择（完全退出 / 最小化到托盘，可记住）
    function handleCloseRequest (): void {
        const saved = localStorage.getItem('issh.closeBehavior')
        if (saved === 'quit') {
            void appQuit()
            return
        }
        if (saved === 'minimize') {
            void minimizeToTray()
            return
        }
        closeRemember = false
        showCloseDialog = true
    }

    function closeChoice (choice: 'quit' | 'minimize'): void {
        if (closeRemember) {
            localStorage.setItem('issh.closeBehavior', choice)
        }
        showCloseDialog = false
        if (choice === 'quit') {
            void appQuit()
        } else {
            void minimizeToTray()
        }
    }
    let pluginUpdates = $state<PluginUpdateInfo[]>([])
    // 插件注册/注销时刷新沙箱面板列表（$state 快照不会自动跟踪 pluginHost 内部 Map）
    const sandboxPanels = $state(getSandboxPanels('bottom'))
    subscribeUi(() => {
        sandboxPanels.length = 0
        sandboxPanels.push(...getSandboxPanels('bottom'))
    })

    // 终端配色热更新：scheme 变更时重建所有 xterm 实例代价高，
    // 通过 storage 事件 + 自定义事件监听，仅更新 theme
    function handleSchemeChange (): void {
        const schemeName = localStorage.getItem('issh.terminalScheme') ?? ''
        const scheme = schemeName ? findScheme(schemeName) : null
        for (const tab of tabs) {
            if (!tab.terminal) continue
            if (scheme) {
                tab.terminal.options.theme = {
                    background: scheme.background,
                    foreground: scheme.foreground,
                    cursor: scheme.cursor,
                    black: scheme.colors[0],
                    red: scheme.colors[1],
                    green: scheme.colors[2],
                    yellow: scheme.colors[3],
                    blue: scheme.colors[4],
                    magenta: scheme.colors[5],
                    cyan: scheme.colors[6],
                    white: scheme.colors[7],
                    brightBlack: scheme.colors[8],
                    brightRed: scheme.colors[9],
                    brightGreen: scheme.colors[10],
                    brightYellow: scheme.colors[11],
                    brightBlue: scheme.colors[12],
                    brightMagenta: scheme.colors[13],
                    brightCyan: scheme.colors[14],
                    brightWhite: scheme.colors[15],
                }
            } else {
                const light = document.documentElement.dataset.colorScheme === 'light'
                tab.terminal.options.theme = {
                    background: light ? '#f6f8fa' : '#171717',
                    foreground: light ? '#1f2933' : '#cacaca',
                    cursor: light ? '#1f2933' : '#bbbbbb',
                    black: light ? '#1f2933' : '#000000',
                    red: light ? '#b42318' : '#ff615a',
                    green: light ? '#18794e' : '#b1e969',
                    yellow: light ? '#9a6700' : '#ebd99c',
                    blue: light ? '#0969da' : '#5da9f6',
                    magenta: light ? '#8250df' : '#e86aff',
                    cyan: light ? '#0969a8' : '#82fff7',
                    white: light ? '#ffffff' : '#dedacf',
                    brightBlack: light ? '#6e7781' : '#313131',
                    brightRed: light ? '#cf222e' : '#f58c80',
                    brightGreen: light ? '#1a7f37' : '#ddf88f',
                    brightYellow: light ? '#7d4e00' : '#eee5b2',
                    brightBlue: light ? '#0550ae' : '#a5c7ff',
                    brightMagenta: light ? '#6639ba' : '#ddaaff',
                    brightCyan: light ? '#075985' : '#b7fff9',
                    brightWhite: light ? '#ffffff' : '#ffffff',
                }
            }
        }
    }

    const schemeChangeHandler = (): void => { handleSchemeChange() }

    // 连接表单
    let formHost = $state('')
    let formPort = $state(22)
    let formUser = $state('')
    let formPassword = $state('')
    let formKeyPath = $state('')
    let formKeyPassphrase = $state('')
    let formVaultSecretId = $state('')
    let connectError = $state('')
    let connecting = $state(false)

    // TOFU 指纹确认
    let pendingFingerprint = $state('')
    let pendingConnect = $state(false)
    // 指纹确认后暂存的连接参数（含 vault 密码解析结果）
    interface PendingConnect {
        host: string
        port: number
        user: string
        password: string
        keyPath: string
        keyPassphrase: string
        vaultSecretId: string
        title?: string
        profile: SshHostProfile | null
        jump?: OpenSshSessionOptions
    }
    let pendingParams = $state<PendingConnect | null>(null)

    // Vault
    let vaultSecrets = $state<VaultSecretKey[]>([])

    const POLL_INTERVAL_MS = 250
    // 每个会话的写队列上限：超出后丢弃输入，避免粘贴风暴把 RPC 队列打满拖垮 UI
    const MAX_WRITE_QUEUE = 64

    let pollHandle: ReturnType<typeof setInterval> | null = null
    let pollInFlight = false

    const activeTab = $derived(tabs.find((tab) => tab.session.id === activeId) ?? null)
    const showStartPage = $derived(tabs.length === 0 || showHome)
    const layoutPaneIds = $derived(splitLayout ? layoutLeaves(splitLayout).filter((id) => tabs.some((tab) => tab.session.id === id)) : [])
    const hasSplitLayout = $derived(layoutPaneIds.length > 1)
    const visiblePaneIds = $derived(maximizedPaneId ? [maximizedPaneId] : (layoutPaneIds.length > 1 ? layoutPaneIds : [activeId]))

    function syncSplitState (): void {
        splitPaneIds = layoutPaneIds
        splitDirection = splitLayout?.type === 'split' ? splitLayout.orientation : null
        if (splitDirection) localStorage.setItem('issh.splitDirection', splitDirection)
    }

    function persistRecursiveSplitRatios (): void {
        persistSplitLayout(splitLayout)
        if (splitLayout?.type === 'split' && splitLayout.children.length === 2) {
            splitRatio = Math.round(splitLayout.ratios[0] * 100)
            localStorage.setItem('issh.splitRatio', String(splitRatio))
        }
    }

    $effect(() => {
        const ids = tabs.map((tab) => tab.session.id)
        if (splitLayout && !layoutLeaves(splitLayout).some((id) => ids.includes(id))) {
            splitLayout = null
            splitPaneIds = []
            splitDirection = null
            persistSplitLayout(null)
        }
    })

    function remapRecoveryLayout (node: SplitLayoutNode | null, mapping: Map<string, string>): SplitLayoutNode | null {
        if (!node) return null
        if (node.type === 'pane') return mapping.has(node.id) ? { type: 'pane', id: mapping.get(node.id)! } : null
        const children = node.children.map((child) => remapRecoveryLayout(child, mapping)).filter((child): child is SplitLayoutNode => child !== null)
        if (children.length === 0) return null
        if (children.length === 1) return children[0]
        const ratios = children.map((_, index) => node.ratios[index] ?? 1 / children.length)
        const total = ratios.reduce((sum, ratio) => sum + ratio, 0) || 1
        return { type: 'split', orientation: node.orientation, children, ratios: ratios.map((ratio) => ratio / total) }
    }

    let recoveryStarted = false
    async function restoreRecoveredTabs (): Promise<void> {
        if (recoveryStarted) return
        recoveryStarted = true
        let saved: TabRecoveryState | null = null
        try { saved = JSON.parse(localStorage.getItem(tabRecoveryKey) ?? 'null') as TabRecoveryState | null } catch {}
        if (!saved?.tabs?.length) return
        let profiles: SshHostProfile[] = []
        try {
            const result = await hostProfiles()
            if (!result.encrypted || result.unlocked) profiles = result.profiles
        } catch {}
        const layout = saved.layout
        const mapping = new Map<string, string>()
        const previousLayout = splitLayout
        splitLayout = null
        splitPaneIds = []
        splitDirection = null
        for (const entry of saved.tabs) {
            if (entry.kind === 'local') {
                const before = new Set(tabs.map((tab) => tab.session.id))
                await addLocalTab()
                const created = tabs.find((tab) => !tab.ssh && !before.has(tab.session.id))
                if (created) mapping.set(entry.oldId, created.session.id)
                continue
            }
            if (!entry.profileId) continue
            const profile = profiles.find((candidate) => candidate.id === entry.profileId)
            if (!profile || !localStorage.getItem(`issh.trustedHostKey.${profile.host}:${profile.port}`)) continue
            const before = new Set(tabs.map((tab) => tab.session.id))
            await connectHost(profile)
            const created = tabs.find((tab) => tab.ssh?.profile?.id === profile.id && !before.has(tab.session.id))
            if (created) mapping.set(entry.oldId, created.session.id)
        }
        splitLayout = remapRecoveryLayout(layout ?? previousLayout, mapping)
        if (splitLayout) {
            persistSplitLayout(splitLayout)
            syncSplitState()
        } else {
            persistSplitLayout(null)
        }
        persistTabRecovery()
    }

    function showHomePage (): void {
        showHome = true
        showSftp = false
        showSend = false
    }

    const writeQueues = new Map<string, Promise<unknown>>()
    const writeQueueLengths = new Map<string, number>()

    function enqueueWrite (sessionId: string, operation: () => Promise<unknown>): void {
        const length = (writeQueueLengths.get(sessionId) ?? 0) + 1
        if (length > MAX_WRITE_QUEUE) {
            // 超限丢弃时提示一次，避免粘贴风暴静默吞掉全部输入造成“终端无响应”错觉
            if (!writeQueueWarned.has(sessionId)) {
                writeQueueWarned.add(sessionId)
                console.warn(`[session ${sessionId}] 写队列超限（>${MAX_WRITE_QUEUE}），部分输入被丢弃`)
            }
            return
        }
        writeQueueLengths.set(sessionId, length)
        const previous = writeQueues.get(sessionId) ?? Promise.resolve()
        const next = previous
            .then(operation)
            .catch(() => {
                // 写失败静默处理：会话断开时 xterm 高频 onData 不应刷屏报错
            })
            .finally(() => {
                const remaining = (writeQueueLengths.get(sessionId) ?? 1) - 1
                writeQueueLengths.set(sessionId, Math.max(0, remaining))
                if (remaining === 0) writeQueueWarned.delete(sessionId)
            })
        writeQueues.set(sessionId, next)
    }

    const writeQueueWarned = new Set<string>()

    async function refresh (): Promise<void> {
        loading = true
        error = ''
        try {
            health = await runtimeHealth()
        } catch (cause) {
            health = null
            error = cause instanceof Error ? cause.message : String(cause)
        } finally {
            loading = false
        }
    }

    function makeTerminal (): Terminal {
        const light = document.documentElement.dataset.colorScheme === 'light'
        const schemeName = localStorage.getItem('issh.terminalScheme') ?? ''
        const scheme = schemeName ? findScheme(schemeName) : null
        if (scheme) {
            return new Terminal({
                allowProposedApi: false,
                convertEol: false,
                cursorBlink: true,
                fontFamily: '"Source Code Pro", Consolas, "Courier New", monospace',
                fontSize: 13,
                scrollback: 2_000,
                theme: {
                    background: scheme.background,
                    foreground: scheme.foreground,
                    cursor: scheme.cursor,
                    black: scheme.colors[0],
                    red: scheme.colors[1],
                    green: scheme.colors[2],
                    yellow: scheme.colors[3],
                    blue: scheme.colors[4],
                    magenta: scheme.colors[5],
                    cyan: scheme.colors[6],
                    white: scheme.colors[7],
                    brightBlack: scheme.colors[8],
                    brightRed: scheme.colors[9],
                    brightGreen: scheme.colors[10],
                    brightYellow: scheme.colors[11],
                    brightBlue: scheme.colors[12],
                    brightMagenta: scheme.colors[13],
                    brightCyan: scheme.colors[14],
                    brightWhite: scheme.colors[15],
                },
            })
        }
        return new Terminal({
            allowProposedApi: false,
            convertEol: false,
            cursorBlink: true,
            fontFamily: '"Source Code Pro", Consolas, "Courier New", monospace',
            fontSize: 13,
            scrollback: 2_000,
            theme: {
                background: light ? '#f6f8fa' : '#171717',
                foreground: light ? '#1f2933' : '#cacaca',
                cursor: light ? '#1f2933' : '#bbbbbb',
                black: light ? '#1f2933' : '#000000',
                red: light ? '#b42318' : '#ff615a',
                green: light ? '#18794e' : '#b1e969',
                yellow: light ? '#9a6700' : '#ebd99c',
                blue: light ? '#0969da' : '#5da9f6',
                magenta: light ? '#8250df' : '#e86aff',
                cyan: light ? '#0969a8' : '#82fff7',
                white: light ? '#ffffff' : '#dedacf',
                brightBlack: light ? '#6e7781' : '#313131',
                brightRed: light ? '#cf222e' : '#f58c80',
                brightGreen: light ? '#1a7f37' : '#ddf88f',
                brightYellow: light ? '#7d4e00' : '#eee5b2',
                brightBlue: light ? '#0550ae' : '#a5c7ff',
                brightMagenta: light ? '#6639ba' : '#ddaaff',
                brightCyan: light ? '#075985' : '#b7fff9',
                brightWhite: light ? '#ffffff' : '#ffffff',
            },
        })
    }

    function bindTerminal (tab: TerminalTab): void {
        if (!tab.terminal || !tab.fitAddon || !tab.host) return
        tab.terminal.open(tab.host)
        tab.fitAddon.fit()
        observeTerminalHost(tab)
        tab.terminal.onSelectionChange(() => {
            void copyTerminalSelection(tab)
        })
        tab.terminal.element?.addEventListener('contextmenu', (event) => {
            event.preventDefault()
            tab.terminal?.focus()
            void pasteTerminalClipboard(tab)
        })
        const sessionId = tab.session.id
        enqueueWrite(sessionId, async () => {
            tab.session = await resizeSession(sessionId, tab.terminal!.cols, tab.terminal!.rows)
        })
        tab.terminal.onResize(({ cols, rows }) => {
            enqueueWrite(sessionId, async () => {
                tab.session = await resizeSession(sessionId, cols, rows)
            })
        })
        tab.terminal.onData((data) => {
            const bytes = new TextEncoder().encode(data)
            enqueueWrite(sessionId, async () => { await writeSession(sessionId, bytes) })
        })
        tab.terminal.onBinary((data) => {
            const bytes = new TextEncoder().encode(data)
            enqueueWrite(sessionId, async () => { await writeSession(sessionId, bytes) })
        })
    }

    function observeTerminalHost (tab: TerminalTab): void {
        if (!tab.host) return
        tab.resizeObserver?.disconnect()
        tab.resizeObserver = new ResizeObserver(() => {
            requestAnimationFrame(() => tab.fitAddon?.fit())
        })
        tab.resizeObserver.observe(tab.host)
    }

    async function copyTerminalSelection (tab: TerminalTab): Promise<boolean> {
        const text = tab.terminal?.getSelection() ?? ''
        if (!text) return false
        try {
            await clipboardWriteText(text)
            return true
        } catch {
            try {
                await navigator.clipboard.writeText(text)
                return true
            } catch {
                return false
            }
        }
    }

    async function pasteTerminalClipboard (tab: TerminalTab): Promise<void> {
        try {
            let text = ''
            try {
                text = await clipboardReadText()
            } catch {
                text = await navigator.clipboard.readText()
            }
            if (text) tab.terminal?.paste(text)
        } catch {
            // Clipboard may be temporarily unavailable; leave terminal input unchanged.
        }
    }

    function activateTab (tab: TerminalTab): void {
        if (splitPaneIds.length > 1 && !splitPaneIds.includes(tab.session.id)) closeSplit()
        activeId = tab.session.id
        setActiveTerminal(tab.session.id)
        showHome = false
        showSftp = false
        sftpSudoPassword = ''
        sftpSudoMode = false
        requestAnimationFrame(() => {
            tab.fitAddon?.fit()
            tab.terminal?.focus()
        })
    }

    // SFTP sudo 密码仅本次使用，关闭面板/切换 tab 即清理（L15）
    function closeSftpPanel (): void {
        showSftp = false
        sftpSudoPassword = ''
    }

    function terminalWorkingDirectory (tab: TerminalTab): string | null {
        const buffer = tab.terminal?.buffer.active
        if (!buffer) return null
        const lines: string[] = []
        const start = Math.max(0, buffer.baseY - 80)
        for (let index = start; index <= buffer.baseY + buffer.cursorY; index++) {
            const line = buffer.getLine(index)?.translateToString(true).trim()
            if (line) lines.push(line)
        }
        for (let index = lines.length - 1; index >= 0; index--) {
            const match = lines[index].match(/(?:^|\s)(\/[^\s:$>]+|~(?:\/[^\s:$>]*)?)(?:\s*[$#>]\s*)$/)
            if (match) return match[1]
        }
        return null
    }

    function sftpHome (tab: TerminalTab): string {
        const user = tab.ssh?.user.trim() || ''
        return user === 'root' ? '/root' : user ? `/home/${user}` : '/'
    }

    function resolveSftpPath (tab: TerminalTab): string {
        const path = terminalWorkingDirectory(tab)
        if (!path || path === '~') return path === '~' ? sftpHome(tab) : sftpHome(tab)
        return path.startsWith('~/') ? `${sftpHome(tab)}${path.slice(1)}` : path
    }

    function openSftpForTab (tab: TerminalTab): void {
        const path = resolveSftpPath(tab)
        const isRootPath = path === '/root' || path.startsWith('/root/')
        if (isRootPath && tab.ssh?.user !== 'root') {
            sftpPrompt = { tab, path }
            return
        }
        sftpInitialPath = path
        sftpSudoMode = false
        sftpSudoPassword = ''
        showSftp = true
    }

    function openNormalSftp (): void {
        if (!sftpPrompt) return
        sftpInitialPath = sftpPrompt.path
        sftpSudoMode = false
        sftpSudoPassword = ''
        sftpPrompt = null
        showSftp = true
    }

    function openSudoSftp (): void {
        if (!sftpPrompt || !sftpSudoPassword.trim()) return
        sftpInitialPath = sftpPrompt.path
        sftpSudoMode = true
        sftpPrompt = null
        showSftp = true
    }

    async function addLocalTab (): Promise<void> {
        try {
            const session = await openLocalSession()
            const tab: TerminalTab = { session, terminal: null, fitAddon: null, host: null, resizeObserver: null, sequence: 0, ssh: null, decoratorCleanups: null, sudoAction: null }
            tabs.push(tab)
            activeId = session.id
            showHome = false
            persistTabRecovery()
        } catch (cause) {
            error = cause instanceof Error ? cause.message : String(cause)
        }
    }

    function requestVaultPassphrase (): Promise<string | null> {
        if (vaultPassphrasePrompt) return Promise.resolve(null)
        vaultPassphrase = ''
        return new Promise((resolve) => { vaultPassphrasePrompt = { resolve } })
    }

    function finishVaultPassphrase (value: string | null): void {
        const request = vaultPassphrasePrompt
        vaultPassphrasePrompt = null
        const passphrase = vaultPassphrase
        vaultPassphrase = ''
        request?.resolve(value === null ? null : passphrase)
    }

    async function exportTerminal (tab: TerminalTab): Promise<void> {
        if (!tab.terminal) return
        const path = await pickSavePath('导出终端内容', `${tab.session.title || 'terminal'}.txt`)
        if (!path) return
        const lines: string[] = []
        const buffer = tab.terminal.buffer.active
        for (let index = 0; index < buffer.length; index++) {
            lines.push(buffer.getLine(index)?.translateToString(true) ?? '')
        }
        const bytes = new TextEncoder().encode(lines.join('\n') + '\n')
        let binary = ''
        for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000))
        await writeLocalChunk(path, btoa(binary), false)
    }

    function quoteDroppedPath (path: string): string {
        return /[\s"']/.test(path) ? `"${path.replaceAll('"', '\\"')}"` : path
    }

    function dropTerminalPath (tab: TerminalTab, event: DragEvent): void {
        event.preventDefault()
        const files = [...(event.dataTransfer?.files ?? [])]
        const paths = files.map((file) => (file as File & { path?: string }).path).filter((path): path is string => Boolean(path))
        if (!paths.length) return
        const data = paths.map(quoteDroppedPath).join(' ')
        enqueueWrite(tab.session.id, async () => { await writeSession(tab.session.id, new TextEncoder().encode(data)) })
    }

    async function cloneTab (source: TerminalTab): Promise<TerminalTab | null> {
        const previousActive = activeId
        const before = new Set(tabs.map((tab) => tab.session.id))
        try {
            if (source.session.kind === 'local') {
                const session = await openLocalSession(source.terminal?.cols ?? 120, source.terminal?.rows ?? 36, undefined, terminalWorkingDirectory(source) ?? undefined)
                const clone: TerminalTab = { session, terminal: null, fitAddon: null, host: null, resizeObserver: null, sequence: 0, ssh: null, decoratorCleanups: null, sudoAction: null }
                tabs.push(clone)
                persistTabRecovery()
                activeId = previousActive
                return clone
            }
            if (!source.ssh?.profile) {
                error = '当前 SSH 会话未绑定主机配置，无法复制'
                return null
            }
            await connectHost(source.ssh.profile)
            const clone = tabs.find((tab) => !before.has(tab.session.id) && tab.ssh?.profile?.id === source.ssh?.profile?.id) ?? null
            activeId = previousActive
            showHome = false
            return clone
        } catch (cause) {
            error = cause instanceof Error ? cause.message : String(cause)
            activeId = previousActive
            return null
        }
    }

    async function splitTab (source: TerminalTab, direction: 'vertical' | 'horizontal'): Promise<void> {
        const current = source.session.id
        const second = await cloneTab(source)
        if (!second) return
        splitDirection = splitDirection ?? direction
        localStorage.setItem('issh.splitDirection', splitDirection)
        splitPaneIds = splitPaneIds.length > 0 ? [...splitPaneIds, second.session.id] : [current, second.session.id]
        splitLayout = { type: 'split', orientation: splitDirection, ratios: splitPaneIds.map(() => 1 / splitPaneIds.length), children: splitPaneIds.map((id) => ({ type: 'pane', id })) }
        persistSplitLayout(splitLayout)
        persistTabRecovery()
        activeId = current
    }

    async function splitActive (direction: 'vertical' | 'horizontal'): Promise<void> {
        const source = tabs.find((tab) => tab.session.id === activeId)
        if (source) await splitTab(source, direction)
    }

    function duplicateTab (source: TerminalTab): void {
        void cloneTab(source)
    }

    function showTabMenu (event: MouseEvent, tab: TerminalTab): void {
        event.preventDefault()
        event.stopPropagation()
        tabMenu = {
            x: Math.max(8, Math.min(event.clientX, window.innerWidth - 230)),
            y: Math.max(8, Math.min(event.clientY, window.innerHeight - 180)),
            items: [
                { label: '复制', action: () => duplicateTab(tab) },
                { label: '右分屏', action: () => { void splitTab(tab, 'vertical') } },
                { label: '下分屏', action: () => { void splitTab(tab, 'horizontal') } },
                { label: '关闭', danger: true, action: () => { void closeTab(tab) } },
            ],
        }
    }

    function closeSplit (): void {
        splitDirection = null
        splitPaneIds = []
        maximizedPaneId = null
        localStorage.removeItem('issh.splitDirection')
        splitLayout = null
        persistSplitLayout(null)
        persistTabRecovery()
    }

    function togglePaneMaximize (): void {
        if (!splitDirection || splitPaneIds.length < 2) return
        maximizedPaneId = maximizedPaneId === activeId ? null : activeId
    }

    function navigatePane (offset: number): void {
        if (!splitPaneIds.length) return
        const index = splitPaneIds.indexOf(activeId)
        const next = splitPaneIds[(index + offset + splitPaneIds.length) % splitPaneIds.length]
        const tab = tabs.find((item) => item.session.id === next)
        if (tab) activateTab(tab)
    }

    function reorderPane (targetId: string): void {
        if (!draggedPaneId || draggedPaneId === targetId || !splitPaneIds.includes(draggedPaneId) || !splitPaneIds.includes(targetId)) return
        const next = [...splitPaneIds]
        const from = next.indexOf(draggedPaneId)
        const to = next.indexOf(targetId)
        next.splice(from, 1)
        next.splice(to, 0, draggedPaneId)
        splitPaneIds = next
        if (splitLayout?.type === 'split') {
            splitLayout = { ...splitLayout, children: next.map((id) => ({ type: 'pane', id })), ratios: next.map(() => 1 / next.length) }
            persistSplitLayout(splitLayout)
        }
        persistTabRecovery()
        draggedPaneId = null
    }

    function startSplitResize (event: PointerEvent): void {
        if (!splitDirection || splitPaneIds.length !== 2) return
        event.preventDefault()
        const start = splitDirection === 'vertical' ? event.clientX : event.clientY
        const host = event.currentTarget as HTMLElement
        const rect = host.parentElement?.getBoundingClientRect()
        if (!rect) return
        const total = splitDirection === 'vertical' ? rect.width : rect.height
        const startRatio = splitRatio
        const onMove = (move: PointerEvent) => {
            const delta = (splitDirection === 'vertical' ? move.clientX : move.clientY) - start
            splitRatio = Math.min(80, Math.max(20, startRatio + (delta / total) * 100))
        }
        const onUp = () => {
            localStorage.setItem('issh.splitRatio', String(splitRatio))
            window.removeEventListener('pointermove', onMove)
            window.removeEventListener('pointerup', onUp)
        }
        window.addEventListener('pointermove', onMove)
        window.addEventListener('pointerup', onUp, { once: true })
    }

    function handleGlobalHotkeys (event: KeyboardEvent): void {
        if (localStorage.getItem('issh.globalHotkey') === 'false') return
        const target = event.target as HTMLElement | null
        if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable)) return
        // xterm 终端内按键不拦截（Ctrl+W 等已在 xterm 内处理，避免浏览器关闭标签页）
        if (target && target.classList.contains('xterm-helper-textarea')) return
        const ctrl = event.ctrlKey || event.metaKey
        if (!ctrl) return
        const key = event.key.toLowerCase()
        if (event.altKey && !event.shiftKey && key === 'arrowright') {
            event.preventDefault()
            void splitActive('vertical')
            return
        }
        if (event.altKey && !event.shiftKey && key === 'arrowdown') {
            event.preventDefault()
            void splitActive('horizontal')
            return
        }
        if (event.altKey && (key === '0' || key === 'escape')) {
            event.preventDefault()
            closeSplit()
            return
        }
        if (event.altKey && key === 'enter') {
            event.preventDefault()
            togglePaneMaximize()
            return
        }
        if (event.altKey && event.shiftKey && (key === 'arrowleft' || key === 'arrowup')) {
            event.preventDefault()
            navigatePane(-1)
            return
        }
        if (event.altKey && event.shiftKey && (key === 'arrowright' || key === 'arrowdown')) {
            event.preventDefault()
            navigatePane(1)
            return
        }
        if (event.shiftKey && key === 't') {
            event.preventDefault()
            void addLocalTab()
        } else if (event.shiftKey && key === 's') {
            event.preventDefault()
            showSend = !showSend
        } else if (!event.shiftKey && key === 'w') {
            event.preventDefault()
            const tab = tabs.find((candidate) => candidate.session.id === activeId)
            if (tab) void closeTab(tab)
        } else if (event.key === 'Tab') {
            event.preventDefault()
            if (tabs.length === 0) return
            const index = tabs.findIndex((candidate) => candidate.session.id === activeId)
            const next = event.shiftKey
                ? (index - 1 + tabs.length) % tabs.length
                : (index + 1) % tabs.length
            activeId = tabs[next]?.session.id ?? activeId
        } else if (!event.shiftKey && key === ',') {
            event.preventDefault()
            showSettings = true
        }
    }

    async function checkUpdatesOnStartup (): Promise<void> {
        if (localStorage.getItem('issh.plugins.autoUpdateCheck') === 'false') return
        const registryUrl = localStorage.getItem('issh.plugins.registryUrl')
        if (!registryUrl) return
        pluginUpdates = await checkPluginUpdates(registryUrl)
    }

    setProfileWriteConfirm((message) => new Promise<boolean>((resolve) => {
        confirmMessage = message
        confirmResolve = resolve
    }))

    let confirmMessage = $state('')
    let confirmResolve: ((ok: boolean) => void) | null = null

    function resolveConfirm (ok: boolean): void {
        confirmMessage = ''
        const resolve = confirmResolve
        confirmResolve = null
        resolve?.(ok)
    }

    function dismissUpdateNotice (): void {
        pluginUpdates = []
    }

    // Electron 存的私钥路径可能是 file:// URI（file://c:\... 或 file:///c:/...），
    // isshd 只接受纯文件路径；%h/%r 模板连接时展开。
    function normalizeKeyPath (path: string, host: string, user: string): string {
        let p = path.trim()
        if (p.toLowerCase().startsWith('file://')) {
            p = p.slice(7)
            // file:///c:/... → c:/...（盘符前的多余斜杠）；Linux 绝对路径 /home/... 保留
            if (p.length >= 3 && p[0] === '/' && /[a-zA-Z]/.test(p[1]) && p[2] === ':') {
                p = p.slice(1)
            }
        }
        return p.replace(/%h/g, host).replace(/%r/g, user)
    }

    async function resolveJumpProfile (profile: SshHostProfile, profiles: SshHostProfile[], seen = new Set<string>()): Promise<OpenSshSessionOptions | undefined> {
        const jumpId = profile.jumpHost?.trim()
        if (!jumpId) return undefined
        if (seen.has(jumpId) || jumpId === profile.id) throw new Error('跳板机配置存在循环引用')
        const jump = profiles.find((candidate) => candidate.id === jumpId)
        if (!jump) throw new Error(`未找到跳板机配置“${jumpId}”`)
        const expectedHostKey = localStorage.getItem(`issh.trustedHostKey.${jump.host}:${jump.port}`)
        if (!expectedHostKey) throw new Error(`请先单独连接跳板机“${jump.name}”并确认其主机密钥`)
        const keyPath = jump.privateKeys[0] ? normalizeKeyPath(jump.privateKeys[0], jump.host, jump.user) : ''
        let password = ''
        let privateKeyPassphrase = ''
        try {
            password = (await resolveSshPassword(jump.user, jump.host, jump.port)) ?? ''
            privateKeyPassphrase = (await resolveKeyPassphrase(jump.user, jump.host, jump.port, keyPath || undefined)) ?? ''
        } catch {}
        const nextSeen = new Set(seen)
        nextSeen.add(profile.id)
        const nested = await resolveJumpProfile(jump, profiles, nextSeen)
        return {
            title: jump.name,
            host: jump.host,
            port: jump.port,
            username: jump.user,
            ...(password ? { password } : {}),
            ...(keyPath ? { privateKeyPath: keyPath } : {}),
            ...(privateKeyPassphrase ? { privateKeyPassphrase } : {}),
            expectedHostKey,
            ...(jump.auth === 'keyboardInteractive' ? { keyboardInteractive: true } : {}),
            ...(jump.proxyCommand ? { proxyCommand: jump.proxyCommand } : {}),
            ...(jump.httpProxyHost ? { httpProxyHost: jump.httpProxyHost, httpProxyPort: jump.httpProxyPort } : {}),
            ...(jump.socksProxyHost ? { socksProxyHost: jump.socksProxyHost, socksProxyPort: jump.socksProxyPort } : {}),
            ...(nested ? { jump: nested } : {}),
        }
    }

    async function connectHost (profile: SshHostProfile): Promise<void> {
        connectError = ''
        connecting = true
        try {
            const keyPath = profile.privateKeys[0] ?? ''
            const expandedKeyPath = keyPath ? normalizeKeyPath(keyPath, profile.host, profile.user) : ''
            // 从已解锁的 vault 解析保存的密码/口令
            let password = ''
            let keyPassphrase = ''
            const profiles = (await hostProfiles()).profiles
            const jump = await resolveJumpProfile(profile, profiles)
            try {
                password = (await resolveSshPassword(profile.user, profile.host, profile.port)) ?? ''
                keyPassphrase = (await resolveKeyPassphrase(profile.user, profile.host, profile.port, expandedKeyPath || undefined)) ?? ''
            } catch {
                // vault 未解锁时忽略，走指纹确认流程手动输入
            }
            await connectWithParams({
                host: profile.host,
                port: profile.port,
                user: profile.user,
                password,
                keyPath: expandedKeyPath,
                keyPassphrase,
                vaultSecretId: '',
                title: profile.name,
                profile,
                jump,
            })
        } catch (cause) {
            connectError = cause instanceof Error ? cause.message : String(cause)
            showConnect = true
        } finally {
            connecting = false
        }
    }

    async function connectWithParams (params: PendingConnect): Promise<void> {
        const fingerprint = await discoverSshHostKey(params.host, params.port)
        pendingFingerprint = fingerprint.fingerprint
        pendingParams = params
        const trustKey = `issh.trustedHostKey.${params.host}:${params.port}`
        const trustedFingerprint = localStorage.getItem(trustKey)
        if (trustedFingerprint === fingerprint.fingerprint) {
            // 指纹未变化时复用已确认的信任记录，不再重复弹窗。
            await confirmFingerprint()
            return
        }
        pendingConnect = true
        showConnect = true
    }

    async function confirmFingerprint (): Promise<void> {
        if (!pendingParams) return
        connectError = ''
        connecting = true
        const params = pendingParams
        // 先快照指纹：下方清空 pendingFingerprint 后 tab 仍需记录它供 Reconnect 使用
        const fingerprint = pendingFingerprint
        try {
            const session = await openSshSession({
                title: params.title?.trim() || `${params.user}@${params.host}`,
                host: params.host,
                port: params.port,
                username: params.user,
                ...(params.password || formPassword ? { password: params.password || formPassword } : {}),
                ...(params.keyPath ? { privateKeyPath: params.keyPath } : {}),
                ...(params.keyPassphrase || formKeyPassphrase ? { privateKeyPassphrase: params.keyPassphrase || formKeyPassphrase } : {}),
                expectedHostKey: fingerprint,
                ...(params.vaultSecretId ? { vaultSecretId: params.vaultSecretId } : {}),
                ...(params.profile?.agentForward ? { agentForward: true } : {}),
                ...(params.profile?.auth === 'keyboardInteractive' ? { keyboardInteractive: true } : {}),
                ...(params.profile?.x11 ? { x11: true } : {}),
                ...(params.profile?.jumpHost ? { jumpHost: params.profile.jumpHost } : {}),
                ...(params.jump ? { jump: params.jump } : {}),
                ...(params.profile?.proxyCommand ? { proxyCommand: params.profile.proxyCommand } : {}),
                ...(params.profile?.forwardedPorts?.length ? { forwardedPorts: params.profile.forwardedPorts } : {}),
                ...(params.profile?.httpProxyHost ? { httpProxyHost: params.profile.httpProxyHost, httpProxyPort: params.profile.httpProxyPort } : {}),
                ...(params.profile?.socksProxyHost ? { socksProxyHost: params.profile.socksProxyHost, socksProxyPort: params.profile.socksProxyPort } : {}),
                ...(params.profile?.reuseSession ? { reuseSession: true } : {}),
            })
            pendingConnect = false
            pendingFingerprint = ''
            pendingParams = null
            showConnect = false
            formPassword = ''
            formKeyPassphrase = ''
            const tab: TerminalTab = {
                session,
                terminal: null,
                fitAddon: null,
                host: null,
                resizeObserver: null,
                sequence: 0,
                ssh: {
                    host: params.host,
                    port: params.port,
                    user: params.user,
                    hostKeyFingerprint: fingerprint,
                    profile: params.profile,
                    keyPath: params.keyPath,
                    jump: params.jump,
                },
                sudoAction: null,
                decoratorCleanups: null,
            }
            localStorage.setItem(`issh.trustedHostKey.${params.host}:${params.port}`, fingerprint)
            tabs.push(tab)
            activeId = session.id
            showHome = false
            void startProfileLocalForwards(session.id, params.profile)
            persistTabRecovery()
        } catch (cause) {
            connectError = cause instanceof Error ? cause.message : String(cause)
        } finally {
            connecting = false
        }
    }

    async function startProfileLocalForwards (sessionId: string, profile: SshHostProfile | null): Promise<void> {
        const forwards = profile?.forwardedPorts ?? []
        for (const forward of forwards) {
            try {
                if (forward.type === 'Dynamic') await startDynamicForward(sessionId, forward)
                else if (forward.type === 'Remote') await startRemoteForward(sessionId, forward)
                else await startLocalForward(sessionId, forward)
            } catch (cause) {
                const label = forward.type === 'Dynamic' ? '动态 SOCKS5' : forward.type === 'Remote' ? '远程' : '本地'
                error = `${label}端口转发 ${forward.host}:${forward.port} 启动失败：${cause instanceof Error ? cause.message : String(cause)}`
            }
        }
    }

    // issh 分支 sshTab 工具栏的 Reconnect：复用上次连接参数重新连接
    async function reconnectTab (tab: TerminalTab): Promise<void> {
        if (!tab.ssh || connecting) return
        const info = tab.ssh
        connectError = ''
        connecting = true
        try {
            // 先关闭旧会话，避免 isshd 侧会话泄漏
            try {
                await closeSession(tab.session.id)
            } catch {
                // 会话可能已关闭
            }
            let password = ''
            let keyPassphrase = ''
            const jump = info.profile ? await resolveJumpProfile(info.profile, (await hostProfiles()).profiles) : undefined
            try {
                password = (await resolveSshPassword(info.user, info.host, info.port)) ?? ''
                keyPassphrase = (await resolveKeyPassphrase(info.user, info.host, info.port, info.keyPath || undefined)) ?? ''
            } catch {
                // vault 未解锁时忽略
            }
            const session = await openSshSession({
                title: info.profile?.name || `${info.user}@${info.host}`,
                host: info.host,
                port: info.port,
                username: info.user,
                ...(password ? { password } : {}),
                ...(info.keyPath ? { privateKeyPath: info.keyPath } : {}),
                ...(keyPassphrase ? { privateKeyPassphrase: keyPassphrase } : {}),
                expectedHostKey: info.hostKeyFingerprint,
                ...(info.profile?.agentForward ? { agentForward: true } : {}),
                ...(info.profile?.auth === 'keyboardInteractive' ? { keyboardInteractive: true } : {}),
                ...(info.profile?.x11 ? { x11: true } : {}),
                ...(info.profile?.socksProxyHost ? { socksProxyHost: info.profile.socksProxyHost, socksProxyPort: info.profile.socksProxyPort } : {}),
                ...(info.profile?.httpProxyHost ? { httpProxyHost: info.profile.httpProxyHost, httpProxyPort: info.profile.httpProxyPort } : {}),
                ...(info.profile?.proxyCommand ? { proxyCommand: info.profile.proxyCommand } : {}),
                ...(jump ? { jump } : {}),
            })
            tab.session = session
            tab.sequence = 0
            tab.terminal?.clear()
            // 重连后 sessionId 变化：重注册 terminalRegistry、重挂 decorators
            unregisterTerminal(tab.session.id)
            registerTerminal(session.id, {
                terminal: tab.terminal!,
                title: session.title,
                write: (data) => {
                    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data
                    enqueueWrite(session.id, async () => { await writeSession(session.id, bytes) })
                },
            })
            runDecoratorCleanups(tab)
            applyTerminalDecorators(tab)
            void startProfileLocalForwards(session.id, info.profile)
        } catch (cause) {
            error = cause instanceof Error ? cause.message : String(cause)
        } finally {
            connecting = false
        }
    }

    async function mountTerminal (tab: TerminalTab, host: HTMLDivElement): Promise<void> {
        if (tab.terminal) return
        const terminal = makeTerminal()
        const fitAddon = new FitAddon()
        terminal.loadAddon(fitAddon)
        tab.terminal = terminal
        tab.fitAddon = fitAddon
        tab.host = host
        bindTerminal(tab)
        applyTerminalDecorators(tab)
        registerTerminal(tab.session.id, {
            terminal,
            title: tab.session.title,
            write: (data) => {
                const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data
                enqueueWrite(tab.session.id, async () => { await writeSession(tab.session.id, bytes) })
            },
        })
        await pollOutput(tab)
        terminal.focus()
    }

    function applyTerminalDecorators (tab: TerminalTab): void {
        if (!tab.terminal) return
        runDecoratorCleanups(tab)
        const cleanups: Array<() => void> = []
        tab.decoratorCleanups = cleanups
        for (const decorator of [autoSudoDecorator, ...getTerminalDecorators()]) {
            try {
                decorator.decorate({
                    sessionId: tab.session.id,
                    kind: tab.session.kind === 'ssh' ? 'ssh' : 'local',
                    title: tab.session.title,
                    terminal: tab.terminal,
                    profile: tab.ssh?.profile
                        ? {
                            name: tab.ssh.profile.name,
                            host: tab.ssh.profile.host,
                            port: tab.ssh.profile.port,
                            user: tab.ssh.profile.user,
                            loginScript: tab.ssh.profile.loginScript,
                        }
                        : null,
                    write: (data) => {
                        const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data
                        enqueueWrite(tab.session.id, async () => { await writeSession(tab.session.id, bytes) })
                    },
                    setAction: (action) => { tab.sudoAction = action },
                    requestVaultPassphrase,
                    dispose: (callback) => { cleanups.push(callback) },
                })
            } catch (cause) {
                console.warn(`[decorator ${decorator.id}] decorate 失败：`, cause)
            }
        }
    }

    function runDecoratorCleanups (tab: TerminalTab): void {
        for (const cleanup of tab.decoratorCleanups ?? []) {
            try { cleanup() } catch { /* decorator 清理失败不阻断 */ }
        }
        tab.decoratorCleanups = null
    }

    function terminalHostAction (node: HTMLDivElement, tab: TerminalTab): { destroy: () => void } {
        tab.host = node
        if (tab.terminal) {
            if (tab.terminal.element && tab.terminal.element.parentElement !== node) {
                node.append(tab.terminal.element)
            }
            observeTerminalHost(tab)
            requestAnimationFrame(() => tab.fitAddon?.fit())
        } else {
            void mountTerminal(tab, node)
        }
        return {
            destroy: () => {
                if (tab.host === node) {
                    tab.resizeObserver?.disconnect()
                    tab.resizeObserver = null
                    tab.host = null
                }
            },
        }
    }

    async function pollOutput (tab: TerminalTab): Promise<void> {
        try {
            const subscription = await subscribeSession(tab.session.id, tab.sequence)
            tab.session = subscription.session
            tab.sequence = subscription.nextAfterSequence
            for (const event of subscription.events) {
                tab.terminal?.write(Uint8Array.from(event.data))
            }
            if (subscription.events.length > 0) {
                // 同一订阅周期内同 sessionId 的数据合并为一次广播，减少沙箱消息风暴
                const merged = subscription.events.map((event) => event.data).flat()
                broadcastSandboxEvent('terminal.data', { sessionId: tab.session.id, data: merged })
            }
            // issh 的默认 behaviorOnSessionEnd=auto：远端 shell 自然退出后关闭页签。
            // 先写入本次订阅的最后输出（例如 logout），再释放终端和 session。
            if (tab.session.state !== 'running') {
                await closeTab(tab)
            }
        } catch {
            // 轮询失败静默处理：下一轮自动重试，避免每轮刷新全局错误提示
        }
    }

    function pollAll (): void {
        if (pollInFlight) return
        pollInFlight = true
        void (async () => {
            for (const tab of tabs) {
                if (tab.session.state === 'closed') continue
                await pollOutput(tab)
            }
            pollInFlight = false
        })()
    }

    async function closeTab (tab: TerminalTab): Promise<void> {
        try {
            await closeSession(tab.session.id)
        } catch {
            // 会话可能已关闭
        }
        tab.resizeObserver?.disconnect()
        tab.resizeObserver = null
        tab.terminal?.dispose()
        runDecoratorCleanups(tab)
        unregisterTerminal(tab.session.id)
        tabs = tabs.filter((candidate) => candidate.session.id !== tab.session.id)
        splitPaneIds = splitPaneIds.filter((id) => id !== tab.session.id)
        if (splitLayout?.type === 'split') {
            const remaining = splitPaneIds
            splitLayout = remaining.length > 1 ? { ...splitLayout, children: remaining.map((id) => ({ type: 'pane', id })), ratios: remaining.map(() => 1 / remaining.length) } : null
            persistSplitLayout(splitLayout)
        }
        persistTabRecovery()
        if (maximizedPaneId === tab.session.id) maximizedPaneId = null
        if (splitPaneIds.length < 2) closeSplit()
        writeQueues.delete(tab.session.id)
        writeQueueLengths.delete(tab.session.id)
        writeQueueWarned.delete(tab.session.id)
        if (activeId === tab.session.id) {
            const next = tabs[0]
            if (next) {
                activateTab(next)
            } else {
                activeId = ''
                showSftp = false
                showSend = false
            }
        }
    }

    async function loadVaultSecrets (): Promise<void> {
        try {
            const status = await vaultStatus()
            if (status.unlocked) {
                vaultSecrets = await vaultListSecrets()
            } else {
                vaultSecrets = []
            }
        } catch {
            vaultSecrets = []
        }
    }

    async function startConnect (): Promise<void> {
        connectError = ''
        connecting = true
        pendingConnect = false
        try {
            const host = formHost.trim()
            const port = Number(formPort) || 22
            if (!host) throw new Error('请输入主机地址')
            if (!formUser.trim()) throw new Error('请输入用户名')
            await connectWithParams({
                host,
                port,
                user: formUser.trim(),
                password: formPassword,
                keyPath: formKeyPath.trim(),
                keyPassphrase: formKeyPassphrase,
                vaultSecretId: formVaultSecretId,
                profile: null,
            })
        } catch (cause) {
            connectError = cause instanceof Error ? cause.message : String(cause)
        } finally {
            connecting = false
        }
    }

    function sendToSession (sessionId: string, bytes: Uint8Array): void {
        enqueueWrite(sessionId, async () => { await writeSession(sessionId, bytes) })
    }

    function openNewSshForm (): void {
        showConnect = true
        void loadVaultSecrets()
    }

    // ssh:// 深链：解析 ssh://user@host:port 或 ssh://user@host 并发起连接
    // （对齐 Electron 分支的 ssh:// 协议处理）
    function handleDeepLinkUrl (raw: string): void {
        let url: URL
        try {
            url = new URL(raw)
        } catch {
            return
        }
        if (url.protocol !== 'ssh:') return
        const user = decodeURIComponent(url.username || '')
        const host = url.hostname
        if (!host) return
        const port = Number(url.port) || 22
        void connectWithParams({
            host,
            port,
            user,
            password: '',
            keyPath: '',
            keyPassphrase: '',
            vaultSecretId: '',
            profile: null,
        }).catch(() => {})
    }

    onMount(() => {
        try {
            const scheme = localStorage.getItem('issh.colorScheme') ?? 'dark'
            document.documentElement.dataset.colorScheme = scheme
            document.documentElement.style.colorScheme = scheme === 'auto' ? 'light dark' : scheme
        } catch {}
        try { showWelcome = localStorage.getItem('issh.enableWelcomeTab') !== 'false' } catch { showWelcome = true }
        void (async () => {
            await refresh()
            await loadVaultSecrets()
            await restoreRecoveredTabs()
            void checkUpdatesOnStartup()
        })()
        pollHandle = setInterval(pollAll, POLL_INTERVAL_MS)
        window.addEventListener('storage', schemeChangeHandler)
        window.addEventListener('issh:terminal-scheme-change', schemeChangeHandler)
        // 深链监听：Rust 侧启动参数/运行期事件统一 emit 到此
        let deepLinkUnlisten: (() => void) | null = null
        void listen<string>('issh://deep-link', (event) => { handleDeepLinkUrl(event.payload) })
            .then((unlisten) => { deepLinkUnlisten = unlisten })
            .catch(() => {})
        // R-046：窗口关闭请求（Rust 侧 prevent_close 后 emit）
        let closeUnlisten: (() => void) | null = null
        void listen('issh://window-close-requested', () => { handleCloseRequest() })
            .then((unlisten) => { closeUnlisten = unlisten })
            .catch(() => {})
        return () => {
            if (pollHandle) clearInterval(pollHandle)
            deepLinkUnlisten?.()
            closeUnlisten?.()
            window.removeEventListener('storage', schemeChangeHandler)
            window.removeEventListener('issh:terminal-scheme-change', schemeChangeHandler)
            for (const tab of tabs) {
                tab.terminal?.dispose()
                void closeSession(tab.session.id)
            }
        }
    })
</script>

<svelte:window onkeydown={handleGlobalHotkeys} />

<div class="app-root">
    {#if pluginUpdates.length > 0}
        <div class="plugin-update-notice" role="status">
            <span>插件更新可用：{pluginUpdates.map((update) => `${update.name} v${update.latestVersion}`).join('、')}</span>
            <button class="update-notice-action" type="button" onclick={() => { showSettings = true }}>查看</button>
            <button class="update-notice-dismiss" type="button" onclick={dismissUpdateNotice} aria-label="关闭更新提示">×</button>
        </div>
    {/if}
    <header class="tab-bar">
        {#if !vaultLocked}
            <button
                class="btn-tab-bar profile-button"
                type="button"
                onclick={() => { showSelector = true }}
                title="Profiles & connections"
                aria-label="Profiles & connections"
            >▦</button>
        {/if}
        <div class="tabs">
            {#each tabs as tab, index (tab.session.id)}
                <button
                    class="tab-header"
                    class:active={tab.session.id === activeId}
                    type="button"
                    onclick={() => activateTab(tab)}
                    oncontextmenu={(event) => showTabMenu(event, tab)}
                    draggable={splitPaneIds.includes(tab.session.id)}
                    ondragstart={() => { draggedPaneId = tab.session.id }}
                    ondragover={(event) => { if (draggedPaneId) event.preventDefault() }}
                    ondrop={(event) => { event.preventDefault(); reorderPane(tab.session.id) }}
                    ondragend={() => { draggedPaneId = null }}
                    title={tab.session.title}
                >
                    <span class="tab-status" class:open={tab.session.state !== 'closed'}></span>
                    <span class="tab-index">{index + 1}</span>
                    <span class="tab-name">{tab.session.title}</span>
                    <span
                        class="tab-close"
                        role="button"
                        tabindex="0"
                        onclick={(event) => { event.stopPropagation(); void closeTab(tab) }}
                        onkeydown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.stopPropagation(); event.preventDefault(); void closeTab(tab) } }}
                        aria-label="关闭标签页"
                    >×</span>
                </button>
            {/each}
        </div>
        <div class="btn-space"></div>
        {#if health}
            <span class="runtime-badge" title={`Runtime ${health.runtimeVersion} · PID ${health.pid}`}>●</span>
        {:else}
            <span class="runtime-badge offline" title="Runtime 未连接">●</span>
        {/if}
        {#if !vaultLocked}
            <button
                class="btn-tab-bar"
                type="button"
                onclick={() => { showSettings = true }}
                title="设置"
                aria-label="设置"
            >⚙</button>
        {/if}
    </header>

    <div class="app-workspace" class:left-open={showSftp && !!activeTab} class:bottom-open={showSend} class:split-vertical={splitDirection === 'vertical'} class:split-horizontal={splitDirection === 'horizontal'} class:multi-split={splitPaneIds.length > 2} class:recursive-split={hasSplitLayout}>
        {#if showStartPage}
            {#if showWelcome}
                <WelcomeHome onclose={() => { showWelcome = false }} />
            {:else}
                <HostManager onconnect={(profile) => void connectHost(profile)} onopenlocal={() => void addLocalTab()} onvaultstate={(locked) => { vaultLocked = locked }} />
            {/if}
        {:else}
            {#if showSftp && activeTab && activeTab.session.kind === 'ssh'}
                <aside class="app-panel-left" aria-label="SFTP 面板">
                    <SftpBrowser sessionId={activeTab.session.id} initialPath={sftpInitialPath} sudoMode={sftpSudoMode} sudoPassword={sftpSudoPassword} onclose={closeSftpPanel} />
                </aside>
            {/if}

            <div class="app-panel-center" style={`--split-ratio: ${splitRatio}%`}>
                <!-- 终端 stack 常驻 DOM：xterm open() 只能执行一次，
                     若用 {#if} 切换会销毁/重建 DOM 导致切回终端空白 -->
                <div class="terminal-stack">
                    {#snippet renderPane(id: string)}
                    {#each tabs.filter((candidate) => candidate.session.id === id) as tab (tab.session.id)}
                        <div
                            class="terminal-pane"
                            class:hidden={!visiblePaneIds.includes(tab.session.id)}
                            class:split-pane={hasSplitLayout && visiblePaneIds.includes(tab.session.id)}
                            class:split-pane-active={hasSplitLayout && tab.session.id === activeId}
                            onclick={() => { if (visiblePaneIds.includes(tab.session.id)) activateTab(tab) }}
                            onkeydown={(event) => { if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); if (visiblePaneIds.includes(tab.session.id)) activateTab(tab) } }}
                            role="button"
                            aria-label={`终端窗格 ${tab.session.title}`}
                            tabindex="0"
                        >
                            <div class="terminal-toolbar">
                                {#if tab.ssh}
                                    <i class="status-dot" class:open={tab.session.state !== 'closed'}></i>
                                    <strong class="toolbar-host">{tab.ssh.user}@{tab.ssh.host}:{tab.ssh.port}</strong>
                                {/if}
                                <span class="toolbar-spacer"></span>
                                {#if tab.sudoAction}
                                    <button
                                        class="toolbar-btn sudo-action"
                                        type="button"
                                        onclick={(event) => { event.stopPropagation(); tab.sudoAction?.invoke(); tab.terminal?.focus() }}
                                        title={tab.sudoAction.label}
                                    >
                                        🔑 <span>{tab.sudoAction.label}</span>
                                    </button>
                                {/if}
                                <button class="toolbar-btn" type="button" onclick={(event) => { event.stopPropagation(); showHomePage() }} title="返回 Home">
                                    ⌂ <span>Home</span>
                                </button>
                                {#if tab.ssh}
                                    <button class="toolbar-btn" type="button" onclick={() => void reconnectTab(tab)} disabled={connecting} title="重新连接">
                                        ↻ <span>Reconnect</span>
                                    </button>
                                    <button class="toolbar-btn" type="button" onclick={() => { if (showSftp) showSftp = false; else openSftpForTab(tab) }} title="SFTP 文件浏览">
                                        🗀 <span>SFTP</span>
                                    </button>
                                {/if}
                                <button class="toolbar-btn" type="button" onclick={() => void exportTerminal(tab)} title="导出终端内容">⇩ <span>Export</span></button>
                                {#if !splitDirection}
                                    <button class="toolbar-btn" type="button" onclick={() => void splitActive('vertical')} title="左右分屏">◫ <span>Split</span></button>
                                    <button class="toolbar-btn" type="button" onclick={() => void splitActive('horizontal')} title="上下分屏">▤ <span>Split</span></button>
                                {:else}
                                    <button class="toolbar-btn" type="button" onclick={() => void splitActive(splitDirection ?? 'vertical')} title="新增窗格">＋ <span>Pane</span></button>
                                    <button class="toolbar-btn" type="button" onclick={togglePaneMaximize} title="最大化当前窗格">□ <span>{maximizedPaneId === tab.session.id ? 'Restore' : 'Maximize'}</span></button>
                                    <button class="toolbar-btn" type="button" onclick={closeSplit} title="关闭分屏">▣ <span>Unsplit</span></button>
                                {/if}
                                <button class="toolbar-btn" type="button" onclick={() => { showSend = !showSend }} title="向多个标签发送输入">
                                    ✈ <span>Send</span>
                                </button>
                            </div>
                            <div
                                class="terminal-host"
                                use:terminalHostAction={tab}
                                ondragover={(event) => { event.preventDefault() }}
                                ondrop={(event) => dropTerminalPath(tab, event)}
                                role="region"
                                aria-label={`终端输入区 ${tab.session.title}`}
                            ></div>
                        </div>
                        {#if splitPaneIds.length === 2 && splitDirection && visiblePaneIds.includes(tab.session.id) && visiblePaneIds.indexOf(tab.session.id) === 0}
                            <button class="split-divider" type="button" aria-label="调整分屏比例" onpointerdown={startSplitResize}></button>
                        {/if}
                    {/each}
                    {/snippet}
                    {#if splitLayout && hasSplitLayout}
                        <SplitLayout node={splitLayout} pane={renderPane} onratiochange={persistRecursiveSplitRatios} />
                    {:else}
                        {#each tabs as tab (tab.session.id)}{@render renderPane(tab.session.id)}{/each}
                    {/if}
                </div>
            </div>

            {#if sandboxPanels.length > 0}
                <div class="app-sandbox-panels">
                    {#each sandboxPanels as { pluginId, panel } (pluginId + ':' + panel.id)}
                        <SandboxPanel {pluginId} {panel} />
                    {/each}
                </div>
            {/if}

            {#if showSend}
                <div class="app-panel-bottom">
                    <BatchInputPanel
                        tabs={tabs.map((tab) => tab.session)}
                        activeId={activeId}
                        onclose={() => { showSend = false }}
                        onwrited={(sessionId, bytes) => sendToSession(sessionId, bytes)}
                    />
                </div>
            {/if}
        {/if}
    </div>

    {#if showSelector}
        <ProfileSelector
            onconnect={(profile) => void connectHost(profile)}
            onopenlocal={() => void addLocalTab()}
            onnewssh={openNewSshForm}
            onclose={() => { showSelector = false }}
        />
    {/if}

    {#if showSettings}
        <Settings onclose={() => { showSettings = false }} />
    {/if}

    {#if confirmMessage}
        <ConfirmDialog message={confirmMessage} onresolve={resolveConfirm} />
    {/if}

    {#if showCloseDialog}
        <div class="confirm-backdrop" role="presentation">
            <div class="confirm-dialog" role="alertdialog" aria-modal="true" aria-label="关闭 issh">
                <div class="confirm-title">关闭 issh</div>
                <pre class="confirm-message">请选择退出方式。最小化到托盘后应用在后台继续运行（Agent Bridge 保持开启）；完全退出会结束进程并自动关闭 Agent Bridge。</pre>
                <label class="settings-toggle">
                    <input type="checkbox" bind:checked={closeRemember} />
                    <span>记住我的选择</span>
                </label>
                <div class="confirm-actions">
                    <button class="secondary" onclick={() => closeChoice('minimize')}>最小化到托盘</button>
                    <button class="primary" onclick={() => closeChoice('quit')}>完全退出</button>
                </div>
            </div>
        </div>
    {/if}

    {#if showConnect}
        <div
            class="modal-backdrop"
            role="presentation"
            onclick={() => { showConnect = false; connectError = ''; pendingConnect = false }}
            onkeydown={(event) => { if (event.key === 'Escape') { showConnect = false; connectError = ''; pendingConnect = false } }}
        >
            <div
                class="connect-panel"
                aria-label="SSH 连接"
                role="dialog"
                aria-modal="true"
                tabindex="-1"
                onclick={(event) => event.stopPropagation()}
                onkeydown={(event) => event.stopPropagation()}
            >
                <h2>SSH 连接</h2>
                {#if pendingConnect}
                    <div class="fingerprint-confirm">
                        <p>主机密钥指纹（SHA256）：</p>
                        <code class="fingerprint">{pendingFingerprint}</code>
                        <p class="fingerprint-hint">首次连接请核对指纹后继续。</p>
                        {#if pendingParams?.keyPath}
                            <p class="fingerprint-key">私钥：{pendingParams.keyPath}</p>
                            {#if !pendingParams.keyPassphrase}
                                <label class="fingerprint-credential">
                                    私钥口令（未从 Vault 获取到，请手动输入；无口令密钥可留空）
                                    <input type="password" bind:value={formKeyPassphrase} autocomplete="off" placeholder="私钥口令（可选）" />
                                </label>
                            {/if}
                        {:else if !pendingParams?.password}
                            <label class="fingerprint-credential">
                                密码（未从 Vault 获取到，请手动输入）
                                <input type="password" bind:value={formPassword} autocomplete="off" placeholder="SSH 登录密码" />
                            </label>
                        {/if}
                        {#if connectError}
                            <p class="connect-error" role="alert">{connectError}</p>
                        {/if}
                        <div class="connect-actions">
                            <button type="button" onclick={() => void confirmFingerprint()} disabled={connecting}>
                                {connecting ? '连接中…' : '信任并连接'}
                            </button>
                            <button type="button" onclick={() => { pendingConnect = false; pendingFingerprint = ''; showConnect = false }} disabled={connecting}>取消</button>
                        </div>
                    </div>
                {:else}
                    <div class="connect-form">
                        <label>主机<input type="text" bind:value={formHost} placeholder="192.168.1.10" /></label>
                        <label>端口<input type="number" bind:value={formPort} min="1" max="65535" /></label>
                        <label>用户名<input type="text" bind:value={formUser} placeholder="root" /></label>
                        <label>密码<input type="password" bind:value={formPassword} autocomplete="off" /></label>
                        <label>私钥路径<input type="text" bind:value={formKeyPath} placeholder="C:\Users\me\.ssh\id_ed25519" /></label>
                        <label>私钥口令<input type="password" bind:value={formKeyPassphrase} autocomplete="off" /></label>
                        <label>
                            Vault 凭据
                            <select bind:value={formVaultSecretId}>
                                <option value="">（不使用）</option>
                                {#each vaultSecrets as secret (secret.id)}
                                    <option value={secret.id}>{secret.id}{secret.description ? ` — ${secret.description}` : ''}</option>
                                {/each}
                            </select>
                        </label>
                        {#if connectError}
                            <p class="connect-error" role="alert">{connectError}</p>
                        {/if}
                        <div class="connect-actions">
                            <button type="button" onclick={() => void startConnect()} disabled={connecting || !formHost.trim() || !formUser.trim()}>
                                {connecting ? '探测中…' : '连接'}
                            </button>
                            <button type="button" onclick={() => { showConnect = false; connectError = '' }} disabled={connecting}>取消</button>
                        </div>
                    </div>
                {/if}
            </div>
        </div>
    {/if}

    {#if error}
        <button
            type="button"
            class="global-error"
            onclick={() => { error = '' }}
        >
            {error}
            <span class="global-error-close">×</span>
        </button>
    {/if}

    {#if sftpPrompt}
        <div class="modal-backdrop" role="presentation" onclick={() => { sftpPrompt = null }}>
            <div class="confirm-modal sftp-sudo-modal" role="dialog" aria-modal="true" aria-labelledby="sftp-sudo-title" tabindex="-1" onclick={(event) => event.stopPropagation()} onkeydown={(event) => event.stopPropagation()}>
                <h2 id="sftp-sudo-title">打开 root 路径</h2>
                <p>当前路径为 <code>{sftpPrompt.path}</code>，普通用户可能没有访问权限。</p>
                <label class="sftp-sudo-label">sudo 密码（仅用于本次 SFTP 通道）
                    <input type="password" bind:value={sftpSudoPassword} autocomplete="off" onkeydown={(event) => { if (event.key === 'Enter') openSudoSftp() }} />
                </label>
                <div class="connect-actions">
                    <button type="button" onclick={openSudoSftp} disabled={!sftpSudoPassword.trim()}>使用 sudo SFTP</button>
                    <button type="button" onclick={openNormalSftp}>普通 SFTP</button>
                    <button type="button" onclick={() => { sftpPrompt = null; sftpSudoPassword = '' }}>取消</button>
                </div>
            </div>
        </div>
    {/if}

    {#if vaultPassphrasePrompt}
        <div class="modal-backdrop" role="presentation" onclick={() => finishVaultPassphrase(null)}>
            <div class="confirm-modal" role="dialog" aria-modal="true" aria-labelledby="sudo-vault-passphrase-title" tabindex="-1" onclick={(event) => event.stopPropagation()} onkeydown={(event) => event.stopPropagation()}>
                <h2 id="sudo-vault-passphrase-title">解锁保险库以填充 sudo 密码</h2>
                <p>仅读取当前 SSH 主机的 sudo 密码，提交后立即重新锁定保险库。</p>
                <label>保险库主口令
                    <input type="password" bind:value={vaultPassphrase} autocomplete="off" use:focusOnMount onkeydown={(event) => { if (event.key === 'Enter') finishVaultPassphrase('submit') }} />
                </label>
                <div class="connect-actions">
                    <button type="button" onclick={() => finishVaultPassphrase('submit')} disabled={!vaultPassphrase}>解锁并填充</button>
                    <button type="button" onclick={() => finishVaultPassphrase(null)}>取消</button>
                </div>
            </div>
        </div>
    {/if}

    {#if tabMenu}
        <ContextMenu x={tabMenu.x} y={tabMenu.y} items={tabMenu.items} onclose={() => { tabMenu = null }} />
    {/if}
</div>
