<script lang="ts">
    import { onMount } from 'svelte'
    import {
        changeHostPassphrase,
        deleteHostCredential,
        disableHostVault,
        enableHostVault,
        hostCredentials,
        lockHostProfiles,
        saveHostCredential,
        unlockHostProfiles,
        type GenericCredential,
        type HostCredential,
        type SshHostGroup,
        type SshHostProfile,
    } from './runtime'

    interface Section {
        encrypted: boolean
        unlocked: boolean
        profiles: SshHostProfile[]
        groups: SshHostGroup[]
        credentials: HostCredential[]
        generic: GenericCredential[]
    }

    interface GroupNode extends SshHostGroup {
        children: GroupNode[]
        credentials: HostCredential[]
        count: number
    }

    let section = $state<Section | null>(null)
    let passphrase = $state('')
    let newPassphrase = $state('')
    let confirmPassphrase = $state('')
    let oldPassphrase = $state('')
    let showChangeForm = $state(false)
    let busy = $state(false)
    let error = $state('')
    let notice = $state('')
    let revealed = $state<Record<string, boolean>>({})
    let editing = $state<Record<string, { password: string, keyPassphrase: string }>>({})
    let collapsed = $state<Set<string>>(new Set())
    let genericRevealed = $state<Record<number, boolean>>({})

    function credentialKey (credential: HostCredential): string {
        return `${credential.user}|${credential.host}|${credential.port}`
    }

    function findCredential (user: string, host: string, port: number): HostCredential | undefined {
        return section?.credentials.find((item) => item.user === user && item.host === host && item.port === port)
    }

    async function refresh (): Promise<void> {
        busy = true
        error = ''
        try {
            const result = await hostCredentials()
            section = result
            if (!result.unlocked) {
                revealed = {}
                editing = {}
                showChangeForm = false
                oldPassphrase = ''
                newPassphrase = ''
                confirmPassphrase = ''
            }
        } catch (cause) {
            error = cause instanceof Error ? cause.message : String(cause)
        } finally {
            busy = false
        }
    }

    onMount(() => {
        void refresh()
    })

    async function unlock (): Promise<void> {
        if (!passphrase.trim()) {
            error = '请输入主口令'
            return
        }
        busy = true
        error = ''
        try {
            await unlockHostProfiles(passphrase)
            passphrase = ''
            await refresh()
        } catch (cause) {
            error = cause instanceof Error ? cause.message : String(cause)
        } finally {
            busy = false
        }
    }

    async function enable (): Promise<void> {
        if (!newPassphrase) {
            error = '请输入主口令'
            return
        }
        if (newPassphrase !== confirmPassphrase) {
            error = '两次输入的主口令不一致'
            return
        }
        busy = true
        error = ''
        try {
            section = await enableHostVault(newPassphrase)
            newPassphrase = ''
            confirmPassphrase = ''
            notice = '保险库已启用，主机配置已加密保存'
        } catch (cause) {
            error = cause instanceof Error ? cause.message : String(cause)
        } finally {
            busy = false
        }
    }

    async function disable (): Promise<void> {
        if (!window.confirm('禁用并清除保险库？\n\n所有主机配置、分组与保存的密码/私钥口令将被永久删除，且无法恢复。')) return
        busy = true
        error = ''
        try {
            section = await disableHostVault()
            notice = '保险库已禁用并清除'
        } catch (cause) {
            error = cause instanceof Error ? cause.message : String(cause)
        } finally {
            busy = false
        }
    }

    async function changePassphrase (): Promise<void> {
        if (!oldPassphrase || !newPassphrase) {
            error = '请填写旧口令与新口令'
            return
        }
        if (newPassphrase !== confirmPassphrase) {
            error = '两次输入的新口令不一致'
            return
        }
        busy = true
        error = ''
        try {
            section = await changeHostPassphrase(oldPassphrase, newPassphrase)
            oldPassphrase = ''
            newPassphrase = ''
            confirmPassphrase = ''
            showChangeForm = false
            notice = '主口令已修改'
        } catch (cause) {
            error = cause instanceof Error ? cause.message : String(cause)
        } finally {
            busy = false
        }
    }

    function lockNow (): void {
        void lockHostProfiles().then(() => refresh())
    }

    // 分组树：按 parentGroupId 建层级，凭据挂到所属分组节点；未分组凭据单独收集
    const groupTree = $derived.by(() => {
        if (!section) return { roots: [] as GroupNode[], ungrouped: [] as HostCredential[] }
        const map = new Map(section.groups.map((group) => [group.id, { ...group, children: [], credentials: [], count: 0 } as GroupNode]))
        const roots: GroupNode[] = []
        for (const group of section.groups) {
            const node = map.get(group.id)!
            const parent = group.parentGroupId ? map.get(group.parentGroupId) : null
            if (parent && parent !== node) parent.children.push(node)
            else roots.push(node)
        }
        const ungrouped: HostCredential[] = []
        const grouped = new Set<string>()
        for (const credential of section.credentials) {
            const profile = section.profiles.find(
                (item) => item.user === credential.user && item.host === credential.host && item.port === credential.port,
            )
            if (profile && profile.group && map.has(profile.group)) {
                map.get(profile.group)!.credentials.push(credential)
                grouped.add(credentialKey(credential))
            } else {
                ungrouped.push(credential)
            }
        }
        const count = (node: GroupNode): number => {
            node.count = node.credentials.length + node.children.reduce((sum, child) => sum + count(child), 0)
            return node.count
        }
        roots.forEach(count)
        return { roots, ungrouped }
    })

    // 与主机列表页一致的排序：分组名 → 主机名
    function sortCredentials (credentials: HostCredential[]): HostCredential[] {
        const nameOf = (credential: HostCredential): string => {
            const profile = section?.profiles.find(
                (item) => item.user === credential.user && item.host === credential.host && item.port === credential.port,
            )
            return profile?.name ?? credential.host
        }
        return [...credentials].sort((a, b) => nameOf(a).localeCompare(nameOf(b)))
    }

    function toggleReveal (credential: HostCredential): void {
        const key = credentialKey(credential)
        revealed = { ...revealed, [key]: !revealed[key] }
    }

    function startEdit (credential: HostCredential): void {
        const key = credentialKey(credential)
        editing = {
            ...editing,
            [key]: { password: credential.password ?? '', keyPassphrase: credential.keyPassphrase ?? '' },
        }
    }

    function cancelEdit (credential: HostCredential): void {
        const key = credentialKey(credential)
        const next = { ...editing }
        delete next[key]
        editing = next
    }

    async function saveEdit (credential: HostCredential): Promise<void> {
        const key = credentialKey(credential)
        const draft = editing[key]
        if (!draft) return
        busy = true
        error = ''
        try {
            const result = await saveHostCredential({
                user: credential.user,
                host: credential.host,
                port: credential.port,
                password: draft.password,
                keyPassphrase: draft.keyPassphrase,
            })
            section = result
            cancelEdit(credential)
        } catch (cause) {
            error = cause instanceof Error ? cause.message : String(cause)
        } finally {
            busy = false
        }
    }

    async function removeCredential (credential: HostCredential): Promise<void> {
        const label = `${credential.user}@${credential.host}:${credential.port}`
        if (!window.confirm(`删除「${label}」的密码与私钥口令？`)) return
        busy = true
        error = ''
        try {
            const result = await deleteHostCredential(credential.user, credential.host, credential.port)
            section = result
        } catch (cause) {
            error = cause instanceof Error ? cause.message : String(cause)
        } finally {
            busy = false
        }
    }

    function toggleGroup (id: string): void {
        const next = new Set(collapsed)
        if (next.has(id)) next.delete(id)
        else next.add(id)
        collapsed = next
    }

    function toggleGenericReveal (index: number): void {
        genericRevealed = { ...genericRevealed, [index]: !genericRevealed[index] }
    }
