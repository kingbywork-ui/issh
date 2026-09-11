<script lang="ts">
  import { onMount } from 'svelte'
  import ConversationPanel from './ConversationPanel.svelte'
  type Binding = { sessionId?: string | null; status: string }
  type Workspace = { id: string; name: string; bindings: Binding[] }
  type Session = { id: string; title: string; profileType?: string | null; connected: boolean }
  type Agent = { id: string; workspaceId: string; name: string; scopes: string[]; status: string; sessionId?: string | null }
  type Found = { sessionId: string; name: string; path: string }
  type Status = { enabled: boolean; running: boolean; port: number; url: string; lastError?: string | null }
  type Health = { runtimeVersion: string; capabilities: string[] }
  type Confirmation = { title: string; detail: string; method: string; params: Record<string, unknown>; success: string }
  class UnauthorizedError extends Error {}

  let token = sessionStorage.getItem('issh-management-token') ?? ''
  let tokenDraft = ''
  let authenticated = false
  let busy = false
  let status: Status | null = null
  let health: Health | null = null
  let runtimeError = ''
  let error = ''
  let notice = ''
  let workspaces: Workspace[] = []
  let sessions: Session[] = []
  let agents: Agent[] = []
  let found: Found[] = []
  let probeErrors: string[] = []
  let scanned = false
  let selectedWorkspace = ''
  let selectedSession = ''
  let newWorkspace = ''
  let newAgent = ''
  let agentSession = ''
  let query = ''
  let scopeChoices: Record<string, string> = {}
  let confirmation: Confirmation | null = null
  const scopeLabels: Record<string, string> = { 'context.read': '读取上下文', 'llm.prompt': '发送提示词', 'command.propose': '建议命令', 'command.execute': '执行命令' }
  $: workspace = workspaces.find((item) => item.id === selectedWorkspace)
  $: ready = authenticated && !!status?.enabled && !!health && !runtimeError
  $: boundSessions = sessions.filter((session) => session.connected && workspace?.bindings.some((binding) => binding.sessionId === session.id))
  $: availableSessions = sessions.filter((session) => session.connected && !workspace?.bindings.some((binding) => binding.sessionId === session.id))
  $: if (!availableSessions.some((session) => session.id === selectedSession)) selectedSession = ''
  $: if (!boundSessions.some((session) => session.id === agentSession)) agentSession = ''
  $: visibleFound = found.filter((item) => workspace?.bindings.some((binding) => binding.sessionId === item.sessionId) && matches(item.name + ' ' + item.path, query))
  $: visibleAgents = agents.filter((item) => matches(item.name, query))

  function matches(value: string, search: string): boolean { return value.toLowerCase().includes(search.trim().toLowerCase()) }
  function sessionLabel(id: string | null | undefined, list: Session[]): string {
    const session = list.find((item) => item.id === id)
    return session ? session.title : id ?? '工作区级'
  }
  function bindingStatus(value?: string): string {
    return value === 'connected' ? '已连接' : value === 'disconnected' ? '已断开' : value ?? '未绑定'
  }
  function registered(item: Found, list: Agent[]): boolean { return list.some((agent) => agent.sessionId === item.sessionId && agent.name.toLowerCase() === item.name.toLowerCase()) }
  function scopeFor(agent: Agent, choices: Record<string, string>): string {
    const selected = choices[agent.id]
    return selected && !agent.scopes.includes(selected) ? selected : Object.keys(scopeLabels).find((scope) => !agent.scopes.includes(scope)) ?? ''
  }

  async function rpc<T>(method: string, params: Record<string, unknown> = {}, bearer = token): Promise<T> {
    const response = await fetch('/rpc', {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + bearer },
      body: JSON.stringify({ jsonrpc: '2.0', id: crypto.randomUUID(), method, params }),
      signal: AbortSignal.timeout(method === 'mgmt.probeAgents' ? 180000 : 20000),
    })
    if (response.status === 401) throw new UnauthorizedError('连接已过期，请从 issh 设置重新打开 Agent Hub，或输入管理令牌。')
    const body = await response.json()
    if (!response.ok || body.error) throw new Error(body.error?.message ?? '请求失败：' + response.status)
    return body.result as T
  }
  function showError(reason: unknown): void {
    if (reason instanceof UnauthorizedError) {
      token = ''
      authenticated = false
      sessionStorage.removeItem('issh-management-token')
    }
    error = reason instanceof Error ? reason.message : String(reason)
  }
  async function load(bearer = token): Promise<void> {
    status = await rpc<Status>('management.status', {}, bearer)
    authenticated = true
    token = bearer
    sessionStorage.setItem('issh-management-token', bearer)
    health = null
    runtimeError = ''
    if (!status.enabled) return
    try {
      health = await rpc<Health>('runtime.health', {}, bearer)
      const nextWorkspaces = await rpc<Workspace[]>('workspace.list', {}, bearer)
      const nextSessions = await rpc<Session[]>('session.list', {}, bearer)
      const nextId = nextWorkspaces.some((item) => item.id === selectedWorkspace) ? selectedWorkspace : nextWorkspaces[0]?.id ?? ''
      const nextAgents = nextId ? await rpc<Agent[]>('agent.list', { workspaceId: nextId }, bearer) : []
      workspaces = nextWorkspaces
      sessions = nextSessions
      selectedWorkspace = nextId
      agents = nextAgents
    } catch (reason) {
      if (reason instanceof UnauthorizedError) throw reason
      runtimeError = reason instanceof Error ? reason.message : String(reason)
      health = null
    }
  }
  async function refresh(): Promise<void> {
    if (busy) return
    busy = true
    error = ''
    try { await load() } catch (reason) { showError(reason) } finally { busy = false }
  }
  async function login(): Promise<void> {
    const candidate = tokenDraft.trim().replace(/^Bearer\s+/i, '').trim()
    if (!candidate || busy) return
    busy = true
    error = ''
    try { await load(candidate); tokenDraft = '' } catch (reason) {
      showError(reason)
      if (reason instanceof UnauthorizedError) error = '管理令牌无效或已过期，请检查后重试。'
    } finally { busy = false }
  }
  onMount(() => {
    void (async () => {
      busy = true
      try {
        const bootstrap = new URLSearchParams(location.hash.slice(1)).get('bootstrap')
        if (bootstrap) {
          history.replaceState(null, '', location.pathname + location.search)
          const response = await fetch('/bootstrap', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ bootstrap }), signal: AbortSignal.timeout(20000) })
          const body = await response.json()
          if (!response.ok || !body.token) throw new Error(body.error?.message ?? '引导地址已失效，请从 issh 设置重新打开。')
          token = body.token
        }
        if (token) await load()
      } catch (reason) { showError(reason) } finally { busy = false }
    })()
  })
  async function selectWorkspace(id: string): Promise<void> {
    if (busy || !ready) return
    busy = true
    error = ''
    try {
      const next = await rpc<Agent[]>('agent.list', { workspaceId: id })
      selectedWorkspace = id
      agents = next
      query = ''
    } catch (reason) { showError(reason) } finally { busy = false }
  }
  async function mutate(method: string, params: Record<string, unknown>, success: string): Promise<boolean> {
    if (busy) return false
    busy = true
    error = ''
    notice = ''
    try {
      const result = await rpc<{ token?: string; id?: string } | null>(method, params)
      if (method === 'management.rotateToken' && result?.token) token = result.token
      if (method === 'workspace.create' && result?.id) selectedWorkspace = result.id
      notice = success
      try { await load() } catch (reason) { showError(reason); notice = success + '；刷新失败，请点击刷新查看最新状态。' }
      return true
    } catch (reason) { showError(reason); return false } finally { busy = false }
  }
  async function createWorkspace(): Promise<void> {
    if (await mutate('workspace.create', { name: newWorkspace.trim() }, '工作区已创建')) newWorkspace = ''
  }
  async function registerManual(): Promise<void> {
    if (await mutate('agent.register', { workspaceId: selectedWorkspace, name: newAgent.trim(), adapter: 'llm', ...(agentSession ? { sessionId: agentSession } : {}) }, 'Agent 已注册')) newAgent = ''
  }
  async function probe(): Promise<void> {
    if (busy || !ready) return
    busy = true
    error = ''
    try {
      const result = await rpc<{ agents: Found[]; errors: string[] }>('mgmt.probeAgents', { workspaceId: selectedWorkspace })
      found = result.agents.filter((item, index, items) => items.findIndex((other) => other.sessionId === item.sessionId && other.name === item.name && other.path === item.path) === index)
      probeErrors = result.errors
      scanned = true
      notice = '探测完成，按当前工作区展示结果。'
    } catch (reason) { showError(reason) } finally { busy = false }
  }
  async function confirmAction(): Promise<void> {
    if (!confirmation) return
    const action = confirmation
    if (await mutate(action.method, action.params, action.success)) confirmation = null
  }
