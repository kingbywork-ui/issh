<script lang="ts">
    import { onMount } from 'svelte'
    import bridgeCss from './bridge.css?inline'
    import {
        authorizeAgent,
        bindSession,
        createWorkspace,
        listAgents,
        listSessions,
        listWorkspaces,
        registerAgent,
        unbindSession,
        type Agent,
        type SessionInfo,
        type Workspace,
    } from './bridgeRpc'

    let workspaces = $state<Workspace[]>([])
    let sessions = $state<SessionInfo[]>([])
    let agents = $state<Agent[]>([])
    let selectedWorkspaceId = $state('')
    let newWorkspaceName = $state('')
    let newAgentName = $state('')
    let newAgentAdapter = $state('llm')
    let newAgentSessionId = $state('')
    let newAgentScopes = $state('read')
    let busy = $state(false)
    let error = $state('')

    const selectedWorkspace = $derived(workspaces.find((workspace) => workspace.id === selectedWorkspaceId) ?? null)
    const openSessions = $derived(sessions.filter((session) => session.state !== 'closed'))

    async function refresh (): Promise<void> {
        busy = true
        error = ''
        try {
            const [ws, ss] = await Promise.all([listWorkspaces(), listSessions()])
            workspaces = ws
            sessions = ss
            if (!workspaces.some((workspace) => workspace.id === selectedWorkspaceId)) {
                selectedWorkspaceId = workspaces[0]?.id ?? ''
            }
            agents = selectedWorkspaceId ? await listAgents(selectedWorkspaceId) : []
        } catch (cause) {
            error = cause instanceof Error ? cause.message : String(cause)
        } finally {
            busy = false
        }
    }

    async function refreshAgents (): Promise<void> {
        agents = selectedWorkspaceId ? await listAgents(selectedWorkspaceId).catch(() => []) : []
    }

    onMount(() => {
        if (!document.getElementById('issh-plugin-agent-bridge-style')) {
            const style = document.createElement('style')
            style.id = 'issh-plugin-agent-bridge-style'
            style.textContent = bridgeCss
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

    async function toggleBind (sessionId: string): Promise<void> {
        if (!selectedWorkspace) return
        busy = true
        error = ''
        try {
            const bound = selectedWorkspace.bindings.some((binding) => binding.sessionId === sessionId)
            if (bound) await unbindSession(selectedWorkspace.id, sessionId)
            else await bindSession(selectedWorkspace.id, sessionId)
            await refresh()
        } catch (cause) {
            error = cause instanceof Error ? cause.message : String(cause)
        } finally {
            busy = false
        }
    }

    async function addAgent (): Promise<void> {
        if (!selectedWorkspaceId || !newAgentName.trim()) {
            error = '需要选择工作区并填写 agent 名称'
            return
        }
        busy = true
        error = ''
        try {
            await registerAgent({
                workspaceId: selectedWorkspaceId,
                name: newAgentName.trim(),
                adapter: newAgentAdapter || 'llm',
                sessionId: newAgentSessionId || undefined,
                scopes: newAgentScopes.split(',').map((scope) => scope.trim()).filter(Boolean),
            })
            newAgentName = ''
            newAgentSessionId = ''
            newAgentScopes = 'read'
            await refreshAgents()
        } catch (cause) {
            error = cause instanceof Error ? cause.message : String(cause)
        } finally {
            busy = false
        }
    }

    async function grantScope (agent: Agent, scope: string): Promise<void> {
        busy = true
        error = ''
        try {
            await authorizeAgent(agent.id, scope)
            await refreshAgents()
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

<div class="bridge-settings">
    {#if error}
        <div class="settings-error" role="alert">{error}</div>
    {/if}

    <div class="bridge-section">
        <div class="settings-field-title">工作区</div>
        <div class="bridge-toolbar">
            <select bind:value={selectedWorkspaceId} onchange={() => void refreshAgents()} aria-label="选择工作区" disabled={workspaces.length === 0}>
                {#if workspaces.length === 0}
                    <option value="">暂无工作区</option>
                {/if}
                {#each workspaces as workspace (workspace.id)}
                    <option value={workspace.id}>{workspace.name}（{workspace.bindings.length} 个绑定会话）</option>
                {/each}
            </select>
            <input type="text" placeholder="新工作区名称" bind:value={newWorkspaceName} aria-label="新工作区名称" />
            <button class="market-install" type="button" disabled={busy || !newWorkspaceName.trim()} onclick={() => void addWorkspace()}>创建</button>
        </div>
    </div>

    {#if selectedWorkspace}
        <div class="bridge-section">
            <div class="settings-field-title">会话绑定（{selectedWorkspace.bindings.length}）</div>
            {#if openSessions.length === 0}
                <div class="settings-empty">当前没有打开的终端会话。打开本地/SSH 标签页后可绑定到工作区。</div>
            {/if}
            {#each openSessions as session (session.id)}
                <div class="bridge-row">
                    <span class="bridge-session-title">{session.title}</span>
                    <span class="bridge-session-kind">{session.kind}</span>
                    <button
                        type="button"
                        disabled={busy}
                        onclick={() => void toggleBind(session.id)}
                    >
                        {selectedWorkspace.bindings.some((binding) => binding.sessionId === session.id) ? '解绑' : '绑定'}
                    </button>
                </div>
            {/each}
        </div>

        <div class="bridge-section">
            <div class="settings-field-title">Agent（{agents.length}）</div>
            <div class="bridge-toolbar">
                <input type="text" placeholder="agent 名称" bind:value={newAgentName} aria-label="agent 名称" />
                <select bind:value={newAgentAdapter} aria-label="适配器">
                    <option value="llm">llm</option>
                    <option value="cli">cli</option>
                </select>
                <select bind:value={newAgentSessionId} aria-label="绑定会话">
                    <option value="">不绑定会话</option>
                    {#each openSessions as session (session.id)}
                        <option value={session.id}>{session.title}</option>
                    {/each}
                </select>
                <input type="text" placeholder="scopes（逗号分隔）" bind:value={newAgentScopes} aria-label="scopes" />
                <button class="market-install" type="button" disabled={busy || !newAgentName.trim()} onclick={() => void addAgent()}>注册</button>
            </div>
            {#if agents.length === 0}
                <div class="settings-empty">该工作区暂无 agent。</div>
            {/if}
            {#each agents as agent (agent.id)}
                <div class="bridge-agent">
                    <div class="bridge-agent-head">
                        <strong>{agent.name}</strong>
                        <span class="bridge-agent-adapter">{agent.adapter}</span>
                        <span class="bridge-agent-status">{agent.status}</span>
                        <span class="bridge-agent-time">{timeLabel(agent.updatedAtUnixMs)}</span>
                    </div>
                    <div class="bridge-agent-meta">
                        <span>scopes：{agent.scopes.length ? agent.scopes.join(', ') : '（无）'}</span>
                        {#if agent.sessionId}
                            <span>会话：{agent.sessionId}</span>
                        {/if}
                    </div>
                    <div class="bridge-agent-actions">
                        {#each ['read', 'write', 'execute'] as scope (scope)}
                            {#if !agent.scopes.includes(scope)}
                                <button type="button" disabled={busy} onclick={() => void grantScope(agent, scope)}>授权 {scope}</button>
                            {/if}
                        {/each}
                    </div>
                </div>
            {/each}
        </div>
    {:else if workspaces.length > 0}
        <div class="settings-empty">选择一个工作区查看详情。</div>
    {/if}
</div>
