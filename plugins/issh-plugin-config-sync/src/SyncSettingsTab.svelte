<script lang="ts">
    import { onMount } from 'svelte'
    import syncCss from './sync.css?inline'
    import { applyPayload, buildPayload, hostProfiles, networkFetch, pluginStorage, previewPayload, validatePayload, type SyncDiffPreview, type SyncPayload } from './syncRpc'

    let profileCount = $state(0)
    let groupCount = $state(0)
    let encrypted = $state(false)
    let busy = $state(false)
    let message = $state('')
    let importText = $state('')
    let gistToken = $state('')
    let gistId = $state('')

    onMount(() => {
        gistToken = pluginStorage().get('gistToken') ?? ''
        gistId = pluginStorage().get('gistId') ?? ''
        if (!document.getElementById('issh-plugin-config-sync-style')) {
            const style = document.createElement('style')
            style.id = 'issh-plugin-config-sync-style'
            style.textContent = syncCss
            document.head.appendChild(style)
        }
        void refresh()
    })

    async function refresh (): Promise<void> {
        busy = true
        message = ''
        try {
            const result = await hostProfiles()
            profileCount = result.profiles.length
            groupCount = result.groups.length
            encrypted = result.encrypted
        } catch (cause) {
            message = cause instanceof Error ? cause.message : String(cause)
        } finally {
            busy = false
        }
    }

    async function exportConfig (): Promise<void> {
        busy = true
        message = ''
        try {
            const result = await hostProfiles()
            const payload = buildPayload(result)
            const json = JSON.stringify(payload, null, 2)
            const blob = new Blob([json], { type: 'application/json' })
            const url = URL.createObjectURL(blob)
            const link = document.createElement('a')
            link.href = url
            link.download = `issh-host-profiles-${new Date().toISOString().slice(0, 10)}.json`
            link.click()
            URL.revokeObjectURL(url)
            message = `已导出 ${result.profiles.length} 个主机配置`
        } catch (cause) {
            message = cause instanceof Error ? cause.message : String(cause)
        } finally {
            busy = false
        }
    }

    let pendingPayload = $state<SyncPayload | null>(null)
    let pendingDiff = $state<SyncDiffPreview | null>(null)

    async function importConfig (): Promise<void> {
        busy = true
        message = ''
        try {
            const payload = validatePayload(importText)
            // A11 差异摘要：先预览（新建/更新明细），确认后再应用
            pendingPayload = payload
            pendingDiff = await previewPayload(payload)
        } catch (cause) {
            message = cause instanceof Error ? cause.message : String(cause)
        } finally {
            busy = false
        }
    }

    async function confirmImport (): Promise<void> {
        if (!pendingPayload) return
        busy = true
        try {
            const stats = await applyPayload(pendingPayload)
            message = `导入完成：新建 ${stats.created}，更新 ${stats.updated}`
            importText = ''
            await refresh()
        } catch (cause) {
            message = cause instanceof Error ? cause.message : String(cause)
        } finally {
            busy = false
            pendingPayload = null
            pendingDiff = null
        }
    }

    function saveGistSettings (): void {
        pluginStorage().set('gistToken', gistToken)
        pluginStorage().set('gistId', gistId)
        message = 'Gist 设置已保存'
    }

    async function syncToGist (): Promise<void> {
        busy = true
        message = ''
        try {
            if (!gistToken) throw new Error('需要 GitHub Token')
            const result = await hostProfiles()
            const json = JSON.stringify(buildPayload(result))
            const response = await networkFetch('https://api.github.com/gists' + (gistId ? `/${gistId}` : ''), {
                method: gistId ? 'PATCH' : 'POST',
                headers: {
                    Authorization: `Bearer ${gistToken}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    description: 'issh host profiles sync',
                    files: { 'issh-host-profiles.json': { content: json } },
                }),
            })
            if (!response.ok) throw new Error(`Gist 同步失败：${response.status}`)
            const data = JSON.parse(response.body) as { id: string }
            gistId = data.id
            pluginStorage().set('gistId', gistId)
            message = `已同步到 Gist ${gistId}`
        } catch (cause) {
            message = cause instanceof Error ? cause.message : String(cause)
        } finally {
            busy = false
        }
    }

    async function pullFromGist (): Promise<void> {
        busy = true
        message = ''
        try {
            if (!gistToken || !gistId) throw new Error('需要 GitHub Token 和 Gist ID')
            const response = await networkFetch(`https://api.github.com/gists/${gistId}`, {
                headers: { Authorization: `Bearer ${gistToken}` },
            })
            if (!response.ok) throw new Error(`Gist 拉取失败：${response.status}`)
            const data = JSON.parse(response.body) as { files?: Record<string, { content?: string }> }
            const content = data.files?.['issh-host-profiles.json']?.content
            if (!content) throw new Error('Gist 中未找到 issh-host-profiles.json')
            const payload = validatePayload(content)
            const stats = await applyPayload(payload)
            message = `拉取完成：新建 ${stats.created}，更新 ${stats.updated}`
            await refresh()
        } catch (cause) {
            message = cause instanceof Error ? cause.message : String(cause)
        } finally {
            busy = false
        }
    }
</script>

<div class="sync-settings">
    {#if message}
        <div class="settings-message" role="status">{message}</div>
    {/if}

    <div class="sync-section">
        <div class="settings-field-title">当前配置</div>
        <div class="sync-stats">
            <span>{profileCount} 个主机</span>
            <span>{groupCount} 个分组</span>
            {#if encrypted}
                <span class="sync-encrypted">已加密（导出为明文 JSON，注意保管）</span>
            {/if}
        </div>
        <div class="sync-toolbar">
            <button class="market-install" type="button" disabled={busy} onclick={() => void exportConfig()}>导出 JSON</button>
            <button class="market-install" type="button" disabled={busy} onclick={() => void refresh()}>刷新</button>
        </div>
    </div>

    <div class="sync-section">
        <div class="settings-field-title">导入</div>
        <textarea bind:value={importText} placeholder="粘贴导出的 JSON 配置" rows="5" aria-label="导入配置 JSON"></textarea>
        <div class="sync-toolbar">
            <button class="market-install" type="button" disabled={busy || !importText.trim()} onclick={() => void importConfig()}>导入配置</button>
        </div>
    </div>

    {#if pendingDiff && pendingPayload}
        <div class="sync-modal-mask" role="presentation" tabindex="-1" onclick={() => { pendingPayload = null; pendingDiff = null }} onkeydown={(event) => { if (event.key === 'Escape') { pendingPayload = null; pendingDiff = null } }}>
            <div class="sync-modal" role="dialog" aria-modal="true" aria-labelledby="sync-import-title" tabindex="-1" onclick={(event) => event.stopPropagation()} onkeydown={(event) => event.stopPropagation()}>
                <h3 id="sync-import-title">导入预览</h3>
                <p class="sync-modal-hint">确认后将应用到主机配置，请核对差异：</p>
                <div class="sync-diff-list">
                    {#if pendingDiff.profiles.create.length}
                        <div class="sync-diff-group"><strong>新建主机（{pendingDiff.profiles.create.length}）</strong>{#each pendingDiff.profiles.create.slice(0, 20) as item}<div>{item}</div>{/each}{#if pendingDiff.profiles.create.length > 20}<div>… 等 {pendingDiff.profiles.create.length - 20} 项</div>{/if}</div>
                    {/if}
                    {#if pendingDiff.profiles.update.length}
                        <div class="sync-diff-group"><strong>更新主机（{pendingDiff.profiles.update.length}）</strong>{#each pendingDiff.profiles.update.slice(0, 20) as item}<div>{item}</div>{/each}{#if pendingDiff.profiles.update.length > 20}<div>… 等 {pendingDiff.profiles.update.length - 20} 项</div>{/if}</div>
                    {/if}
                    {#if pendingDiff.groups.create.length}
                        <div class="sync-diff-group"><strong>新建分组（{pendingDiff.groups.create.length}）</strong>{#each pendingDiff.groups.create as item}<div>{item}</div>{/each}</div>
                    {/if}
                    {#if pendingDiff.groups.update.length}
                        <div class="sync-diff-group"><strong>更新分组（{pendingDiff.groups.update.length}）</strong>{#each pendingDiff.groups.update as item}<div>{item}</div>{/each}</div>
                    {/if}
                    {#if !pendingDiff.profiles.create.length && !pendingDiff.profiles.update.length && !pendingDiff.groups.create.length && !pendingDiff.groups.update.length}
                        <p class="sync-diff-empty">没有检测到差异，导入不会产生变化。</p>
                    {/if}
                </div>
                <div class="sync-modal-actions">
                    <button class="secondary" type="button" onclick={() => { pendingPayload = null; pendingDiff = null }}>取消</button>
                    <button class="market-install" type="button" disabled={busy} onclick={() => void confirmImport()}>确认导入</button>
                </div>
            </div>
        </div>
    {/if}

    <div class="sync-section">
        <div class="settings-field-title">GitHub Gist 同步</div>
        <label class="settings-field">
            <span>GitHub Token（需 gist 权限）</span>
            <input type="password" bind:value={gistToken} onchange={saveGistSettings} autocomplete="off" />
        </label>
        <label class="settings-field">
            <span>Gist ID（首次同步后自动填入）</span>
            <input type="text" bind:value={gistId} onchange={saveGistSettings} />
        </label>
        <div class="sync-toolbar">
            <button class="market-install" type="button" disabled={busy || !gistToken} onclick={() => void syncToGist()}>推送到 Gist</button>
            <button class="market-install" type="button" disabled={busy || !gistToken || !gistId} onclick={() => void pullFromGist()}>从 Gist 拉取</button>
        </div>
    </div>
</div>
