<script lang="ts">
    import { onMount } from 'svelte'
    import {
        hostCredentials,
        saveHostCredential,
        type HostCredential,
        type SshHostProfile,
    } from './runtime'
import { clearLegacySudoPasswords, isAutoSudoEnabled, setAutoSudoEnabled } from './autoSudo'

    let enabled = $state(isAutoSudoEnabled())
    let profiles = $state<SshHostProfile[]>([])
    let credentials = $state<HostCredential[]>([])
    let selectedKey = $state('')
    let password = $state('')
    let busy = $state(false)
    let loading = $state(true)
    let error = $state('')
    let notice = $state('')

    function keyOf (profile: Pick<SshHostProfile, 'user' | 'host' | 'port'>): string {
        return `${profile.user}|${profile.host}|${profile.port}`
    }

    function selectedProfile (): SshHostProfile | undefined {
        return profiles.find((profile) => keyOf(profile) === selectedKey)
    }

    function credentialFor (profile: SshHostProfile): HostCredential | undefined {
        return credentials.find((credential) => keyOf(credential) === keyOf(profile))
    }

    async function refresh (): Promise<void> {
        loading = true
        error = ''
        try {
            const result = await hostCredentials()
            profiles = result.profiles
            credentials = result.credentials
            if (!profiles.some((profile) => keyOf(profile) === selectedKey)) selectedKey = profiles.length > 0 ? keyOf(profiles[0]) : ''
            const profile = selectedProfile()
            password = profile ? credentialFor(profile)?.sudoPassword ?? '' : ''
        } catch (cause) {
            error = cause instanceof Error ? cause.message : String(cause)
        } finally {
            loading = false
        }
    }

    function toggle (value: boolean): void {
        enabled = value
        setAutoSudoEnabled(value)
    }

    async function save (): Promise<void> {
        const profile = selectedProfile()
        if (!profile) return
        if (!password.trim()) {
            error = '请输入 sudo 密码；如需删除请使用删除按钮'
            return
        }
        busy = true
        error = ''
        notice = ''
        try {
            const result = await saveHostCredential({ user: profile.user, host: profile.host, port: profile.port, sudoPassword: password })
            credentials = result.credentials
            notice = `已保存 ${profile.user}@${profile.host}:${profile.port} 的 sudo 密码`
        } catch (cause) {
            error = cause instanceof Error ? cause.message : String(cause)
        } finally {
            busy = false
        }
    }

    async function remove (): Promise<void> {
        const profile = selectedProfile()
        if (!profile || !credentialFor(profile)?.sudoPassword) return
        if (!window.confirm(`删除 ${profile.user}@${profile.host}:${profile.port} 的 sudo 密码？`)) return
        busy = true
        error = ''
        try {
            const result = await saveHostCredential({ user: profile.user, host: profile.host, port: profile.port, sudoPassword: '' })
            credentials = result.credentials
            password = ''
            notice = 'sudo 密码已删除'
        } catch (cause) {
            error = cause instanceof Error ? cause.message : String(cause)
        } finally {
            busy = false
        }
    }

    function choose (value: string): void {
        selectedKey = value
        const profile = selectedProfile()
        password = profile ? credentialFor(profile)?.sudoPassword ?? '' : ''
        error = ''
        notice = ''
    }

    onMount(() => {
        const removed = clearLegacySudoPasswords()
        if (removed > 0) notice = '已清理旧版本明文 sudo 密码，请为主机重新录入并保存。'
        void refresh()
    })
</script>

<section aria-label="sudo 密码自动填充">
    <div class="settings-field">
        <div class="settings-field-title">sudo 密码自动填充</div>
        <p class="settings-hint">仅 SSH 会话可用。出现 sudo 提示后，点击终端工具栏中的填充按钮；保险库已解锁时也可按 Ctrl+Enter。保险库锁定时会要求输入主口令，并在取出当前密码后立即重新锁定。</p>
    </div>
    <label class="settings-toggle">
        <input type="checkbox" checked={enabled} onchange={(event) => { toggle((event.currentTarget as HTMLInputElement).checked) }} />
        <span>启用自动填充</span>
    </label>

    {#if error}<div class="settings-error">{error}</div>{/if}

    {#if loading}
        <div class="settings-empty">正在读取主机凭据…</div>
    {:else if profiles.length === 0}
        <div class="settings-empty">请先在主机管理中添加 SSH 主机。</div>
    {:else}
        <div class="settings-field sudo-form">
            <label>SSH 主机
                <select value={selectedKey} onchange={(event) => { choose((event.currentTarget as HTMLSelectElement).value) }}>
                    {#each profiles as profile (profile.id)}
                        <option value={keyOf(profile)}>{profile.name || profile.user}@{profile.host}:{profile.port}</option>
                    {/each}
                </select>
            </label>
            <label>sudo 密码
                <input type="password" autocomplete="off" bind:value={password} placeholder="输入后保存到保险库" />
            </label>
            <div class="sudo-actions">
                <button type="button" disabled={busy || !selectedProfile()} onclick={() => void save()}>保存</button>
                <button class="plugin-remove" type="button" disabled={busy || !credentialFor(selectedProfile() ?? profiles[0])?.sudoPassword} onclick={() => void remove()}>删除</button>
            </div>
        </div>
        {#if notice}<div class="settings-hint vault-notice">{notice}</div>{/if}
        <div class="settings-field">
            <div class="settings-field-title">已配置的主机</div>
            <ul class="sudo-user-list">
                {#each credentials.filter((item) => item.sudoPassword !== null) as credential (keyOf(credential))}
                    <li><span>{credential.user}@{credential.host}:{credential.port}</span><span class="host-badge recent">已保存</span></li>
                {:else}
                    <li class="settings-empty">暂无已配置的 sudo 密码</li>
                {/each}
            </ul>
        </div>
    {/if}
</section>
