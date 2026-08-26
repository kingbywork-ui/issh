<script lang="ts">
    import { onMount } from 'svelte'
    import ContextMenu, { type ContextMenuItem } from './ContextMenu.svelte'
    import HostGroupEditor from './HostGroupEditor.svelte'
    import HostProfileEditor from './HostProfileEditor.svelte'
    import { hostProfiles, lockHostProfiles, mutateHostProfiles, unlockHostProfiles, type HostProfileMutation, type SshHostGroup, type SshHostProfile } from './runtime'

    let { onconnect, onopenlocal }: { onconnect: (profile: SshHostProfile) => void, onopenlocal: () => void } = $props()
    interface GroupNode extends SshHostGroup { children: GroupNode[], profileIds: string[], count: number }
    let profiles = $state<SshHostProfile[]>([])
    let groups = $state<SshHostGroup[]>([])
    let encrypted = $state(false)
    let unlocked = $state(true)
    let loading = $state(true)
    let error = $state('')
    let query = $state('')
    let environment = $state('')
    let favoritesOnly = $state(false)
    let recentOnly = $state(false)
    let view = $state<'all' | 'favorites' | 'recent' | { group: string }>('all')
    let recentIds = $state<string[]>(loadRecent())
    let collapsed = $state(new Set<string>())
    let menu = $state<{ x: number, y: number, items: ContextMenuItem[] } | null>(null)
    let editorProfile = $state<SshHostProfile | null>(null)
    let editorGroup = $state<SshHostGroup | null>(null)
    const recentKey = 'issh.recentHosts'
    function loadRecent (): string[] { try { const value = JSON.parse(localStorage.getItem(recentKey) ?? '[]'); return Array.isArray(value) ? value.filter((x): x is string => typeof x === 'string') : [] } catch { return [] } }
    function recordRecent (profile: SshHostProfile): void { recentIds = [profile.id, ...recentIds.filter((id) => id !== profile.id)].slice(0, 6); try { localStorage.setItem(recentKey, JSON.stringify(recentIds)) } catch {} }
    async function refresh (): Promise<void> { loading = true; error = ''; try { const result = await hostProfiles(); profiles = result.profiles; groups = result.groups; encrypted = result.encrypted; unlocked = !result.encrypted || result.unlocked } catch (cause) { error = cause instanceof Error ? cause.message : String(cause) } finally { loading = false } }
    async function unlock (passphrase: string): Promise<void> { try { const result = await unlockHostProfiles(passphrase); profiles = result.profiles; groups = result.groups; encrypted = result.encrypted; unlocked = result.unlocked } catch (cause) { error = cause instanceof Error ? cause.message : String(cause) } }
    function lock (): void { void lockHostProfiles().then((result) => { profiles = result.profiles; groups = result.groups; unlocked = result.unlocked }).catch(() => {}) }
    function tree (): GroupNode[] { const map = new Map(groups.map((group) => [group.id, { ...group, children: [], profileIds: [], count: 0 } as GroupNode])); const roots: GroupNode[] = []; for (const group of groups) { const node = map.get(group.id)!; const parent = group.parentGroupId ? map.get(group.parentGroupId) : null; (parent ? parent.children : roots).push(node) } for (const profile of profiles) { const node = map.get(profile.group); if (node) node.profileIds.push(profile.id) } const count = (node: GroupNode): number => { node.count = node.profileIds.length + node.children.reduce((sum, child) => sum + count(child), 0); return node.count }; roots.forEach(count); return roots }
    const groupTree = $derived(tree())
    function collect (node: GroupNode, result: Set<string>): void { node.profileIds.forEach((id) => result.add(id)); node.children.forEach((child) => collect(child, result)) }
    function findNode (nodes: GroupNode[], id: string): GroupNode | null { for (const node of nodes) { if (node.id === id) return node; const child = findNode(node.children, id); if (child) return child } return null }
    const environments = $derived([...new Set(profiles.map((profile) => profile.environment).filter((value): value is string => Boolean(value)))].sort())
    const visible = $derived.by(() => { let result = profiles.filter((profile) => !query.trim() || `${profile.name} ${profile.host} ${profile.user} ${profile.remark ?? ''} ${profile.tags.join(' ')}`.toLowerCase().includes(query.trim().toLowerCase())); if (environment) result = result.filter((profile) => profile.environment === environment); if (favoritesOnly || view === 'favorites') result = result.filter((profile) => profile.favorite); if (recentOnly || view === 'recent') result = result.filter((profile) => recentIds.includes(profile.id)); if (typeof view === 'object') { const node = findNode(groupTree, view.group); const ids = new Set<string>(); if (node) collect(node, ids); result = result.filter((profile) => ids.has(profile.id)) } return result.sort((a, b) => (recentIds.indexOf(a.id) < 0 ? 999 : recentIds.indexOf(a.id)) - (recentIds.indexOf(b.id) < 0 ? 999 : recentIds.indexOf(b.id)) || Number(b.favorite) - Number(a.favorite) || a.name.localeCompare(b.name)) })
    function showMenu (event: MouseEvent, items: ContextMenuItem[]): void { event.preventDefault(); menu = { x: Math.min(event.clientX, window.innerWidth - 230), y: Math.min(event.clientY, window.innerHeight - 300), items } }
    function profileItems (profile: SshHostProfile): ContextMenuItem[] { return [{ label: '连接', action: () => { recordRecent(profile); onconnect(profile) } }, { label: '编辑', action: () => { editorProfile = profile } }, { label: '复制', action: () => { editorProfile = { ...profile, id: '', name: `${profile.name} copy`, tags: [...profile.tags], privateKeys: [...profile.privateKeys] } } }, { label: profile.favorite ? '取消收藏' : '收藏', action: () => void mutate({ action: 'toggleFavorite', profileId: profile.id }) }, { label: '删除', danger: true, action: () => { if (window.confirm(`删除主机“${profile.name}”？`)) void mutate({ action: 'deleteProfile', profileId: profile.id }) } }] }
    function groupItems (group: SshHostGroup): ContextMenuItem[] { return [{ label: '新建子分组', action: () => { editorGroup = { id: `group-${Date.now().toString(36)}`, name: '', parentGroupId: group.id } } }, { label: '重命名', action: () => { editorGroup = group } }, { label: '删除分组', danger: true, action: () => { if (window.confirm(`删除分组“${group.name}”？`)) void mutate({ action: 'deleteGroup', groupId: group.id }) } }] }
    async function mutate (change: HostProfileMutation): Promise<void> { try { const result = await mutateHostProfiles(change); profiles = result.profiles; groups = result.groups; encrypted = result.encrypted; unlocked = result.unlocked; editorProfile = null; editorGroup = null } catch (cause) { error = cause instanceof Error ? cause.message : String(cause) } }
    function saveProfile (profile: SshHostProfile): void { void mutate({ action: profiles.some((item) => item.id === profile.id) ? 'updateProfile' : 'createProfile', profile }) }
    function saveGroup (group: SshHostGroup): void { void mutate({ action: groups.some((item) => item.id === group.id) ? 'updateGroup' : 'createGroup', group }) }
    function newProfile (): void { editorProfile = { id: '', name: '', group: '', host: '', port: 22, user: '', auth: null, privateKeys: [], environment: null, remark: null, favorite: false, tags: [] } }
    function newGroup (parentGroupId: string | null = null): void { editorGroup = { id: `group-${Date.now().toString(36)}`, name: '', parentGroupId } }
    function resetFilters (): void { query = ''; environment = ''; favoritesOnly = false; recentOnly = false; view = 'all' }
    function title (): string { if (view === 'favorites') return '收藏'; if (view === 'recent') return '最近连接'; if (typeof view === 'object') return findNode(groupTree, view.group)?.name ?? '分组'; return '全部主机' }
    function launch (profile: SshHostProfile): void { recordRecent(profile); onconnect(profile) }
    onMount(() => { void refresh() })
