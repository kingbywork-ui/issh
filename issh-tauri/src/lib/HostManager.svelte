<script lang="ts">
    import { onMount } from 'svelte'
    import ContextMenu, { type ContextMenuItem } from './ContextMenu.svelte'
    import HostGroupEditor from './HostGroupEditor.svelte'
    import HostProfileEditor from './HostProfileEditor.svelte'
    import { focusOnMount } from './a11y'
    import { hostProfiles, lockHostProfiles, mutateHostProfiles, unlockHostProfiles, readSshConfig, type HostProfileMutation, type SshHostGroup, type SshHostProfile } from './runtime'
    import { parseSshConfig } from './sshConfig'

    let { onconnect, onopenlocal, onvaultstate }: { onconnect: (profile: SshHostProfile) => void, onopenlocal: () => void, onvaultstate?: (locked: boolean) => void } = $props()
    interface GroupNode extends SshHostGroup { children: GroupNode[], profileIds: string[], count: number }
    let profiles = $state<SshHostProfile[]>([])
    let groups = $state<SshHostGroup[]>([])
    let encrypted = $state(false)
    let unlocked = $state(true)
    let loading = $state(true)
    let error = $state('')
    let importing = $state(false)
    let query = $state('')
    let environment = $state('')
    let favoritesOnly = $state(false)
    let recentOnly = $state(false)
    const recentKey = 'issh.recentHosts'
    const activeGroupKey = 'startPageActiveGroupId'
    const activeViewKey = 'startPageActiveView'
    const collapsedGroupsKey = 'profileGroupCollapsed'
    let view = $state<'all' | 'favorites' | 'recent' | { group: string }>(loadStartView())
    let recentIds = $state<string[]>(loadRecent())
    let collapsed = $state<Set<string>>(loadCollapsedGroups())
    let menu = $state<{ x: number, y: number, items: ContextMenuItem[] } | null>(null)
    let editorProfile = $state<SshHostProfile | null>(null)
    let editorGroup = $state<SshHostGroup | null>(null)
    let moveProfile = $state<SshHostProfile | null>(null)
    let groupDelete = $state<{ group: SshHostGroup, profiles: SshHostProfile[] } | null>(null)
    function loadRecent (): string[] { try { const value = JSON.parse(localStorage.getItem(recentKey) ?? '[]'); return Array.isArray(value) ? value.filter((x): x is string => typeof x === 'string') : [] } catch { return [] } }
    function loadStartView (): 'all' | 'favorites' | 'recent' | { group: string } {
        try {
            const group = localStorage.getItem(activeGroupKey)
            if (group) return { group }
            const savedView = localStorage.getItem(activeViewKey)
            if (savedView === 'favorites' || savedView === 'recent') return savedView
        } catch {}
        return 'all'
    }
    function loadCollapsedGroups (): Set<string> {
        try {
            const value = JSON.parse(localStorage.getItem(collapsedGroupsKey) ?? '{}') as Record<string, boolean>
            return new Set(Object.entries(value).filter(([, collapsed]) => collapsed).map(([id]) => id))
        } catch { return new Set<string>() }
    }
    function persistView (next: 'all' | 'favorites' | 'recent' | { group: string }): void {
        try {
            if (typeof next === 'object') {
                localStorage.setItem(activeGroupKey, next.group)
                localStorage.removeItem(activeViewKey)
            } else if (next === 'favorites' || next === 'recent') {
                localStorage.setItem(activeViewKey, next)
                localStorage.removeItem(activeGroupKey)
            } else {
                localStorage.removeItem(activeGroupKey)
                localStorage.removeItem(activeViewKey)
            }
        } catch {}
    }
    function persistCollapsedGroups (next: Set<string>): void {
        try { localStorage.setItem(collapsedGroupsKey, JSON.stringify(Object.fromEntries([...next].map((id) => [id, true])))) } catch {}
    }
    function recordRecent (profile: SshHostProfile): void { recentIds = [profile.id, ...recentIds.filter((id) => id !== profile.id)].slice(0, 6); try { localStorage.setItem(recentKey, JSON.stringify(recentIds)) } catch {} }
    function reportVaultState (): void { onvaultstate?.(encrypted && !unlocked) }
    async function refresh (): Promise<void> { loading = true; error = ''; try { const result = await hostProfiles(); profiles = result.profiles; groups = result.groups; encrypted = result.encrypted; unlocked = !result.encrypted || result.unlocked; reportVaultState() } catch (cause) { error = cause instanceof Error ? cause.message : String(cause) } finally { loading = false } }
    async function unlock (passphrase: string): Promise<void> { try { const result = await unlockHostProfiles(passphrase); profiles = result.profiles; groups = result.groups; encrypted = result.encrypted; unlocked = result.unlocked; reportVaultState() } catch (cause) { error = cause instanceof Error ? cause.message : String(cause) } }
    function lock (): void { void lockHostProfiles().then((result) => { profiles = result.profiles; groups = result.groups; encrypted = result.encrypted; unlocked = result.unlocked; reportVaultState() }).catch(() => {}) }
    function tree (): GroupNode[] { const map = new Map(groups.map((group) => [group.id, { ...group, children: [], profileIds: [], count: 0 } as GroupNode])); const roots: GroupNode[] = []; for (const group of groups) { const node = map.get(group.id)!; const parent = group.parentGroupId ? map.get(group.parentGroupId) : null; (parent ? parent.children : roots).push(node) } for (const profile of profiles) { const node = map.get(profile.group); if (node) node.profileIds.push(profile.id) } const count = (node: GroupNode): number => { node.count = node.profileIds.length + node.children.reduce((sum, child) => sum + count(child), 0); return node.count }; roots.forEach(count); return roots }
    const groupTree = $derived(tree())
    function collect (node: GroupNode, result: Set<string>): void { node.profileIds.forEach((id) => result.add(id)); node.children.forEach((child) => collect(child, result)) }
    function findNode (nodes: GroupNode[], id: string): GroupNode | null { for (const node of nodes) { if (node.id === id) return node; const child = findNode(node.children, id); if (child) return child } return null }
    const environments = $derived([...new Set(profiles.map((profile) => profile.environment).filter((value): value is string => Boolean(value)))].sort())
    const visible = $derived.by(() => { let result = profiles.filter((profile) => !query.trim() || `${profile.name} ${profile.host} ${profile.user} ${profile.remark ?? ''} ${profile.tags.join(' ')}`.toLowerCase().includes(query.trim().toLowerCase())); if (environment) result = result.filter((profile) => profile.environment === environment); if (favoritesOnly || view === 'favorites') result = result.filter((profile) => profile.favorite); if (recentOnly || view === 'recent') result = result.filter((profile) => recentIds.includes(profile.id)); if (typeof view === 'object') { const node = findNode(groupTree, view.group); const ids = new Set<string>(); if (node) collect(node, ids); result = result.filter((profile) => ids.has(profile.id)) } return result.sort((a, b) => (recentIds.indexOf(a.id) < 0 ? 999 : recentIds.indexOf(a.id)) - (recentIds.indexOf(b.id) < 0 ? 999 : recentIds.indexOf(b.id)) || Number(b.favorite) - Number(a.favorite) || a.name.localeCompare(b.name)) })
    function showMenu (event: MouseEvent, items: ContextMenuItem[]): void { event.preventDefault(); event.stopPropagation(); menu = { x: Math.max(8, Math.min(event.clientX, window.innerWidth - 230)), y: Math.max(8, Math.min(event.clientY, window.innerHeight - 300)), items } }
    function profileItems (profile: SshHostProfile): ContextMenuItem[] {
        return [
            { label: '连接', action: () => { recordRecent(profile); onconnect(profile) } },
            { label: '编辑', action: () => { editorProfile = { ...profile, tags: [...profile.tags], privateKeys: [...profile.privateKeys] } } },
            { label: '克隆', action: () => { editorProfile = { ...profile, id: '', name: `${profile.name} copy`, tags: [...profile.tags], privateKeys: [...profile.privateKeys] } } },
            { label: '更改分组', action: () => { moveProfile = { ...profile, tags: [...profile.tags], privateKeys: [...profile.privateKeys] } } },
            { label: profile.favorite ? '取消收藏' : '收藏', action: () => void mutate({ action: 'toggleFavorite', profileId: profile.id }) },
            { label: '删除', danger: true, action: () => { if (window.confirm(`删除主机“${profile.name}”？`)) void mutate({ action: 'deleteProfile', profileId: profile.id }) } },
        ]
    }
    function groupProfiles (group: SshHostGroup): SshHostProfile[] {
        const ids = new Set<string>()
        const collect = (id: string): void => {
            profiles.filter((profile) => profile.group === id).forEach((profile) => ids.add(profile.id))
            groups.filter((child) => child.parentGroupId === id).forEach((child) => collect(child.id))
        }
        collect(group.id)
        return profiles.filter((profile) => ids.has(profile.id))
    }
    async function connectGroup (group: SshHostGroup): Promise<void> {
        const entries = groupProfiles(group)
        if (entries.length === 0 || !window.confirm(`连接分组“${group.name}”中的 ${entries.length} 台 SSH 主机？`)) return
        for (const profile of entries) { recordRecent(profile); onconnect(profile) }
    }
    function requestDeleteGroup (group: SshHostGroup): void {
        groupDelete = { group, profiles: groupProfiles(group) }
    }
    async function confirmDeleteGroup (deleteProfiles: boolean): Promise<void> {
        const request = groupDelete
        if (!request) return
        groupDelete = null
        const { group, profiles: entries } = request
        const removeChildren = (parentId: string): SshHostGroup[] => groups.filter((item) => item.parentGroupId === parentId).flatMap((item) => [...removeChildren(item.id), item])
        const deleteGroups = [...removeChildren(group.id), group]
        if (deleteProfiles) {
            for (const profile of entries) await mutate({ action: 'deleteProfile', profileId: profile.id })
        } else if (entries.length > 0) {
            await mutate({ action: 'moveProfiles', profileIds: entries.map((profile) => profile.id), groupId: '' })
        }
        for (const child of deleteGroups) await mutate({ action: 'deleteGroup', groupId: child.id })
    }
    function groupItems (group: SshHostGroup): ContextMenuItem[] {
        const count = groupProfiles(group).length
        return [
            { label: `连接 (${count})`, disabled: count === 0, action: () => void connectGroup(group) },
            { label: '新增主机', action: () => { editorProfile = { id: '', name: '', group: group.id, host: '', port: 22, user: '', auth: null, privateKeys: [], environment: null, remark: null, favorite: false, tags: [], loginScript: null, x11: false, agentForward: false, jumpHost: null, proxyCommand: null, forwardedPorts: [], socksProxyHost: null, socksProxyPort: null, httpProxyHost: null, httpProxyPort: null, reuseSession: false } } },
            { label: '新增子分组', action: () => { editorGroup = { id: `group-${Date.now().toString(36)}`, name: '', parentGroupId: group.id } } },
            { label: '重命名', action: () => { editorGroup = { ...group } } },
            { label: '删除组', danger: true, action: () => requestDeleteGroup(group) },
        ]
    }
    async function mutate (change: HostProfileMutation): Promise<void> { try { const result = await mutateHostProfiles(change); profiles = result.profiles; groups = result.groups; encrypted = result.encrypted; unlocked = result.unlocked; reportVaultState(); editorProfile = null; editorGroup = null; moveProfile = null } catch (cause) { error = cause instanceof Error ? cause.message : String(cause) } }
    function saveProfile (profile: SshHostProfile): void { void mutate({ action: profiles.some((item) => item.id === profile.id) ? 'updateProfile' : 'createProfile', profile }) }
    function saveGroup (group: SshHostGroup): void { void mutate({ action: groups.some((item) => item.id === group.id) ? 'updateGroup' : 'createGroup', group }) }
    function newProfile (): void { editorProfile = { id: '', name: '', group: '', host: '', port: 22, user: '', auth: null, privateKeys: [], environment: null, remark: null, favorite: false, tags: [], loginScript: null, x11: false, agentForward: false, jumpHost: null, proxyCommand: null, forwardedPorts: [], socksProxyHost: null, socksProxyPort: null, httpProxyHost: null, httpProxyPort: null, reuseSession: false } }
    function newGroup (parentGroupId: string | null = null): void { editorGroup = { id: `group-${Date.now().toString(36)}`, name: '', parentGroupId } }
    function resetFilters (): void { query = ''; environment = ''; favoritesOnly = false; recentOnly = false; view = 'all'; persistView(view) }
    function title (): string { if (view === 'favorites') return '收藏'; if (view === 'recent') return '最近连接'; if (typeof view === 'object') return findNode(groupTree, view.group)?.name ?? '分组'; return '全部主机' }
    function launch (profile: SshHostProfile): void { recordRecent(profile); onconnect(profile) }

    // A2（R-012）SSH config 导入：读取 ~/.ssh/config 并解析为非通配符主机条目增量导入。
    async function importSshConfig (): Promise<void> {
        importing = true
        error = ''
        try {
            const text = await readSshConfig()
            const parsed = parseSshConfig(text)
            if (parsed.hosts.length === 0) {
                window.alert('未从 ~/.ssh/config 解析到可导入的主机条目（通配符 Host 与 Match 段已跳过）。')
                return
            }
            const existing = new Set(profiles.map((p) => `${p.host}:${p.port}:${p.user}`))
            let created = 0
            let skipped = 0
            for (const host of parsed.hosts) {
                const key = `${host.hostName}:${host.port ?? 22}:${host.user ?? ''}`
                if (existing.has(key)) { skipped += 1; continue }
                const remarkParts = [
                    host.identityFiles.length ? `IdentityFile: ${host.identityFiles.join(', ')}` : '',
                    host.proxyJump ? `ProxyJump: ${host.proxyJump}` : '',
                ].filter(Boolean)
                const profile: SshHostProfile = {
                    id: '', name: host.alias, group: '', host: host.hostName, port: host.port ?? 22,
                    user: host.user ?? '', auth: null, privateKeys: [], environment: null,
                    remark: remarkParts.join('；') || null, favorite: false, tags: ['ssh-config'],
                    loginScript: null, x11: false, agentForward: false, jumpHost: null, proxyCommand: null,
                    forwardedPorts: [], socksProxyHost: null, socksProxyPort: null, httpProxyHost: null, httpProxyPort: null,
                    reuseSession: false,
                }
                try {
                    await mutateHostProfiles({ action: 'createProfile', profile })
                    created += 1
                    existing.add(key)
                } catch { skipped += 1 }
            }
            await refresh()
            const extras: string[] = []
            if (skipped > 0) extras.push(`${skipped} 个已存在或失败跳过`)
            if (parsed.ignored > 0) extras.push(`${parsed.ignored} 个通配符条目跳过`)
            window.alert(`导入完成：新增 ${created} 台主机。${extras.join('；')}`)
        } catch (cause) {
            error = cause instanceof Error ? cause.message : String(cause)
        } finally {
            importing = false
        }
    }
    onMount(() => { void refresh() })
    $effect(() => { reportVaultState() })
