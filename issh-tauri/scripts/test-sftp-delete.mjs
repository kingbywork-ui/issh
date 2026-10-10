import assert from 'node:assert/strict'
import { removeSftpTree } from '../src/lib/sftpDelete.ts'

const entry = (path, isDir = false, isSymlink = false) => ({
    path, name: path.slice(path.lastIndexOf('/') + 1), isDir, isFile: !isDir, isSymlink,
    size: 0, modifiedUnixSecs: null,
})

function server (items) {
    const files = new Map(items.map((item) => [item.path, item]))
    const calls = []
    return {
        files, calls,
        operations: {
            list: async (path, offset) => {
                calls.push(`list ${path} ${offset}`)
                const children = [...files.values()].filter((item) => item.path.startsWith(`${path}/`) && !item.path.slice(path.length + 1).includes('/'))
                const entries = children.slice(offset, offset + 2)
                return { path, offset, entries, total: children.length, hasMore: offset + entries.length < children.length }
            },
            removeFile: async (path) => {
                calls.push(`file ${path}`)
                if (path.endsWith('/denied')) throw new Error('Permission denied')
                assert.ok(files.delete(path), `missing file: ${path}`)
            },
            removeDir: async (path) => {
                calls.push(`dir ${path}`)
                if ([...files.keys()].some((item) => item.startsWith(`${path}/`))) throw new Error('SFTP transfer error: Failure: Failure')
                assert.ok(files.delete(path), `missing directory: ${path}`)
            },
        },
    }
}

const root = entry('/x', true)
const fixture = server([root, entry('/x/a'), entry('/x/b'), entry('/x/nested', true), entry('/x/nested/c'), entry('/x/link', true, true), entry('/keep')])
await assert.rejects(() => fixture.operations.removeDir('/x'), /Failure: Failure/)
await removeSftpTree(root, fixture.operations)
assert.deepEqual([...fixture.files.keys()], ['/keep'])
assert.ok(fixture.calls.includes('list /x 2'), 'directory pagination must be read before deletion')
assert.ok(!fixture.calls.some((call) => call.startsWith('list /x/link')), 'symlinks must not be traversed')
assert.ok(fixture.calls.indexOf('dir /x/nested') < fixture.calls.lastIndexOf('dir /x'))

const failure = server([entry('/failed', true), entry('/failed/denied')])
await assert.rejects(() => removeSftpTree(entry('/failed', true), failure.operations), /Permission denied/)
assert.ok(failure.files.has('/failed'), 'parent directory must remain after child deletion fails')

const single = server([entry('/one')])
await removeSftpTree(entry('/one'), single.operations)
assert.equal(single.files.size, 0)
console.log('SFTP deletion: non-empty nested directory, pagination, symlink and failure behavior passed')
