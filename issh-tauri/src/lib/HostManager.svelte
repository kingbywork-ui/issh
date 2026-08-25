<script lang="ts">
    import {
        hostProfiles,
        lockHostProfiles,
        unlockHostProfiles,
        type SshHostGroup,
        type SshHostProfile,
    } from './runtime'

    interface GroupNode {
        id: string
        name: string
        children: GroupNode[]
        count: number
        profileIds: string[]
    }

    let { onconnect, onopenlocal }: {
        onconnect: (profile: SshHostProfile) => void
        onopenlocal: () => void
    } = $props()

    let encrypted = $state(false)
    let unlocked = $state(false)
    let profiles = $state<SshHostProfile[]>([])
    let groups = $state<SshHostGroup[]>([])
    let loading = $state(true)
    let error = $state('')

    // 解锁弹窗
    let showUnlock = $state(false)
    let passphrase = $state('')
    let unlocking = $state(false)
    let unlockError = $state('')

    // 侧栏视图
    let view = $state<'all' | 'favorites' | 'recent' | { group: string }>('all')
    let collapsedGroups = $state<Set<string>>(new Set())

    const RECENT_KEY = 'issh.recentHosts'
    const RECENT_LIMIT = 6

    let recentIds = $state<string[]>(loadRecent())

    function loadRecent (): string[] {
        try {
            const raw = localStorage.getItem(RECENT_KEY)
            const parsed = raw ? JSON.parse(raw) : []
            return Array.isArray(parsed) ? parsed.filter((id) => typeof id === 'string') : []
        } catch {
            return []
        }
    }

    function recordRecent (profile: SshHostProfile): void {
        recentIds = [profile.id, ...recentIds.filter((id) => id !== profile.id)].slice(0, RECENT_LIMIT)
        try {
            localStorage.setItem(RECENT_KEY, JSON.stringify(recentIds))
        } catch {
            // localStorage 不可用时忽略
        }
    }

    async function refresh (): Promise<void> {
        loading = true
        error = ''
        try {
            const result = await hostProfiles()
            encrypted = result.encrypted
            unlocked = !result.encrypted || result.unlocked
            profiles = result.profiles
            groups = result.groups
        } catch (cause) {
            error = cause instanceof Error ? cause.message : String(cause)
        } finally {
            loading = false
        }
    }

    async function unlock (): Promise<void> {
        unlocking = true
        unlockError = ''
        try {
            const result = await unlockHostProfiles(passphrase)
            encrypted = result.encrypted
            unlocked = result.unlocked
            profiles = result.profiles
            groups = result.groups
            passphrase = ''
            showUnlock = false
        } catch (cause) {
            unlockError = cause instanceof Error ? cause.message : String(cause)
        } finally {
            unlocking = false
        }
    }

    function lock (): void {
        void lockHostProfiles().then((result) => {
            unlocked = result.unlocked
            profiles = result.profiles
            groups = result.groups
        }).catch(() => null)
    }

    function isRecent (profile: SshHostProfile): boolean {
        return recentIds.includes(profile.id)
    }

    function connectionInfo (profile: SshHostProfile): { user: string, host: string, port: number } | null {
        if (!profile.host) return null
        return { user: profile.user, host: profile.host, port: profile.port }
    }

    function environmentBadge (environment: string | null): { label: string, cls: string } | null {
        if (!environment) return null
        const normalized = environment.trim().toLowerCase()
        if (normalized === 'prod' || normalized === 'production' || environment.includes('生产')) {
            return { label: environment, cls: 'env-badge--risk' }
        }
        if (normalized === 'test' || normalized === 'staging' || environment.includes('测试')) {
            return { label: environment, cls: 'env-badge--warn' }
        }
        return { label: environment, cls: 'env-badge--info' }
    }

    // 分组树：groups（带 parentGroupId，profile.group 存组 UUID）+ .ssh/config 导入的字符串路径
    function buildGroupTree (): GroupNode[] {
        const byId = new Map<string, GroupNode>()
        for (const group of groups) {
            byId.set(group.id, { id: group.id, name: group.name, children: [], count: 0, profileIds: [] })
        }
        const roots: GroupNode[] = []
        for (const group of groups) {
            const node = byId.get(group.id)!
            const parent = group.parentGroupId ? byId.get(group.parentGroupId) : undefined
            if (parent) {
                parent.children.push(node)
            } else {
                roots.push(node)
            }
        }
        // profile.group 可能是组 UUID（Electron config）或字符串路径（.ssh/config 导入）
        const pathNodes = new Map<string, GroupNode>()
        for (const profile of profiles) {
            const path = profile.group?.trim()
            if (!path) continue
            const groupNode = byId.get(path)
            if (groupNode) {
                groupNode.profileIds.push(profile.id)
                continue
            }
            const segments = path.split('/').map((s) => s.trim()).filter(Boolean)
            let parentNodes = roots
            let prefix = ''
            for (const segment of segments) {
                prefix = prefix ? `${prefix} / ${segment}` : segment
                let node = pathNodes.get(prefix)
                if (!node) {
                    node = { id: `path:${prefix}`, name: segment, children: [], count: 0, profileIds: [] }
                    pathNodes.set(prefix, node)
                    parentNodes.push(node)
                }
                node.profileIds.push(profile.id)
                parentNodes = node.children
            }
        }
        const countInto = (node: GroupNode): number => {
            node.count = node.children.reduce((sum, child) => sum + countInto(child), node.profileIds.length)
            return node.count
        }
        for (const root of roots) countInto(root)
        return roots.filter((node) => node.count > 0 || node.children.length > 0 || node.id.startsWith('path:'))
    }

    const groupTree = $derived(buildGroupTree())

    function groupDisplayName (profile: SshHostProfile): string {
        const raw = profile.group?.trim()
        if (!raw) return '未分组'
        const group = groups.find((g) => g.id === raw)
        return group ? group.name : raw
    }

    function findNode (nodes: GroupNode[], id: string): GroupNode | null {
        for (const node of nodes) {
            if (node.id === id) return node
            const found = findNode(node.children, id)
            if (found) return found
        }
        return null
    }

    function collectProfileIds (node: GroupNode, into: Set<string>): void {
        for (const id of node.profileIds) into.add(id)
        for (const child of node.children) collectProfileIds(child, into)
    }

    function visibleProfiles (): SshHostProfile[] {
        if (view === 'all') return profiles
        if (view === 'favorites') return profiles.filter((p) => p.favorite)
        if (view === 'recent') return recentIds
            .map((id) => profiles.find((p) => p.id === id))
            .filter((p): p is SshHostProfile => Boolean(p))
        if (typeof view === 'object' && 'group' in view) {
            const node = findNode(groupTree, view.group)
            if (!node) return []
            const ids = new Set<string>()
            collectProfileIds(node, ids)
            return profiles.filter((p) => ids.has(p.id))
        }
        return profiles
    }

    function viewTitle (): string {
        if (view === 'all') return '全部主机'
        if (view === 'favorites') return '收藏'
        if (view === 'recent') return '最近连接'
        if (typeof view === 'object' && 'group' in view) {
            return findNode(groupTree, view.group)?.name ?? view.group
        }
        return '全部主机'
    }

    function toggleCollapse (node: GroupNode): void {
        const next = new Set(collapsedGroups)
        if (next.has(node.id)) {
            next.delete(node.id)
        } else {
            next.add(node.id)
        }
        collapsedGroups = next
    }

    function selectGroup (node: GroupNode): void {
        view = { group: node.id }
    }

    function launch (profile: SshHostProfile): void {
        recordRecent(profile)
        onconnect(profile)
    }

    function isActiveView (candidate: 'all' | 'favorites' | 'recent'): boolean {
        return view === candidate
    }

    function isGroupActive (node: GroupNode): boolean {
        return typeof view === 'object' && 'group' in view && view.group === node.id
    }

    function railKind (profile: SshHostProfile): string {
        if (profile.favorite) return 'favorite'
        const env = profile.environment?.trim().toLowerCase() ?? ''
        if (env === 'prod' || env === 'production' || (profile.environment ?? '').includes('生产')) return 'risk'
        return 'signal'
    }

    // 初始加载
    void refresh()
