<script lang="ts">
  import { onMount, afterUpdate } from 'svelte'
  type Agent = { id: string; name: string; scopes: string[] }
  type Config = { kind: string; executable: string; args: string[]; cwd: string; launchCwd?: string; timeoutMs: number }
  type Message = { id: string; kind: string; from: string; to: string; text: string; createdAt: number; nativeConversationId?: string }
  type Room = { id: string; title: string; agentIds: string[]; names: Record<string, string>; status: string; error: string; activeAgentId?: string; updatedAt: number; messages?: Message[]; nativeSessions: Record<string, string> }
  export let workspaceId: string
  export let agents: Agent[]
  export let ready: boolean
  export let rpc: <T>(method: string, params?: Record<string, unknown>) => Promise<T>
  export let onError: (reason: unknown) => void
  let rooms: Room[] = []
  let room: Room | null = null
  let configs: Record<string, Config | null> = {}
  let first = ''
  let second = ''
  let draft = ''
  let turns = 3
  let busy = false
  let polling = false
  let disposed = false
  let failure = ''
  let notice = ''
  let editing = ''
  let kind = 'pi'
  let executable = ''
  let argv = '[]'
  let cwd = ''
  let launchCwd = ''
  let timeoutMs = 120000
  let configOpen = false
  let logElement: HTMLDivElement
  let atBottom = true
  let renderedRoom = ''
  let renderedCount = 0
  let pendingRequest: { id: string; roomId: string; text: string; turns: number } | null = null
  const labels: Record<string, string> = { idle: '待发送', running: '正在通讯', completed: '已完成', failed: '失败', interrupted: '已中断', cancelled: '已停止' }
  $: if (!agents.some(a => a.id === first)) first = agents[0]?.id ?? ''
  $: if (!agents.some(a => a.id === second) || first === second) second = agents.find(a => a.id !== first)?.id ?? ''
  $: canSend = ready && !busy && room?.status !== 'running' && !!room && room.agentIds.every(id => configs[id] && agents.some(a => a.id === id && a.scopes.includes('llm.prompt')))
  $: needsConfig = !!room && !room.agentIds.every(id => configs[id] && agents.some(a => a.id === id && a.scopes.includes('llm.prompt')))

  function latest(): void { if (logElement) { logElement.scrollTop = logElement.scrollHeight; atBottom = true } }
  afterUpdate(() => {
    if (room && (renderedRoom !== room.id || renderedCount !== room.messages?.length)) {
      if (atBottom || renderedRoom !== room.id) latest()
      renderedRoom = room.id
      renderedCount = room.messages?.length ?? 0
    }
  })

  function name(id: string, item = room): string { return id === 'user' ? '你' : item?.names[id] ?? agents.find(a => a.id === id)?.name ?? id }
  function date(value: number): string { return new Date(value).toLocaleString('zh-CN', { hour12: false }) }
  async function call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> { return rpc<T>(method, { ...params, workspaceId }) }
  function fail(reason: unknown): void { failure = reason instanceof Error ? reason.message : String(reason); onError(reason) }
  async function reload(): Promise<void> {
    if (!ready || polling || disposed) return
    polling = true
    const selected = room?.id
    try {
      const [nextRooms, nextConfigs] = await Promise.all([call<Room[]>('conversation.list'), call<Record<string, Config | null>>('conversation.configs')])
      if (disposed) return
      rooms = nextRooms
      configs = nextConfigs
      const id = selected ?? nextRooms[0]?.id
      if (id) {
        const next = await call<Room>('conversation.read', { conversationId: id })
        if (!disposed && (!room || room.id === id)) room = next
      }
    } catch (reason) { if (!disposed) fail(reason) } finally { polling = false }
  }
  onMount(() => {
    void reload()
    const interval = setInterval(() => { if (!busy) void reload() }, 2500)
    return () => { disposed = true; clearInterval(interval) }
  })
  async function choose(id: string): Promise<void> {
    if (busy) return
    busy = true
    failure = ''
    try { room = await call<Room>('conversation.read', { conversationId: id }) } catch (reason) { fail(reason) } finally { busy = false }
  }
  async function create(): Promise<void> {
    busy = true
    failure = ''
    try { room = await call<Room>('conversation.create', { agentIds: [first, second] }); await reload() } catch (reason) { fail(reason) } finally { busy = false }
  }
  function edit(id: string): void {
    editing = id
    const current = configs[id]
    kind = current?.kind ?? (agents.find(a => a.id === id)?.name.toLowerCase().includes('hermes') ? 'hermes' : agents.find(a => a.id === id)?.name.toLowerCase().includes('codex') ? 'codex' : 'pi')
    executable = current?.executable ?? ''
    argv = JSON.stringify(current?.args ?? (kind === 'hermes' ? ['acp'] : kind === 'codex' ? ['app-server'] : ['--mode', 'rpc']), null, 2)
    cwd = current?.cwd ?? ''
    launchCwd = current?.launchCwd ?? ''
    timeoutMs = current?.timeoutMs ?? 120000
    configOpen = true
    notice = ''
  }
  async function saveConfig(): Promise<void> {
    busy = true
    failure = ''
    try {
      const args: unknown = JSON.parse(argv)
      if (!Array.isArray(args) || args.some(a => typeof a !== 'string')) throw new Error('启动参数必须是 JSON 字符串数组，例如 ["--mode", "rpc"]')
      const config = await call<Config>('conversation.configure', { agentId: editing, config: { kind, executable, args, cwd, launchCwd, timeoutMs } })
      configs = { ...configs, [editing]: config }
      notice = '通讯配置已保存，发送时会连接协议会话。'
      editing = ''
    } catch (reason) { fail(reason) } finally { busy = false }
  }
  async function send(): Promise<void> {
    if (!room || !canSend || !draft.trim()) return
    busy = true
    failure = ''
    if (!pendingRequest || pendingRequest.roomId !== room.id || pendingRequest.text !== draft.trim() || pendingRequest.turns !== turns) pendingRequest = { id: crypto.randomUUID(), roomId: room.id, text: draft.trim(), turns }
    try {
      room = await call<Room>('conversation.send', { conversationId: room.id, requestId: pendingRequest.id, text: pendingRequest.text, turns: pendingRequest.turns })
      draft = ''
      pendingRequest = null
      await reload()
    } catch (reason) { fail(reason) } finally { busy = false }
  }
  async function stop(): Promise<void> {
    if (!room) return
    busy = true
    try { room = await call<Room>('conversation.cancel', { conversationId: room.id }) } catch (reason) { fail(reason) } finally { busy = false }
  }
