<script lang="ts">
    import { onMount } from 'svelte'
    import bridgeCss from './bridge.css?inline'
    import { managementStatus, openManagement, runtimeHealth, type ManagementStatus, type RuntimeHealth } from './bridgeRpc'

    let status = $state<ManagementStatus | null>(null)
    let health = $state<RuntimeHealth | null>(null)
    let loading = $state(false)
    let error = $state('')

    async function refresh (): Promise<void> {
        if (loading) return
        loading = true
        error = ''
        try {
            const results = await Promise.all([managementStatus(), runtimeHealth().catch(() => null)])
            status = results[0]
            health = results[1]
        } catch (cause) {
            error = cause instanceof Error ? cause.message : String(cause)
        } finally {
            loading = false
        }
    }

    async function openWeb (): Promise<void> {
        try { await openManagement() } catch (cause) { error = cause instanceof Error ? cause.message : String(cause) }
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
            <h3>Agent 桥接</h3>
            <p class="settings-hint">工作区、会话和 Agent 由 Web 管理界面统一管理。</p>
        </div>
        <button type="button" disabled={loading} onclick={() => void refresh()}>{loading ? '刷新中…' : '刷新状态'}</button>
    </div>
    {#if error}<div class="settings-hint" role="alert">{error}</div>{/if}
    <div class="bridge-section">
        <div class="bridge-row">
            <span class="bridge-session-title">管理服务器</span>
            <span class="bridge-agent-status">{status?.running ? (status.enabled ? '运行中' : '已暂停') : '不可用'}</span>
        </div>
        <div class="bridge-row"><span>地址</span><code>http://127.0.0.1:{status?.port ?? 33555}</code></div>
        <div class="bridge-row"><span>令牌</span><span>{status?.tokenConfigured ? '已配置（由打开 Web 自动注入）' : '未配置'}</span></div>
        {#if status?.lastError}<div class="settings-hint" role="alert">{status.lastError}</div>{/if}
        <div class="bridge-toolbar">
            <button class="market-install" type="button" disabled={!status?.running} onclick={() => void openWeb()}>打开 Web 管理界面</button>
        </div>
    </div>
    <div class="bridge-section">
        <div class="settings-field-title">Runtime 健康</div>
        <div class="settings-hint">版本：{health?.runtimeVersion ?? '不可用'} · 能力：{health?.capabilities?.length ?? 0} 项</div>
    </div>
</div>
