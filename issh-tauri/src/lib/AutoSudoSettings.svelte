<script lang="ts">
    import { onMount } from 'svelte'
    import {
        deleteSavedSudoUser,
        isAutoSudoEnabled,
        listSavedSudoUsers,
        setAutoSudoEnabled,
    } from './autoSudo'

    let enabled = $state(isAutoSudoEnabled())
    let users = $state<Array<{ user: string }>>([])

    function refresh (): void {
        users = listSavedSudoUsers()
    }

    function toggle (value: boolean): void {
        enabled = value
        setAutoSudoEnabled(value)
    }

    function remove (user: string): void {
        if (!window.confirm(`删除用户 ${user} 的已保存 sudo 密码？`)) return
        deleteSavedSudoUser(user)
        refresh()
    }

    onMount(() => {
        refresh()
    })
</script>

<section aria-label="sudo 密码自动填充">
    <div class="settings-field">
        <div class="settings-field-title">sudo 密码自动填充</div>
        <p class="settings-hint">终端出现 sudo 密码提示（多语言）时，按 Ctrl+Enter 自动填充已保存的密码。</p>
    </div>
    <label class="settings-toggle">
        <input type="checkbox" checked={enabled} onchange={(event) => { toggle((event.currentTarget as HTMLInputElement).checked) }} />
        <span>启用自动填充</span>
    </label>
    <div class="settings-field">
        <div class="settings-field-title">已保存的密码</div>
        <p class="settings-hint">已保存的 sudo 密码按用户名存储在本地（localStorage）。删除后对应终端不再自动填充。</p>
        {#if users.length === 0}
            <div class="settings-empty">暂无已保存的密码</div>
        {:else}
            <ul class="sudo-user-list">
                {#each users as entry (entry.user)}
                    <li>
                        <span>{entry.user}</span>
                        <button class="plugin-remove" type="button" onclick={() => remove(entry.user)}>删除</button>
                    </li>
                {/each}
            </ul>
        {/if}
    </div>
</section>
