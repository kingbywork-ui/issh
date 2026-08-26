<script lang="ts">
    import { onMount } from 'svelte'
    import {
        hostProfiles,
        lockHostProfiles,
        unlockHostProfiles,
        type SshHostProfile,
    } from './runtime'

    let {
        onconnect,
        onopenlocal,
        onnewssh,
        onclose,
    }: {
        onconnect: (profile: SshHostProfile) => void
        onopenlocal: () => void
        onnewssh: () => void
        onclose: () => void
    } = $props()

    let encrypted = $state(false)
    let unlocked = $state(false)
    let profiles = $state<SshHostProfile[]>([])
    let loading = $state(true)
    let error = $state('')
    let query = $state('')

    let showUnlock = $state(false)
    let passphrase = $state('')
    let unlocking = $state(false)
    let unlockError = $state('')

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
            passphrase = ''
            showUnlock = false
        } catch (cause) {
            unlockError = cause instanceof Error ? cause.message : String(cause)
        } finally {
            unlocking = false
        }
    }

    const recentProfiles = $derived(
        recentIds
            .map((id) => profiles.find((p) => p.id === id))
            .filter((p): p is SshHostProfile => Boolean(p)),
    )

    const filteredProfiles = $derived.by(() => {
        const needle = query.trim().toLowerCase()
        if (!needle) return profiles
        return profiles.filter((p) =>
            p.name.toLowerCase().includes(needle)
            || p.host.toLowerCase().includes(needle)
            || p.user.toLowerCase().includes(needle),
        )
    })

    function pick (profile: SshHostProfile): void {
        recordRecent(profile)
        onclose()
        onconnect(profile)
    }

    function pickLocal (): void {
        onclose()
        onopenlocal()
    }

    function startNewSsh (): void {
        onclose()
        onnewssh()
    }

    onMount(() => {
        void refresh()
    })
</script>

<div
    class="modal-backdrop"
    role="presentation"
    onclick={onclose}
    onkeydown={(event) => { if (event.key === 'Escape') onclose() }}
>
    <div
        class="profile-selector"
        role="dialog"
        aria-modal="true"
        aria-label="Profiles & connections"
        tabindex="-1"
        onclick={(event) => event.stopPropagation()}
        onkeydown={(event) => event.stopPropagation()}
    >
        <div class="selector-search">
            <input
                type="text"
                bind:value={query}
                placeholder="搜索主机、地址或用户名…"
                aria-label="搜索"
            />
        </div>

        {#if loading}
            <div class="selector-empty">正在读取主机配置…</div>
        {:else if encrypted && !unlocked}
            <div class="selector-locked">
                <p>主机配置已加密，输入主口令解锁后查看。</p>
                {#if showUnlock}
                    <form class="selector-unlock-form" onsubmit={(event) => { event.preventDefault(); void unlock() }}>
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
                    </form>
                    {#if unlockError}
                        <p class="selector-error" role="alert">{unlockError}</p>
                    {/if}
                {:else}
                    <button class="selector-unlock-button" type="button" onclick={() => { showUnlock = true }}>解锁配置</button>
                {/if}
            </div>
        {:else}
            {#if error}
                <p class="selector-error" role="alert">{error}</p>
            {/if}

            {#if recentProfiles.length > 0 && !query.trim()}
                <div class="selector-group">
                    <div class="selector-group-title">最近</div>
                    {#each recentProfiles as profile (profile.id)}
                        <button class="selector-item" type="button" onclick={() => pick(profile)}>
                            <span class="selector-icon recent">↻</span>
                            <span class="selector-copy">
                                <span class="selector-name">{profile.name}</span>
                                <span class="selector-desc">{profile.user}@{profile.host}:{profile.port}</span>
                            </span>
                        </button>
                    {/each}
                </div>
            {/if}

            <div class="selector-group">
                <div class="selector-group-title">本地终端</div>
                <button class="selector-item" type="button" onclick={pickLocal}>
                    <span class="selector-icon home">⌂</span>
                    <span class="selector-copy">
                        <span class="selector-name">本地终端</span>
                        <span class="selector-desc">CMD · 当前设备</span>
                    </span>
                </button>
            </div>

            <div class="selector-group">
                <div class="selector-group-title">SSH 主机</div>
                {#if filteredProfiles.length > 0}
                    {#each filteredProfiles as profile (profile.id)}
                        <button class="selector-item" type="button" onclick={() => pick(profile)}>
                            <span class="selector-icon ssh">▦</span>
                            <span class="selector-copy">
                                <span class="selector-name">{profile.name}</span>
                                <span class="selector-desc">{profile.user}@{profile.host}:{profile.port}</span>
                            </span>
                        </button>
                    {/each}
                {:else}
                    <div class="selector-empty small">{query.trim() ? '没有匹配的主机' : '没有已保存的 SSH 主机'}</div>
                {/if}
            </div>

            <div class="selector-footer">
                <button class="selector-new" type="button" onclick={startNewSsh}>＋ 新建 SSH 连接</button>
            </div>
        {/if}
    </div>
</div>