</script>

<section class="card conversations" aria-label="Agent 会话">
  <div class="section-head"><div><p class="eyebrow">AGENT ↔ AGENT</p><h2>Agent 会话</h2></div><button disabled={busy || !ready} onclick={() => void reload()}>刷新记录</button></div>
  <p class="muted">让已注册 Agent 交换消息，回复与记录留在当前工作区。使用独立协议会话，不接管终端里正在进行的聊天。</p>
  {#if failure}<p class="conversation-error" role="alert">{failure}</p>{/if}
  {#if notice}<p class="conversation-notice" role="status">{notice}</p>{/if}
  <details class="connection-settings" bind:open={configOpen}>
    <summary>通讯配置 · {agents.filter(a => configs[a.id]).length}/{agents.length} 已配置</summary>
    <div class="endpoint-list">{#each agents as agent (agent.id)}<div><span><b>{agent.name}</b><small>{configs[agent.id] ? configs[agent.id]?.kind + ' · 已配置，发送时连接' : '尚未配置通讯方式'}</small></span><button disabled={busy || !ready} onclick={() => edit(agent.id)}>配置 {agent.name}</button></div>{/each}</div>
    {#if editing}
      <form class="endpoint-form" onsubmit={(event) => { event.preventDefault(); void saveConfig() }}>
        <h3>配置 {name(editing)}</h3><p class="muted">本地填写 Agent 的可执行文件；远端可用 ssh.exe -T 的 stdio 通道。参数使用 JSON 数组，不填密码或 API key。模型与凭据沿用 Agent 自身配置。</p>
        <label>对话协议<select bind:value={kind}><option value="pi">Pi RPC</option><option value="hermes">Hermes ACP</option><option value="codex">Codex App Server</option></select></label>
        <label>可执行文件<input bind:value={executable} placeholder="例如 C:\Windows\System32\OpenSSH\ssh.exe" required /></label>
        <label>启动参数（JSON 数组）<textarea bind:value={argv} rows="5" spellcheck="false" required></textarea></label>
        <p class="muted">Pi 用 --mode rpc；Hermes 用 acp；Codex 用 app-server。Windows 的 .cmd/.ps1 不能直接运行，请填写 node.exe 并将 CLI 的 .js 路径放在参数首项。SSH 参数示例：["-T", "主机别名", "hermes", "acp"]。</p>
        <label>Agent 工作目录<input bind:value={cwd} placeholder="本地绝对路径；SSH Agent 填远端目录，例如 /root" required /></label>
        <label>本地进程启动目录（可选）<input bind:value={launchCwd} placeholder="SSH / WSL 留空使用 issh 的本地目录" /></label>
        <label>单次回复超时（毫秒）<input type="number" bind:value={timeoutMs} min="10000" max="300000" /></label>
        <div class="actions"><button class="primary" disabled={busy || !ready}>保存通讯配置</button><button type="button" onclick={() => editing = ''}>取消</button></div>
      </form>
    {/if}
  </details>
  <div class="conversation-layout">
    <aside class="room-list">
      <form onsubmit={(event) => { event.preventDefault(); void create() }}>
        <label>先发言的 Agent<select bind:value={first}>{#each agents as agent}<option value={agent.id}>{agent.name}</option>{/each}</select></label>
        <label>协作 Agent<select bind:value={second}>{#each agents.filter(a => a.id !== first) as agent}<option value={agent.id}>{agent.name}</option>{/each}</select></label>
        <button class="primary" disabled={busy || !ready || !first || !second}>新建会话</button>
      </form>
      <nav aria-label="历史会话">{#each rooms as item (item.id)}<button class:current={room?.id === item.id} onclick={() => void choose(item.id)} disabled={busy}><b>{item.title}</b><small>{labels[item.status] ?? item.status} · {date(item.updatedAt)}</small></button>{:else}<p class="muted">选择两个 Agent，新建第一次对话。</p>{/each}</nav>
    </aside>
    <div class="conversation-body">
      {#if room}
        <header class="thread-head"><div><h3>{room.title}</h3><small>{labels[room.status] ?? room.status}{room.activeAgentId ? ' · 等待 ' + name(room.activeAgentId) + ' 回复' : ''}</small></div>{#if room.status === 'running'}<button class="danger" disabled={busy || !ready} onclick={() => void stop()}>停止转发</button>{/if}</header>
        {#if room.error}<p class="conversation-error" role="status">{room.error}</p>{/if}
        <div class="message-log" bind:this={logElement} onscroll={() => atBottom = logElement.scrollHeight - logElement.clientHeight - logElement.scrollTop < 60} role="log" aria-label="会话记录" aria-live="polite" aria-relevant="additions">
          {#each room.messages ?? [] as message (message.id)}
            <article class="message" class:from-agent={message.kind === 'reply'} class:message-failed={message.kind === 'error'}>
              <div class="message-meta"><b>{name(message.from)} <span>→ {name(message.to)}</span></b><time>{date(message.createdAt)}</time></div>
              <p>{message.text.trim()}</p>
              {#if message.nativeConversationId}<small class="native-id">对话 {message.nativeConversationId}</small>{/if}
            </article>
          {:else}<div class="thread-empty"><h3>{name(room.agentIds[0])} ↔ {name(room.agentIds[1])}</h3><p>写下议题。第一位 Agent 回复后，消息会交给第二位，直到达到本次回复次数。</p></div>{/each}
        </div>
        {#if !atBottom}<button class="latest" onclick={latest}>查看最新消息 ↓</button>{/if}
        <form class="composer" onsubmit={(event) => { event.preventDefault(); void send() }}>
          <label for="conversation-message">发送给 {name(room.agentIds[0])}</label><textarea id="conversation-message" rows="3" bind:value={draft} maxlength="16000" placeholder="例如：共同讨论这个方案，各自指出一个问题，再给出改进建议。" disabled={busy}></textarea>
          <div class="composer-actions"><label>本次回复次数<select bind:value={turns}>{#each [1, 2, 3, 4, 5, 6] as count}<option value={count}>{count} 次{count === 3 ? '（A → B → A）' : ''}</option>{/each}</select></label><button class="primary" disabled={!canSend || !draft.trim()}>发送并开始协作</button></div>
          {#if needsConfig}<small>发送前，请为双方保存通讯配置并授予“发送提示词”权限。</small>{/if}
        </form>
      {:else}<div class="thread-empty"><h3>消息有来处，回复有记录</h3><p>从左侧打开历史会话，或选择两个已注册 Agent 开始新对话。</p></div>{/if}
    </div>
  </div>
</section>

<style>
  .conversations { padding: 22px; }
  .conversation-layout { display: grid; grid-template-columns: 205px minmax(0, 1fr); margin-top: 18px; border: 1px solid var(--border); border-radius: 10px; overflow: hidden; }
  .room-list { padding: 14px; background: #0d1a22; border-right: 1px solid var(--border); min-width: 0; }
  .room-list form, .endpoint-form { display: grid; gap: 12px; }
  label { display: grid; gap: 6px; }
  .room-list nav { display: grid; gap: 7px; margin-top: 20px; max-height: 440px; overflow: auto; }
  .room-list nav button { text-align: left; white-space: normal; display: grid; gap: 5px; }
  .room-list .current { border-color: var(--accent); background: #19382f; }
  .conversation-body { min-width: 0; background: #101c25; }
  .thread-head { padding: 16px 18px; display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid var(--border); gap: 10px; }
  .message-log { max-height: 560px; min-height: 240px; overflow-y: auto; padding: 18px; }
  .message { padding: 13px 15px; border-left: 2px solid #839da9; background: #172733; margin-bottom: 12px; border-radius: 0 8px 8px 0; }
  .message.from-agent { border-left-color: var(--accent); }
  .message.message-failed { border-left-color: #ffb4b0; }
  .message-meta { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px; font-size: 12px; }
  .message-meta span, time, .native-id { color: var(--muted); font-size: 10px; }
  .message p { white-space: pre-wrap; overflow-wrap: anywhere; font-size: 13px; line-height: 1.8; margin: 10px 0; }
  .native-id { font-family: Consolas, monospace; overflow-wrap: anywhere; }
  .latest { display: block; margin: 0 auto 10px; }
  .composer { display: grid; gap: 9px; border-top: 1px solid var(--border); padding: 16px 18px; }
  textarea { width: 100%; min-width: 0; resize: vertical; border: 1px solid #38515e; border-radius: 8px; padding: 11px; color: inherit; background: #0d1a22; font: 13px/1.6 "Segoe UI", "Microsoft YaHei", sans-serif; }
  .composer-actions { display: flex; align-items: end; justify-content: space-between; gap: 12px; }
  .thread-empty { padding: 45px 24px; text-align: center; color: var(--muted); }
  .thread-empty p { margin-top: 12px; font-size: 12px; line-height: 1.8; }
  .connection-settings { margin-top: 18px; border-top: 1px solid var(--border); padding-top: 14px; }
  .connection-settings summary { font-size: 13px; }
  .endpoint-list { display: grid; gap: 8px; margin-top: 12px; }
  .endpoint-list > div { display: flex; justify-content: space-between; align-items: center; gap: 10px; }
  .endpoint-list span { display: grid; }
  .endpoint-list b { font-size: 13px; }
  .endpoint-form { border: 1px solid var(--border); padding: 18px; border-radius: 10px; margin-top: 14px; }
  .conversation-error, .conversation-notice { margin: 12px 0; padding: 12px; border-radius: 8px; font-size: 12px; overflow-wrap: anywhere; line-height: 1.7; }
  .conversation-error { color: #ffb4b0; background: #35272d; }
  .conversation-notice { color: var(--accent); background: #19382f; }
  @media (max-width: 1050px) { .conversation-layout { grid-template-columns: 1fr; } .room-list { border-right: 0; border-bottom: 1px solid var(--border); } .room-list form { grid-template-columns: 1fr 1fr; } .room-list form button { grid-column: 1 / -1; } .room-list nav { max-height: 150px; } }
  @media (max-width: 540px) { .conversations { padding: 14px; } .composer-actions { align-items: stretch; flex-direction: column; } .message-log { padding: 10px; } .message-meta { display: grid; } }
</style>