</script>

<section aria-label="保险库">
    {#if error}
        <div class="settings-error" role="alert">{error}</div>
    {/if}

    {#if !section}
        <div class="settings-empty">正在读取保险库状态…</div>
    {:else if !section.encrypted}
        <div class="settings-field">
            <div class="settings-field-title">启用保险库</div>
            <p class="settings-hint">设置主口令后，所有主机配置与保存的密码/私钥口令将加密存储。每次启动需输入主口令解锁。</p>
            <input
                class="settings-input"
                type="password"
                placeholder="主口令（至少 1 个字符）"
                bind:value={newPassphrase}
                aria-label="新主口令"
            />
            <input
                class="settings-input"
                type="password"
                placeholder="确认主口令"
                bind:value={confirmPassphrase}
                aria-label="确认主口令"
                onkeydown={(event) => { if (event.key === 'Enter') void enable() }}
            />
            <div class="settings-actions">
                <button class="market-install" type="button" disabled={busy} onclick={() => void enable()}>设置主口令并启用</button>
            </div>
        </div>
    {:else if !section.unlocked}
        <div class="settings-field">
            <div class="settings-field-title">保险库已锁定</div>
            <p class="settings-hint">解锁后可查看和管理所有主机的账号密码与私钥口令。</p>
            <input
                class="settings-input"
                type="password"
                placeholder="主口令"
                bind:value={passphrase}
                aria-label="保险库主口令"
                onkeydown={(event) => { if (event.key === 'Enter') void unlock() }}
            />
            <div class="settings-actions">
                <button class="market-install" type="button" disabled={busy} onclick={() => void unlock()}>解锁</button>
            </div>
        </div>
    {:else}
        <div class="vault-status-line">
            <strong>已解锁</strong>
            <span>{section.credentials.length} 台主机凭据 · {section.generic.length} 条通用凭据</span>
            <span class="vault-secret-spacer"></span>
            <button type="button" disabled={busy} onclick={() => { showChangeForm = !showChangeForm }}>{showChangeForm ? '取消改口令' : '修改主口令'}</button>
            <button type="button" disabled={busy} onclick={lockNow}>锁定</button>
            <button class="plugin-remove" type="button" disabled={busy} onclick={() => void disable()}>禁用并清除</button>
        </div>

        {#if showChangeForm}
            <div class="settings-field">
                <div class="settings-field-title">修改主口令</div>
                <input class="settings-input" type="password" placeholder="旧主口令" bind:value={oldPassphrase} aria-label="旧主口令" />
                <input class="settings-input" type="password" placeholder="新主口令" bind:value={newPassphrase} aria-label="新主口令" />
                <input class="settings-input" type="password" placeholder="确认新主口令" bind:value={confirmPassphrase} aria-label="确认新主口令" />
                <div class="settings-actions">
                    <button class="market-install" type="button" disabled={busy} onclick={() => void changePassphrase()}>确认修改</button>
                </div>
            </div>
        {/if}

        {#if notice}
            <div class="settings-hint vault-notice">{notice}</div>
        {/if}

        {#if section.credentials.length === 0 && section.generic.length === 0}
            <div class="settings-empty">保险库中暂无主机账号密码。连接主机时勾选保存密码，或在此手动编辑。</div>
        {/if}

        {#snippet credentialRow(credential: HostCredential, indent: boolean)}
            {@const key = credentialKey(credential)}
            <div class="vault-secret" class:indented={indent}>
                <div class="vault-secret-head">
                    <span class="vault-account">{credential.user}@{credential.host}:{credential.port}</span>
                    {#if credential.password !== null}<span class="host-badge recent">密码</span>{/if}
                    {#if credential.keyPassphrase !== null}<span class="host-badge favorite">口令</span>{/if}
                    {#if credential.passphraseByKey}<span class="vault-secret-desc">按私钥匹配</span>{/if}
                    <span class="vault-secret-spacer"></span>
                    {#if editing[key]}
                        <button type="button" disabled={busy} onclick={() => void saveEdit(credential)}>保存</button>
                        <button type="button" disabled={busy} onclick={() => cancelEdit(credential)}>取消</button>
                    {:else}
                        <button type="button" disabled={busy} onclick={() => toggleReveal(credential)}>{revealed[key] ? '隐藏' : '查看'}</button>
                        <button type="button" disabled={busy} onclick={() => startEdit(credential)}>编辑</button>
                        <button class="plugin-remove" type="button" disabled={busy} onclick={() => void removeCredential(credential)}>删除</button>
                    {/if}
                </div>
                {#if revealed[key] && !editing[key]}
                    <div class="vault-secret-value">
                        {#if credential.password !== null}<div>密码：{credential.password}</div>{/if}
                        {#if credential.keyPassphrase !== null}<div>私钥口令：{credential.keyPassphrase}</div>{/if}
                    </div>
                {/if}
                {#if editing[key]}
                    <div class="vault-edit-form">
                        <label>密码<input type="text" bind:value={editing[key].password} placeholder="留空表示清除" /></label>
                        <label>私钥口令<input type="text" bind:value={editing[key].keyPassphrase} placeholder="留空表示清除" /></label>
                    </div>
                {/if}
            </div>
        {/snippet}

        {#if section.credentials.length > 0}
            <div class="settings-field">
                <div class="settings-field-title">主机账号密码（按分组）</div>
                {#snippet renderGroup(node: GroupNode, level: number)}
                    <div class="vault-group-row" style:padding-left={`${level * 18}px`}>
                        <button class="tree-toggle" type="button" onclick={() => toggleGroup(node.id)}>{node.children.length || node.credentials.length ? (collapsed.has(node.id) ? '▸' : '▾') : '·'}</button>
                        <span class="vault-group-name">▣ {node.name}</span>
                        <span class="vault-group-count">{node.count}</span>
                    </div>
                    {#if !collapsed.has(node.id)}
                        {#each sortCredentials(node.credentials) as credential, credential_index (credential_index)}
                            {@render credentialRow(credential, true)}
                        {/each}
                        {#each node.children as child (child.id)}
                            {@render renderGroup(child, level + 1)}
                        {/each}
                    {/if}
                {/snippet}
                {#each groupTree.roots as node (node.id)}
                    {@render renderGroup(node, 0)}
                {/each}
                {#if groupTree.ungrouped.length > 0}
                    <div class="vault-group-row"><span class="vault-group-name">▣ 未分组</span><span class="vault-group-count">{groupTree.ungrouped.length}</span></div>
                    {#each sortCredentials(groupTree.ungrouped) as credential, credential_index (credential_index)}
                        {@render credentialRow(credential, true)}
                    {/each}
                {/if}
            </div>
        {/if}

        {#if section.generic.length > 0}
            <div class="settings-field">
                <div class="settings-field-title">通用凭据（未绑定具体主机）</div>
                {#each section.generic as item, index (index)}
                    <div class="vault-secret">
                        <div class="vault-secret-head">
                            <span class="vault-account">{item.kind === 'password' ? '默认密码' : '私钥口令'} · {item.user}{item.keyPath ? ` · ${item.keyPath}` : ''}</span>
                            <span class="vault-secret-spacer"></span>
                            <button type="button" onclick={() => toggleGenericReveal(index)}>{genericRevealed[index] ? '隐藏' : '查看'}</button>
                        </div>
                        {#if genericRevealed[index] && item.value !== null}
                            <div class="vault-secret-value">{item.value}</div>
                        {/if}
                    </div>
                {/each}
            </div>
        {/if}
    {/if}
</section>
