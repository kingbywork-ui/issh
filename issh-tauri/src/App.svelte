<script lang="ts">
    import { onMount } from 'svelte'
    import { runtimeHealth, type RuntimeHealth } from './lib/runtime'

    let health: RuntimeHealth | null = null
    let loading = true
    let error = ''

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

    onMount(refresh)
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
            <button class="nav-item" type="button" disabled>
                <span class="nav-glyph">▱</span>
                <span>终端</span>
                <small>迁移中</small>
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
                <p class="eyebrow">DESKTOP MIGRATION / STAGE 01</p>
                <h1>原生运行时控制台</h1>
                <p class="lede">先让窗口、命令和状态完全绕过 Electron，再逐项迁移终端能力。</p>
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