</script>

<svelte:window onkeydown={(event) => { if (event.key === 'Escape' && !busy) confirmation = null }} />
<main class="shell" inert={confirmation !== null}>
  <header class="page-head">
    <div class="brand"><span class="brand-mark" aria-hidden="true">H</span><div><p class="eyebrow">ISSH · LOCAL WORKSPACE</p><h1>Agent Hub</h1></div></div>
    <div class="header-actions"><span class="connection"><i class:online={ready}></i>{ready ? '已连接' : busy ? '连接中' : authenticated ? '需要处理' : '未连接'}</span>{#if authenticated}<button onclick={() => void refresh()} disabled={busy}>{busy ? '处理中…' : '刷新'}</button>{/if}</div>
  </header>
  {#if error}<div class="notice error" role="alert">{error}</div>{/if}
  {#if notice && authenticated}<div class="notice success" role="status">{notice}</div>{/if}
  {#if !authenticated}
    <section class="card login">
      <p class="eyebrow">连接你的本地环境</p><h2>进入 Agent Hub</h2>
      <p class="muted">从 issh 设置中打开本页可自动连接，也可以使用管理令牌。</p>
      <form onsubmit={(event) => { event.preventDefault(); void login() }}>
        <label for="token">管理令牌</label><input id="token" type="password" bind:value={tokenDraft} placeholder="粘贴管理令牌，支持 Bearer 前缀" autocomplete="off" />
        <button class="primary" disabled={busy || !tokenDraft.trim()}>{busy ? '正在连接…' : '连接'}</button>
      </form><small>令牌仅保存在当前浏览器会话中。</small>
    </section>
  {:else}
    <section class="overview" aria-label="连接概览">
      <div><span>管理服务</span><strong>{status?.enabled ? '运行中' : '已暂停'}</strong><small>{status?.url}</small></div>
      <div><span>终端运行时</span><strong>{health ? '已就绪' : status?.enabled ? '不可用' : '已暂停访问'}</strong><small>{health ? 'v' + health.runtimeVersion + ' · ' + health.capabilities.length + ' 项能力' : '工作区操作依赖终端运行时'}</small></div>
      <div><span>当前工作区</span><strong>{workspace?.name ?? '尚未创建'}</strong><small>{workspace?.bindings.length ?? 0} 个会话 · {agents.length} 个已注册 Agent</small></div>
    </section>
    {#if runtimeError}<div class="notice error" role="alert"><b>终端运行时暂不可用</b><p>{runtimeError}</p><small>请确认 issh 正常运行后刷新。下方保留上次数据，操作已暂时禁用。</small></div>{/if}
    {#if !status?.enabled}<div class="notice" role="status">管理访问已暂停。<button onclick={() => void mutate('management.enable', {}, '管理访问已恢复')} disabled={busy}>恢复管理访问</button></div>{/if}
    <div class="workspace-layout">
      <aside class="card workspace-nav">
        <div class="section-head"><h2>工作区</h2><span class="count">{workspaces.length}</span></div>
        <p class="muted">选择工作区，管理会话与 Agent。</p>
        <nav aria-label="工作区列表">
          {#each workspaces as item (item.id)}
            <button class:selected={item.id === selectedWorkspace} aria-current={item.id === selectedWorkspace ? 'true' : undefined} onclick={() => void selectWorkspace(item.id)} disabled={busy || !ready}><b>{item.name}</b><small>{item.bindings.length} 个会话 <span aria-hidden="true">→</span></small></button>
          {/each}
        </nav>
        {#if !workspaces.length}<p class="empty compact">创建第一个工作区，然后绑定 issh 会话。</p>{/if}
        <form class="create-form" onsubmit={(event) => { event.preventDefault(); void createWorkspace() }}>
          <label for="workspace-name">新工作区</label><input id="workspace-name" bind:value={newWorkspace} maxlength="120" placeholder="例如：开发环境" /><button class="primary" disabled={busy || !ready || !newWorkspace.trim()}>创建工作区</button>
        </form>
      </aside>
      <div class="workspace-content">
        {#if workspace}
          {#key selectedWorkspace}<ConversationPanel workspaceId={selectedWorkspace} {agents} {ready} {rpc} onError={showError} />{/key}
          <section class="card">
            <div class="section-head"><div><p class="eyebrow">工作区会话</p><h2>{workspace.name}</h2></div><button class="danger subtle" disabled={busy || !ready} onclick={() => confirmation = { title: '删除工作区', detail: '将删除「' + workspace.name + '」及其中的 Agent、任务和绑定记录。此操作无法撤销，但不会关闭终端会话。', method: 'workspace.delete', params: { workspaceId: workspace.id }, success: '工作区已删除' }}>删除工作区</button></div>
            <form class="inline" onsubmit={(event) => { event.preventDefault(); void mutate('workspace.bind', { workspaceId: selectedWorkspace, sessionId: selectedSession }, '会话已绑定') }}>
              <div class="field"><label for="session">绑定在线会话</label><select id="session" bind:value={selectedSession}><option value="">{availableSessions.length ? '选择 issh 会话' : '暂无可绑定的在线会话'}</option>{#each availableSessions as session (session.id)}<option value={session.id}>{session.title} · {session.profileType ?? 'local'} · {session.id}</option>{/each}</select></div>
              <button class="primary" disabled={busy || !ready || !selectedSession}>绑定会话</button>
            </form>
            <div class="session-list">
              {#each workspace.bindings as binding, index (binding.sessionId ?? index)}
                <div class="session-row"><div class="identity"><b>{sessionLabel(binding.sessionId, sessions)}</b><small>{binding.sessionId ?? '会话记录不可用'} · {sessions.find((item) => item.id === binding.sessionId)?.profileType ?? '未知类型'}</small></div><span class="badge" class:good={binding.status === 'connected'}>{bindingStatus(binding.status)}</span><button disabled={busy || !ready || !binding.sessionId} onclick={() => confirmation = { title: '解除会话绑定', detail: '解除「' + sessionLabel(binding.sessionId, sessions) + '」与当前工作区的绑定。已注册 Agent 的记录仍会保留。', method: 'workspace.unbind', params: { workspaceId: selectedWorkspace, sessionId: binding.sessionId }, success: '会话已解绑' }}>解绑</button></div>
              {:else}<p class="empty">还没有绑定会话。先在 issh 打开本地或 SSH 终端，再从上方选择绑定。</p>{/each}
            </div>
          </section>
          <section class="card agents">
            <div class="section-head"><div><p class="eyebrow">AGENT DIRECTORY</p><h2>Agent</h2></div><button class="primary" disabled={busy || !ready || !boundSessions.length} onclick={() => void probe()}>探测 Agent</button></div>
            <p class="muted">展示「{workspace.name}」的 Agent，来源会话与工作区绑定一一对应。</p>
            <label class="search-label" for="agent-search">搜索 Agent</label><input id="agent-search" type="search" bind:value={query} placeholder="搜索名称或可执行文件路径" />
            <div class="subsection-head"><h3>探测结果</h3><span class="count">{visibleFound.length}</span></div>
            {#each visibleFound as item (JSON.stringify([item.sessionId, item.name, item.path]))}
              <article class="agent-row">
                <div class="agent-info"><div class="agent-title"><b>{item.name}</b><span class="badge">{registered(item, agents) ? '已注册' : '可注册'}</span></div><code class="path">{item.path}</code><p class="binding"><span>{workspace.name}</span><span aria-hidden="true">→</span><span>{sessionLabel(item.sessionId, sessions)}</span><small>{item.sessionId} · {bindingStatus(workspace.bindings.find((binding) => binding.sessionId === item.sessionId)?.status)}</small></p></div>
                <button disabled={busy || !ready || registered(item, agents) || !boundSessions.some((session) => session.id === item.sessionId)} onclick={() => void mutate('agent.register', { workspaceId: workspace.id, name: item.name, adapter: 'llm', sessionId: item.sessionId }, item.name + ' 已注册')}>{registered(item, agents) ? '已注册' : '注册'}</button>
              </article>
            {:else}<p class="empty">{query ? '没有匹配的探测结果。' : !boundSessions.length ? '绑定在线会话后，即可探测其中安装的 Agent。' : scanned ? '当前工作区没有探测结果。确认 Agent 已安装后重新探测。' : '点击“探测 Agent”，查找会话中安装的 Agent。'}</p>{/each}
            {#if probeErrors.length}<details class="probe-errors"><summary>部分会话探测失败（{probeErrors.length}）</summary>{#each probeErrors as failure}<p>{failure}</p>{/each}</details>{/if}
            <div class="subsection-head"><h3>已注册 Agent</h3><span class="count">{agents.length}</span></div>
            {#each visibleAgents as agent (agent.id)}
              <article class="registered-agent">
                <div class="agent-title"><b>{agent.name}</b><span class="badge">{agent.status === 'idle' ? '空闲' : agent.status}</span><small>{agent.id}</small></div>
                <p class="binding"><span>{workspace.name}</span><span aria-hidden="true">→</span><span>{agent.sessionId ? sessionLabel(agent.sessionId, sessions) : '工作区级（未指定会话）'}</span>{#if agent.sessionId}<small>{agent.sessionId} · {bindingStatus(workspace.bindings.find((binding) => binding.sessionId === agent.sessionId)?.status)}</small>{/if}</p>
                {#if !agent.sessionId}<p class="muted">工作区会话：{workspace.bindings.map((binding) => sessionLabel(binding.sessionId, sessions) + '（' + bindingStatus(binding.status) + '）').join('、') || '暂无会话'}</p>{/if}
                <div class="scopes">{#each agent.scopes as scope}<span title={scope}>{scopeLabels[scope] ?? scope}</span>{/each}</div>
                <div class="agent-actions"><label class="field">新增权限<select value={scopeFor(agent, scopeChoices)} onchange={(event) => scopeChoices = { ...scopeChoices, [agent.id]: event.currentTarget.value }} disabled={busy || !ready}><option value="">选择尚未授予的权限</option>{#each Object.entries(scopeLabels) as [scope, label]}{#if !agent.scopes.includes(scope)}<option value={scope}>{label}</option>{/if}{/each}</select></label><button disabled={busy || !ready || !scopeFor(agent, scopeChoices)} onclick={() => void mutate('agent.grantScope', { agentId: agent.id, scope: scopeFor(agent, scopeChoices) }, agent.name + ' 权限已更新')}>授权</button><button class="danger subtle" disabled={busy || !ready} onclick={() => confirmation = { title: '注销 Agent', detail: '从「' + workspace.name + '」移除 ' + agent.name + ' 的注册记录，不会卸载会话中的程序。', method: 'agent.unregister', params: { workspaceId: agent.workspaceId, agentId: agent.id }, success: agent.name + ' 已注销' }}>注销</button></div>
              </article>
            {:else}<p class="empty">{query ? '没有匹配的已注册 Agent。' : '尚未注册 Agent。可从探测结果中注册，也可在下方手动添加。'}</p>{/each}
            <details class="manual"><summary>手动注册 Agent</summary><p class="muted">注册到当前工作区，可选择一个已绑定的在线会话。</p><form class="manual-form" onsubmit={(event) => { event.preventDefault(); void registerManual() }}><label class="field">Agent 名称<input bind:value={newAgent} maxlength="120" placeholder="输入 Agent 名称" /></label><label class="field">关联会话<select bind:value={agentSession}><option value="">工作区级（不指定会话）</option>{#each boundSessions as session (session.id)}<option value={session.id}>{session.title} · {session.id}</option>{/each}</select></label><button class="primary" disabled={busy || !ready || !newAgent.trim()}>注册 Agent</button></form></details>
          </section>
        {:else}<section class="card welcome"><p class="eyebrow">从一个工作区开始</p><h2>把会话与 Agent 放在一起</h2><p class="muted">创建工作区 → 绑定会话 → 探测并注册 Agent</p></section>{/if}
      </div>
    </div>
    <details class="card service"><summary>管理服务设置</summary><div class="service-content"><p class="muted">暂停会禁用管理操作，但服务仍监听。需要彻底关闭 Agent Hub 时，请使用 issh 设置中的“关闭 Agent Hub”。</p><div class="actions"><button disabled={busy} onclick={() => void mutate(status?.enabled ? 'management.disable' : 'management.enable', {}, status?.enabled ? '管理访问已暂停' : '管理访问已恢复')}>{status?.enabled ? '暂停管理访问' : '恢复管理访问'}</button><button disabled={busy} onclick={() => confirmation = { title: '轮换管理令牌', detail: '其他浏览器的现有连接将失效，当前页面会使用新令牌继续连接。', method: 'management.rotateToken', params: {}, success: '管理令牌已轮换' }}>轮换管理令牌</button></div></div></details>
  {/if}
</main>
{#if confirmation}
  <div class="modal-backdrop">
    <div class="card confirmation" role="dialog" aria-modal="true" aria-labelledby="confirmation-title" tabindex="-1" use:focusDialog>
      <h2 id="confirmation-title">{confirmation.title}</h2><p>{confirmation.detail}</p>
      {#if error}<p class="error" role="alert">{error}</p>{/if}
      <div class="actions"><button disabled={busy} onclick={() => confirmation = null}>取消</button><button class="danger" disabled={busy} onclick={() => void confirmAction()}>{busy ? '处理中…' : '确认' + confirmation.title}</button></div>
    </div>
  </div>
{/if}
<script context="module" lang="ts">
  function focusDialog(node: HTMLElement) {
    const previous = document.activeElement as HTMLElement | null
    node.querySelector<HTMLButtonElement>('button')?.focus()
    function trap(event: KeyboardEvent) {
      if (event.key !== 'Tab') return
      const controls = [...node.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]
      const first = controls[0], last = controls[controls.length - 1]
      if (!first) { event.preventDefault(); return }
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
    }
    node.addEventListener('keydown', trap)
    return { destroy() { node.removeEventListener('keydown', trap); previous?.focus() } }
  }
</script>
