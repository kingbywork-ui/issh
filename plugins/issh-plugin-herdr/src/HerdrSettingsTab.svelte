<script lang="ts">
    import { onMount } from 'svelte'
    import herdrCss from './herdr.css?inline'
    import {
        bindSession,
        createWorkspace,
        listSessions,
        listWorkspaces,
        runtimeHealth,
        unbindSession,
        type RuntimeHealth,
        type SessionInfo,
        type Workspace,
    } from './herdrRpc'

    let workspaces = $state<Workspace[]>([])
    let sessions = $state<SessionInfo[]>([])
    let health = $state<RuntimeHealth | null>(null)
    let newWorkspaceName = $state('')
    let busy = $state(false)
    let error = $state('')

    const openSessions = $derived(sessions.filter((session) => session.state !== 'closed'))
    const workspaceCapabilities = $derived(health?.capabilities.filter((capability) => capability.startsWith('workspace.')) ?? [])

    async function refresh (): Promise<void> {
        busy = true
        error = ''
        try {
            const [ws, ss] = await Promise.all([listWorkspaces(), listSessions()])
            workspaces = ws
            sessions = ss
            health = await runtimeHealth().catch(() => null)
        } catch (cause) {
            error = cause instanceof Error ? cause.message : String(cause)
        } finally {
            busy = false
        }
    }

    onMount(() => {
        if (!document.getElementById('issh-plugin-herdr-style')) {
            const style = document.createElement('style')
            style.id = 'issh-plugin-herdr-style'
            style.textContent = herdrCss
            document.head.appendChild(style)
        }
        void refresh()
    })

    async function addWorkspace (): Promise<void> {
        if (!newWorkspaceName.trim()) return
        busy = true
        error = ''
        try {
            await createWorkspace(newWorkspaceName.trim())
            newWorkspaceName = ''
            await refresh()
        } catch (cause) {
            error = cause instanceof Error ? cause.message : String(cause)
        } finally {
            busy = false
        }
    }

    async function toggleBind (workspace: Workspace, sessionId: string): Promise<void> {
        busy = true
        error = ''
        try {
            const bound = workspace.bindings.some((binding) => binding.sessionId === sessionId)
            if (bound) await unbindSession(workspace.id, sessionId)
            else await bindSession(workspace.id, sessionId)
            await refresh()
        } catch (cause) {
            error = cause instanceof Error ? cause.message : String(cause)
        } finally {
            busy = false
        }
    }

    function timeLabel (unixMs: number): string {
        return new Date(unixMs).toLocaleString()
    }
</script>

<div class="herdr-settings">
    {#if error}
        <div class="settings-error" role="alert">{error}</div>
    {/if}

    <div class="herdr-section">
        <div class="settings-field-title">Runtime</div>
        {#if health}
            <div class="herdr-health">
                <span>版本 {health.runtimeVersion}</span>
                <span>workspace 能力：{workspaceCapabilities.length ? workspaceCapabilities.join(', ') : '（未声明）'}</span>
            </div>
        {:else}
            <div class="settings-empty">Runtime 未连接或 health 不可用。</div>
        {/if}
    </div>

    <div class="herdr-section">
        <div class="settings-field-title">工作区（{workspaces.length}）</div>
        <div class="herdr-toolbar">
            <input type="text" placeholder="新工作区名称" bind:value={newWorkspaceName} aria-label="新工作区名称" />
            <button class="market-install" type="button" disabled={busy || !newWorkspaceName.trim()} onclick={() => void addWorkspace()}>创建</button>
        </div>
        {#if workspaces.length === 0}
            <div class="settings-empty">暂无工作区。</div>
        {/if}
        {#each workspaces as workspace (workspace.id)}
            <div class="herdr-workspace">
                <div class="herdr-workspace-head">
                    <strong>{workspace.name}</strong>
                    <span class="herdr-workspace-id">{workspace.id}</span>
                    <span class="herdr-workspace-time">创建于 {timeLabel(workspace.createdAtUnixMs)}</span>
                </div>
                {#if openSessions.length > 0}
                    <div class="herdr-bindings">
                        {#each openSessions as session (session.id)}
                            <button
                                type="button"
                                disabled={busy}
                                class:bound={workspace.bindings.some((binding) => binding.sessionId === session.id)}
                                onclick={() => void toggleBind(workspace, session.id)}
                            >
                                {workspace.bindings.some((binding) => binding.sessionId === session.id) ? '✓ ' : ''}{session.title}
                            </button>
                        {/each}
                    </div>
                {:else}
                    <div class="settings-empty">打开终端会话后可绑定到此工作区。</div>
                {/if}
            </div>
        {/each}
    </div>
</div>
