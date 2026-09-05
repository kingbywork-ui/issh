<script lang="ts">
    import { onMount } from 'svelte'
    import bridgeCss from './bridge.css?inline'
    import {
        runtimeHealth,
        bindSession,
        createWorkspace,
        listAgents,
        listSessions,
        probeRemoteAgents,
        listWorkspaces,
        registerAgent,
        unregisterAgent,
        unbindSession,
        type Agent,
        type SessionInfo,
        type Workspace,
    } from './bridgeRpc'

    let workspaces = $state<Workspace[]>([])
    let sessions = $state<SessionInfo[]>([])
    let detectedAgents = $state<DetectedAgent[]>([])
    let agents = $state<Agent[]>([])
    let selectedWorkspaceId = $state('')
    let newWorkspaceName = $state('')
    let newAgentName = $state('')
    let newAgentSessionId = $state('')
    let newAgentScopes = $state('context.read,llm.prompt,command.propose')
    let health = $state<{ runtimeVersion: string; capabilities: string[] } | null>(null)
    let busy = $state(false)
    let error = $state('')
    let scanning = $state(false)
    let scanStatus = $state('')
    let scanErrors = $state<string[]>([])

    interface DetectedAgent {
        name: string
        sessionId: string
        evidence: string
        command?: string
        path?: string
        source: 'remote' | 'terminal'
    }

    const REMOTE_AGENT_COMMANDS = [
        { command: 'pi', name: 'Pi' },
        { command: 'omp', name: 'OMP' },
        { command: 'codex', name: 'Codex' },
        { command: 'claude', name: 'Claude Code' },
        { command: 'opencode', name: 'OpenCode' },
        { command: 'hermes', name: 'Hermes Agent' },
        { command: 'hermes-agent', name: 'Hermes Agent' },
    ] as const

    const selectedWorkspace = $derived(workspaces.find((workspace) => workspace.id === selectedWorkspaceId) ?? null)
    const openSessions = $derived(sessions.filter((session) => session.connected))
    const boundOpenSessions = $derived(openSessions.filter((session) => selectedWorkspace?.bindings.some((binding) => binding.sessionId === session.id)))
    const disconnectedBindings = $derived(selectedWorkspace?.bindings.filter((binding) => binding.sessionId && !openSessions.some((session) => session.id === binding.sessionId)) ?? [])
    const unregisteredDetectedAgents = $derived(detectedAgents.filter((detected) => !agents.some((agent) => agent.sessionId === detected.sessionId && agent.name === detected.name)))

    async function detectAgents (candidates: SessionInfo[], workspace: Workspace | null): Promise<DetectedAgent[]> {
        const boundSessionIds = new Set(workspace?.bindings.map((binding) => binding.sessionId) ?? [])
        const results = await Promise.all(candidates.filter((session) => session.connected && session.profileType === 'ssh' && boundSessionIds.has(session.id)).map(async (session) => {
            const detected: DetectedAgent[] = []
            try {
                const remote = await probeRemoteAgents(session.id)
                for (const line of remote.output.split(/\r?\n/)) {
                    const [command, path] = line.trim().split(/\t+/, 2)
                    const candidate = REMOTE_AGENT_COMMANDS.find((item) => item.command === command)
                    if (candidate && path?.startsWith('/') && !detected.some((agent) => agent.name === candidate.name)) {
                        detected.push({ name: candidate.name, command, path, sessionId: session.id, evidence: session.title, source: 'remote' })
                    }
                }
            } catch (cause) {
                scanErrors = [...scanErrors, `${session.title}: ${cause instanceof Error ? cause.message : String(cause)}`]
            }
            return detected
        }))
        return results.flat()
    }

    async function refresh (): Promise<void> {
        if (scanning) return
        scanning = true
        scanStatus = '正在探测…'
        scanErrors = []
        detectedAgents = []
        busy = true
        error = ''
        try {
            const [ws, ss] = await Promise.all([listWorkspaces(), listSessions()])
            workspaces = ws
            sessions = ss
            health = await runtimeHealth().catch(() => null)
            if (!workspaces.some((workspace) => workspace.id === selectedWorkspaceId)) {
                selectedWorkspaceId = workspaces[0]?.id ?? ''
            }
            const workspace = workspaces.find((candidate) => candidate.id === selectedWorkspaceId) ?? null
            detectedAgents = await detectAgents(ss, workspace)
            const scannedCount = ss.filter((session) => session.connected && session.profileType === 'ssh' && workspace?.bindings.some((binding) => binding.sessionId === session.id)).length
            scanStatus = scannedCount === 0
                ? '没有可扫描的 SSH 会话，请先绑定并连接会话。'
                : `探测完成：${scannedCount} 个 SSH 会话，发现 ${detectedAgents.length} 个 Agent，${scanErrors.length} 个会话失败（${new Date().toLocaleTimeString()}）。`
            agents = selectedWorkspaceId ? await listAgents(selectedWorkspaceId) : []
        } catch (cause) {
            error = cause instanceof Error ? cause.message : String(cause)
            scanStatus = '探测失败，请查看错误信息后重试。'
        } finally {
            scanning = false
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
                adapter: 'llm',
                sessionId: newAgentSessionId || undefined,
                scopes: newAgentScopes.split(',').map((scope) => scope.trim()).filter(Boolean),
            })
            newAgentName = ''
            newAgentSessionId = ''
            newAgentScopes = 'context.read,llm.prompt,command.propose'
            await refreshAgents()
        } catch (cause) {
            error = cause instanceof Error ? cause.message : String(cause)
        } finally {
            busy = false
        }
    }

    async function registerDetectedAgent (detected: DetectedAgent): Promise<void> {
        if (!selectedWorkspace) return
        busy = true
        error = ''
        try {
            if (!selectedWorkspace.bindings.some((binding) => binding.sessionId === detected.sessionId)) {
                await bindSession(selectedWorkspace.id, detected.sessionId)
            }
            await registerAgent({
                workspaceId: selectedWorkspace.id,
                name: detected.name,
                adapter: 'llm',
                sessionId: detected.sessionId,
                scopes: ['context.read', 'llm.prompt', 'command.propose'],
            })
            await refresh()
        } catch (cause) {
            error = cause instanceof Error ? cause.message : String(cause)
        } finally {
            busy = false
        }
    }

    async function removeAgent (agent: Agent): Promise<void> {
        if (!selectedWorkspaceId) return
        if (!window.confirm(`确定注销 ${agent.name}？该 Agent 及其关联任务记录将被删除。`)) return
        busy = true
        error = ''
        try {
            await unregisterAgent(selectedWorkspaceId, agent.id)
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
        <div class="settings-field-title">Runtime</div>
        {#if health}
            <div class="settings-hint">版本 {health.runtimeVersion} · workspace 能力：{health.capabilities.filter((capability) => capability.startsWith('workspace.')).join(', ') || '（未声明）'}</div>
        {:else}
            <div class="settings-empty">Runtime 未连接或 health 不可用。</div>
        {/if}
    </div>

    <div class="bridge-section">
        <div class="settings-field-title">工作区</div>
        <div class="bridge-toolbar">
            <select bind:value={selectedWorkspaceId} onchange={() => void refresh()} aria-label="选择工作区" disabled={workspaces.length === 0}>
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
                    <span class="bridge-session-kind">{session.profileType === 'ssh' ? 'SSH' : '本地'}</span>
                    <button
                        type="button"
                        disabled={busy}
                        onclick={() => void toggleBind(session.id)}
                    >
                        {selectedWorkspace.bindings.some((binding) => binding.sessionId === session.id) ? '解绑' : '绑定'}
                    </button>
                </div>
            {/each}
            {#each disconnectedBindings as binding (binding.sessionId)}
                <div class="bridge-row">
                    <span class="bridge-session-title">{binding.sessionId}</span>
                    <span class="bridge-session-kind">已断开</span>
                    <button type="button" disabled={busy} onclick={() => void toggleBind(binding.sessionId)}>解绑</button>
                </div>
            {/each}
        </div>

        <div class="bridge-section">
            <div class="bridge-row">
                <div class="settings-field-title">Agent（{agents.length}）</div>
                <button type="button" disabled={busy || scanning} onclick={() => void refresh()}>{scanning ? '正在探测…' : '重新探测'}</button>
            </div>
            <div class="settings-hint" role="status" aria-live="polite">{scanStatus}</div>
            {#each scanErrors as scanError}
                <div class="settings-hint" role="alert">{scanError}</div>
            {/each}
            {#if unregisteredDetectedAgents.length > 0}
                <div class="bridge-section">
                    <div class="settings-hint">检测到已绑定 SSH 账号下的 Agent 可执行文件（不代表正在运行，点击注册到当前工作区）</div>
                    {#each unregisteredDetectedAgents as detected (detected.sessionId + ':' + detected.name + ':' + (detected.command ?? 'terminal'))}
                        <div class="bridge-row">
                            <span class="bridge-session-title">{detected.name} · {detected.evidence}{#if detected.path} · {detected.path}{/if}</span>
                            <span class="bridge-session-kind">{detected.source === 'remote' ? '远端命令' : '终端输出'}</span>
                            <button type="button" disabled={busy} onclick={() => void registerDetectedAgent(detected)}>注册</button>
                        </div>
                    {/each}
                </div>
            {/if}
            <div class="bridge-toolbar">
                <input type="text" placeholder="agent 名称" bind:value={newAgentName} aria-label="agent 名称" />
                <span class="bridge-session-kind">llm</span>
                <select bind:value={newAgentSessionId} aria-label="绑定会话">
                    <option value="">不绑定会话</option>
                    {#each boundOpenSessions as session (session.id)}
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
                        <button type="button" disabled={busy} onclick={() => void removeAgent(agent)}>注销</button>
                    </div>
                </div>
            {/each}
        </div>
    {:else if workspaces.length > 0}
        <div class="settings-empty">选择一个工作区查看详情。</div>
    {/if}
</div>
