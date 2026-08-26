<script lang="ts">
    import { onMount } from 'svelte'
    import { FitAddon } from '@xterm/addon-fit'
    import { Terminal } from '@xterm/xterm'
    import '@xterm/xterm/css/xterm.css'
    import HostManager from './lib/HostManager.svelte'
    import WelcomeHome from './lib/WelcomeHome.svelte'
    import SftpBrowser from './lib/SftpBrowser.svelte'
    import BatchInputPanel from './lib/BatchInputPanel.svelte'
    import ProfileSelector from './lib/ProfileSelector.svelte'
    import {
        closeSession,
        discoverSshHostKey,
        openLocalSession,
        openSshSession,
        resolveKeyPassphrase,
        resolveSshPassword,
        resizeSession,
        runtimeHealth,
        subscribeSession,
        vaultListSecrets,
        vaultStatus,
        writeSession,
        type RuntimeHealth,
        type RuntimeSessionSnapshot,
        type SshHostProfile,
        type VaultSecretKey,
    } from './lib/runtime'

    interface SshTabInfo {
        host: string
        port: number
        user: string
        hostKeyFingerprint: string
        profile: SshHostProfile | null
        keyPath: string
    }

    interface TerminalTab {
        session: RuntimeSessionSnapshot
        terminal: Terminal | null
        fitAddon: FitAddon | null
        host: HTMLDivElement | null
        sequence: number
        ssh: SshTabInfo | null
    }

    let health: RuntimeHealth | null = $state(null)
    let loading = $state(true)
    let error = $state('')
    let tabs = $state<TerminalTab[]>([])
    let activeId = $state('')
    let showSftp = $state(false)
    let sftpInitialPath = $state('/')
    let sftpSudoMode = $state(false)
    let sftpSudoPassword = $state('')
    let sftpPrompt = $state<{ tab: TerminalTab, path: string } | null>(null)
    let showSend = $state(false)
    let showConnect = $state(false)
    let showSelector = $state(false)
    let showWelcome = $state(false)

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
    const showStartPage = $derived(tabs.length === 0)

    const writeQueues = new Map<string, Promise<unknown>>()
    const writeQueueLengths = new Map<string, number>()

    function enqueueWrite (sessionId: string, operation: () => Promise<unknown>): void {
        const length = (writeQueueLengths.get(sessionId) ?? 0) + 1
        if (length > MAX_WRITE_QUEUE) {
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
            })
        writeQueues.set(sessionId, next)
    }

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
        return new Terminal({
            allowProposedApi: false,
            convertEol: false,
            cursorBlink: true,
            fontFamily: '"Source Code Pro", Consolas, "Courier New", monospace',
            fontSize: 13,
            scrollback: 2_000,
            theme: {
                background: '#171717',
                foreground: '#cacaca',
                cursor: '#bbbbbb',
                black: '#000000',
                red: '#ff615a',
                green: '#b1e969',
                yellow: '#ebd99c',
                blue: '#5da9f6',
                magenta: '#e86aff',
                cyan: '#82fff7',
                white: '#dedacf',
                brightBlack: '#313131',
                brightRed: '#f58c80',
                brightGreen: '#ddf88f',
                brightYellow: '#eee5b2',
                brightBlue: '#a5c7ff',
                brightMagenta: '#ddaaff',
                brightCyan: '#b7fff9',
                brightWhite: '#ffffff',
            },
        })
    }

    function bindTerminal (tab: TerminalTab): void {
        if (!tab.terminal || !tab.fitAddon || !tab.host) return
        tab.terminal.open(tab.host)
        tab.fitAddon.fit()
        const sessionId = tab.session.id
        enqueueWrite(sessionId, async () => {
            tab.session = await resizeSession(sessionId, tab.terminal!.cols, tab.terminal!.rows)
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

    function activateTab (tab: TerminalTab): void {
        activeId = tab.session.id
        showSftp = false
        sftpSudoPassword = ''
        sftpSudoMode = false
        requestAnimationFrame(() => {
            tab.fitAddon?.fit()
            tab.terminal?.focus()
        })
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
            const tab: TerminalTab = { session, terminal: null, fitAddon: null, host: null, sequence: 0, ssh: null }
            tabs.push(tab)
            activeId = session.id
        } catch (cause) {
            error = cause instanceof Error ? cause.message : String(cause)
        }
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

    async function connectHost (profile: SshHostProfile): Promise<void> {
        connectError = ''
        connecting = true
        try {
            const keyPath = profile.privateKeys[0] ?? ''
            const expandedKeyPath = keyPath ? normalizeKeyPath(keyPath, profile.host, profile.user) : ''
            // 从已解锁的 vault 解析保存的密码/口令
            let password = ''
            let keyPassphrase = ''
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
            })
            // 指纹确认 UI 在连接弹窗内，必须打开弹窗才能继续连接流程
            showConnect = true
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
        pendingConnect = true
        showConnect = true
    }

    async function confirmFingerprint (): Promise<void> {
        if (!pendingParams) return
        connectError = ''
        connecting = true
        const params = pendingParams
        try {
            const session = await openSshSession({
                title: params.title?.trim() || `${params.user}@${params.host}`,
                host: params.host,
                port: params.port,
                username: params.user,
                ...(params.password || formPassword ? { password: params.password || formPassword } : {}),
                ...(params.keyPath ? { privateKeyPath: params.keyPath } : {}),
                ...(params.keyPassphrase || formKeyPassphrase ? { privateKeyPassphrase: params.keyPassphrase || formKeyPassphrase } : {}),
                expectedHostKey: pendingFingerprint,
                ...(params.vaultSecretId ? { vaultSecretId: params.vaultSecretId } : {}),
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
                sequence: 0,
                ssh: {
                    host: params.host,
                    port: params.port,
                    user: params.user,
                    hostKeyFingerprint: pendingFingerprint,
                    profile: params.profile,
                    keyPath: params.keyPath,
                },
            }
            tabs.push(tab)
            activeId = session.id
        } catch (cause) {
            connectError = cause instanceof Error ? cause.message : String(cause)
        } finally {
            connecting = false
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
            })
            tab.session = session
            tab.sequence = 0
            tab.terminal?.clear()
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
        await pollOutput(tab)
        terminal.focus()
    }

    function terminalHostAction (node: HTMLDivElement, tab: TerminalTab): void {
        tab.host = node
        void mountTerminal(tab, node)
    }

    async function pollOutput (tab: TerminalTab): Promise<void> {
        try {
            const subscription = await subscribeSession(tab.session.id, tab.sequence)
            tab.session = subscription.session
            tab.sequence = subscription.nextAfterSequence
            for (const event of subscription.events) {
                tab.terminal?.write(Uint8Array.from(event.data))
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
        tab.terminal?.dispose()
        tabs = tabs.filter((candidate) => candidate.session.id !== tab.session.id)
        writeQueues.delete(tab.session.id)
        writeQueueLengths.delete(tab.session.id)
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

    onMount(() => {
        try { showWelcome = localStorage.getItem('issh.enableWelcomeTab') !== 'false' } catch { showWelcome = true }
        void (async () => {
            await refresh()
            await loadVaultSecrets()
        })()
        pollHandle = setInterval(pollAll, POLL_INTERVAL_MS)
        return () => {
            if (pollHandle) clearInterval(pollHandle)
            for (const tab of tabs) {
                tab.terminal?.dispose()
                void closeSession(tab.session.id)
            }
        }
    })
</script>

<div class="app-root">
    <header class="tab-bar">
        <button
            class="btn-tab-bar profile-button"
            type="button"
            onclick={() => { showSelector = true }}
            title="Profiles & connections"
            aria-label="Profiles & connections"
        >▦</button>
        <div class="tabs">
            {#each tabs as tab, index (tab.session.id)}
                <button
                    class="tab-header"
                    class:active={tab.session.id === activeId}
                    type="button"
                    onclick={() => activateTab(tab)}
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
    </header>

    <div class="app-workspace" class:left-open={showSftp && !!activeTab} class:bottom-open={showSend}>
        {#if showStartPage}
            {#if showWelcome}
                <WelcomeHome onclose={() => { showWelcome = false }} />
            {:else}
                <HostManager onconnect={(profile) => void connectHost(profile)} onopenlocal={() => void addLocalTab()} />
            {/if}
        {:else}
            {#if showSftp && activeTab && activeTab.session.kind === 'ssh'}
                <aside class="app-panel-left" aria-label="SFTP 面板">
                    <SftpBrowser sessionId={activeTab.session.id} initialPath={sftpInitialPath} sudoMode={sftpSudoMode} sudoPassword={sftpSudoPassword} onclose={() => { showSftp = false; sftpSudoPassword = '' }} />
                </aside>
            {/if}

            <div class="app-panel-center">
                <!-- 终端 stack 常驻 DOM：xterm open() 只能执行一次，
                     若用 {#if} 切换会销毁/重建 DOM 导致切回终端空白 -->
                <div class="terminal-stack">
                    {#each tabs as tab (tab.session.id)}
                        <div
                            class="terminal-pane"
                            class:hidden={tab.session.id !== activeId}
                        >
                            <div class="terminal-toolbar">
                                {#if tab.ssh}
                                    <i class="status-dot" class:open={tab.session.state !== 'closed'}></i>
                                    <strong class="toolbar-host">{tab.ssh.user}@{tab.ssh.host}:{tab.ssh.port}</strong>
                                {/if}
                                <span class="toolbar-spacer"></span>
                                {#if tab.ssh}
                                    <button class="toolbar-btn" type="button" onclick={() => void reconnectTab(tab)} disabled={connecting} title="重新连接">
                                        ↻ <span>Reconnect</span>
                                    </button>
                                    <button class="toolbar-btn" type="button" onclick={() => { if (showSftp) showSftp = false; else openSftpForTab(tab) }} title="SFTP 文件浏览">
                                        🗀 <span>SFTP</span>
                                    </button>
                                {/if}
                                <button class="toolbar-btn" type="button" onclick={() => { showSend = !showSend }} title="向多个标签发送输入">
                                    ✈ <span>Send</span>
                                </button>
                            </div>
                            <div
                                class="terminal-host"
                                use:terminalHostAction={tab}
                            ></div>
                        </div>
                    {/each}
                </div>
            </div>

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
</div>
