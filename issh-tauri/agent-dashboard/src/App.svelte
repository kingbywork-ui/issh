<script lang="ts">
  type RpcResponse<T> = { result?: T; error?: { message?: string } }
  type Workspace = { id: string; name: string; bindings: Array<{ sessionId?: string | null; status: string }> }
  type Session = { id: string; title: string; profileType?: string | null; connected: boolean }
  type Agent = { id: string; workspaceId: string; name: string; adapter: string; scopes: string[]; status: string; sessionId?: string | null }
  type Health = { runtimeVersion: string; capabilities: string[] }
  type Status = { enabled: boolean; running: boolean; port: number; url: string; tokenConfigured: boolean; lastError?: string | null }
  type Probe = { agents: Array<{ sessionId: string; name: string; path: string }>; errors: string[] }

  const bootstrap = location.hash.match(/bootstrap=([^&]+)/)?.[1] ? decodeURIComponent(location.hash.match(/bootstrap=([^&]+)/)![1]) : ''
  let token = sessionStorage.getItem('issh-management-token') ?? ''
  let status: Status | null = null
  let health: Health | null = null
  let workspaces: Workspace[] = []
  let sessions: Session[] = []
  let agents: Agent[] = []
  let probes: Probe | null = null
  let selectedWorkspace = ''
  let newWorkspace = ''
  let newAgent = ''
  let authorizationScope = 'context.read'
  let selectedSession = ''
  let message = ''
  let busy = false

  async function rpc<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const response = await fetch('/rpc', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: crypto.randomUUID(), method, params }),
    })
    const body = await response.json() as RpcResponse<T>
    if (!response.ok || body.error) throw new Error(body.error?.message ?? `请求失败：${response.status}`)
    return body.result as T
  }

  async function refresh(): Promise<void> {
    if (!token) return
    busy = true
    message = ''
    try {
      status = await rpc<Status>('management.status')
      health = await rpc<Health>('runtime.health')
      workspaces = await rpc<Workspace[]>('workspace.list')
      sessions = await rpc<Session[]>('session.list')
      if (!workspaces.some((workspace) => workspace.id === selectedWorkspace)) selectedWorkspace = workspaces[0]?.id ?? ''
      if (selectedWorkspace) agents = await rpc<Agent[]>('agent.list', { workspaceId: selectedWorkspace })
      else agents = []
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    } finally {
      busy = false
    }
  }

  async function call(method: string, params: Record<string, unknown> = {}): Promise<void> {
    busy = true
    message = ''
    try {
      const result = await rpc<{ token?: string }>(method, params)
      if (method === 'management.rotateToken' && result.token) {
        token = result.token
        sessionStorage.setItem('issh-management-token', token)
      }
      await refresh()
    } catch (error) { message = error instanceof Error ? error.message : String(error) } finally { busy = false }
  }

  async function login(): Promise<void> { await refresh() }
  function selectWorkspace(id: string): void { selectedWorkspace = id; void refresh() }
  function selectedSessions(): Session[] {
    const workspace = workspaces.find((item) => item.id === selectedWorkspace)
    const bound = new Set((workspace?.bindings ?? []).map((binding) => binding.sessionId).filter(Boolean))
    return sessions.filter((session) => bound.has(session.id))
  }

  async function probe(): Promise<void> {
    busy = true
    try { probes = await rpc<Probe>('mgmt.probeAgents'); message = `探测到 ${probes.agents.length} 个 Agent` } catch (error) { message = error instanceof Error ? error.message : String(error) } finally { busy = false }
  }

  $: if (token && !status && !busy) void refresh()

  if (!token && bootstrap) {
    void fetch('/bootstrap', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ bootstrap }),
    }).then(async (response) => {
      const body = await response.json() as RpcResponse<{ token?: string }>
      if (!response.ok || body.error || !body.result?.token) throw new Error(body.error?.message ?? '引导地址已失效，请重新打开 Web')
      token = body.result.token
      sessionStorage.setItem('issh-management-token', token)
      history.replaceState(null, '', location.pathname)
      await refresh()
    }).catch((error) => { message = error instanceof Error ? error.message : String(error) })
  }
</script>

