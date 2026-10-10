import assert from 'node:assert/strict'
import fs from 'node:fs'
import ts from 'typescript'
import { removeSftpTree } from '../src/lib/sftpDelete.ts'

// Execute the component's real operation and recovery paths with rejected RPCs.
const source = fs.readFileSync(new URL('../src/lib/SftpBrowser.svelte', import.meta.url), 'utf8').split('</script>')[0].replace('<script lang="ts">', '')
const parsed = ts.createSourceFile('SftpBrowser.ts', source, ts.ScriptTarget.Latest, true)
const names = new Set(['isPermissionError', 'isChannelError', 'withReconnect', 'reportOperationError', 'joinPath', 'normalizePath', 'uploadPath', 'ensureRemoteDir', 'beginUpload', 'uploadSingle', 'cancelUploadDismiss', 'clearUploadProgress', 'scheduleUploadDismiss', 'downloadFile', 'downloadDirectory', 'downloadEntry', 'confirmRemoveEntry', 'refresh'])
const functions = parsed.statements.filter((node) => ts.isFunctionDeclaration(node) && names.has(node.name?.text)).map((node) => node.getText(parsed)).join('\n')
const compiled = ts.transpileModule(functions, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
const denied = 'SFTP transfer error: Permission denied: Permission denied'
const entry = { name: 'file.txt', path: '/root/file.txt', isDir: false, isSymlink: false, size: 2 }

function fixture (overrides = {}) {
    const alerts = [], calls = []
    let reopens = 0
    const operation = (name, fallback) => async (...args) => {
        calls.push([name, ...args])
        return overrides[name] ? overrides[name](...args) : fallback
    }
    const api = new Function('deps', `
        const { showAlert, reopenSftpChannel, removeSftpTree, sftpWrite, sftpRead, sftpStat, sftpMkdir, sftpRename, sftpRemove, sftpRemoveDir, sftpList, pickSavePath, pickDirectory, writeLocalChunk, createLocalDir } = deps;
        let sessionId = 'original', sudoMode = false, cwd = '/root';
        let uploading = false, transfer = null, deleting = false, loading = false;
        let error = '', notice = '', uploadProgress = null, entries = [], disconnected = false, navGeneration = 0;
        let uploadDismissTimer = null, uploadDismissSeconds = null, uploadProgressHovered = false;
        let deleteTarget = null, deleteTargetSessionId = 'original', dialogClosed = false;
        const deleteDialog = { close: () => { dialogClosed = true } };
        const UPLOAD_CHUNK = 2, DOWNLOAD_CHUNK = 2;
        const bytesToBase64 = (bytes) => Buffer.from(bytes).toString('base64');
        ${compiled}
        return { withReconnect, isChannelError, beginUpload, downloadEntry, confirmRemoveEntry, refresh,
            setDelete: (entry) => { deleteTarget = entry }, setSudo: () => { sudoMode = true },
            state: () => ({ uploading, transfer, deleting, loading, error, notice, uploadProgress, disconnected, dialogClosed }) };
    `)({
        showAlert: async (message, title) => { alerts.push({ message, title }) },
        reopenSftpChannel: async () => { reopens++ },
        removeSftpTree,
        sftpWrite: operation('write'), sftpRead: operation('read', { length: 2, dataBase64: 'b2s=', eof: true }),
        sftpStat: operation('stat', { size: 2, isDir: false }), sftpMkdir: operation('mkdir'),
        sftpRename: operation('rename'), sftpRemove: operation('remove'), sftpRemoveDir: operation('removeDir'),
        sftpList: operation('list', { entries: [], hasMore: false }),
        pickSavePath: async () => 'C:/downloads/file.txt', pickDirectory: async () => 'C:/downloads',
        writeLocalChunk: operation('localWrite'), createLocalDir: operation('localMkdir'),
    })
    return { api, alerts, calls, reopens: () => reopens }
}

function assertReleased (f, action) {
    const state = f.api.state()
    assert.equal(state.uploading, false)
    assert.equal(state.transfer, null)
    assert.equal(state.deleting, false)
    assert.equal(f.reopens(), 0, 'permission failure must not reopen the SFTP channel')
    assert.equal(f.alerts.length, 1)
    assert.equal(f.alerts[0].title, `${action}失败`)
    assert.match(f.alerts[0].message, /权限不足/)
    assert.match(f.alerts[0].message, /\/root/)
}

for (const message of [denied, 'SFTP transfer error: PermissionDenied', 'Access is denied. (os error 5)', 'Permission denied (os error 13)', 'SFTP transfer error: No such file: No such file', 'SFTP transfer error: Failure: Failure', 'SFTP transfer error: file closed by policy']) {
    const f = fixture()
    let count = 0
    await assert.rejects(f.api.withReconnect(async () => { count++; throw new Error(message) }))
    assert.equal(f.reopens(), 0, message)
    assert.equal(count, 1, message)
}

const connection = fixture()
let count = 0
assert.equal(await connection.api.withReconnect(async () => {
    if (++count === 1) throw new Error('SFTP transfer error: connection lost')
    return 'recovered'
}), 'recovered')
assert.equal(connection.reopens(), 1)
assert.equal(count, 2)
assert.equal(connection.api.isChannelError('SFTP transfer error: Timeout'), true)
assert.equal(connection.api.isChannelError('SFTP transfer error: No connection: '), true)
assert.equal(connection.api.isChannelError('SFTP transfer error: session closed'), true)
assert.equal(connection.api.isChannelError('SFTP transfer error: sender dropped'), true)
const sudo = fixture()
sudo.api.setSudo()
await assert.rejects(sudo.api.withReconnect(async () => { throw new Error('channel closed') }))
assert.equal(sudo.reopens(), 0)

const reject = async () => { throw new Error(denied) }
const upload = fixture({ write: reject })
await upload.api.beginUpload(() => ({ files: [{ file: new File(['ok'], 'file.txt'), path: 'file.txt' }], directories: [] }))
assertReleased(upload, '上传')
assert.equal(upload.api.state().uploadProgress.phase, 'failed')
assert.equal(upload.calls.filter(([name]) => name === 'write').length, 1)
assert.equal(upload.calls.filter(([name]) => name === 'remove').length, 0, 'no temp file to remove when the first write is denied')

// The failed rename must be reported even if cleanup never answers.
let finishCleanup
const rename = fixture({ rename: reject, remove: () => new Promise((resolve) => { finishCleanup = resolve }) })
let finished = false
const uploadResult = rename.api.beginUpload(() => ({ files: [{ file: new File(['ok'], 'file.txt'), path: 'file.txt' }], directories: [] })).then(() => { finished = true })
await new Promise((resolve) => setTimeout(resolve, 0))
assert.equal(finished, true, 'permission failure must not wait for best-effort temp cleanup')
assertReleased(rename, '上传')
finishCleanup()
await uploadResult

const download = fixture({ read: reject })
await download.api.downloadEntry(entry)
assertReleased(download, '下载')
const localDownload = fixture({ localWrite: async () => { throw new Error('Access is denied. (os error 5)') } })
await localDownload.api.downloadEntry(entry)
assertReleased(localDownload, '下载')
const folderDownload = fixture({ list: reject })
await folderDownload.api.downloadEntry({ ...entry, isDir: true })
assertReleased(folderDownload, '下载')

const deletion = fixture({ remove: reject, list: () => new Promise(() => {}) })
deletion.api.setDelete(entry)
await deletion.api.confirmRemoveEntry()
assertReleased(deletion, '删除')
assert.equal(deletion.api.state().dialogClosed, true)
assert.equal(deletion.calls.filter(([name]) => name === 'list').length, 0, 'first denied deletion must not block on an unnecessary refresh')
const folderDeletion = fixture({ list: reject })
folderDeletion.api.setDelete({ ...entry, isDir: true })
await folderDeletion.api.confirmRemoveEntry()
assertReleased(folderDeletion, '删除')

const listing = fixture({ list: reject })
await listing.api.refresh()
assert.equal(listing.api.state().loading, false)
assert.equal(listing.api.state().disconnected, false, 'permission denied is not a disconnect')
assert.equal(listing.reopens(), 0)
console.log('SFTP errors: permission/status failures do not reconnect; upload/download/delete release state and alert; temp cleanup cannot block permission feedback; channel recovery remains intact')
