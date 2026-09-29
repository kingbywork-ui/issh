<script lang="ts">
    import { onMount, untrack } from 'svelte'
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
    import PluginPanelHost from './lib/PluginPanelHost.svelte'
    import { getTerminalDecorators, getSandboxPanels, getPanels, subscribeUi } from './lib/plugins/pluginHost'
    import type { PanelDefinition, PanelHostContext } from './lib/plugins/types'
    import { autoSudoDecorator } from './lib/autoSudo'
    import { registerTerminal, unregisterTerminal, setActiveTerminal } from './lib/plugins/terminalRegistry'
    import { broadcastSandboxEvent, setProfileWriteConfirm } from './lib/plugins/sandboxBridge'
    import ConfirmDialog from './lib/ConfirmDialog.svelte'
    import ContextMenu, { type ContextMenuItem } from './lib/ContextMenu.svelte'
    import SplitLayout from './lib/SplitLayout.svelte'
    import { insertSplitPane, layoutLeaves, removeSplitPane, type SplitLayoutNode } from './lib/splitLayout'
    import { focusOnMount } from './lib/a11y'
    import { connectionCredentials, retryConnectionCredentials, type ConnectionAuth } from './lib/connectCredentials'
    import { checkPluginUpdates, type PluginUpdateInfo } from './lib/plugins/pluginHost'
    import { findScheme } from './lib/terminalSchemes'
    import {
        appQuit,
        clipboardReadText,
        clipboardWriteText,
        closeSession,
        discoverSshHostKey,
        hostProfiles,
        mutateHostProfiles,
        minimizeToTray,
        openLocalSession,
        openSshSession,
        resolveKeyPassphrase,
        resolveSshPassword,
        saveHostCredential,
        startLocalForward,
        startDynamicForward,
        startRemoteForward,
        resizeSession,
        runtimeHealth,
        setActiveSession,
        subscribeSession,
        syncWorkspaceSessions,
        vaultListSecrets,
        vaultStatus,
        writeSession,
        pickSavePath,
        writeLocalChunk,
        openExternalUrl,
        type RuntimeHealth,
        type RuntimeSessionSnapshot,
        type SshHostProfile,
        type OpenSshSessionOptions,
        type VaultSecretKey,
    } from './lib/runtime'
    import { registerTerminalLinkifier } from './lib/linkifier'
    import SearchPanel from './lib/SearchPanel.svelte'
    import ToastHost from './lib/ToastHost.svelte'
    import { pushToast } from './lib/toast.svelte'

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
        bracketedPaste: boolean
        pollErrors?: number
        disconnectNotified?: boolean
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

    async function syncWorkspaceState (): Promise<void> {
        try {
            await syncWorkspaceSessions(tabs.map((tab) => ({
                id: tab.session.id,
                title: tab.session.title,
                customTitle: null,
                active: tab.session.id === activeId,
                focused: tab.session.id === activeId,
                profileType: tab.ssh ? 'ssh' : 'local',
                profileName: tab.ssh?.profile?.name ?? null,
                profileId: tab.ssh?.profile?.id ?? null,
                host: tab.ssh?.host ?? null,
                user: tab.ssh?.user ?? null,
                port: tab.ssh?.port ?? null,
                connected: tab.session.state === 'running',
            })))
        } catch (cause) {
            console.warn('[workspace] session sync failed', cause)
        }
    }
    // Agent Bridge：tab 切换时上报当前 active 会话（供外部 agent 的 "active" 引用）
    $effect(() => {
        const currentActiveId = activeId
        void setActiveSession(currentActiveId || null)
        untrack(() => { void syncWorkspaceState() })
    })
    let splitDirection = $state<'vertical' | 'horizontal' | null>((localStorage.getItem('issh.splitDirection') as 'vertical' | 'horizontal' | null) ?? null)
    let splitPaneIds = $state<string[]>([])
    let maximizedPaneId = $state<string | null>(null)
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
    let pendingConnections = $state<Array<{ id: number, name: string, address: string }>>([])
    let activePendingId = $state<number | null>(null)
    let nextPendingId = 0
    let showSelector = $state(false)
    let tabMenu = $state<{ x: number, y: number, items: ContextMenuItem[] } | null>(null)
    let searchOpen = $state(false)
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
    const pluginPanels = $state(getPanels('right'))
    let activePluginPanelId = $state<string | null>(null)
    const activePluginPanel = $derived(pluginPanels.find((panel) => panel.id === activePluginPanelId) ?? null)
    subscribeUi(() => {
        sandboxPanels.length = 0
        sandboxPanels.push(...getSandboxPanels('bottom'))
        pluginPanels.length = 0
        pluginPanels.push(...getPanels('right'))
    })

    function panelHostContext (panel: PanelDefinition): PanelHostContext {
        return {
            getActiveSession: () => {
                const tab = tabs.find((candidate) => candidate.session.id === activeId)
                if (!tab || showHome || !tab.terminal) return null
                const lines: string[] = []
                if (panel.canReadTerminal) {
                    const buffer = tab.terminal.buffer.active
                    const end = buffer.baseY + buffer.cursorY
                    for (let row = Math.max(0, end - 29); row <= end; row += 1) {
                        const line = buffer.getLine(row)
                        if (line) lines.push(line.translateToString(true))
                    }
                }
                return { id: tab.session.id, title: tab.session.title, kind: tab.session.kind, lines }
            },
        }
    }

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
    let formAuth = $state<ConnectionAuth>('auto')
    let formEnvironment = $state('')
    let saveConnectionCredential = $state(false)
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
    const showStartPage = $derived((tabs.length === 0 && pendingConnections.length === 0) || showHome)
    const layoutPaneIds = $derived(splitLayout ? layoutLeaves(splitLayout).filter((id) => tabs.some((tab) => tab.session.id === id)) : [])
    const hasSplitLayout = $derived(layoutPaneIds.length > 1)
    const splitRootId = $derived(hasSplitLayout ? layoutPaneIds[0] : null)
    const headerTabs = $derived(tabs.filter((tab) => !hasSplitLayout || !layoutPaneIds.includes(tab.session.id) || tab.session.id === splitRootId))
    const visiblePaneIds = $derived(maximizedPaneId ? [maximizedPaneId] : (layoutPaneIds.length > 1 ? layoutPaneIds : [activeId]))

    function syncSplitState (): void {
        splitPaneIds = layoutPaneIds
        splitDirection = splitLayout?.type === 'split' ? splitLayout.orientation : null
        if (splitDirection) localStorage.setItem('issh.splitDirection', splitDirection)
        else localStorage.removeItem('issh.splitDirection')
    }

    function persistRecursiveSplitRatios (): void {
        persistSplitLayout(splitLayout)
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
        } catch (cause) {
            pushToast('error', `恢复上次会话失败：无法读取主机配置（${cause instanceof Error ? cause.message : String(cause)}）`, 6000)
        }
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

    // P0 看门狗：周期探测 Runtime 健康；丢失/恢复时通知用户。
    // Tauri 侧 ensure_started 会在 pipe 失达时自动拉起 isshd，所以恢复时无需手动重启。
    const WATCHDOG_INTERVAL_MS = 5000
    const WATCHDOG_DOWN_THRESHOLD = 2
    let watchdogHandle: ReturnType<typeof setInterval> | null = null
    let watchdogInFlight = false
    let runtimeDownCount = 0
    let runtimeWasDown = false

    async function watchRuntime (): Promise<void> {
        if (watchdogInFlight) return
        watchdogInFlight = true
        try {
            const next = await runtimeHealth()
            runtimeDownCount = 0
            if (runtimeWasDown) {
                runtimeWasDown = false
                pushToast('ok', `Runtime 已恢复（PID ${next.pid}）`, 6000)
            }
            health = next
        } catch (cause) {
            runtimeDownCount += 1
            if (runtimeDownCount >= WATCHDOG_DOWN_THRESHOLD && !runtimeWasDown) {
                runtimeWasDown = true
                health = null
                pushToast('error', `Runtime 失去响应（${cause instanceof Error ? cause.message : String(cause)}），正在自动恢复…`, 8000)
            }
        } finally {
            watchdogInFlight = false
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
        // A8 linkifier：URL 点击打开浏览器；绝对路径点击复制到剪贴板
        registerTerminalLinkifier(tab.terminal, (match) => {
            if (match.kind === 'url') {
                void openExternalUrl(match.text).catch(() => {})
            } else {
                void clipboardWriteText(match.text).catch(() => {})
            }
        })
        // A5（R-013）bracketed paste：检测远端 ?2004h/l，vim/编辑器内粘贴多行时自动包装
        tab.terminal.parser.registerCsiHandler({ prefix: '?', final: 'h' }, (params) => {
            if (params[0] === 2004) tab.bracketedPaste = true
            return false
        })
        tab.terminal.parser.registerCsiHandler({ prefix: '?', final: 'l' }, (params) => {
            if (params[0] === 2004) tab.bracketedPaste = false
            return false
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
            if (text) {
                // A5（R-013）：bracketed paste 模式下多行粘贴整体包装，避免 vim/编辑器 autoindent 逐行错乱
                if (tab.bracketedPaste && text.includes('\n')) {
                    const wrapped = `\x1b[200~${text}\x1b[201~`
                    const bytes = new TextEncoder().encode(wrapped)
                    enqueueWrite(tab.session.id, async () => { await writeSession(tab.session.id, bytes) })
                } else {
                    tab.terminal?.paste(text)
                }
            }
        } catch {
            // Clipboard may be temporarily unavailable; leave terminal input unchanged.
        }
    }

    function activateTab (tab: TerminalTab): void {
        if (splitPaneIds.length > 1 && !splitPaneIds.includes(tab.session.id)) closeSplit()
        activePendingId = null
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
            const tab: TerminalTab = { session, terminal: null, fitAddon: null, host: null, resizeObserver: null, sequence: 0, ssh: null, decoratorCleanups: null, sudoAction: null, bracketedPaste: false }
            tabs.push(tab)
            activeId = session.id
            showHome = false
            persistTabRecovery()
            await syncWorkspaceState()
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
                const clone: TerminalTab = { session, terminal: null, fitAddon: null, host: null, resizeObserver: null, sequence: 0, ssh: null, decoratorCleanups: null, sudoAction: null, bracketedPaste: false }
                tabs.push(clone)
                persistTabRecovery()
                activeId = previousActive
                await syncWorkspaceState()
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
            await syncWorkspaceState()
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
        if (splitLayout && !layoutLeaves(splitLayout).includes(current)) closeSplit()
        splitLayout = insertSplitPane(splitLayout, current, second.session.id, direction)
        syncSplitState()
        maximizedPaneId = null
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
                { label: '关闭', danger: true, action: () => { void closeHeaderTab(tab) } },
            ],
        }
    }

    function closeSplit (): void {
        const paneIds = layoutLeaves(splitLayout)
        const rootId = paneIds[0]
        splitDirection = null
        splitPaneIds = []
        maximizedPaneId = null
        localStorage.removeItem('issh.splitDirection')
        splitLayout = null
        persistSplitLayout(null)
        if (paneIds.includes(activeId) && rootId) {
            activeId = rootId
            setActiveTerminal(rootId)
            requestAnimationFrame(() => {
                if (activeId !== rootId) return
                const root = tabs.find((tab) => tab.session.id === rootId)
                root?.fitAddon?.fit()
                root?.terminal?.focus()
            })
        }
        for (const id of paneIds.slice(1)) {
            const tab = tabs.find((candidate) => candidate.session.id === id)
            if (tab) void closeTab(tab)
        }
        persistTabRecovery()
    }

    async function closeHeaderTab (tab: TerminalTab): Promise<void> {
        if (hasSplitLayout && tab.session.id === splitRootId) closeSplit()
        await closeTab(tab)
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

    // 应用级快捷键统一在 window 捕获阶段处理，先于 xterm textarea 收到按键。
    // 焦点在终端内时仅拦截与终端输入无冲突的应用快捷键（Ctrl+0 Home、Ctrl+Shift+T/S/D/F/B、Ctrl+,、Ctrl+Tab、Ctrl+W），
    // Ctrl+C、Alt+方向键等保留给 shell，避免破坏终端语义。
    function handleGlobalHotkeys (event: KeyboardEvent): void {
        if (localStorage.getItem('issh.globalHotkey') === 'false') return
        const target = event.target as HTMLElement | null
        const inTerminal = !!target && (target.classList.contains('xterm-helper-textarea') || !!target.closest('.xterm-helper-textarea'))
        if (!inTerminal && target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable)) return
        const ctrl = event.ctrlKey || event.metaKey
        if (!ctrl) return
        const key = event.key.toLowerCase()
        if (inTerminal && !(event.key === 'Tab' || (event.shiftKey && (key === 't' || key === 's' || key === 'f' || key === 'd' || key === 'b')) || (!event.shiftKey && (key === 'w' || key === ',' || key === '0')))) return
        let handled = false
        if (!inTerminal && event.altKey && !event.shiftKey && key === 'arrowright') {
            handled = true
            void splitActive('vertical')
        } else if (!inTerminal && event.altKey && !event.shiftKey && key === 'arrowdown') {
            handled = true
            void splitActive('horizontal')
        } else if (!inTerminal && event.altKey && (key === '0' || key === 'escape')) {
            handled = true
            closeSplit()
        } else if (!inTerminal && event.altKey && key === 'enter') {
            handled = true
            togglePaneMaximize()
        } else if (!inTerminal && event.altKey && event.shiftKey && (key === 'arrowleft' || key === 'arrowup')) {
            handled = true
            navigatePane(-1)
        } else if (!inTerminal && event.altKey && event.shiftKey && (key === 'arrowright' || key === 'arrowdown')) {
            handled = true
            navigatePane(1)
        } else if (event.shiftKey && key === 't') {
            handled = true
            void addLocalTab()
        } else if (event.shiftKey && key === 's') {
            // 左右分屏
            handled = true
            void splitActive('vertical')
        } else if (event.shiftKey && key === 'd') {
            // 上下分屏
            handled = true
            void splitActive('horizontal')
        } else if (event.shiftKey && key === 'b') {
            // 批量输入（由原 Ctrl+Shift+S 迁移，Ctrl+Shift+S 已让位给左右分屏）
            handled = true
            showSend = !showSend
        } else if (event.shiftKey && key === 'f') {
            // A6 终端内搜索：终端焦点下同样生效
            handled = true
            searchOpen = !searchOpen
        } else if (event.key === 'Tab') {
            handled = true
            if (headerTabs.length > 0) {
                const currentId = layoutPaneIds.includes(activeId) ? splitRootId : activeId
                const index = headerTabs.findIndex((candidate) => candidate.session.id === currentId)
                const next = event.shiftKey
                    ? (index - 1 + headerTabs.length) % headerTabs.length
                    : (index + 1) % headerTabs.length
                const tab = headerTabs[next]
                if (tab) activateTab(tab)
            }
        } else if (!event.shiftKey && key === 'w') {
            handled = true
            const tab = tabs.find((candidate) => candidate.session.id === activeId)
            if (tab) void (tab.session.id === splitRootId ? closeHeaderTab(tab) : closeTab(tab))
        } else if (!event.shiftKey && key === ',') {
            handled = true
            showSettings = true
        } else if (!event.shiftKey && key === '0') {
            // Home：返回首页（保留已打开的标签）
            handled = true
            showHomePage()
        }
        if (handled) {
            event.preventDefault()
            // 捕获阶段截断传播：xterm textarea 收不到按键，组合键不会转发给 shell
            event.stopPropagation()
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

    // 认证方式决定连接时使用的凭据组合：密码/交互式不使用私钥，私钥不使用密码，其余（自动/Agent）两者都尝试。
    function credentialPolicy (profile: SshHostProfile): { useKey: boolean, usePassword: boolean } {
        const auth = profile.auth ?? ''
        return {
            useKey: auth !== 'password' && auth !== 'keyboardInteractive',
            usePassword: auth !== 'publicKey',
        }
    }

    async function resolveJumpProfile (profile: SshHostProfile, profiles: SshHostProfile[], seen = new Set<string>()): Promise<OpenSshSessionOptions | undefined> {
        const jumpId = profile.jumpHost?.trim()
        if (!jumpId) return undefined
        if (seen.has(jumpId) || jumpId === profile.id) throw new Error('跳板机配置存在循环引用')
        const jump = profiles.find((candidate) => candidate.id === jumpId)
        if (!jump) throw new Error(`未找到跳板机配置“${jumpId}”`)
        const expectedHostKey = localStorage.getItem(`issh.trustedHostKey.${jump.host}:${jump.port}`)
        if (!expectedHostKey) throw new Error(`请先单独连接跳板机“${jump.name}”并确认其主机密钥`)
        const policy = credentialPolicy(jump)
        const keyPath = policy.useKey && jump.privateKeys[0] ? normalizeKeyPath(jump.privateKeys[0], jump.host, jump.user) : ''
        let password = ''
        let privateKeyPassphrase = ''
        try {
            password = policy.usePassword ? (await resolveSshPassword(jump.user, jump.host, jump.port)) ?? '' : ''
            privateKeyPassphrase = policy.useKey ? (await resolveKeyPassphrase(jump.user, jump.host, jump.port, keyPath || undefined)) ?? '' : ''
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
        const pendingId = ++nextPendingId
        pendingConnections.push({ id: pendingId, name: profile.name, address: `${profile.user}@${profile.host}:${profile.port}` })
        activePendingId = pendingId
        showHome = false
        connectError = ''
        connecting = true
        const policy = credentialPolicy(profile)
        const keyPath = policy.useKey ? (profile.privateKeys[0] ?? '') : ''
        const expandedKeyPath = keyPath ? normalizeKeyPath(keyPath, profile.host, profile.user) : ''
        const params: PendingConnect = {
            host: profile.host,
            port: profile.port,
            user: profile.user,
            password: '',
            keyPath: expandedKeyPath,
            keyPassphrase: '',
            vaultSecretId: '',
            title: profile.name,
            profile,
        }
        prepareConnectionForm(params)
        try {
            // 从已解锁的 vault 解析保存的密码/口令
            const jump = profile.jumpHost ? await resolveJumpProfile(profile, (await hostProfiles()).profiles) : undefined
            const [passwordResult, keyPassphraseResult] = await Promise.allSettled([
                policy.usePassword ? resolveSshPassword(profile.user, profile.host, profile.port) : Promise.resolve(null),
                policy.useKey ? resolveKeyPassphrase(profile.user, profile.host, profile.port, expandedKeyPath || undefined) : Promise.resolve(null),
            ])
            // Vault 未解锁时单项凭据失败不应丢弃另一项，继续走手动输入。
            if (passwordResult.status === 'fulfilled') params.password = passwordResult.value ?? ''
            if (keyPassphraseResult.status === 'fulfilled') params.keyPassphrase = keyPassphraseResult.value ?? ''
            params.jump = jump
            await connectWithParams(params)
        } catch (cause) {
            connectError = cause instanceof Error ? cause.message : String(cause)
            showConnect = true
        } finally {
            pendingConnections = pendingConnections.filter((entry) => entry.id !== pendingId)
            if (activePendingId === pendingId) activePendingId = pendingConnections[pendingConnections.length - 1]?.id ?? null
            connecting = false
        }
    }

    function prepareConnectionForm (params: PendingConnect): void {
        pendingConnect = false
        pendingFingerprint = ''
        pendingParams = params
        formHost = params.host
        formPort = params.port
        formUser = params.user
        formKeyPath = params.profile?.privateKeys[0] ?? params.keyPath
        formEnvironment = params.profile?.environment ?? ''
        formVaultSecretId = params.vaultSecretId
        formAuth = params.profile?.auth === 'password' || params.profile?.auth === 'publicKey' || params.profile?.auth === 'agent' || params.profile?.auth === 'keyboardInteractive'
            ? params.profile.auth
            : params.profile ? 'auto' : params.keyPath ? 'publicKey' : 'password'
        if (params.profile) {
            formPassword = ''
            formKeyPassphrase = ''
        }
        saveConnectionCredential = false
    }

    async function connectWithParams (params: PendingConnect): Promise<void> {
        prepareConnectionForm(params)
        const fingerprint = await discoverSshHostKey(params.host, params.port)
        pendingFingerprint = fingerprint.fingerprint
        const trustKey = `issh.trustedHostKey.${params.host}:${params.port}`
        const trustedFingerprint = localStorage.getItem(trustKey)
        if (trustedFingerprint === fingerprint.fingerprint && params.user.trim() && !(formAuth === 'publicKey' && !formKeyPath.trim()) && !((formAuth === 'password' || formAuth === 'keyboardInteractive') && !params.password && !formPassword)) {
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
            const user = formUser.trim()
            if (!user) throw new Error('请输入用户名')
            const rawKeyPath = formKeyPath.trim()
            if (formAuth === 'publicKey' && !rawKeyPath) throw new Error('请输入私钥路径')
            const originalKeyPath = params.profile?.privateKeys[0] ?? params.keyPath
            const typedPassword = formAuth === 'auto' || formAuth === 'password' || formAuth === 'keyboardInteractive' ? formPassword : ''
            const typedKeyPassphrase = formAuth === 'auto' || formAuth === 'publicKey' ? formKeyPassphrase : ''
            const credentials = connectionCredentials({
                auth: formAuth,
                user,
                originalUser: params.user,
                password: typedPassword,
                storedPassword: params.password,
                keyPath: rawKeyPath,
                originalKeyPath,
                keyPassphrase: typedKeyPassphrase,
                storedKeyPassphrase: params.keyPassphrase,
            })
            const keyPath = credentials.useKey && rawKeyPath ? normalizeKeyPath(rawKeyPath, params.host, user) : ''
            if (saveConnectionCredential) {
                if (!typedPassword && !typedKeyPassphrase) throw new Error('请先输入需要保存的密码或私钥口令')
                const vault = await hostProfiles()
                if (!vault.encrypted) throw new Error('请先在保险库启用主口令，再保存连接密码')
                if (!vault.unlocked) throw new Error('请先解锁保险库，再保存连接密码')
            }
            const connectedProfile: SshHostProfile | null = params.profile ? {
                ...params.profile,
                user,
                auth: formAuth === 'auto' ? null : formAuth,
                privateKeys: credentials.useKey ? (rawKeyPath ? [rawKeyPath, ...params.profile.privateKeys.slice(1)] : []) : params.profile.privateKeys,
                environment: formEnvironment.trim() || null,
            } : null
            const session = await openSshSession({
                title: params.title?.trim() || `${user}@${params.host}`,
                host: params.host,
                port: params.port,
                username: user,
                ...(credentials.password ? { password: credentials.password } : {}),
                ...(keyPath ? { privateKeyPath: keyPath } : {}),
                ...(credentials.keyPassphrase ? { privateKeyPassphrase: credentials.keyPassphrase } : {}),
                expectedHostKey: fingerprint,
                ...(params.vaultSecretId ? { vaultSecretId: params.vaultSecretId } : {}),
                ...(params.profile?.agentForward ? { agentForward: true } : {}),
                ...(formAuth === 'keyboardInteractive' ? { keyboardInteractive: true } : {}),
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
                    user,
                    hostKeyFingerprint: fingerprint,
                    profile: connectedProfile,
                    keyPath,
                    jump: params.jump,
                },
                sudoAction: null,
                decoratorCleanups: null,
                bracketedPaste: false,
            }
            localStorage.setItem(`issh.trustedHostKey.${params.host}:${params.port}`, fingerprint)
            tabs.push(tab)
            activeId = session.id
            activePendingId = null
            showHome = false
            void startProfileLocalForwards(session.id, connectedProfile)
            persistTabRecovery()
            void syncWorkspaceState()
            try {
                if (connectedProfile && params.profile && (
                    connectedProfile.user !== params.profile.user || connectedProfile.auth !== params.profile.auth ||
                    connectedProfile.environment !== params.profile.environment ||
                    connectedProfile.privateKeys.join('\0') !== params.profile.privateKeys.join('\0')
                )) await mutateHostProfiles({ action: 'updateProfile', profile: connectedProfile })
                if (saveConnectionCredential) await saveHostCredential({
                    user, host: params.host, port: params.port,
                    ...(typedPassword ? { password: typedPassword } : {}),
                    ...(typedKeyPassphrase ? { keyPassphrase: typedKeyPassphrase } : {}),
                })
            } catch (cause) {
                pushToast('error', `连接已建立，但主机或保险库保存失败：${cause instanceof Error ? cause.message : String(cause)}`, 8000)
            }
            formPassword = ''
            formKeyPassphrase = ''
            saveConnectionCredential = false
        } catch (cause) {
            connectError = cause instanceof Error ? cause.message : String(cause)
            // 直连路径（指纹已信任）失败时原本静默无反馈：重新打开连接弹窗，
            // 让用户看到错误并补充凭据（如 vault 中未保存密码导致的认证失败）。
            showConnect = true
            pendingConnect = true
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
            const policy = info.profile ? credentialPolicy(info.profile) : { useKey: true, usePassword: true }
            let password = ''
            let keyPassphrase = ''
            const jump = info.profile ? await resolveJumpProfile(info.profile, (await hostProfiles()).profiles) : undefined
            try {
                password = policy.usePassword ? (await resolveSshPassword(info.user, info.host, info.port)) ?? '' : ''
                keyPassphrase = policy.useKey ? (await resolveKeyPassphrase(info.user, info.host, info.port, info.keyPath || undefined)) ?? '' : ''
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
            await syncWorkspaceState()
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
            tab.pollErrors = 0
            tab.disconnectNotified = false
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
            // 订阅失败不代表 shell 已退出；保留会话并继续探测，避免误杀正在运行的任务。
            tab.pollErrors = (tab.pollErrors ?? 0) + 1
            if (tab.pollErrors >= 3 && !tab.disconnectNotified) {
                tab.disconnectNotified = true
                pushToast('error', `暂时无法读取会话：${tab.session.title}，正在重试`, 6000)
            }
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
        const closePromise = closeSession(tab.session.id).catch(() => { /* 会话可能已关闭 */ })
        tab.resizeObserver?.disconnect()
        tab.resizeObserver = null
        tab.terminal?.dispose()
        runDecoratorCleanups(tab)
        unregisterTerminal(tab.session.id)
        tabs = tabs.filter((candidate) => candidate.session.id !== tab.session.id)
        splitLayout = removeSplitPane(splitLayout, tab.session.id)
        syncSplitState()
        persistSplitLayout(splitLayout)
        persistTabRecovery()
        if (maximizedPaneId === tab.session.id) maximizedPaneId = null
        if (splitLayout && splitPaneIds.length < 2) closeSplit()
        writeQueues.delete(tab.session.id)
        writeQueueLengths.delete(tab.session.id)
        writeQueueWarned.delete(tab.session.id)
        if (activeId === tab.session.id) {
            const next = tabs.find((candidate) => candidate.session.id === layoutLeaves(splitLayout)[0]) ?? tabs[0]
            if (next) {
                activateTab(next)
            } else {
                activeId = ''
                showSftp = false
                showSend = false
            }
        }
        await closePromise
        await syncWorkspaceState()
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
            const user = formUser.trim()
            const keyPath = formKeyPath.trim()
            if (!host) throw new Error('请输入主机地址')
            if (!user) throw new Error('请输入用户名')
            const previous = pendingParams
            const retry = retryConnectionCredentials({
                previous: previous ? { ...previous, profileKeyPath: previous.profile?.privateKeys[0] } : null,
                host, port, user, keyPath,
                password: formPassword,
                keyPassphrase: formKeyPassphrase,
            })
            await connectWithParams({
                host,
                port,
                user,
                password: retry.password,
                keyPath,
                keyPassphrase: retry.keyPassphrase,
                vaultSecretId: formVaultSecretId,
                profile: retry.sameIdentity && retry.sameKeyPath ? previous?.profile ?? null : null,
                title: retry.sameIdentity ? previous?.title : undefined,
                jump: retry.sameIdentity ? previous?.jump : undefined,
            })
        } catch (cause) {
            connectError = cause instanceof Error ? cause.message : String(cause)
        } finally {
            connecting = false
        }
    }

    function cancelConnect (): void {
        if (connecting) return
        showConnect = false
        connectError = ''
        pendingConnect = false
        pendingParams = null
        pendingFingerprint = ''
        formPassword = ''
        formKeyPassphrase = ''
        saveConnectionCredential = false
    }

    function sendToSession (sessionId: string, bytes: Uint8Array): void {
        enqueueWrite(sessionId, async () => { await writeSession(sessionId, bytes) })
    }

    function openNewSshForm (): void {
        formHost = ''
        formPort = 22
        formUser = ''
        formPassword = ''
        formKeyPath = ''
        formKeyPassphrase = ''
        formAuth = 'auto'
        formEnvironment = ''
        formVaultSecretId = ''
        pendingParams = null
        pendingFingerprint = ''
        pendingConnect = false
        connectError = ''
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
        }).catch((cause) => {
            pushToast('error', `深链连接失败：${cause instanceof Error ? cause.message : String(cause)}`, 6000)
        })
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
        watchdogHandle = setInterval(() => { void watchRuntime() }, WATCHDOG_INTERVAL_MS)
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
            if (watchdogHandle) clearInterval(watchdogHandle)
            deepLinkUnlisten?.()
            closeUnlisten?.()
            window.removeEventListener('keydown', handleGlobalHotkeys, true)
            window.removeEventListener('keydown', handleGlobalHotkeys, true)
            window.removeEventListener('storage', schemeChangeHandler)
            window.removeEventListener('issh:terminal-scheme-change', schemeChangeHandler)
            for (const tab of tabs) {
                tab.terminal?.dispose()
                void closeSession(tab.session.id)
            }
        }
    })
    // 全局快捷键监听用 $effect 注册：HMR 热更新会重跑 effect 并重建监听器，
    // 避免 onMount 一次性注册在函数体更新后仍持有旧函数引用（旧快捷键失效）。
    $effect(() => {
        window.removeEventListener('keydown', handleGlobalHotkeys, true)
        window.addEventListener('keydown', handleGlobalHotkeys, true)
        return () => {
            window.removeEventListener('keydown', handleGlobalHotkeys, true)
        }
    })