</script>

{#if loading && profiles.length === 0 && !encrypted}
    <div class="start-empty">正在读取主机配置…</div>
{:else if encrypted && !unlocked}
    <div class="vault-locked">
        <div class="vault-locked-icon">🔒</div>
        <h2>主机配置已加密</h2>
        <p>配置文件使用 Vault 加密存储，输入主口令解锁后查看主机列表。</p>
        {#if showUnlock}
            <form class="vault-unlock-form" onsubmit={(event) => { event.preventDefault(); void unlock() }}>
                <input
                    type="password"
                    bind:value={passphrase}
                    placeholder="主口令"
                    autocomplete="off"
                    disabled={unlocking}
                />
                <button type="submit" disabled={unlocking || !passphrase}>
                    {unlocking ? '解锁中…' : '解锁'}
                </button>
                <button type="button" class="secondary" onclick={() => { showUnlock = false; unlockError = '' }} disabled={unlocking}>取消</button>
                {#if unlockError}
                    <p class="vault-error" role="alert">{unlockError}</p>
                {/if}
            </form>
        {:else}
            <button type="button" onclick={() => { showUnlock = true }}>解锁配置</button>
        {/if}
    </div>
{:else}
    <div class="start-page-layout">
        <aside class="start-page-sidebar">
            <div class="sidebar-tree">
                <button class="sidebar-tree-item root-item" class:active={isActiveView('all')} type="button" onclick={() => { view = 'all' }}>
                    <span class="tree-icon">▦</span>
                    <span class="tree-label">全部</span>
                    <span class="count">{profiles.length}</span>
                </button>
                <button class="sidebar-tree-item root-item" class:active={isActiveView('favorites')} type="button" onclick={() => { view = 'favorites' }}>
                    <span class="tree-icon">★</span>
                    <span class="tree-label">收藏</span>
                    <span class="count">{profiles.filter((p) => p.favorite).length}</span>
                </button>
                <button class="sidebar-tree-item root-item" class:active={isActiveView('recent')} type="button" onclick={() => { view = 'recent' }}>
                    <span class="tree-icon">↻</span>
                    <span class="tree-label">最近</span>
                    <span class="count">{recentIds.length}</span>
                </button>

                {#each groupTree as node (node.id)}
                    <button
                        class="sidebar-tree-item"
                        class:active={isGroupActive(node)}
                        type="button"
                        onclick={() => selectGroup(node)}
                    >
                        {#if node.children.length > 0}
                            <span
                                class="tree-toggle"
                                role="button"
                                tabindex="0"
                                onclick={(event) => { event.stopPropagation(); toggleCollapse(node) }}
                                onkeydown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.stopPropagation(); event.preventDefault(); toggleCollapse(node) } }}
                            >
                                {collapsedGroups.has(node.id) ? '▸' : '▾'}
                            </span>
                        {:else}
                            <span class="tree-toggle-spacer"></span>
                        {/if}
                        <span class="tree-icon folder">{collapsedGroups.has(node.id) ? '▤' : '▣'}</span>
                        <span class="tree-label">{node.name}</span>
                        <span class="count">{node.count}</span>
                    </button>

                    {#if !collapsedGroups.has(node.id)}
                        {#each node.children as child (child.id)}
                            <button
                                class="sidebar-tree-item"
                                class:active={isGroupActive(child)}
                                style:padding-left="1.4rem"
                                type="button"
                                onclick={() => selectGroup(child)}
                            >
                                <span class="tree-toggle-spacer"></span>
                                <span class="tree-icon folder">▣</span>
                                <span class="tree-label">{child.name}</span>
                                <span class="count">{child.count}</span>
                            </button>
                        {/each}
                    {/if}
                {/each}
            </div>
            {#if encrypted && unlocked}
                <div class="sidebar-footer">
                    <button type="button" class="lock-button" onclick={lock}>🔒 锁定配置</button>
                </div>
            {/if}
        </aside>

        <main class="start-page-main">
            <header class="main-header">
                <h2 class="main-title">{viewTitle()}</h2>
                <span class="main-count">{visibleProfiles().length} 台主机</span>
                <span class="main-spacer"></span>
                <button type="button" class="local-terminal-button" onclick={onopenlocal}>＋ 本地终端</button>
            </header>

            {#if error}
                <p class="start-error" role="alert">{error}</p>
            {/if}

            {#if visibleProfiles().length > 0}
                <div class="host-list">
                    {#each visibleProfiles() as profile (profile.id)}
                        <button
                            class="host-list-item"
                            class:risk={environmentBadge(profile.environment)?.cls === 'env-badge--risk'}
                            type="button"
                            onclick={() => launch(profile)}
                            title={profile.name}
                        >
                            <span class="host-status-rail" data-kind={railKind(profile)}></span>
                            <span class="host-item-body">
                                <span class="host-item-info">
                                    <span class="host-item-name-row">
                                        <span class="host-item-name">{profile.name}</span>
                                        <span class="host-item-badges">
                                            {#if profile.favorite}<span class="host-badge favorite">收藏</span>{/if}
                                            {#if isRecent(profile)}<span class="host-badge recent">最近</span>{/if}
                                        </span>
                                    </span>
                                    {#if connectionInfo(profile)}
                                        <span class="host-item-meta">
                                            {#if profile.user}<span>👤 {profile.user}</span>{/if}
                                            {#if profile.host}<span>🌐 {profile.host}</span>{/if}
                                            {#if profile.port && profile.port !== 22}<span>: {profile.port}</span>{/if}
                                        </span>
                                    {/if}
                                    {#if profile.remark}
                                        <span class="host-item-remark">{profile.remark}</span>
                                    {/if}
                                    {#if profile.tags.length > 0}
                                        <span class="host-item-tags">
                                            {#each profile.tags as tag (tag)}<span class="host-tag">{tag}</span>{/each}
                                        </span>
                                    {/if}
                                </span>
                                <span class="host-item-actions">
                                    {#if environmentBadge(profile.environment)}
                                        <span class="env-badge {environmentBadge(profile.environment)!.cls}">{profile.environment}</span>
                                    {/if}
                                    <span class="connect-btn">连接</span>
                                </span>
                            </span>
                        </button>
                    {/each}
                </div>
            {:else}
                <div class="host-list-empty">
                    <div class="empty-icon">▦</div>
                    <div class="empty-text">{view === 'all' ? '没有已保存的主机，点击右上角「本地终端」或在终端中使用 SSH 连接' : '当前分组没有主机'}</div>
                </div>
            {/if}
        </main>
    </div>
{/if}
