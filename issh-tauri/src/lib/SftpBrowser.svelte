<script lang="ts">
    import { onMount } from 'svelte'
    import ContextMenu, { type ContextMenuItem } from './ContextMenu.svelte'
    import { removeSftpTree } from './sftpDelete'
    import { showAlert, askPrompt } from './dialogs'
    import {
        base64ToBytes,
        bytesToBase64,
        createLocalDir,
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

    let { sessionId, initialPath = '/', sudoMode = false, sudoPassword = '', onpathchange }: { sessionId: string, initialPath?: string, sudoMode?: boolean, sudoPassword?: string, onpathchange?: (path: string) => void } = $props()

    let cwd = $state('/')
    let entries = $state<SftpEntry[]>([])
    let loading = $state(false)
    let error = $state('')
    let notice = $state('')
    let previewPath = $state('')
    let previewText = $state('')
    let previewLoading = $state(false)
    let deleteTarget = $state<SftpEntry | null>(null)
    let deleteDialog: HTMLDialogElement | null = $state(null)
    let deleteTargetSessionId = ''
    let deleting = $state(false)
    let fileInput: HTMLInputElement | null = $state(null)
    let folderInput: HTMLInputElement | null = $state(null)
    let browserElement: HTMLElement | null = $state(null)
    let dragOver = $state(false)
    let dragTargetPath = $state<string | null>(null)
    let contextMenu = $state<{ x: number, y: number, items: ContextMenuItem[] } | null>(null)
    let editingPath = $state(false)
    let pathInput = $state('/')
    let disconnected = $state(false)
    let reconnecting = $state(false)
    let uploading = $state(false)
    let uploadProgress = $state<{
        phase: 'preparing' | 'running' | 'completed' | 'cancelled' | 'failed'
        doneBytes: number
        totalBytes: number
        doneFiles: number
        totalFiles: number
        doneDirs: number
        totalDirs: number
        currentFile: string
        destination: string
        cancel: boolean
    } | null>(null)
    let uploadDismissSeconds = $state<number | null>(null)
    let uploadDismissTimer: ReturnType<typeof setInterval> | null = null
    let uploadProgressHovered = false
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

    type UploadItem = { file: File, path: string }
    type UploadPlan = { files: UploadItem[], directories: string[] }

    function cancelUploadDismiss (): void {
        if (uploadDismissTimer !== null) clearInterval(uploadDismissTimer)
        uploadDismissTimer = null
        uploadDismissSeconds = null
    }

    function clearUploadProgress (): void {
        cancelUploadDismiss()
        uploadProgress = null
        uploadProgressHovered = false
    }

    function preserveUploadProgress (): void {
        uploadProgressHovered = true
        cancelUploadDismiss()
    }

    function scheduleUploadDismiss (): void {
        cancelUploadDismiss()
        if (uploadProgress?.phase !== 'completed' || uploadProgressHovered) return
        const completedProgress = uploadProgress
        const deadline = Date.now() + 5000
        uploadDismissSeconds = 5
        uploadDismissTimer = setInterval(() => {
            if (uploadProgress !== completedProgress) {
                cancelUploadDismiss()
                return
            }
            const remaining = Math.max(0, Math.ceil((deadline - Date.now()) / 1000))
            if (remaining === 0) clearUploadProgress()
            else uploadDismissSeconds = remaining
        }, 1000)
    }

    // 取消当前传输（下载/上传循环每块检查）
    function cancelTransfer (): void {
        if (uploadProgress && (uploadProgress.phase === 'preparing' || uploadProgress.phase === 'running')) uploadProgress.cancel = true
        if (transfer) transfer.cancel = true
    }

    function isPermissionError (message: string): boolean {
        return /permission[\s_-]*denied|access[\s_-]*denied|权限不足|权限拒绝|拒绝访问|os error (?:5|13)\b/i.test(message)
    }

    function reportOperationError (action: string, path: string, cause: unknown): void {
        const reason = cause instanceof Error ? cause.message : String(cause)
        error = `${action}失败：${path}\n${isPermissionError(reason) ? '权限不足，请检查当前账户的文件或目录权限。\n' : ''}${reason}`
        void showAlert(error, `${action}失败`)
    }

    // SFTP status errors (权限、文件不存在等) 不代表通道断开，不重建或重复执行。
    function isChannelError (message: string): boolean {
        if (isPermissionError(message)) return false
        return /SFTP session not found|session (?:is )?closed|sender dropped|channel (?:error|closed)|connection (?:closed|reset|lost)|no connection|broken pipe|unexpected eof|timed out|\btimeout\b|(?:^|:\s*)closed\b/i.test(message)
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
    async function withReconnect<T> (operation: () => Promise<T>, targetSessionId = sessionId): Promise<T> {
        try {
            return await operation()
        } catch (cause) {
            const message = cause instanceof Error ? cause.message : String(cause)
            if (!isChannelError(message) || sudoMode || targetSessionId !== sessionId) throw cause
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

    // 目录优先 + 名称自然排序
    const visibleEntries = $derived.by(() => {
        const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })
        return [...entries].sort((a, b) => {
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
            disconnected = isChannelError(error)
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
        onpathchange?.(cwd)
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
        const targetSessionId = sessionId
        const targetDir = cwd
        const input = await askPrompt('新目录名', '', '新建目录')
        if (input === null || targetSessionId !== sessionId) return
        const name = input.trim()
        if (!name) return
        error = ''
        try {
            await withReconnect(() => sftpMkdir(targetSessionId, joinPath(targetDir, name)), targetSessionId)
            notice = `已创建目录 ${name}`
            await refresh()
        } catch (cause) {
            reportOperationError('新建目录', joinPath(targetDir, name), cause)
        }
    }

    async function beginRename (entry: SftpEntry): Promise<void> {
        const targetSessionId = sessionId
        const input = await askPrompt(`重命名 ${entry.name}`, entry.name, '重命名')
        if (input === null || targetSessionId !== sessionId) return
        const name = input.trim()
        if (!name || name === entry.name) return
        error = ''
        try {
            await withReconnect(() => sftpRename(targetSessionId, entry.path, joinPath(parentPath(entry.path), name)), targetSessionId)
            notice = `已重命名为 ${name}`
            await refresh()
        } catch (cause) {
            reportOperationError('重命名', entry.path, cause)
        }
    }

    // 权限修改：八进制模式输入（如 755），对齐 issh sftpPanel 的 chmod 操作
    async function changeMode (entry: SftpEntry): Promise<void> {
        const targetSessionId = sessionId
        const input = await askPrompt(`修改权限（八进制，如 755）：${entry.name}`, '644', '修改权限')
        if (input === null || targetSessionId !== sessionId) return
        const trimmed = input.trim()
        if (!/^[0-7]{3,4}$/.test(trimmed)) {
            error = `无效的权限模式：${trimmed}`
            return
        }
        error = ''
        try {
            await withReconnect(() => sftpChmod(targetSessionId, entry.path, parseInt(trimmed, 8)), targetSessionId)
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

    function removeEntry (entry: SftpEntry): void {
        if (deleting) return
        deleteTarget = entry
        deleteTargetSessionId = sessionId
        deleteDialog?.showModal()
    }

    async function confirmRemoveEntry (): Promise<void> {
        const entry = deleteTarget
        const targetSessionId = deleteTargetSessionId
        if (!entry || deleting) return
        if (targetSessionId !== sessionId) {
            deleteDialog?.close()
            return
        }
        deleting = true
        error = ''
        let changedRemote = false
        try {
            await removeSftpTree(entry, {
                list: (path, offset) => withReconnect(() => sftpList(targetSessionId, path, offset, 256), targetSessionId),
                removeFile: async (path) => {
                    await withReconnect(() => sftpRemove(targetSessionId, path), targetSessionId)
                    changedRemote = true
                },
                removeDir: async (path) => {
                    await withReconnect(() => sftpRemoveDir(targetSessionId, path), targetSessionId)
                    changedRemote = true
                },
            })
            deleteDialog?.close()
            if (targetSessionId !== sessionId) return
            notice = `已删除 ${entry.name}`
            await refresh()
        } catch (cause) {
            deleteDialog?.close()
            if (targetSessionId !== sessionId) return
            reportOperationError('删除', entry.path, cause)
            // 部分子项可能已删除；刷新不能阻塞失败提示与操作状态释放。
            if (changedRemote) {
                const deleteError = error
                void refresh().then(() => { if (targetSessionId === sessionId) error = deleteError })
            }
        } finally {
            deleting = false
        }
    }

    async function onUploadChange (event: Event): Promise<void> {
        const input = event.currentTarget as HTMLInputElement
        const files = Array.from(input.files ?? [])
        input.value = ''
        await beginUpload(() => ({ files: files.map((file) => ({ file, path: file.name })), directories: [] }))
    }

    async function onFolderChange (event: Event): Promise<void> {
        const input = event.currentTarget as HTMLInputElement
        const files = Array.from(input.files ?? [])
        input.value = ''
        await beginUpload(() => ({
            files: files.map((file) => ({ file, path: file.webkitRelativePath || file.name })),
            directories: [],
        }))
    }

    function uploadPath (path: string): string {
        const parts = path.replace(/\\/g, '/').split('/')
        if (parts.some((part) => !part || part === '.' || part === '..')) throw new Error(`无效的上传路径：${path}`)
        return parts.join('/')
    }

    async function ensureRemoteDir (remoteDir: string, baseDir: string, targetSessionId: string): Promise<void> {
        const base = baseDir.replace(/\/+$/, '')
        const relative = remoteDir.slice(base.length).split('/').filter(Boolean)
        let current = base || '/'
        for (const part of relative) {
            current = joinPath(current, part)
            try {
                await withReconnect(() => sftpMkdir(targetSessionId, current), targetSessionId)
            } catch (cause) {
                const existing = await withReconnect(() => sftpStat(targetSessionId, current), targetSessionId).catch(() => null)
                if (!existing?.isDir) throw cause
            }
        }
    }

    // ---- Drag & drop handlers ----
    function dropDestination (target: EventTarget | null): string {
        const folder = (target as HTMLElement | null)?.closest?.('[data-sftp-upload-dir]') as HTMLElement | null
        return folder && browserElement?.contains(folder) ? folder.dataset.sftpUploadDir || cwd : cwd
    }

    function onDragOver (event: DragEvent): void {
        if (!Array.from(event.dataTransfer?.types ?? []).includes('Files')) return
        event.preventDefault()
        const blocked = uploading || transfer !== null || deleting || loading
        if (event.dataTransfer) event.dataTransfer.dropEffect = blocked ? 'none' : 'copy'
        if (blocked) return
        dragOver = true
        dragTargetPath = dropDestination(event.target)
    }
    function onDragLeave (event: DragEvent): void {
        const bounds = (event.currentTarget as HTMLElement).getBoundingClientRect()
        if (event.clientX <= bounds.left || event.clientX >= bounds.right || event.clientY <= bounds.top || event.clientY >= bounds.bottom) {
            dragOver = false
            dragTargetPath = null
        }
    }
    async function onDrop (event: DragEvent): Promise<void> {
        event.preventDefault()
        event.stopPropagation()
        const destination = dropDestination(event.target)
        dragOver = false
        dragTargetPath = null
        const dt = event.dataTransfer
        if (!dt) return
        await beginUpload(() => collectDrop(dt), destination)
    }

    async function collectDrop (dt: DataTransfer): Promise<UploadPlan> {
        const items = Array.from(dt.items ?? []).filter((item) => item.kind === 'file')
        // getAsEntry 必须在 drop 事件的同步阶段调用，否则浏览器可能清空 DataTransfer。
        const entries = items.map((item) => item.webkitGetAsEntry?.()).filter((entry): entry is FileSystemEntry => !!entry)
        if (entries.length !== items.length || entries.length === 0) {
            return { files: Array.from(dt.files ?? []).map((file) => ({ file, path: file.name })), directories: [] }
        }
        const plan: UploadPlan = { files: [], directories: [] }
        async function visit (entry: FileSystemEntry, prefix: string): Promise<void> {
            const path = prefix ? `${prefix}/${entry.name}` : entry.name
            if (entry.isFile) {
                const fileEntry = entry as FileSystemFileEntry
                const file: File = await new Promise((resolve, reject) => fileEntry.file(resolve, reject))
                plan.files.push({ file, path })
            } else if (entry.isDirectory) {
                plan.directories.push(path)
                const children = await readDirectoryEntries(entry as FileSystemDirectoryEntry)
                for (const child of children) await visit(child, path)
            }
        }
        for (const entry of entries) await visit(entry, '')
        return plan
    }

    function readDirectoryEntries (dir: FileSystemDirectoryEntry): Promise<FileSystemEntry[]> {
        return new Promise((resolve, reject) => {
            const reader = dir.createReader()
            const all: FileSystemEntry[] = []
            const read = () => {
                reader.readEntries((batch: FileSystemEntry[]) => {
                    if (batch.length === 0) resolve(all)
                    else { all.push(...batch); read() }
                }, reject)
            }
            read()
        })
    }

    // ---- Context menu ----
    function showEntryMenu (event: MouseEvent, entry: SftpEntry): void {
        event.preventDefault()
        event.stopPropagation()
        const items: ContextMenuItem[] = [
            { label: entry.isDir ? '打开' : '预览', action: () => void (entry.isSymlink ? followSymlink(entry) : openEntry(entry)) },
            { label: entry.isDir && !entry.isSymlink ? '下载文件夹' : '下载', disabled: transfer !== null || uploading, action: () => void downloadEntry(entry) },
            { label: '重命名', action: () => void beginRename(entry) },
            { label: '修改权限', action: () => void changeMode(entry) },
            { label: '删除', danger: true, action: () => void removeEntry(entry) },
        ]
        const margin = 8
        const menuWidth = 200
        const menuHeight = 180
        const x = Math.max(margin, Math.min(event.clientX, window.innerWidth - menuWidth - margin))
        const y = Math.max(margin, Math.min(event.clientY, window.innerHeight - menuHeight - margin))
        contextMenu = { x, y, items }
    }
    function showBlankMenu (event: MouseEvent): void {
        // 右键空白处：新建目录 / 上传 / 上传文件夹 / 刷新
        if ((event.target as HTMLElement)?.closest('.sftp-row')) return
        event.preventDefault()
        const items: ContextMenuItem[] = [
            { label: '新建目录', disabled: loading || deleting, action: () => void createDirectory() },
            { label: '上传文件', disabled: loading || uploading || transfer !== null || deleting, action: () => fileInput?.click() },
            { label: '上传文件夹', disabled: loading || uploading || transfer !== null || deleting, action: () => folderInput?.click() },
            { label: '刷新', action: () => void refresh() },
        ]
        const x = Math.max(8, Math.min(event.clientX, window.innerWidth - 210))
        const y = Math.max(8, Math.min(event.clientY, window.innerHeight - 160))
        contextMenu = { x, y, items }
    }

    async function beginUpload (prepare: () => UploadPlan | Promise<UploadPlan>, targetDir = cwd): Promise<void> {
        if (uploading || transfer || deleting || loading) return
        const destination = normalizePath(targetDir)
        const targetSessionId = sessionId
        cancelUploadDismiss()
        uploading = true
        error = ''
        notice = ''
        uploadProgress = { phase: 'preparing', doneBytes: 0, totalBytes: 0, doneFiles: 0, totalFiles: 0, doneDirs: 0, totalDirs: 0, currentFile: '', destination, cancel: false }
        let changedRemote = false
        try {
            const plan = await prepare()
            if (plan.files.length === 0 && plan.directories.length === 0) {
                clearUploadProgress()
                return
            }
            const directorySet = new Set(plan.directories.map(uploadPath))
            for (const item of plan.files) {
                item.path = uploadPath(item.path)
                const parts = item.path.split('/')
                for (let index = 1; index < parts.length; index++) directorySet.add(parts.slice(0, index).join('/'))
            }
            const directories = [...directorySet].sort((a, b) => a.split('/').length - b.split('/').length)
            if (!uploadProgress) return
            uploadProgress.totalFiles = plan.files.length
            uploadProgress.totalDirs = directories.length
            uploadProgress.totalBytes = plan.files.reduce((sum, item) => sum + item.file.size, 0)
            uploadProgress.phase = 'running'
            for (const directory of directories) {
                if (uploadProgress.cancel) break
                uploadProgress.currentFile = `${directory}/`
                await ensureRemoteDir(joinPath(destination, directory), destination, targetSessionId)
                uploadProgress.doneDirs += 1
                changedRemote = true
            }
            for (const item of plan.files) {
                if (uploadProgress.cancel) break
                uploadProgress.currentFile = item.path
                await uploadSingle(item.file, item.path, destination, targetSessionId)
                uploadProgress.doneFiles += 1
                changedRemote = true
            }
            uploadProgress.phase = uploadProgress.cancel ? 'cancelled' : 'completed'
            scheduleUploadDismiss()
            notice = uploadProgress.cancel
                ? `上传已取消，完成 ${uploadProgress.doneFiles}/${uploadProgress.totalFiles} 个文件`
                : `已上传 ${uploadProgress.doneFiles} 个文件、${uploadProgress.doneDirs} 个文件夹到 ${destination}`
        } catch (cause) {
            if (uploadProgress) uploadProgress.phase = uploadProgress.cancel ? 'cancelled' : 'failed'
            if (uploadProgress?.cancel) notice = `上传已取消，完成 ${uploadProgress.doneFiles}/${uploadProgress.totalFiles} 个文件`
            else reportOperationError('上传', destination, cause)
        } finally {
            uploading = false
            if (changedRemote && targetSessionId === sessionId) {
                const uploadError = error
                await refresh()
                if (uploadError) error = uploadError
            }
        }
    }

    async function uploadSingle (file: File, name: string, destination: string, targetSessionId: string): Promise<void> {
        // 原子上传：先写临时文件，全部成功后 rename 到目标名，避免半成品覆盖已有文件
        const finalPath = joinPath(destination, name)
        const lastSlash = finalPath.lastIndexOf('/')
        const target = `${finalPath.slice(0, lastSlash + 1)}.${finalPath.slice(lastSlash + 1)}.issh-upload-${crypto.randomUUID()}`
        let renamed = false
        let wroteChunk = false
        let permissionFailure = false
        try {
            // 空文件也必须创建临时文件，之后才能 rename。
            if (file.size === 0) {
                await withReconnect(() => sftpWrite(targetSessionId, target, '', 0, true), targetSessionId)
                wroteChunk = true
            }
            let offset = 0
            while (offset < file.size) {
                if (uploadProgress?.cancel) throw new Error('已取消')
                const slice = file.slice(offset, offset + UPLOAD_CHUNK)
                const bytes = new Uint8Array(await slice.arrayBuffer())
                await withReconnect(() => sftpWrite(targetSessionId, target, bytesToBase64(bytes), offset, offset === 0), targetSessionId)
                wroteChunk = true
                offset += bytes.length
                if (uploadProgress) uploadProgress.doneBytes += bytes.length
            }
            if (uploadProgress?.cancel) throw new Error('已取消')
            await withReconnect(() => sftpRename(targetSessionId, target, finalPath), targetSessionId)
            renamed = true
        } catch (cause) {
            const reason = cause instanceof Error ? cause.message : String(cause)
            permissionFailure = isPermissionError(reason)
            throw cause
        } finally {
            if (!renamed && (wroteChunk || !permissionFailure)) {
                const cleanup = withReconnect(() => sftpRemove(targetSessionId, target), targetSessionId).catch(() => {})
                // 权限拒绝立即反馈；已写入的临时文件仍尽力清理，清理不阻塞提示。
                if (!permissionFailure) await cleanup
            }
        }
    }

    function uploadPercent (): number {
        if (!uploadProgress) return 0
        if (uploadProgress.phase === 'completed') return 100
        const { doneBytes, totalBytes, doneFiles, totalFiles, doneDirs, totalDirs } = uploadProgress
        if (totalBytes > 0) return Math.min(99, Math.round(100 * doneBytes / totalBytes))
        const totalItems = totalFiles + totalDirs
        return totalItems > 0 ? Math.min(99, Math.round(100 * (doneFiles + doneDirs) / totalItems)) : 0
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
        if (transfer || uploading) return
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
                reportOperationError('下载', entry.path, cause)
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
            cancelUploadDismiss()
            cancelTransfer()
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

<section bind:this={browserElement} class="sftp-browser" aria-label={sudoMode ? 'SUDO SFTP 文件浏览器' : 'SFTP 文件浏览器'} ondragover={onDragOver} ondragleave={onDragLeave} ondrop={(event) => void onDrop(event)} oncontextmenu={showBlankMenu} class:drag-over={dragOver}>
    <header class="sftp-toolbar">
        <button class="sftp-nav" type="button" onclick={() => void navigate(parentPath(cwd))} disabled={cwd === '/' || loading} title="上级目录">
            ↑
        </button>
        <nav class="sftp-crumbs" aria-label="当前路径">
            {#each breadcrumbs() as crumb, index (crumb.path)}
                {#if index > 0}<span class="crumb-separator">/</span>{/if}
                <button type="button" class="sftp-crumb" data-sftp-upload-dir={crumb.path} ondblclick={() => { editingPath = true; pathInput = cwd }} onclick={() => void navigate(crumb.path)} title={crumb.path}>
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
    </header>
    <input bind:this={fileInput} class="sftp-file" type="file" multiple onchange={(event) => void onUploadChange(event)} aria-label="选择本地文件" style="display:none" />
    <input bind:this={folderInput} class="sftp-file" type="file" webkitdirectory multiple onchange={(event) => void onFolderChange(event)} aria-label="选择本地文件夹" style="display:none" />
    <p class="sftp-drop-hint" class:active={dragOver} role="status">{dragOver ? `松开以上传到 ${dragTargetPath}` : '拖到空白处上传到当前目录，拖到文件夹上传到该文件夹'}</p>

    {#if error}
        <p class="sftp-error" role="alert">{error}</p>
    {/if}
    {#if notice}
        <p class="sftp-notice">{notice}</p>
    {/if}
    {#if uploadProgress}
        <div class="sftp-transfer sftp-upload-progress" role="status" aria-live="polite" onmouseenter={preserveUploadProgress} onmouseleave={() => { uploadProgressHovered = false }} onfocusin={cancelUploadDismiss}>
            <div class="sftp-transfer-head">
                <span title={uploadProgress.currentFile}>{uploadProgress.phase === 'preparing' ? '正在整理上传内容…' : uploadProgress.phase === 'running' ? `正在上传 ${uploadProgress.currentFile}` : uploadProgress.phase === 'completed' ? '上传完成' : uploadProgress.phase === 'cancelled' ? '上传已取消' : '上传失败'}</span>
                {#if uploadProgress.phase !== 'preparing'}
                    <span class="sftp-upload-summary">{uploadProgress.doneFiles}/{uploadProgress.totalFiles} 文件{uploadProgress.totalDirs ? ` · ${uploadProgress.doneDirs}/${uploadProgress.totalDirs} 文件夹` : ''} · {formatBytes(uploadProgress.doneBytes)} / {formatBytes(uploadProgress.totalBytes)} · {uploadPercent()}%</span>
                {/if}
                {#if uploadDismissSeconds !== null}
                    <span class="sftp-upload-countdown">{uploadDismissSeconds}s 后关闭</span>
                {/if}
                {#if uploadProgress.phase === 'preparing' || uploadProgress.phase === 'running'}
                    <button type="button" onclick={cancelTransfer}>取消</button>
                {:else}
                    <button type="button" onclick={clearUploadProgress} aria-label="清除上传进度">×</button>
                {/if}
            </div>
            <span class="sftp-upload-destination" title={uploadProgress.destination}>目标：{uploadProgress.destination}</span>
            {#if uploadProgress.phase === 'preparing'}
                <progress class="sftp-transfer-bar"></progress>
            {:else}
                <progress class="sftp-transfer-bar" value={uploadPercent()} max="100"></progress>
            {/if}
        </div>
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
            <button class="sftp-parent-row" class:drop-target={dragOver && dragTargetPath === parentPath(cwd)} data-sftp-upload-dir={parentPath(cwd)} type="button" onclick={() => void navigate(parentPath(cwd))}>↖ <span>..</span></button>
        {/if}
        {#each visibleEntries as entry (entry.path)}
            <div class="sftp-row" class:drop-target={dragOver && dragTargetPath === entry.path} data-sftp-upload-dir={entry.isDir && !entry.isSymlink ? entry.path : undefined} role="listitem" oncontextmenu={(event) => showEntryMenu(event, entry)}>
                <button class="sftp-entry" type="button" onclick={() => void (entry.isSymlink ? followSymlink(entry) : openEntry(entry))} title={entry.path}>
                    <span class="sftp-icon" class:dir={entry.isDir} class:link={entry.isSymlink}>
                        {entryIcon(entry)}
                    </span>
                    <span class="sftp-name">{entry.name}</span>
                </button>
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
    {#if contextMenu}
        <ContextMenu x={contextMenu.x} y={contextMenu.y} items={contextMenu.items} onclose={() => { contextMenu = null }} />
    {/if}
</section>

<dialog bind:this={deleteDialog} class="sftp-delete-dialog" aria-labelledby="sftp-delete-title" oncancel={(event) => { if (deleting) event.preventDefault() }} onclose={() => { deleteTarget = null }}>
    <h2 id="sftp-delete-title">确认删除</h2>
    <p>确定删除 {deleteTarget?.isDir && !deleteTarget.isSymlink ? '目录及其所有内容' : '文件'} {deleteTarget?.name}？</p>
    <div class="sftp-delete-actions">
        <button type="button" disabled={deleting} onclick={() => deleteDialog?.close()}>取消</button>
        <button type="button" class="danger" disabled={deleting} onclick={() => void confirmRemoveEntry()}>{deleting ? '正在删除…' : '确定删除'}</button>
    </div>
</dialog>
