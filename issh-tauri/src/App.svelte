<script lang="ts">
    import { onMount } from 'svelte'
    import { FitAddon } from '@xterm/addon-fit'
    import { Terminal } from '@xterm/xterm'
    import '@xterm/xterm/css/xterm.css'
    import SftpBrowser from './lib/SftpBrowser.svelte'
    import {
        closeSession,
        discoverSshHostKey,
        openLocalSession,
        openSshSession,
        resizeSession,
        runtimeHealth,
        subscribeSession,
        vaultListSecrets,
        vaultStatus,
        writeSession,
        type RuntimeHealth,
        type RuntimeSessionSnapshot,
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
    let showConnect = $state(false)
    let showSftp = $state(false)

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

    // Vault
    let vaultSecrets = $state<VaultSecretKey[]>([])

    let pollHandle: ReturnType<typeof setInterval> | null = null
    let pollInFlight = false

    const activeTab = $derived(tabs.find((tab) => tab.session.id === activeId) ?? null)

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
            fontFamily: '"Cascadia Code", Consolas, monospace',
            fontSize: 13,
            scrollback: 2_000,
            theme: {
                background: '#09131b',
                foreground: '#dce7e8',
                cursor: '#45b99b',
                cursorAccent: '#09131b',
                selectionBackground: '#244a54',
                black: '#09131b',
                brightBlack: '#526b75',
                green: '#45b99b',
                brightGreen: '#72d6b8',
                yellow: '#dca85c',
                brightYellow: '#f0c87f',
                red: '#e47a73',
                brightRed: '#ff9b92',
                cyan: '#66c7cb',
                brightCyan: '#96e8e8',
                blue: '#79a9db',
                brightBlue: '#a6c8ef',
                magenta: '#bd9bd8',
                brightMagenta: '#d7b8ed',
                white: '#dce7e8',
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

    async function tick (): Promise<void> {
        await new Promise((resolve) => requestAnimationFrame(() => resolve(null)))
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
            const fingerprint = await discoverSshHostKey(host, port)
            pendingFingerprint = fingerprint.fingerprint
            pendingConnect = true
        } catch (cause) {
            connectError = cause instanceof Error ? cause.message : String(cause)
        } finally {
            connecting = false
        }
    }

    async function confirmFingerprint (): Promise<void> {
        connectError = ''
        connecting = true
        try {
            const session = await openSshSession({
                title: `${formUser.trim()}@${formHost.trim()}`,
                host: formHost.trim(),
                port: Number(formPort) || 22,
                username: formUser.trim(),
                ...(formPassword ? { password: formPassword } : {}),
                ...(formKeyPath.trim() ? { privateKeyPath: formKeyPath.trim() } : {}),
                ...(formKeyPassphrase ? { privateKeyPassphrase: formKeyPassphrase } : {}),
                expectedHostKey: pendingFingerprint,
                ...(formVaultSecretId ? { vaultSecretId: formVaultSecretId } : {}),
            })
            pendingConnect = false
            pendingFingerprint = ''
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

    onMount(() => {
        void (async () => {
            await refresh()
            await addLocalTab()
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

<div class="shell">
    <aside class="rail">
        <div class="brand"><span class="brand-mark">issh</span><span>Tauri</span></div>
        <nav>
            <button class="nav-item" type="button" onclick={() => void addLocalTab()}>＋ 本地终端</button>
            <button class="nav-item" type="button" onclick={() => { showConnect = true; void loadVaultSecrets() }}>⇢ SSH 连接</button>
            {#if activeTab && activeTab.session.kind === 'ssh'}
                <button class="nav-item" type="button" onclick={() => { showSftp = !showSftp }}>
                    {showSftp ? '▤ 关闭 SFTP' : '▤ SFTP 浏览'}
                </button>
            {/if}
        </nav>
        <div class="session-list">
            {#each tabs as tab (tab.session.id)}
                <button
                    class="session-item"
                    class:active={tab.session.id === activeId}
                    type="button"
                    onclick={() => activateTab(tab)}
                    title={tab.session.title}
                >
                    <span class="session-kind" data-kind={tab.session.kind}>{tab.session.kind === 'ssh' ? '⇢' : '▤'}</span>
                    <span class="session-title">{tab.session.title}</span>
                    <span class="session-state" data-state={tab.session.state}>{tab.session.state}</span>
                    <span
                        class="session-close"
                        role="button"
                        tabindex="0"
                        onclick={(event) => { event.stopPropagation(); void closeTab(tab) }}
                        onkeydown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.stopPropagation(); void closeTab(tab) } }}
                    >✕</span>
                </button>
            {/each}
        </div>
        <footer class="rail-footer">
            {#if health}
                <span>Runtime {health.runtimeVersion} · PID {health.pid}</span>
            {:else}
                <span class="rail-offline">Runtime 未连接</span>
            {/if}
        </footer>
    </aside>

    <main class="content">
        {#if loading && tabs.length === 0}
            <p class="status">正在连接 Runtime…</p>
        {/if}
        {#if error}
            <p class="status error" role="alert">{error}</p>
        {/if}

        {#if showConnect}
            <section class="connect-panel" aria-label="SSH 连接">
                <h2>SSH 连接</h2>
                {#if pendingConnect}
                    <div class="fingerprint-confirm">
                        <p>主机密钥指纹（SHA256）：</p>
                        <code class="fingerprint">{pendingFingerprint}</code>
                        <p class="fingerprint-hint">首次连接请核对指纹后继续。</p>
                        <div class="connect-actions">
                            <button type="button" onclick={() => void confirmFingerprint()} disabled={connecting}>
                                {connecting ? '连接中…' : '信任并连接'}
                            </button>
                            <button type="button" onclick={() => { pendingConnect = false; pendingFingerprint = '' }} disabled={connecting}>取消</button>
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
            </section>
        {:else if showSftp && activeTab}
            <SftpBrowser sessionId={activeTab.session.id} />
        {:else}
            <div class="terminal-stack">
                {#each tabs as tab (tab.session.id)}
                    <div
                        class="terminal-pane"
                        class:hidden={tab.session.id !== activeId}
                        use:terminalHostAction={tab}
                    ></div>
                {/each}
            </div>
        {/if}
    </main>
</div>
