<script lang="ts">
    import { onMount } from 'svelte'
    import bridgeCss from './bridge.css?inline'
    import { agentHubStatus, openAgentHub, type AgentHubStatus } from './bridgeRpc'

    let status = $state<AgentHubStatus | null>(null)
    let loading = $state(false)
    let error = $state('')

    const stateLabel = $derived(!status?.installed ? '未安装' : !status.running ? '已停止' : !status.compatible ? '版本不兼容' : '运行中')

    async function refresh (): Promise<void> {
        if (loading) return
        loading = true
        error = ''
        try { status = await agentHubStatus() }
        catch (cause) { error = cause instanceof Error ? cause.message : String(cause) }
        finally { loading = false }
    }

    async function openWeb (): Promise<void> {
        error = ''
        try { await openAgentHub() }
        catch (cause) { error = cause instanceof Error ? cause.message : String(cause) }
    }

    onMount(() => {
        void refresh()
        const timer = window.setInterval(() => void refresh(), 5000)
        return () => window.clearInterval(timer)
    })
</script>

<svelte:head><style>{bridgeCss}</style></svelte:head>

<div class="bridge-settings">
    <div class="bridge-header">
        <div>
            <h3>Agent Hub</h3>
            <p class="settings-hint">多 Agent、任务和对话由独立 Agent Hub 管理；issh 仅提供终端 Provider。</p>
        </div>
        <button type="button" disabled={loading} onclick={() => void refresh()}>{loading ? '刷新中…' : '刷新状态'}</button>
    </div>
    {#if error}<div class="settings-hint" role="alert">{error}</div>{/if}
    <div class="bridge-section">
        <div class="bridge-row"><span class="bridge-session-title">Hub 服务</span><span class="bridge-agent-status">{stateLabel}</span></div>
        <div class="bridge-row"><span>地址</span><code>{status?.url ?? 'http://127.0.0.1:33555'}</code></div>
        <div class="bridge-row"><span>版本</span><span>{status?.version ?? '不可用'}</span></div>
        <div class="bridge-row"><span>issh Provider</span><span>{status?.providerStatus ?? '未连接'}</span></div>
        {#if status?.lastError}<div class="settings-hint" role="alert">{status.lastError}</div>{/if}
        <div class="bridge-toolbar">
            <button class="market-install" type="button" disabled={!status?.running || !status?.compatible} onclick={() => void openWeb()}>打开 Agent Hub Web</button>
        </div>
    </div>
</div>
