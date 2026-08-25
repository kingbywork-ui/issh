<script lang="ts">
    import { onMount } from 'svelte'
    import { FitAddon } from '@xterm/addon-fit'
    import { Terminal } from '@xterm/xterm'
    import '@xterm/xterm/css/xterm.css'
    import HostManager from './lib/HostManager.svelte'
    import SftpBrowser from './lib/SftpBrowser.svelte'
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

    interface TerminalTab {
        session: RuntimeSessionSnapshot
        terminal: Terminal | null
        fitAddon: FitAddon | null
        host: HTMLDivElement | null
        sequence: number
    }

    let health: RuntimeHealth | null = $state(null)
    let loading = $state(true)
    let error = $state('')
    let tabs = $state<TerminalTab[]>([])
    let activeId = $state('')
    let showSftp = $state(false)
    let showConnect = $state(false)

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
    }
    let pendingParams = $state<PendingConnect | null>(null)

    // Vault
    let vaultSecrets = $state<VaultSecretKey[]>([])

    let pollHandle: ReturnType<typeof setInterval> | null = null
    let pollInFlight = false

    const activeTab = $derived(tabs.find((tab) => tab.session.id === activeId) ?? null)
    const showStartPage = $derived(tabs.length === 0)

    const writeQueues = new Map<string, Promise<unknown>>()

    function enqueueWrite (sessionId: string, operation: () => Promise<unknown>): void {
        const previous = writeQueues.get(sessionId) ?? Promise.resolve()
        const next = previous.then(operation).catch((cause: unknown) => {
            error = cause instanceof Error ? cause.message : String(cause)
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
        requestAnimationFrame(() => {
            tab.fitAddon?.fit()
            tab.terminal?.focus()
        })
    }

    async function addLocalTab (): Promise<void> {
        try {
            const session = await openLocalSession()
            const tab: TerminalTab = { session, terminal: null, fitAddon: null, host: null, sequence: 0 }
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

    async function connectWithParams (params: {
        host: string
        port: number
        user: string
        password: string
        keyPath: string
        keyPassphrase: string
        vaultSecretId: string
        title?: string
    }): Promise<void> {
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
            const tab: TerminalTab = { session, terminal: null, fitAddon: null, host: null, sequence: 0 }
            tabs.push(tab)
            activeId = session.id
        } catch (cause) {
            connectError = cause instanceof Error ? cause.message : String(cause)
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
        } catch (cause) {
            if (tab.session.state !== 'closed') {
                error = cause instanceof Error ? cause.message : String(cause)
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
        try {
            await closeSession(tab.session.id)
        } catch {
            // 会话可能已关闭
        }
        tab.terminal?.dispose()
        tabs = tabs.filter((candidate) => candidate.session.id !== tab.session.id)
        writeQueues.delete(tab.session.id)
        if (activeId === tab.session.id) {
            const next = tabs[0]
            if (next) {
                activateTab(next)
            } else {
                activeId = ''
                showSftp = false
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
            })
        } catch (cause) {
            connectError = cause instanceof Error ? cause.message : String(cause)
        } finally {
            connecting = false
        }
    }

    onMount(() => {
        void (async () => {
            await refresh()
            await loadVaultSecrets()
        })()
        pollHandle = setInterval(pollAll, 80)
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
        <div class="tabs">
            {#each tabs as tab, index (tab.session.id)}
                <button
                    class="tab-header"
                    class:active={tab.session.id === activeId}
                    type="button"
                    onclick={() => activateTab(tab)}
                    title={tab.session.title}
                >
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
        <div class="tab-bar-actions">
            {#if activeTab && activeTab.session.kind === 'ssh'}
                <button class="btn-tab-bar" type="button" onclick={() => { showSftp = !showSftp }} title="SFTP 文件浏览">
                    {showSftp ? '关闭 SFTP' : 'SFTP'}
                </button>
            {/if}
            <button class="btn-tab-bar" type="button" onclick={() => { showConnect = true; void loadVaultSecrets() }} title="新建 SSH 连接">＋ SSH</button>
            <button class="btn-tab-bar" type="button" onclick={() => void addLocalTab()} title="新建本地终端">＋ 终端</button>
        </div>
        <div class="btn-space"></div>
        {#if health}
            <span class="runtime-badge" title={`Runtime ${health.runtimeVersion} · PID ${health.pid}`}>●</span>
        {:else}
            <span class="runtime-badge offline" title="Runtime 未连接">●</span>
        {/if}
    </header>

    <div class="app-workspace">
        {#if showStartPage}
            <HostManager onconnect={(profile) => void connectHost(profile)} onopenlocal={() => void addLocalTab()} />
        {:else}
            {#if showSftp && activeTab}
                <SftpBrowser sessionId={activeTab.session.id} />
            {/if}
            <!-- 终端 stack 常驻 DOM：xterm open() 只能执行一次，
                 若用 {#if} 切换会销毁/重建 DOM 导致切回终端空白 -->
            <div class="terminal-stack" class:hidden={showSftp && !!activeTab}>
                {#each tabs as tab (tab.session.id)}
                    <div
                        class="terminal-pane"
                        class:hidden={tab.session.id !== activeId}
                        use:terminalHostAction={tab}
                    ></div>
                {/each}
            </div>
        {/if}
    </div>

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
</div>
