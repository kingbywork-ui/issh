<script lang="ts">
    import { onMount } from 'svelte'
    import {
        vaultDeleteSecret,
        vaultGetSecret,
        vaultListSecrets,
        vaultLock,
        vaultPutSecret,
        vaultSetEnabled,
        vaultStatus,
        vaultUnlock,
        type VaultSecretKey,
        type VaultStatus,
    } from './runtime'

    let status = $state<VaultStatus | null>(null)
    let secrets = $state<VaultSecretKey[]>([])
    let passphrase = $state('')
    let newId = $state('')
    let newDescription = $state('')
    let newValue = $state('')
    let busy = $state(false)
    let error = $state('')
    let revealed = $state<Record<string, string>>({})

    async function refresh (): Promise<void> {
        busy = true
        error = ''
        try {
            status = await vaultStatus()
            secrets = status.unlocked ? await vaultListSecrets() : []
        } catch (cause) {
            error = cause instanceof Error ? cause.message : String(cause)
        } finally {
            busy = false
        }
    }

    onMount(() => {
        void refresh()
    })

    async function enable (): Promise<void> {
        if (!passphrase.trim()) {
            error = '请先输入 passphrase'
            return
        }
        busy = true
        error = ''
        try {
            status = await vaultSetEnabled(true, passphrase)
            passphrase = ''
            await refresh()
        } catch (cause) {
            error = cause instanceof Error ? cause.message : String(cause)
        } finally {
            busy = false
        }
    }

    async function disable (): Promise<void> {
        if (!window.confirm('禁用保险库将清除加密存储的机密，确定继续？')) return
        busy = true
        error = ''
        try {
            status = await vaultSetEnabled(false)
            secrets = []
            revealed = {}
            await refresh()
        } catch (cause) {
            error = cause instanceof Error ? cause.message : String(cause)
        } finally {
            busy = false
        }
    }

    async function unlock (): Promise<void> {
        busy = true
        error = ''
        try {
            status = await vaultUnlock(passphrase)
            passphrase = ''
            await refresh()
        } catch (cause) {
            error = cause instanceof Error ? cause.message : String(cause)
        } finally {
            busy = false
        }
    }

    async function lock (): Promise<void> {
        busy = true
        error = ''
        try {
            status = await vaultLock()
            secrets = []
            revealed = {}
        } catch (cause) {
            error = cause instanceof Error ? cause.message : String(cause)
        } finally {
            busy = false
        }
    }

    async function saveSecret (): Promise<void> {
        if (!newId.trim() || !newValue) {
            error = '机密 id 与值不能为空'
            return
        }
        busy = true
        error = ''
        try {
            await vaultPutSecret(newId.trim(), newDescription.trim(), newValue)
            newId = ''
            newDescription = ''
            newValue = ''
            await refresh()
        } catch (cause) {
            error = cause instanceof Error ? cause.message : String(cause)
        } finally {
            busy = false
        }
    }

    async function reveal (id: string): Promise<void> {
        if (revealed[id] !== undefined) {
            delete revealed[id]
            revealed = { ...revealed }
            return
        }
        busy = true
        error = ''
        try {
            const secret = await vaultGetSecret(id)
            revealed = { ...revealed, [id]: secret.value }
        } catch (cause) {
            error = cause instanceof Error ? cause.message : String(cause)
        } finally {
            busy = false
        }
    }

    async function removeSecret (id: string): Promise<void> {
        if (!window.confirm(`删除机密「${id}」？`)) return
        busy = true
        error = ''
        try {
            await vaultDeleteSecret(id)
            delete revealed[id]
            revealed = { ...revealed }
            await refresh()
        } catch (cause) {
            error = cause instanceof Error ? cause.message : String(cause)
        } finally {
            busy = false
        }
    }
</script>

<section aria-label="保险库">
    {#if error}
        <div class="settings-error" role="alert">{error}</div>
    {/if}

    {#if !status}
        <div class="settings-empty">正在读取保险库状态…</div>
    {:else if !status.enabled}
        <div class="settings-field">
            <div class="settings-field-title">保险库未启用</div>
            <p class="settings-hint">设置 passphrase 后启用加密存储，SSH 主机密码与密钥口令将加密保存。</p>
            <input class="settings-input" type="password" placeholder="passphrase" bind:value={passphrase} aria-label="保险库 passphrase" />
            <div class="settings-actions">
                <button class="market-install" type="button" disabled={busy} onclick={() => void enable()}>启用保险库</button>
            </div>
        </div>
    {:else if !status.unlocked}
        <div class="settings-field">
            <div class="settings-field-title">保险库已锁定（{status.secretCount} 条机密）</div>
            <input class="settings-input" type="password" placeholder="passphrase" bind:value={passphrase} aria-label="保险库 passphrase" />
            <div class="settings-actions">
                <button class="market-install" type="button" disabled={busy} onclick={() => void unlock()}>解锁</button>
                <button class="plugin-remove" type="button" disabled={busy} onclick={() => void disable()}>禁用并清除</button>
            </div>
        </div>
    {:else}
        <div class="vault-status-line">
            <strong>已解锁</strong>
            <span>{status.secretCount} 条机密</span>
            <button type="button" disabled={busy} onclick={() => void lock()}>锁定</button>
        </div>

        <div class="settings-field vault-add">
            <div class="settings-field-title">新增机密</div>
            <input class="settings-input" type="text" placeholder="id（如 host:web-01:password）" bind:value={newId} aria-label="机密 id" />
            <input class="settings-input" type="text" placeholder="描述（可选）" bind:value={newDescription} aria-label="机密描述" />
            <input class="settings-input" type="password" placeholder="值" bind:value={newValue} aria-label="机密值" />
            <div class="settings-actions">
                <button class="market-install" type="button" disabled={busy} onclick={() => void saveSecret()}>保存机密</button>
            </div>
        </div>

        <div class="settings-field">
            <div class="settings-field-title">机密列表</div>
            {#if secrets.length === 0}
                <div class="settings-empty">暂无机密。</div>
            {/if}
            {#each secrets as secret (secret.id)}
                <div class="vault-secret">
                    <div class="vault-secret-head">
                        <span class="vault-secret-id">{secret.id}</span>
                        <span class="vault-secret-desc">{secret.description}</span>
                        <button type="button" disabled={busy} onclick={() => void reveal(secret.id)}>{revealed[secret.id] !== undefined ? '隐藏' : '查看'}</button>
                        <button class="plugin-remove" type="button" disabled={busy} onclick={() => void removeSecret(secret.id)}>删除</button>
                    </div>
                    {#if revealed[secret.id] !== undefined}
                        <div class="vault-secret-value">{revealed[secret.id]}</div>
                    {/if}
                </div>
            {/each}
        </div>
    {/if}
</section>
