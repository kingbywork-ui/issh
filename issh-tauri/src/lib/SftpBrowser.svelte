<script lang="ts">
    import { onMount } from 'svelte'
    import {
        base64ToBytes,
        bytesToBase64,
        createLocalDir,
        deleteLocalFile,
        openSftpSession,
        pickDirectory,
        pickSavePath,
        sftpClose,
        sftpList,
        sftpChmod,
        sftpMkdir,
        sftpRead,
        sftpReadlink,
        sftpRemove,
        sftpRemoveDir,
        sftpRename,
        sftpStat,
        sftpWrite,
        writeLocalChunk,
        type SftpEntry,
    } from './runtime'

    let { sessionId, initialPath = '/', sudoMode = false, sudoPassword = '', onclose }: { sessionId: string, initialPath?: string, sudoMode?: boolean, sudoPassword?: string, onclose?: () => void } = $props()

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
    let uploadQueue: File[] = $state([])
    let editingPath = $state(false)
    let pathInput = $state('/')
    let disconnected = $state(false)
    let reconnecting = $state(false)
    let uploading = $state(false)
    let navGeneration = 0
    let previewGeneration = 0
    let transfer = $state<{ label: string, done: number, total: number | null, cancel: boolean } | null>(null)

    // isshd 要求先 sftp.open 建立 SFTP 子系统通道，后续 sftp.list 等操作才能找到会话。
    // sessionId 变化（切换 tab）时重新 open；卸载时关闭，避免通道泄漏。
    let openedSessionId = ''
    let initializedSessionId = ''
    let initializedInitialPath = ''

    const PREVIEW_LIMIT = 256 * 1024
    const UPLOAD_CHUNK = 512 * 1024
    const DOWNLOAD_CHUNK = 1024 * 1024

    // 取消当前传输（下载/上传循环每块检查）
    function cancelTransfer (): void {
        if (transfer) transfer.cancel = true
    }

    // SFTP 通道类错误：断连/超时/通道异常，可尝试重建 SFTP 子系统通道恢复
    function isChannelError (message: string): boolean {
        return /closed|SFTP session not found|channel error|timed out|transfer error/i.test(message)
    }

    // 并发失败去重：多个操作同时触发重连时共享同一次重建
    let reconnectPromise: Promise<void> | null = null

    async function reopenSftpChannel (): Promise<void> {
        if (!reconnectPromise) {
            reconnectPromise = (async () => {
                reconnecting = true
                try {
                    // 不先 close 旧通道：后端对已断通道 close 会阻塞至 30s 超时；
                    // sftp.open 用 HashMap::insert 覆盖同 sessionId 条目，旧通道随之废弃
                    await openSftpSession(sessionId, sudoPassword || undefined)
                    openedSessionId = sessionId
                } finally {
                    reconnectPromise = null
                    reconnecting = false
                }
            })()
        }
        return reconnectPromise
    }

    // 断连自动重连包装：通道类错误时重建 SFTP 通道并重试一次。
    // sudo 模式不自动重连（密码可能已失效/无法复用），交由上层提示。
    async function withReconnect<T> (operation: () => Promise<T>): Promise<T> {
        try {
            return await operation()
        } catch (cause) {
            const message = cause instanceof Error ? cause.message : String(cause)
            if (!isChannelError(message) || sudoMode) throw cause
            try {
                await reopenSftpChannel()
            } catch {
                throw cause
            }
            return operation()
        }
    }

    function formatSize (size: number): string {
        if (size >= 1024 * 1024 * 1024) return `${(size / 1024 / 1024 / 1024).toFixed(1)} GB`
        if (size >= 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`
        if (size >= 1024) return `${(size / 1024).toFixed(1)} KB`
        return `${size} B`
    }

    // 文件类型图标：对齐 issh 分支 getFileType/getIcon 的扩展名分类
    const FILE_TYPE_ICONS: Record<string, string> = {
        code: '</>',
        image: '🖼',
        pdf: '📄',
        archive: '🗜',
        word: '📝',
        video: '🎬',
        powerpoint: '📊',
        text: '📃',
        audio: '🎵',
        excel: '📈',
    }

    const EXTENSION_TYPES: Record<string, string> = {
        c: 'code', cc: 'code', cpp: 'code', conf: 'code', cs: 'code', css: 'code',
        go: 'code', h: 'code', hh: 'code', hpp: 'code', htm: 'code', html: 'code',
        java: 'code', js: 'code', json: 'code', jsx: 'code', lua: 'code', php: 'code',
        pl: 'code', py: 'code', rb: 'code', rs: 'code', sh: 'code', swift: 'code',
        ts: 'code', tsx: 'code', xml: 'code', yaml: 'code', yml: 'code',
        bmp: 'image', gif: 'image', heic: 'image', ico: 'image', jpeg: 'image',
        jpg: 'image', png: 'image', svg: 'image', tiff: 'image', webp: 'image',
        pdf: 'pdf',
        '7z': 'archive', bz2: 'archive', gz: 'archive', rar: 'archive', tar: 'archive',
        xz: 'archive', zip: 'archive',
        doc: 'word', docx: 'word', odt: 'word', rtf: 'word',
        avi: 'video', flv: 'video', m4v: 'video', mkv: 'video', mov: 'video',
        mp4: 'video', mpeg: 'video', wmv: 'video',
        ppt: 'powerpoint', pptx: 'powerpoint',
        log: 'text', md: 'text', text: 'text', txt: 'text',
        aac: 'audio', flac: 'audio', m4a: 'audio', mp3: 'audio', ogg: 'audio',
        opus: 'audio', wav: 'audio', wma: 'audio',
        csv: 'excel', ods: 'excel', xls: 'excel', xlsx: 'excel',
    }

    function entryIcon (entry: SftpEntry): string {
        if (entry.isDir) return '▤'
        if (entry.isSymlink) return '⇄'
        const extension = entry.name.includes('.') ? entry.name.split('.').pop()!.toLowerCase() : ''
        const type = EXTENSION_TYPES[extension]
        return type ? FILE_TYPE_ICONS[type] ?? '▪' : '▪'
    }

    let filterText = $state('')

    // 过滤（实时，大小写不敏感）+ 目录优先 + 名称自然排序
    const visibleEntries = $derived.by(() => {
        const keyword = filterText.trim().toLowerCase()
        const filtered = keyword ? entries.filter((entry) => entry.name.toLowerCase().includes(keyword)) : entries
        const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })
        return [...filtered].sort((a, b) => {
            if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
            return collator.compare(a.name, b.name)
        })
    })

    async function refresh (): Promise<void> {
        const generation = ++navGeneration
        loading = true
        error = ''
        try {
            const result = await withReconnect(() => sftpList(sessionId, cwd))
            if (generation !== navGeneration) return
            entries = result.entries
            disconnected = false
        } catch (cause) {
            if (generation !== navGeneration) return
            error = cause instanceof Error ? cause.message : String(cause)
            disconnected = true
        } finally {
            if (generation === navGeneration) loading = false
        }
    }

    function parentPath (path: string): string {
        if (path === '/' || path === '') return '/'
        const trimmed = path.replace(/\/+$/, '')
        const index = trimmed.lastIndexOf('/')
        return index <= 0 ? '/' : trimmed.slice(0, index)
    }

    function joinPath (dir: string, name: string): string {
        const clean = name.replace(/^\/+/, '')
        return dir === '/' ? `/${clean}` : `${dir}/${clean}`
    }

    function normalizePath (path: string): string {
        const parts: string[] = []
        for (const part of path.trim().split('/')) {
            if (!part || part === '.') continue
            if (part === '..') parts.pop()
            else parts.push(part)
        }
        return `/${parts.join('/')}` || '/'
    }

    function breadcrumbs (): Array<{ label: string, path: string }> {
        const result = [{ label: sudoMode ? 'SUDO SFTP' : 'SFTP', path: '/' }]
        let path = ''
        for (const part of cwd.split('/').filter(Boolean)) {
            path += `/${part}`
            result.push({ label: part, path })
        }
        return result
    }

    async function navigate (path: string): Promise<void> {
        cwd = normalizePath(path)
        pathInput = cwd
        await refresh()
    }

    async function openEntry (entry: SftpEntry): Promise<void> {
        if (entry.isDir) {
            await navigate(entry.path)
        } else {
            await preview(entry)
        }
    }

    async function preview (entry: SftpEntry): Promise<void> {
        const generation = ++previewGeneration
        previewLoading = true
        previewPath = entry.path
        previewText = ''
        error = ''
        try {
            const stat = await withReconnect(() => sftpStat(sessionId, entry.path))
            const limit = Math.min(stat.size, PREVIEW_LIMIT)
            const chunk = await withReconnect(() => sftpRead(sessionId, entry.path, 0, limit))
            if (generation !== previewGeneration) return
            const bytes = base64ToBytes(chunk.dataBase64)
            // 二进制检测：前 8KB 内含 NUL 字节则不按 UTF-8 文本渲染（避免乱码/卡顿）
            const probe = bytes.subarray(0, Math.min(bytes.length, 8192))
            if (generation !== previewGeneration) return
            if (probe.includes(0)) {
                previewText = `（二进制文件，${formatSize(stat.size)}，不支持文本预览）`
                return
            }
            previewText = new TextDecoder('utf-8', { fatal: false }).decode(bytes)
            if (stat.size > PREVIEW_LIMIT) {
                previewText += `\n\n…（文件 ${formatSize(stat.size)}，仅预览前 ${formatSize(PREVIEW_LIMIT)}）`
            }
        } catch (cause) {
            if (generation !== previewGeneration) return
            error = cause instanceof Error ? cause.message : String(cause)
        } finally {
            if (generation === previewGeneration) previewLoading = false
        }
    }

    async function createDirectory (): Promise<void> {
        const name = mkdirName.trim()
        if (!name) return
        error = ''
        try {
            await withReconnect(() => sftpMkdir(sessionId, joinPath(cwd, name)))
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

    // 权限修改：八进制模式输入（如 755），对齐 issh sftpPanel 的 chmod 操作
    async function changeMode (entry: SftpEntry): Promise<void> {
        const input = window.prompt(`修改权限（八进制，如 755）：${entry.name}`, '644')
        if (input === null) return
        const trimmed = input.trim()
        if (!/^[0-7]{3,4}$/.test(trimmed)) {
            error = `无效的权限模式：${trimmed}`
            return
        }
        error = ''
        try {
            await withReconnect(() => sftpChmod(sessionId, entry.path, parseInt(trimmed, 8)))
            notice = `已修改 ${entry.name} 权限为 ${trimmed}`
            await refresh()
        } catch (cause) {
            error = cause instanceof Error ? cause.message : String(cause)
        }
    }

    // 链接跟随：打开 symlink 时先 readlink，指向目录则进入，文件则提示目标
    async function followSymlink (entry: SftpEntry): Promise<void> {
        error = ''
        try {
            const { target } = await withReconnect(() => sftpReadlink(sessionId, entry.path))
            const resolved = target.startsWith('/') ? target : joinPath(cwd, target)
            const stat = await withReconnect(() => sftpStat(sessionId, resolved))
            if (stat.isDir) {
                await navigate(resolved)
            } else {
                notice = `链接 ${entry.name} → ${target}`
            }
        } catch (cause) {
            error = cause instanceof Error ? cause.message : String(cause)
        }
    }

    async function confirmRename (): Promise<void> {
        if (!renameTarget) return
        const name = renameValue.trim()
        if (!name || name === renameTarget.name) {
            renameTarget = null
            return
        }
        error = ''
        const target = renameTarget
        try {
            await withReconnect(() => sftpRename(sessionId, target.path, joinPath(cwd, name)))
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
                await withReconnect(() => sftpRemoveDir(sessionId, entry.path))
            } else {
                await withReconnect(() => sftpRemove(sessionId, entry.path))
            }
            notice = `已删除 ${entry.name}`
            await refresh()
        } catch (cause) {
            error = cause instanceof Error ? cause.message : String(cause)
        }
    }

    async function onUploadChange (event: Event): Promise<void> {
        const input = event.currentTarget as HTMLInputElement
        const files = Array.from(input.files ?? [])
        if (files.length === 0) return
        uploadQueue = files
        uploadFile = files[0]
    }

    async function upload (): Promise<void> {
        if (uploading) return
        // 多文件：逐个复用单文件原子上传；uploadPath 仅对单文件生效（作为重命名目标）
        const files = uploadQueue.length > 0 ? uploadQueue : uploadFile ? [uploadFile] : []
        if (files.length === 0) return
        const renameTarget = uploadPath.trim()
        for (const file of files) {
            const name = files.length === 1 && renameTarget ? renameTarget : file.name
            await uploadSingle(file, name)
            if (transfer?.cancel) break
        }
        uploadQueue = []
        uploadFile = null
        uploadPath = ''
    }

    async function uploadSingle (file: File, name: string): Promise<void> {
        if (!name) return
        // 原子上传：先写临时文件，全部成功后 rename 到目标名，避免半成品覆盖已有文件
        const target = joinPath(cwd, `.${name}.issh-upload-tmp`)
        const finalPath = joinPath(cwd, name)
        error = ''
        notice = `上传中 ${file.name} …`
        uploading = true
        transfer = { label: `上传 ${file.name}`, done: 0, total: file.size, cancel: false }
        try {
            let offset = 0
            while (offset < file.size) {
                if (transfer?.cancel) {
                    try { await withReconnect(() => sftpRemove(sessionId, target)) } catch { /* 尽力清理 */ }
                    notice = '上传已取消'
                    return
                }
                const slice = file.slice(offset, offset + UPLOAD_CHUNK)
                const bytes = new Uint8Array(await slice.arrayBuffer())
                await withReconnect(() => sftpWrite(sessionId, target, bytesToBase64(bytes), offset, offset === 0))
                offset += bytes.length
                if (transfer) transfer.done = offset
            }
            await withReconnect(() => sftpRename(sessionId, target, finalPath))
            notice = `已上传 ${file.name} → ${finalPath}`
            await refresh()
        } catch (cause) {
            error = cause instanceof Error ? cause.message : String(cause)
            notice = ''
            try { await withReconnect(() => sftpRemove(sessionId, target)) } catch { /* 尽力清理 */ }
        } finally {
            uploading = false
            transfer = null
        }
    }

    function formatBytes (size: number): string {
        return formatSize(size)
    }

    // 单文件下载：分块读到本地路径，写盘走 Tauri 壳（流式，不占内存）
    async function downloadFile (remotePath: string, size: number, localPath: string): Promise<void> {
        await writeLocalChunk(localPath, '', false)
        let offset = 0
        while (offset < size) {
            if (transfer?.cancel) throw new Error('已取消')
            const chunk = await withReconnect(() => sftpRead(sessionId, remotePath, offset, DOWNLOAD_CHUNK))
            if (chunk.length === 0) break
            await writeLocalChunk(localPath, chunk.dataBase64, true)
            offset += chunk.length
            if (transfer) transfer.done = offset
            if (chunk.eof) break
        }
    }

    // 递归下载目录：mkdir -p + 逐文件下载
    async function downloadDirectory (remoteDir: string, localDir: string): Promise<number> {
        await createLocalDir(localDir)
        let count = 0
        let listOffset = 0
        for (;;) {
            const page = await withReconnect(() => sftpList(sessionId, remoteDir, listOffset, 256))
            for (const entry of page.entries) {
                if (transfer?.cancel) throw new Error('已取消')
                const localPath = `${localDir}\\${entry.name}`
                if (entry.isDir && !entry.isSymlink) {
                    count += await downloadDirectory(entry.path, localPath)
                } else {
                    if (transfer) transfer.label = `下载 ${entry.path}`
                    await downloadFile(entry.path, entry.size, localPath)
                    count += 1
                }
            }
            if (!page.hasMore) break
            listOffset += page.entries.length
        }
        return count
    }

    async function downloadEntry (entry: SftpEntry): Promise<void> {
        if (transfer) return
        error = ''
        try {
            if (entry.isDir && !entry.isSymlink) {
                const dir = await pickDirectory(`选择保存 ${entry.name} 的位置`)
                if (!dir) return
                const localDir = `${dir}\\${entry.name}`
                transfer = { label: `下载 ${entry.name}/`, done: 0, total: null, cancel: false }
                const count = await downloadDirectory(entry.path, localDir)
                notice = `已下载目录 ${entry.name}（${count} 个文件）`
            } else {
                const stat = await withReconnect(() => sftpStat(sessionId, entry.path))
                const local = await pickSavePath('保存文件', entry.name)
                if (!local) return
                transfer = { label: `下载 ${entry.name}`, done: 0, total: stat.size, cancel: false }
                await downloadFile(entry.path, stat.size, local)
                notice = `已下载 ${entry.name} → ${local}`
            }
            await refresh()
        } catch (cause) {
            if (transfer?.cancel) {
                notice = '下载已取消'
            } else {
                error = cause instanceof Error ? cause.message : String(cause)
            }
        } finally {
            transfer = null
        }
    }

    async function ensureOpen (): Promise<void> {
        if (openedSessionId === sessionId) return
        if (openedSessionId) {
            try {
                await sftpClose(openedSessionId)
            } catch {
                // 会话可能已关闭
            }
        }
        await openSftpSession(sessionId, sudoPassword || undefined)
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

    // sessionId 变化（切换 SSH tab）时重新打开 SFTP 通道并回到 initialPath
    $effect(() => {
        const currentSessionId = sessionId
        const currentInitialPath = initialPath
        if (initializedSessionId === currentSessionId && initializedInitialPath === currentInitialPath) return
        initializedSessionId = currentSessionId
        initializedInitialPath = currentInitialPath
        void (async () => {
            loading = true
            error = ''
            try {
                await ensureOpen()
                cwd = normalizePath(currentInitialPath)
                pathInput = cwd
                await refresh()
            } catch (cause) {
                error = cause instanceof Error ? cause.message : String(cause)
            } finally {
                loading = false
            }
        })()
    })
</script>

<section class="sftp-browser" aria-label={sudoMode ? 'SUDO SFTP 文件浏览器' : 'SFTP 文件浏览器'}>
    <header class="sftp-toolbar">
        <button class="sftp-nav" type="button" onclick={() => void navigate(parentPath(cwd))} disabled={cwd === '/' || loading} title="上级目录">
            ↑
        </button>
        <nav class="sftp-crumbs" aria-label="当前路径">
            {#each breadcrumbs() as crumb, index (crumb.path)}
                {#if index > 0}<span class="crumb-separator">/</span>{/if}
                <button type="button" class="sftp-crumb" ondblclick={() => { editingPath = true; pathInput = cwd }} onclick={() => void navigate(crumb.path)} title={crumb.path}>
                    {crumb.label}
                </button>
            {/each}
        </nav>
        {#if editingPath}
            <input class="sftp-path-input" bind:value={pathInput} onkeydown={(event) => { if (event.key === 'Enter') { editingPath = false; void navigate(pathInput) } if (event.key === 'Escape') editingPath = false }} onblur={() => { editingPath = false }} aria-label="SFTP 路径" />
        {/if}
        <button class="sftp-nav" type="button" onclick={() => void refresh()} disabled={loading} title="刷新">
            {reconnecting ? '⟳' : loading ? '…' : '↻'}
        </button>
        {#if onclose}
            <button class="sftp-nav close" type="button" onclick={onclose} title="关闭 SFTP">×</button>
        {/if}
    </header>

    <div class="sftp-actions">
        <input class="sftp-input filter" type="search" placeholder="过滤当前目录…" bind:value={filterText} aria-label="过滤文件" />
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
        <input class="sftp-file" type="file" multiple onchange={(event) => void onUploadChange(event)} aria-label="选择本地文件" />
        <button type="button" onclick={() => void upload()} disabled={!uploadFile || loading || uploading}>上传</button>
    </div>

    {#if error}
        <p class="sftp-error" role="alert">{error}</p>
    {/if}
    {#if notice}
        <p class="sftp-notice">{notice}</p>
    {/if}
    {#if transfer}
        <div class="sftp-transfer" role="status">
            <div class="sftp-transfer-head">
                <span>{transfer.label}</span>
                <span>{formatBytes(transfer.done)}{transfer.total !== null ? ` / ${formatBytes(transfer.total)}` : ''}</span>
                <button type="button" onclick={cancelTransfer}>取消</button>
            </div>
            {#if transfer.total !== null && transfer.total > 0}
                <progress class="sftp-transfer-bar" value={transfer.done} max={transfer.total}></progress>
            {:else}
                <progress class="sftp-transfer-bar"></progress>
            {/if}
        </div>
    {/if}
    {#if disconnected}
        <div class="sftp-disconnected" role="alert">
            <strong>{sudoMode ? 'SUDO SFTP 会话已断开' : 'SFTP 会话已断开'}</strong>
            <span>{sudoMode ? 'sudo 模式不支持自动重连，请关闭面板后重新打开并确认 sudo 密码。' : '自动重连失败，请检查网络后点击刷新重试。'}</span>
        </div>
    {/if}

    <div class="sftp-list" role="list">
        {#if cwd !== '/'}
            <button class="sftp-parent-row" type="button" onclick={() => void navigate(parentPath(cwd))}>↖ <span>..</span></button>
        {/if}
        {#each visibleEntries as entry (entry.path)}
            <div class="sftp-row" role="listitem">
                <button class="sftp-entry" type="button" onclick={() => void (entry.isSymlink ? followSymlink(entry) : openEntry(entry))} title={entry.path}>
                    <span class="sftp-icon" class:dir={entry.isDir} class:link={entry.isSymlink}>
                        {entryIcon(entry)}
                    </span>
                    <span class="sftp-name">{entry.name}</span>
                </button>
                <span class="sftp-ops">
                    <button type="button" onclick={() => void downloadEntry(entry)} disabled={transfer !== null} title="下载">↓</button>
                    <button type="button" onclick={() => void changeMode(entry)} title="修改权限">权</button>
                    <button type="button" onclick={() => beginRename(entry)} title="重命名">改</button>
                    <button type="button" onclick={() => void removeEntry(entry)} title="删除">删</button>
                </span>
            </div>
        {:else}
            <p class="sftp-empty">{loading ? '正在读取目录…' : filterText.trim() ? '无匹配文件' : '目录为空'}</p>
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
