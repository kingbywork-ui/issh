<script lang="ts">
    import { onMount } from 'svelte'
    import { FitAddon } from '@xterm/addon-fit'
    import { Terminal } from '@xterm/xterm'
    import '@xterm/xterm/css/xterm.css'
    import {
        closeSession,
        openLocalSession,
        resizeSession,
        runtimeHealth,
        subscribeSession,
        writeSession,
        type RuntimeHealth,
        type RuntimeSessionSnapshot,
    } from './lib/runtime'

    let health: RuntimeHealth | null = null
    let loading = true
    let error = ''
    let terminalError = ''
    let session: RuntimeSessionSnapshot | null = null
    let terminalHost: HTMLDivElement

    const migrationGates = [
        { label: 'Native runtime', detail: '状态、任务、Pane 与策略', state: 'ready' },
        { label: 'Desktop shell', detail: 'Tauri 窗口与本地命令边界', state: 'active' },
        { label: 'Terminal transport', detail: 'Rust SSH / PTY / SFTP', state: 'next' },
        { label: 'Legacy removal', detail: '删除 Electron / Angular / Node main', state: 'locked' },
    ] as const

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

    onMount(() => {
        let terminal: Terminal | null = null
        let fitAddon: FitAddon | null = null
        let resizeObserver: ResizeObserver | null = null
        let pollHandle: ReturnType<typeof setInterval> | null = null
        let pollInFlight = false
        let sequence = 0
        let writeQueue = Promise.resolve()

        const syncSize = (): void => {
            if (!terminal || !session || !fitAddon) return
            fitAddon.fit()
            const columns = terminal.cols
            const rows = terminal.rows
            if (columns === session.columns && rows === session.rows) return
            writeQueue = writeQueue
                .then(async () => {
                    session = await resizeSession(session?.id ?? '', columns, rows)
                })
                .catch((cause: unknown) => {
                    terminalError = cause instanceof Error ? cause.message : String(cause)
                })
        }

        const sendInput = (data: string): void => {
            if (!session) return
            const bytes = new TextEncoder().encode(data)
            writeQueue = writeQueue
                .then(async () => { await writeSession(session?.id ?? '', bytes) })
                .catch((cause: unknown) => {
                    terminalError = cause instanceof Error ? cause.message : String(cause)
                })
        }

        const pollOutput = async (): Promise<void> => {
            if (!session || pollInFlight) return
            pollInFlight = true
            try {
                const subscription = await subscribeSession(session.id, sequence)
                session = subscription.session
                sequence = subscription.nextAfterSequence
                for (const event of subscription.events) {
                    terminal?.write(Uint8Array.from(event.data))
                }
            } catch (cause) {
                terminalError = cause instanceof Error ? cause.message : String(cause)
            } finally {
                pollInFlight = false
            }
        }

        const initialize = async (): Promise<void> => {
            await refresh()
            if (!health) return
            try {
                session = await openLocalSession()
                terminal = new Terminal({
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
                fitAddon = new FitAddon()
                terminal.loadAddon(fitAddon)
                terminal.open(terminalHost)
                fitAddon.fit()
                session = await resizeSession(session.id, terminal.cols, terminal.rows)
                terminal.onData(sendInput)
                terminal.onBinary(sendInput)
                resizeObserver = new ResizeObserver(syncSize)
                resizeObserver.observe(terminalHost)
                await pollOutput()
                pollHandle = setInterval(() => { void pollOutput() }, 80)
            } catch (cause) {
                terminalError = cause instanceof Error ? cause.message : String(cause)
            }
        }

        void initialize()
        return () => {
            if (pollHandle) clearInterval(pollHandle)
            resizeObserver?.disconnect()
            terminal?.dispose()
            if (session) void closeSession(session.id)
        }
    })
</script>

<svelte:head>
    <meta name="description" content="issh 原生桌面迁移控制台" />
</svelte:head>

<div class="shell">
    <aside class="rail" aria-label="主导航">
        <div class="brand" aria-label="issh">
            <span class="brand-mark">i:</span>
            <span>issh</span>
        </div>

        <nav>
            <button class="nav-item active" type="button" aria-current="page">
                <span class="nav-glyph">⌁</span>
                <span>Runtime</span>
            </button>
            <button class="nav-item active-subsection" type="button" aria-current="page">
                <span class="nav-glyph">▱</span>
                <span>终端</span>
                <small>本地 PTY</small>
            </button>
            <button class="nav-item" type="button" disabled>
                <span class="nav-glyph">◇</span>
                <span>Agents</span>
                <small>待接入</small>
            </button>
        </nav>

        <div class="rail-foot">
            <span class="native-badge">TAURI NATIVE</span>
            <p>当前窗口不依赖 Electron。</p>
        </div>
    </aside>

    <main>
        <header class="topline">
            <div>
                <p class="eyebrow">DESKTOP MIGRATION / STAGE 02</p>
                <h1>本地终端工作台</h1>
                <p class="lede">终端字节已经由 Rust PTY 接管；窗口只负责呈现和发送用户输入。</p>
            </div>
            <button class="refresh" type="button" onclick={refresh} disabled={loading}>
                <span class:spinning={loading}>↻</span>
                {loading ? '正在连接' : '重新检查'}
            </button>
        </header>

        <section class="runtime-panel" class:error-state={!!error} aria-live="polite">
            <div class="signal-column" aria-hidden="true">
                <span class="signal-dot" class:online={!!health}></span>
                <span class="signal-line"></span>
                <span class="signal-cap"></span>
            </div>
            <div class="runtime-copy">
                <p class="panel-label">LOCAL CONTROL PLANE</p>
                {#if health}
                    <h2>Runtime 已接管</h2>
                    <p>这条健康信息来自 Tauri 原生命令和当前用户 Named Pipe，不经过 Electron IPC。</p>
                {:else if error}
                    <h2>Runtime 未连接</h2>
                    <p>{error}</p>
                {:else}
                    <h2>正在建立本地链路</h2>
                    <p>启动或连接当前用户的 isshd 实例。</p>
                {/if}
            </div>
            <dl class="telemetry">
                <div>
                    <dt>协议</dt>
                    <dd>{health?.protocolVersion ?? '—'}</dd>
                </div>
                <div>
                    <dt>进程</dt>
                    <dd>{health ? `PID ${health.pid}` : '—'}</dd>
                </div>
                <div>
                    <dt>能力</dt>
                    <dd>{health?.capabilities.length ?? 0}</dd>
                </div>
            </dl>
        </section>

        <section class="terminal-workbench" aria-labelledby="terminal-title">
            <div class="terminal-heading">
                <div>
                    <p class="eyebrow">LOCAL PTY / CONPTY</p>
                    <h2 id="terminal-title">交互式 Shell</h2>
                </div>
                <span class:session-live={session?.state === 'running'} class="session-state">
                    {session?.state === 'running' ? 'LIVE CHANNEL' : session?.state === 'closed' ? 'CLOSED' : 'CONNECTING'}
                </span>
            </div>
            <div class="terminal-grid">
                <div class="terminal-frame">
                    <div class="terminal-bar" aria-hidden="true">
                        <span class="terminal-dot"></span>
                        <span>issh / local-shell</span>
                        <span class="terminal-bar-right">RAW BYTES · SEQ {session?.nextSequence ?? 0}</span>
                    </div>
                    <div class="terminal-host" bind:this={terminalHost} aria-label="本地终端输出"></div>
                    {#if terminalError}
                        <p class="terminal-error" role="alert">{terminalError}</p>
                    {/if}
                </div>
                <aside class="session-inspector" aria-label="终端会话信息">
                    <p class="panel-label">SESSION CHANNEL</p>
                    <dl>
                        <div><dt>会话</dt><dd>{session?.id ?? '—'}</dd></div>
                        <div><dt>PID</dt><dd>{session?.pid ?? '—'}</dd></div>
                        <div><dt>尺寸</dt><dd>{session ? `${session.columns} × ${session.rows}` : '—'}</dd></div>
                        <div><dt>缓冲</dt><dd>{session ? `${session.bufferedBytes} B` : '—'}</dd></div>
                    </dl>
                    <p class="inspector-note">输出保留 ANSI 与控制序列，订阅通过序号恢复；关闭窗口只回收本会话创建的 Shell。</p>
                </aside>
            </div>
        </section>

        <section class="gates" aria-labelledby="gates-title">
            <div class="section-heading">
                <div>
                    <p class="eyebrow">REPLACEMENT GATES</p>
                    <h2 id="gates-title">Electron 退出路径</h2>
                </div>
                <p>每一道门都需要真实功能对等和回归证据。</p>
            </div>

            <ol class="gate-list">
                {#each migrationGates as gate, index}
                    <li class:ready={gate.state === 'ready'} class:active-gate={gate.state === 'active'}>
                        <span class="gate-index">{String(index + 1).padStart(2, '0')}</span>
                        <div>
                            <strong>{gate.label}</strong>
                            <p>{gate.detail}</p>
                        </div>
                        <span class="gate-state">{gate.state === 'ready' ? '已验证' : gate.state === 'active' ? '进行中' : gate.state === 'next' ? '下一步' : '未解锁'}</span>
                    </li>
                {/each}
            </ol>
        </section>
    </main>
</div>
