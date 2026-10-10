import assert from 'node:assert/strict'
import fs from 'node:fs'
import ts from 'typescript'

// Run the component's actual upload functions against an in-memory SFTP server.
const source = fs.readFileSync(new URL('../src/lib/SftpBrowser.svelte', import.meta.url), 'utf8').split('</script>')[0].replace('<script lang="ts">', '')
const parsed = ts.createSourceFile('SftpBrowser.ts', source, ts.ScriptTarget.Latest, true)
const names = new Set(['joinPath', 'normalizePath', 'uploadPath', 'ensureRemoteDir', 'dropDestination', 'onDragOver', 'onDragLeave', 'onDrop', 'collectDrop', 'readDirectoryEntries', 'beginUpload', 'uploadSingle', 'uploadPercent', 'cancelTransfer', 'cancelUploadDismiss', 'clearUploadProgress', 'preserveUploadProgress', 'scheduleUploadDismiss', 'isPermissionError', 'reportOperationError'])
const functions = parsed.statements.filter((node) => ts.isFunctionDeclaration(node) && names.has(node.name?.text)).map((node) => node.getText(parsed)).join('\n')
const compiled = ts.transpileModule(functions, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText

function fixture ({ onWrite, onRename } = {}) {
    const writes = []
    const snapshots = []
    const files = new Map()
    const dirs = new Set(['/root', '/root/folder'])
    const timers = new Map()
    let now = 0
    let nextTimerId = 1
    let api
    const make = new Function('deps', `
        const { sftpWrite, sftpRename, sftpRemove, sftpMkdir, sftpStat, crypto, setInterval, clearInterval, Date } = deps;
        let cwd = '/root', sessionId = 'original', uploading = false, transfer = null, deleting = false, loading = false;
        let error = '', notice = '', uploadProgress = null, dragOver = false, dragTargetPath = null;
        let uploadDismissSeconds = null, uploadDismissTimer = null, uploadProgressHovered = false;
        const browserElement = { contains: () => true };
        const UPLOAD_CHUNK = 2;
        const withReconnect = async (operation) => operation();
        const refresh = async () => {};
        const showAlert = async () => {};
        const bytesToBase64 = (bytes) => Buffer.from(bytes).toString('base64');
        ${compiled}
        return { onDrop, onDragOver, onDragLeave, beginUpload, cancelTransfer, uploadPercent, preserveUploadProgress, clearUploadProgress, cancelUploadDismiss,
            state: () => ({ cwd, sessionId, uploading, error, notice, uploadProgress, dragOver, dragTargetPath, uploadDismissSeconds }),
            setCwd: (path) => { cwd = path }, setSessionId: (id) => { sessionId = id } };
    `)
    api = make({
        crypto,
        setInterval: (callback) => { const id = nextTimerId++; timers.set(id, callback); return id },
        clearInterval: (id) => timers.delete(id),
        Date: { now: () => now },
        sftpWrite: async (session, path, data, offset, truncate) => {
            writes.push({ session, path, offset })
            let previous = truncate ? Buffer.alloc(0) : files.get(path) ?? Buffer.alloc(0)
            const bytes = Buffer.from(data, 'base64')
            const result = Buffer.alloc(Math.max(previous.length, offset + bytes.length))
            previous.copy(result)
            bytes.copy(result, offset)
            files.set(path, result)
            snapshots.push(structuredClone(api.state().uploadProgress))
            await onWrite?.(api, path)
        },
        sftpRename: async (_session, from, to) => {
            await onRename?.(api)
            assert.ok(files.has(from), `missing temporary file: ${from}`)
            files.set(to, files.get(from))
            files.delete(from)
        },
        sftpRemove: async (_session, path) => { files.delete(path) },
        sftpMkdir: async (_session, path) => { dirs.add(path) },
        sftpStat: async (_session, path) => ({ isDir: dirs.has(path) }),
    })
    const advanceSeconds = (seconds) => {
        for (let i = 0; i < seconds; i++) {
            now += 1000
            for (const callback of [...timers.values()]) callback()
        }
    }
    return { api, files, dirs, writes, snapshots, advanceSeconds, timers }
}

function event (files, folder = null) {
    const target = { closest: () => folder ? { dataset: { sftpUploadDir: folder } } : null }
    return { target, preventDefault () {}, stopPropagation () {}, dataTransfer: { files, items: [], types: ['Files'], dropEffect: '' } }
}

const config = JSON.parse(fs.readFileSync(new URL('../src-tauri/tauri.conf.json', import.meta.url), 'utf8'))
console.log('Windows HTML drop enabled:', config.app.windows[0].dragDropEnabled === false)
const finishingPercent = []
const folder = fixture({ onRename: (api) => finishingPercent.push(api.uploadPercent()) })
folder.api.onDragOver(event([], '/root/folder'))
assert.equal(folder.api.state().dragTargetPath, '/root/folder')
assert.equal(folder.api.state().dragOver, true)
await folder.api.onDrop(event([new File(['abc'], 'one.txt'), new File(['de'], 'two.txt')], '/root/folder'))
console.log('folder drop destinations:', [...folder.files.keys()])
assert.ok(folder.files.has('/root/folder/one.txt'), 'folder drop must upload into the hovered folder')
assert.equal(folder.api.state().uploadProgress.doneBytes, 5)
assert.equal(folder.api.state().uploadProgress.totalBytes, 5)
assert.equal(folder.api.state().uploadProgress.doneFiles, 2)
assert.equal(folder.api.uploadPercent(), 100)
assert.ok(finishingPercent.every((percent) => percent < 100), '100% must wait for the final rename')
assert.deepEqual(folder.snapshots.map((state) => state.doneBytes), [0, 2, 3], 'byte progress must accumulate only after each write is acknowledged')
assert.ok(folder.snapshots.every((state) => state.totalBytes === 5))
assert.equal(config.app.windows[0].dragDropEnabled, false, 'Windows must pass file drops to HTML handlers')

const directory = fixture()
const fileEntry = { name: 'inside.txt', isFile: true, file: (resolve) => resolve(new File(['hi'], 'inside.txt')) }
const emptyDirectory = { name: 'empty', isDirectory: true, createReader: () => ({ readEntries: (resolve) => resolve([]) }) }
const droppedDirectory = { name: 'local', isDirectory: true, createReader: () => {
    let done = false
    return { readEntries: (resolve) => { const entries = done ? [] : [fileEntry, emptyDirectory]; done = true; resolve(entries) } }
} }
const directoryEvent = event([], '/root/folder')
directoryEvent.dataTransfer.items = [{ kind: 'file', webkitGetAsEntry: () => droppedDirectory }]
await directory.api.onDrop(directoryEvent)
assert.equal(directory.files.get('/root/folder/local/inside.txt').toString(), 'hi')
assert.ok(directory.dirs.has('/root/folder/local/empty'), 'empty local directories must be preserved')
assert.equal(directory.api.state().uploadProgress.phase, 'completed')

const background = fixture({ onWrite: (api) => { api.setCwd('/elsewhere'); api.setSessionId('another') } })
await background.api.onDrop(event([new File(['abc'], 'stay.txt')]))
assert.ok(background.files.has('/root/stay.txt'), 'destination must remain fixed during upload')
assert.ok(background.writes.every((write) => write.session === 'original'), 'session must remain fixed during upload')

const empty = fixture()
await empty.api.onDrop(event([new File([], 'empty')], '/root/folder'))
assert.equal(empty.files.get('/root/folder/empty').length, 0)
assert.equal(empty.api.uploadPercent(), 100)

const cancelled = fixture({ onWrite: (api) => api.cancelTransfer() })
await cancelled.api.onDrop(event([new File(['abcdef'], 'cancel.txt')]))
assert.equal(cancelled.files.size, 0, 'cancelled upload must clean the temporary file')
assert.equal(cancelled.api.state().uploadProgress.phase, 'cancelled')

const failed = fixture({ onRename: () => { throw new Error('rename denied') } })
await failed.api.onDrop(event([new File(['abc'], 'failed.txt')]))
assert.equal(failed.files.size, 0)
assert.equal(failed.api.state().uploadProgress.phase, 'failed')
assert.match(failed.api.state().error, /rename denied/)

const timed = fixture()
await timed.api.onDrop(event([new File(['x'], 'timed.txt')]))
assert.equal(timed.api.state().uploadDismissSeconds, 5)
timed.advanceSeconds(4)
assert.ok(timed.api.state().uploadProgress)
assert.equal(timed.api.state().uploadDismissSeconds, 1)
timed.advanceSeconds(1)
assert.equal(timed.api.state().uploadProgress, null)
assert.equal(timed.timers.size, 0)

const hovered = fixture()
await hovered.api.onDrop(event([new File(['x'], 'hovered.txt')]))
hovered.advanceSeconds(2)
hovered.api.preserveUploadProgress()
assert.equal(hovered.api.state().uploadDismissSeconds, null)
hovered.advanceSeconds(10)
assert.equal(hovered.api.state().uploadProgress.phase, 'completed')
hovered.api.clearUploadProgress()
assert.equal(hovered.api.state().uploadProgress, null)

const earlyHover = fixture({ onWrite: (api) => api.preserveUploadProgress() })
await earlyHover.api.onDrop(event([new File(['x'], 'early.txt')]))
assert.equal(earlyHover.api.state().uploadDismissSeconds, null)
assert.equal(earlyHover.timers.size, 0)

const replacement = fixture()
await replacement.api.onDrop(event([new File(['x'], 'old.txt')]))
replacement.advanceSeconds(4)
let finishPreparing
const nextUpload = replacement.api.beginUpload(() => new Promise((resolve) => { finishPreparing = resolve }))
replacement.advanceSeconds(6)
assert.equal(replacement.api.state().uploadProgress.phase, 'preparing', 'an old countdown must not dismiss the next upload')
finishPreparing({ files: [], directories: [] })
await nextUpload
assert.equal(replacement.timers.size, 0)
failed.advanceSeconds(10)
cancelled.advanceSeconds(10)
assert.equal(failed.api.state().uploadProgress.phase, 'failed')
assert.equal(cancelled.api.state().uploadProgress.phase, 'cancelled')

console.log('SFTP upload: folder/background targets, fixed destination/session, total progress, empty file, cancellation and failure passed')
console.log('Upload progress: 5-second dismissal, hover preservation, manual close and timer cleanup passed')