</script>

{#if loading}<div class="start-empty">正在读取主机配置…</div>
{:else if encrypted && !unlocked}<div class="vault-locked"><h2>主机配置已加密</h2><p>解锁后可以查看和管理 SSH 主机。</p><form class="vault-unlock-form" onsubmit={(event) => { event.preventDefault(); const input = event.currentTarget.querySelector('input') as HTMLInputElement; void unlock(input.value) }}><input type="password" placeholder="主口令" use:focusOnMount /><button type="submit">解锁</button></form></div>
{:else}<div class="start-page-layout">
    <aside class="start-page-sidebar" oncontextmenu={(event) => showMenu(event, [{ label: '新建分组', action: () => newGroup() }, { label: '新建 SSH 主机', action: newProfile }])}>
        <div class="sidebar-heading"><span>连接</span><button class="icon-button" type="button" title="新建分组" onclick={() => newGroup()}>＋</button></div>
        <button class="sidebar-tree-item root-item" class:active={view === 'all'} type="button" onclick={() => { view = 'all'; favoritesOnly = false; recentOnly = false; persistView(view) }}>▦ <span>全部</span><b>{profiles.length}</b></button>
        <button class="sidebar-tree-item root-item" class:active={view === 'favorites'} type="button" onclick={() => { view = 'favorites'; favoritesOnly = true; recentOnly = false; persistView(view) }}>★ <span>收藏</span><b>{profiles.filter((p) => p.favorite).length}</b></button>
        <button class="sidebar-tree-item root-item" class:active={view === 'recent'} type="button" onclick={() => { view = 'recent'; recentOnly = true; favoritesOnly = false; persistView(view) }}>↻ <span>最近</span><b>{recentIds.length}</b></button>
        {#snippet renderGroup(node: GroupNode, level: number)}<div class="sidebar-group-row" role="treeitem" aria-selected={typeof view === 'object' && view.group === node.id} tabindex="-1" style:padding-left={`${12 + level * 18}px`} oncontextmenu={(event) => showMenu(event, groupItems(node))}><button class="tree-toggle" type="button" onclick={() => { const next = new Set(collapsed); next.has(node.id) ? next.delete(node.id) : next.add(node.id); collapsed = next; persistCollapsedGroups(next) }}>{node.children.length && !collapsed.has(node.id) ? '▾' : '▸'}</button><button class="sidebar-tree-item" class:active={typeof view === 'object' && view.group === node.id} type="button" onclick={() => { view = { group: node.id }; favoritesOnly = false; recentOnly = false; persistView(view) }}>▣ <span>{node.name}</span><b>{node.count}</b></button></div>{#if !collapsed.has(node.id)}{#each node.children as child (child.id)}{@render renderGroup(child, level + 1)}{/each}{/if}{/snippet}
        {#each groupTree as node (node.id)}{@render renderGroup(node, 0)}{/each}
        {#if encrypted}<div class="sidebar-footer"><button class="lock-button" type="button" onclick={lock}>🔒 锁定配置</button></div>{/if}
    </aside>
    <main class="start-page-main"><header class="main-header"><div><h2 class="main-title">{title()}</h2><span class="main-count">{visible.length} 台主机</span></div><span class="main-spacer"></span><button type="button" class="local-terminal-button" onclick={onopenlocal}>⌂ 本地终端</button><button type="button" class="local-terminal-button" onclick={newProfile}>＋ 新建 SSH</button><button type="button" class="local-terminal-button" onclick={() => void importSshConfig()} disabled={importing}>{importing ? '导入中…' : '⇩ 导入 SSH Config'}</button></header>
        <div class="host-toolbar"><input type="search" bind:value={query} placeholder="搜索名称、地址或用户名" /><select bind:value={environment}><option value="">全部环境</option>{#each environments as item}<option value={item}>{item}</option>{/each}</select><label><input type="checkbox" bind:checked={favoritesOnly} /> 仅收藏</label><label><input type="checkbox" bind:checked={recentOnly} /> 最近</label><button type="button" class="secondary" onclick={resetFilters}>清除筛选</button></div>
        {#if error}<p class="start-error" role="alert">{error}</p>{/if}
        {#if visible.length}<div class="host-list">{#each visible as profile (profile.id)}<div class="host-list-item" role="button" tabindex="0" onclick={() => launch(profile)} onkeydown={(event) => { if (event.key === 'Enter') launch(profile) }} oncontextmenu={(event) => showMenu(event, profileItems(profile))}><span class="host-status-rail" data-kind={profile.favorite ? 'favorite' : 'signal'}></span><div class="host-item-body"><div class="host-item-info"><div class="host-item-name-row"><strong>{profile.name}</strong>{#if profile.favorite}<span class="host-badge favorite">收藏</span>{/if}{#if recentIds.includes(profile.id)}<span class="host-badge recent">最近</span>{/if}</div><div class="host-item-meta">{profile.user}@{profile.host}:{profile.port}</div>{#if profile.remark}<div class="host-item-remark">{profile.remark}</div>{/if}{#if profile.tags.length}<div class="host-item-tags">{#each profile.tags as tag}<span class="host-tag">{tag}</span>{/each}</div>{/if}</div><div class="host-item-actions">{#if profile.environment}<span class="env-badge env-badge--info">{profile.environment}</span>{/if}<button type="button" class="icon-button" title="更多操作" onclick={(event) => { event.stopPropagation(); showMenu(event, profileItems(profile)) }}>⋯</button><span class="connect-btn">连接</span></div></div></div>{/each}</div>{:else}<div class="host-list-empty"><div class="empty-icon">▦</div><div class="empty-text">当前筛选没有匹配的 SSH 主机</div></div>{/if}
    </main></div>{/if}
{#if menu}<ContextMenu x={menu.x} y={menu.y} items={menu.items} onclose={() => { menu = null }} />{/if}
{#if editorProfile}<HostProfileEditor profile={editorProfile} groups={groups} onconnect={saveProfile} oncancel={() => { editorProfile = null }} />{/if}
{#if editorGroup}<HostGroupEditor group={editorGroup} groups={groups} onsave={saveGroup} oncancel={() => { editorGroup = null }} />{/if}
{#if moveProfile}
    <div class="modal-backdrop" role="presentation" onclick={(event) => { if (event.target === event.currentTarget) moveProfile = null }}>
        <div class="editor-panel" role="dialog" aria-modal="true" aria-labelledby="move-profile-title" tabindex="-1">
            <form onsubmit={(event) => { event.preventDefault(); if (moveProfile) void mutate({ action: 'updateProfile', profile: moveProfile }) }}>
                <div class="editor-header"><h2 id="move-profile-title">更改分组</h2><button type="button" class="icon-button" aria-label="关闭" onclick={() => { moveProfile = null }}>×</button></div>
                <p>选择“{moveProfile.name}”所属的分组。</p>
                <label>分组<select bind:value={moveProfile.group}><option value="">未分组</option>{#each groups as group (group.id)}<option value={group.id}>{group.name}</option>{/each}</select></label>
                <div class="editor-actions"><button type="button" class="secondary" onclick={() => { moveProfile = null }}>取消</button><button type="submit">保存</button></div>
            </form>
        </div>
    </div>
{/if}
{#if groupDelete}
    <div class="modal-backdrop" role="presentation" onclick={(event) => { if (event.target === event.currentTarget) groupDelete = null }}>
        <div class="editor-panel" role="dialog" aria-modal="true" aria-labelledby="group-delete-title" tabindex="-1">
            <div class="editor-header"><h2 id="group-delete-title">删除分组</h2><button type="button" class="icon-button" aria-label="关闭" onclick={() => { groupDelete = null }}>×</button></div>
            {#if groupDelete.profiles.length > 0}
                <p>“{groupDelete.group.name}”及其子分组中有 {groupDelete.profiles.length} 台主机。</p>
                <p class="settings-hint">可以保留主机并移到未分组，或连同主机一起删除。</p>
                <div class="editor-actions"><button type="button" class="secondary" onclick={() => { groupDelete = null }}>取消</button><button type="button" class="secondary" onclick={() => void confirmDeleteGroup(false)}>移动到未分组</button><button type="button" class="plugin-remove" onclick={() => void confirmDeleteGroup(true)}>同时删除主机</button></div>
            {:else}
                <p>确认删除分组“{groupDelete.group.name}”及其子分组？</p>
                <div class="editor-actions"><button type="button" class="secondary" onclick={() => { groupDelete = null }}>取消</button><button type="button" class="plugin-remove" onclick={() => void confirmDeleteGroup(false)}>删除分组</button></div>
            {/if}
        </div>
    </div>
{/if}