<main class="shell">
  <header><div><p class="eyebrow">ISSH / AGENT BRIDGE</p><h1>Agent 管理</h1></div><button onclick={() => void refresh()} disabled={busy}>刷新</button></header>
  {#if !token}
    <section class="card login"><h2>输入管理令牌</h2><p>令牌只保存在当前浏览器会话中。</p><input type="password" bind:value={token} placeholder="Bearer token" onkeydown={(event) => event.key === 'Enter' && void login()} /><button class="primary" onclick={() => void login()}>连接</button></section>
  {:else}
    {#if message}<div class="notice">{message}</div>{/if}
    <section class="grid overview">
      <div class="card"><span>管理服务</span><strong class:ok={status?.running}>{status?.running ? '运行中' : '已暂停'}</strong><small>127.0.0.1:{status?.port ?? 33555}</small></div>
      <div class="card"><span>Runtime</span><strong>{health?.runtimeVersion ?? '—'}</strong><small>{health?.capabilities?.length ?? 0} 项能力</small></div>
      <div class="card"><span>工作区 / Agent</span><strong>{workspaces.length} / {agents.length}</strong><small>{status?.lastError ?? '本地受保护连接'}</small></div>
    </section>
    <section class="card controls"><div><h2>管理服务</h2><p>{status?.url ?? 'http://127.0.0.1:33555'}</p></div><div class="actions"><button onclick={() => void call(status?.enabled ? 'management.disable' : 'management.enable')} disabled={busy}>{status?.enabled ? '暂停' : '启用'}</button><button onclick={() => void call('management.rotateToken')} disabled={busy}>轮换令牌</button></div></section>
    <section class="card"><div class="section-head"><h2>工作区</h2><div class="inline"><input placeholder="新工作区名称" bind:value={newWorkspace} /><button class="primary" disabled={busy || !newWorkspace.trim()} onclick={() => { void call('workspace.create', { name: newWorkspace.trim() }); newWorkspace = '' }}>创建</button></div></div>
      <div class="workspace-list">{#each workspaces as workspace (workspace.id)}<button class:selected={workspace.id === selectedWorkspace} onclick={() => selectWorkspace(workspace.id)}><span>{workspace.name}</span><small>{workspace.bindings.length} 个会话</small></button>{/each}</div>
      {#if selectedWorkspace}<div class="detail"><div class="section-head"><h3>{workspaces.find((item) => item.id === selectedWorkspace)?.name}</h3><button class="danger" onclick={() => void call('workspace.delete', { workspaceId: selectedWorkspace })}>删除工作区</button></div><div class="inline"><select bind:value={selectedSession}><option value="">选择会话绑定</option>{#each sessions as session (session.id)}<option value={session.id}>{session.title} · {session.profileType ?? 'local'}</option>{/each}</select><button onclick={() => void call('workspace.bind', { workspaceId: selectedWorkspace, sessionId: selectedSession })} disabled={!selectedSession || busy}>绑定</button></div>{#each workspaces.find((item) => item.id === selectedWorkspace)?.bindings ?? [] as binding (binding.sessionId)}<div class="row"><span>{binding.sessionId ?? '未知会话'}</span><small>{binding.status}</small><button onclick={() => void call('workspace.unbind', { workspaceId: selectedWorkspace, sessionId: binding.sessionId })}>解绑</button></div>{/each}</div>{/if}
    </section>
    <section class="card"><div class="section-head"><h2>Agent</h2><button onclick={() => void probe()} disabled={busy}>探测</button></div>{#if probes}{#each probes.agents as found (found.sessionId + found.name)}<div class="row"><span>{found.name} · {found.path}</span><button onclick={() => void call('agent.register', { workspaceId: selectedWorkspace, name: found.name, adapter: 'llm', sessionId: found.sessionId })} disabled={!selectedWorkspace}>注册</button></div>{/each}{#each probes.errors as error}<p class="error">{error}</p>{/each}{/if}<div class="inline"><input placeholder="Agent 名称" bind:value={newAgent} /><button class="primary" disabled={!newAgent.trim() || !selectedWorkspace} onclick={() => { void call('agent.register', { workspaceId: selectedWorkspace, name: newAgent.trim(), adapter: 'llm' }); newAgent = '' }}>注册</button></div>{#each agents as agent (agent.id)}<div class="row"><span><b>{agent.name}</b><small>{agent.status} · {agent.scopes.join(', ')}</small></span><div class="actions"><select bind:value={authorizationScope}><option value="context.read">context.read</option><option value="llm.prompt">llm.prompt</option><option value="command.propose">command.propose</option><option value="command.execute">command.execute</option></select><button onclick={() => void call('agent.authorize', { agentId: agent.id, scope: authorizationScope })}>授权</button><button onclick={() => void call('agent.unregister', { workspaceId: selectedWorkspace, agentId: agent.id })}>注销</button></div></div>{/each}</section>
  {/if}
</main>