</script>

{#if loading}<div class="start-empty">正在读取主机配置…</div>
{:else if encrypted && !unlocked}<div class="vault-locked"><h2>主机配置已加密</h2><p>解锁后可以查看和管理 SSH 主机。</p><form onsubmit={(event) => { event.preventDefault(); const input = event.currentTarget.querySelector('input') as HTMLInputElement; void unlock(input.value) }}><input type="password" placeholder="主口令" autofocus /><button type="submit">解锁</button></form></div>
{:else}<div class="start-page-layout">
    <aside class="start-page-sidebar" oncontextmenu={(event) => showMenu(event, [{ label: '新建分组', action: () => newGroup() }, { label: '新建 SSH 主机', action: newProfile }])}>
        <div class="sidebar-heading"><span>连接</span><button class="icon-button" type="button" title="新建分组" onclick={() => newGroup()}>＋</button></div>
        <button class="sidebar-tree-item root-item" class:active={view === 'all'} type="button" onclick={() => { view = 'all'; favoritesOnly = false; recentOnly = false }}>▦ <span>全部</span><b>{profiles.length}</b></button>
        <button class="sidebar-tree-item root-item" class:active={view === 'favorites'} type="button" onclick={() => { view = 'favorites'; favoritesOnly = true; recentOnly = false }}>★ <span>收藏</span><b>{profiles.filter((p) => p.favorite).length}</b></button>
        <button class="sidebar-tree-item root-item" class:active={view === 'recent'} type="button" onclick={() => { view = 'recent'; recentOnly = true; favoritesOnly = false }}>↻ <span>最近</span><b>{recentIds.length}</b></button>
        {#snippet renderGroup(node: GroupNode, level: number)}<div class="sidebar-group-row" role="treeitem" style:padding-left={`${12 + level * 18}px`} oncontextmenu={(event) => showMenu(event, groupItems(node))}><button class="tree-toggle" type="button" onclick={() => { const next = new Set(collapsed); next.has(node.id) ? next.delete(node.id) : next.add(node.id); collapsed = next }}>{node.children.length && !collapsed.has(node.id) ? '▾' : '▸'}</button><button class="sidebar-tree-item" class:active={typeof view === 'object' && view.group === node.id} type="button" onclick={() => { view = { group: node.id }; favoritesOnly = false; recentOnly = false }}>▣ <span>{node.name}</span><b>{node.count}</b></button></div>{#if !collapsed.has(node.id)}{#each node.children as child (child.id)}{@render renderGroup(child, level + 1)}{/each}{/if}{/snippet}
        {#each groupTree as node (node.id)}{@render renderGroup(node, 0)}{/each}
        {#if encrypted}<div class="sidebar-footer"><button class="lock-button" type="button" onclick={lock}>🔒 锁定配置</button></div>{/if}
    </aside>
    <main class="start-page-main"><header class="main-header"><div><h2 class="main-title">{title()}</h2><span class="main-count">{visible.length} 台主机</span></div><span class="main-spacer"></span><button type="button" class="local-terminal-button" onclick={onopenlocal}>⌂ 本地终端</button><button type="button" class="local-terminal-button" onclick={newProfile}>＋ 新建 SSH</button></header>
        <div class="host-toolbar"><input type="search" bind:value={query} placeholder="搜索名称、地址或用户名" /><select bind:value={environment}><option value="">全部环境</option>{#each environments as item}<option value={item}>{item}</option>{/each}</select><label><input type="checkbox" bind:checked={favoritesOnly} /> 仅收藏</label><label><input type="checkbox" bind:checked={recentOnly} /> 最近</label><button type="button" class="secondary" onclick={resetFilters}>清除筛选</button></div>
        {#if error}<p class="start-error" role="alert">{error}</p>{/if}
        {#if visible.length}<div class="host-list">{#each visible as profile (profile.id)}<div class="host-list-item" role="button" tabindex="0" onclick={() => launch(profile)} onkeydown={(event) => { if (event.key === 'Enter') launch(profile) }} oncontextmenu={(event) => showMenu(event, profileItems(profile))}><span class="host-status-rail" data-kind={profile.favorite ? 'favorite' : 'signal'}></span><div class="host-item-body"><div class="host-item-info"><div class="host-item-name-row"><strong>{profile.name}</strong>{#if profile.favorite}<span class="host-badge favorite">收藏</span>{/if}{#if recentIds.includes(profile.id)}<span class="host-badge recent">最近</span>{/if}</div><div class="host-item-meta">{profile.user}@{profile.host}:{profile.port}</div>{#if profile.remark}<div class="host-item-remark">{profile.remark}</div>{/if}{#if profile.tags.length}<div class="host-item-tags">{#each profile.tags as tag}<span class="host-tag">{tag}</span>{/each}</div>{/if}</div><div class="host-item-actions">{#if profile.environment}<span class="env-badge env-badge--info">{profile.environment}</span>{/if}<button type="button" class="icon-button" title="更多操作" onclick={(event) => { event.stopPropagation(); showMenu(event, profileItems(profile)) }}>⋯</button><span class="connect-btn">连接</span></div></div></div>{/each}</div>{:else}<div class="host-list-empty"><div class="empty-icon">▦</div><div class="empty-text">当前筛选没有匹配的 SSH 主机</div></div>{/if}
    </main></div>{/if}
{#if menu}<ContextMenu x={menu.x} y={menu.y} items={menu.items} onclose={() => { menu = null }} />{/if}
{#if editorProfile}<HostProfileEditor profile={editorProfile} groups={groups} onconnect={saveProfile} oncancel={() => { editorProfile = null }} />{/if}
{#if editorGroup}<HostGroupEditor group={editorGroup} groups={groups} onsave={saveGroup} oncancel={() => { editorGroup = null }} />{/if}