</script>

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
                title="主机与连接"
                aria-label="主机与连接"
            >▦</button>
        {/if}
        <div class="tabs">
            {#each headerTabs as tab, index (tab.session.id)}
                <button
                    class="tab-header"
                    class:active={activePendingId === null && (tab.session.id === activeId || (tab.session.id === splitRootId && layoutPaneIds.includes(activeId)))}
                    type="button"
                    onclick={() => activateTab(tab)}
                    oncontextmenu={(event) => showTabMenu(event, tab)}
                    title={tab.session.title}
                >
                    <span class="tab-status" class:open={tab.session.state !== 'closed'}></span>
                    <span class="tab-index">{index + 1}</span>
                    <span class="tab-name">{tab.session.title}</span>
                    <span
                        class="tab-close"
                        role="button"
                        tabindex="0"
                        onclick={(event) => { event.stopPropagation(); void closeHeaderTab(tab) }}
                        onkeydown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.stopPropagation(); event.preventDefault(); void closeHeaderTab(tab) } }}
                        aria-label="关闭标签页"
                    >×</span>
                </button>
            {/each}
            {#each pendingConnections as pending (pending.id)}
                <button
                    class="tab-header pending-tab"
                    class:active={activePendingId === pending.id && !showHome}
                    type="button"
                    onclick={() => { activePendingId = pending.id; showHome = false }}
                    title={`正在连接 ${pending.address}`}
                >
                    <span class="tab-status"></span>
                    <span class="tab-name">{pending.name} · 连接中…</span>
                </button>
            {/each}
        </div>
        <div class="btn-space"></div>
        {#if health}
            <span class="runtime-badge" title={`运行时 ${health.runtimeVersion} · 进程 ${health.pid}`}>●</span>
        {:else}
            <span class="runtime-badge offline" title="运行时未连接">●</span>
        {/if}
        {#if !vaultLocked}
            {#each pluginPanels as panel (panel.id)}
                <button
                    class="btn-tab-bar plugin-panel-toggle"
                    class:active={activePluginPanelId === panel.id}
                    type="button"
                    onclick={() => { activePluginPanelId = activePluginPanelId === panel.id ? null : panel.id }}
                    title={panel.title}
                    aria-label={panel.title}
                    aria-pressed={activePluginPanelId === panel.id}
                >{panel.title}</button>
            {/each}
            <button
                class="btn-tab-bar"
                type="button"
                onclick={() => { showSettings = true }}
                title="设置"
                aria-label="设置"
            >⚙</button>
        {/if}
    </header>

    <div class="app-content">
    <div class="app-workspace" class:left-open={showSftp && !!activeTab} class:bottom-open={showSend} class:recursive-split={hasSplitLayout}>
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

            <div class="app-panel-center">
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
                                <button class="toolbar-btn" type="button" onclick={(event) => { event.stopPropagation(); showHomePage() }} title="返回首页">
                                    ⌂ <span>首页</span>
                                </button>
                                {#if tab.ssh}
                                    <button class="toolbar-btn" type="button" onclick={(event) => { event.stopPropagation(); void reconnectTab(tab) }} disabled={connecting} title="重新连接">
                                        ↻ <span>重连</span>
                                    </button>
                                    <button class="toolbar-btn" type="button" onclick={(event) => { event.stopPropagation(); if (showSftp) showSftp = false; else openSftpForTab(tab) }} title="SFTP 文件浏览">
                                        🗀 <span>SFTP</span>
                                    </button>
                                {/if}
                                <button class="toolbar-btn" type="button" onclick={(event) => { event.stopPropagation(); void exportTerminal(tab) }} title="导出终端内容">⇩ <span>导出</span></button>
                                {#if hasSplitLayout}
                                    <button class="toolbar-btn" type="button" onclick={(event) => { event.stopPropagation(); togglePaneMaximize() }} title={maximizedPaneId === tab.session.id ? '还原当前窗格' : '最大化当前窗格'}>□ <span>{maximizedPaneId === tab.session.id ? '还原' : '最大化'}</span></button>
                                    <button class="toolbar-btn" type="button" onclick={(event) => { event.stopPropagation(); closeSplit() }} title="取消分屏">▣ <span>取消分屏</span></button>
                                {/if}
                                <button class="toolbar-btn" type="button" onclick={(event) => { event.stopPropagation(); showSend = !showSend }} title="向多个标签发送输入">
                                    ✈ <span>群发</span>
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
                    {/each}
                    {/snippet}
                    {#if splitLayout && hasSplitLayout}
                        <SplitLayout node={splitLayout} pane={renderPane} onratiochange={persistRecursiveSplitRatios} />
                    {:else}
                        {#each tabs as tab (tab.session.id)}{@render renderPane(tab.session.id)}{/each}
                    {/if}
                    {#each pendingConnections.filter((entry) => entry.id === activePendingId) as pending (pending.id)}
                        <div class="connection-pending" role="status" aria-live="polite">
                            <span class="connection-pending-dot" aria-hidden="true"></span>
                            <strong>正在连接 {pending.name}</strong>
                            <span>{pending.address}</span>
                        </div>
                    {/each}
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

    {#if activePluginPanel && !vaultLocked}
        <aside class="plugin-side-panel" aria-label={activePluginPanel.title}>
            <div class="plugin-side-panel-header">
                <strong>{activePluginPanel.title}</strong>
                <button type="button" onclick={() => { activePluginPanelId = null }} aria-label={`关闭${activePluginPanel.title}`}>×</button>
            </div>
            {#key activePluginPanel.id}
                <PluginPanelHost panel={activePluginPanel} host={panelHostContext(activePluginPanel)} />
            {/key}
        </aside>
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
            onclick={cancelConnect}
            onkeydown={(event) => { if (event.key === 'Escape') cancelConnect() }}
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
                        <div class="fingerprint-fields">
                            <label class="fingerprint-credential">用户名
                                <input type="text" bind:value={formUser} autocomplete="username" placeholder="SSH 用户名" />
                            </label>
                            <label class="fingerprint-credential">认证方式
                                <select bind:value={formAuth} onchange={() => { saveConnectionCredential = false }}>
                                    <option value="auto">自动</option>
                                    <option value="password">密码</option>
                                    <option value="publicKey">私钥</option>
                                    <option value="agent">SSH Agent</option>
                                    <option value="keyboardInteractive">键盘交互</option>
                                </select>
                            </label>
                            {#if formAuth === 'password' || formAuth === 'keyboardInteractive' || formAuth === 'auto'}
                                <label class="fingerprint-credential">密码
                                    <input type="password" bind:value={formPassword} autocomplete="off" placeholder={pendingParams?.password ? '留空则沿用本次连接密码' : 'SSH 登录密码'} />
                                </label>
                            {/if}
                            {#if pendingParams?.profile}
                                <label class="fingerprint-credential">环境
                                    <input type="text" bind:value={formEnvironment} placeholder="prod / test / dev" />
                                </label>
                            {/if}
                            {#if formAuth === 'publicKey' || formAuth === 'auto'}
                                <label class="fingerprint-credential fingerprint-wide">私钥路径
                                    <input type="text" bind:value={formKeyPath} placeholder="C:\Users\me\.ssh\id_ed25519" />
                                </label>
                                {#if formAuth === 'publicKey' || formKeyPath.trim()}
                                    <label class="fingerprint-credential fingerprint-wide">私钥口令（无口令可留空）
                                        <input type="password" bind:value={formKeyPassphrase} autocomplete="off" placeholder={pendingParams?.keyPassphrase ? '留空则沿用本次私钥口令' : '私钥口令（可选）'} />
                                    </label>
                                {/if}
                            {/if}
                        </div>
                        {#if formAuth !== 'agent'}
                            <label class="fingerprint-save"><input type="checkbox" bind:checked={saveConnectionCredential} /> 将本次输入的密码或私钥口令保存到保险库</label>
                        {/if}
                        {#if connectError}
                            <p class="connect-error" role="alert">{connectError}</p>
                        {/if}
                        <div class="connect-actions">
                            <button type="button" onclick={() => void confirmFingerprint()} disabled={connecting || !formUser.trim()}>
                                {connecting ? '连接中…' : '信任并连接'}
                            </button>
                            <button type="button" onclick={cancelConnect} disabled={connecting}>取消</button>
                        </div>
                    </div>
                {:else}
                    <div class="connect-form">
                        <label>主机<input type="text" bind:value={formHost} placeholder="192.168.1.10" /></label>
                        <label>端口<input type="number" bind:value={formPort} min="1" max="65535" /></label>
                        <label>用户名<input type="text" bind:value={formUser} placeholder="root" /></label>
                        <label>密码<input type="password" bind:value={formPassword} autocomplete="off" placeholder={pendingParams?.password ? '留空则沿用本次连接密码' : ''} /></label>
                        <label>私钥路径<input type="text" bind:value={formKeyPath} placeholder="C:\Users\me\.ssh\id_ed25519" /></label>
                        <label>私钥口令<input type="password" bind:value={formKeyPassphrase} autocomplete="off" placeholder={pendingParams?.keyPassphrase ? '留空则沿用本次私钥口令' : ''} /></label>
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
                            <button type="button" onclick={cancelConnect} disabled={connecting}>取消</button>
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

    {#if searchOpen && activeTab?.terminal}
        <SearchPanel terminal={activeTab.terminal} onclose={() => { searchOpen = false }} />
    {/if}

    <ToastHost />
</div>
