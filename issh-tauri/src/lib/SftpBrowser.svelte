<script lang="ts">
    import { onMount } from 'svelte'
    import {
        base64ToBytes,
        bytesToBase64,
        openSftpSession,
        sftpClose,
        sftpList,
        sftpMkdir,
        sftpRead,
        sftpRemove,
        sftpRemoveDir,
        sftpRename,
        sftpStat,
        sftpWrite,
        type SftpEntry,
    } from './runtime'

    let { sessionId, onclose }: { sessionId: string, onclose?: () => void } = $props()

    let cwd = $state('/')
    let entries = $state<SftpEntry[]>([])
    let loading = $state(false)
    let error = $state('')
    let notice = $state('')
    let previewPath = $state('')
    let previewText = $state('')
    let previewLoading = $state(false)
    let mkdirName = $state('')
    let renameTarget = $state<SftpEntry | null>(null)
    let renameValue = $state('')
    let uploadPath = $state('')
    let uploadFile: File | null = $state(null)

    const PREVIEW_LIMIT = 256 * 1024
    const UPLOAD_CHUNK = 24 * 1024

    function formatSize (size: number): string {
        if (size >= 1024 * 1024 * 1024) return `${(size / 1024 / 1024 / 1024).toFixed(1)} GB`
        if (size >= 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`
        if (size >= 1024) return `${(size / 1024).toFixed(1)} KB`
        return `${size} B`
    }

    function formatTime (unixSecs: number | null): string {
        if (!unixSecs) return '—'
        return new Date(unixSecs * 1000).toLocaleString()
    }

    async function refresh (): Promise<void> {
        loading = true
        error = ''
        try {
            const result = await sftpList(sessionId, cwd)
            entries = result.entries
        } catch (cause) {
            error = cause instanceof Error ? cause.message : String(cause)
        } finally {
            loading = false
        }
    }

    function parentPath (path: string): string {
        if (path === '/' || path === '') return '/'
        const trimmed = path.replace(/\/+$/, '')
        const index = trimmed.lastIndexOf('/')
        return index <= 0 ? '/' : trimmed.slice(0, index)
    }

    function joinPath (dir: string, name: string): string {
        return dir === '/' ? `/${name}` : `${dir}/${name}`
    }

    async function openEntry (entry: SftpEntry): Promise<void> {
        if (entry.isDir) {
            cwd = entry.path
            await refresh()
        } else {
            await preview(entry)
        }
    }

    async function preview (entry: SftpEntry): Promise<void> {
        previewLoading = true
        previewPath = entry.path
        previewText = ''
        error = ''
        try {
            const stat = await sftpStat(sessionId, entry.path)
            const limit = Math.min(stat.size, PREVIEW_LIMIT)
            const chunk = await sftpRead(sessionId, entry.path, 0, limit)
            const bytes = base64ToBytes(chunk.dataBase64)
            previewText = new TextDecoder('utf-8', { fatal: false }).decode(bytes)
            if (stat.size > PREVIEW_LIMIT) {
                previewText += `\n\n…（文件 ${formatSize(stat.size)}，仅预览前 ${formatSize(PREVIEW_LIMIT)}）`
            }
        } catch (cause) {
            error = cause instanceof Error ? cause.message : String(cause)
        } finally {
            previewLoading = false
        }
    }

    async function createDirectory (): Promise<void> {
        const name = mkdirName.trim()
        if (!name) return
        error = ''
        try {
            await sftpMkdir(sessionId, joinPath(cwd, name))
            mkdirName = ''
            notice = `已创建目录 ${name}`
            await refresh()
        } catch (cause) {
            error = cause instanceof Error ? cause.message : String(cause)
        }
    }

    function beginRename (entry: SftpEntry): void {
        renameTarget = entry
        renameValue = entry.name
    }

    async function confirmRename (): Promise<void> {
        if (!renameTarget) return
        const name = renameValue.trim()
        if (!name || name === renameTarget.name) {
            renameTarget = null
            return
        }
        error = ''
        try {
            await sftpRename(sessionId, renameTarget.path, joinPath(cwd, name))
            renameTarget = null
            notice = `已重命名为 ${name}`
            await refresh()
        } catch (cause) {
            error = cause instanceof Error ? cause.message : String(cause)
        }
    }

    async function removeEntry (entry: SftpEntry): Promise<void> {
        if (!window.confirm(`确定删除 ${entry.isDir ? '目录' : '文件'} ${entry.name}？`)) return
        error = ''
        try {
            if (entry.isDir) {
                await sftpRemoveDir(sessionId, entry.path)
            } else {
                await sftpRemove(sessionId, entry.path)
            }
            notice = `已删除 ${entry.name}`
            await refresh()
        } catch (cause) {
            error = cause instanceof Error ? cause.message : String(cause)
        }
    }

    async function onUploadChange (event: Event): Promise<void> {
        const input = event.currentTarget as HTMLInputElement
        uploadFile = input.files?.[0] ?? null
    }

    async function upload (): Promise<void> {
        if (!uploadFile) return
        const name = uploadPath.trim() || uploadFile.name
        if (!name) return
        const target = joinPath(cwd, name)
        error = ''
        notice = `上传中 ${uploadFile.name} …`
        try {
            let offset = 0
            while (offset < uploadFile.size) {
                const slice = uploadFile.slice(offset, offset + UPLOAD_CHUNK)
                const bytes = new Uint8Array(await slice.arrayBuffer())
                await sftpWrite(sessionId, target, bytesToBase64(bytes), offset, offset === 0)
                offset += bytes.length
            }
            notice = `已上传 ${uploadFile.name} → ${target}`
            uploadFile = null
            uploadPath = ''
            await refresh()
        } catch (cause) {
            error = cause instanceof Error ? cause.message : String(cause)
            notice = ''
        }
    }

    // isshd 要求先 sftp.open 建立 SFTP 子系统通道，后续 sftp.list 等操作才能找到会话。
    // sessionId 变化（切换 tab）时重新 open；卸载时关闭，避免通道泄漏。
    let openedSessionId = ''

    async function ensureOpen (): Promise<void> {
        if (openedSessionId === sessionId) return
        if (openedSessionId) {
            try {
                await sftpClose(openedSessionId)
            } catch {
                // 会话可能已关闭
            }
        }
        await openSftpSession(sessionId)
        openedSessionId = sessionId
    }

    onMount(() => {
        return () => {
            if (openedSessionId) {
                void sftpClose(openedSessionId).catch(() => {})
                openedSessionId = ''
            }
        }
    })

    // sessionId 变化（切换 SSH tab）时重新打开 SFTP 通道并回到根目录
    $effect(() => {
        void sessionId
        void (async () => {
            loading = true
            error = ''
            try {
                await ensureOpen()
                cwd = '/'
                await refresh()
            } catch (cause) {
                error = cause instanceof Error ? cause.message : String(cause)
            } finally {
                loading = false
            }
        })()
    })
</script>

<section class="sftp-browser" aria-label="SFTP 文件浏览器">
    <header class="sftp-toolbar">
        <button class="sftp-nav" type="button" onclick={() => { cwd = parentPath(cwd); void refresh() }} disabled={cwd === '/' || loading} title="上级目录">
            ↑
        </button>
        <span class="sftp-crumb" title={cwd}>{cwd}</span>
        <button class="sftp-nav" type="button" onclick={() => void refresh()} disabled={loading} title="刷新">
            {loading ? '…' : '↻'}
        </button>
        {#if onclose}
            <button class="sftp-nav close" type="button" onclick={onclose} title="关闭 SFTP">×</button>
        {/if}
    </header>

    <div class="sftp-actions">
        <input class="sftp-input" type="text" placeholder="新目录名" bind:value={mkdirName} aria-label="新目录名" />
        <button type="button" onclick={() => void createDirectory()} disabled={!mkdirName.trim() || loading}>新建目录</button>
        {#if renameTarget}
            <input class="sftp-input rename" type="text" bind:value={renameValue} aria-label="重命名" />
            <button type="button" onclick={() => void confirmRename()}>确认重命名</button>
            <button type="button" onclick={() => { renameTarget = null }}>取消</button>
        {/if}
        <input
            class="sftp-input"
            type="text"
            placeholder="上传目标文件名（默认本地文件名）"
            bind:value={uploadPath}
            aria-label="上传目标文件名"
        />
        <input class="sftp-file" type="file" onchange={(event) => void onUploadChange(event)} aria-label="选择本地文件" />
        <button type="button" onclick={() => void upload()} disabled={!uploadFile || loading}>上传</button>
    </div>

    {#if error}
        <p class="sftp-error" role="alert">{error}</p>
    {/if}
    {#if notice}
        <p class="sftp-notice">{notice}</p>
    {/if}

    <div class="sftp-list" role="list">
        {#each entries as entry (entry.path)}
            <div class="sftp-row" role="listitem">
                <button class="sftp-entry" type="button" onclick={() => void openEntry(entry)} title={entry.path}>
                    <span class="sftp-icon" class:dir={entry.isDir} class:link={entry.isSymlink}>
                        {entry.isDir ? '▤' : entry.isSymlink ? '⇄' : '▪'}
                    </span>
                    <span class="sftp-name">{entry.name}</span>
                    <span class="sftp-size">{entry.isDir ? '—' : formatSize(entry.size)}</span>
                    <span class="sftp-time">{formatTime(entry.modifiedUnixSecs)}</span>
                </button>
                <span class="sftp-ops">
                    <button type="button" onclick={() => beginRename(entry)} title="重命名">改</button>
                    <button type="button" onclick={() => void removeEntry(entry)} title="删除">删</button>
                </span>
            </div>
        {:else}
            <p class="sftp-empty">{loading ? '正在读取目录…' : '目录为空'}</p>
        {/each}
    </div>

    {#if previewPath}
        <section class="sftp-preview" aria-label="文件预览">
            <header>
                <strong>{previewPath}</strong>
                <button type="button" onclick={() => { previewPath = ''; previewText = '' }}>关闭</button>
            </header>
            <pre class="sftp-preview-body">{previewLoading ? '读取中…' : previewText}</pre>
        </section>
    {/if}
</section>
