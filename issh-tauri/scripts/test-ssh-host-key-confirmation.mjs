import assert from 'node:assert/strict'
import { setImmediate as tick } from 'node:timers/promises'
import { get } from 'svelte/store'
import { askConfirm, currentDialog, dismissDialogs, resolveDialog } from '../src/lib/dialogs.ts'
import { createHostKeyConfirmationHandler } from '../src/lib/sshHostKeyConfirmation.ts'

const records = new Map()
const responses = []
const reveals = []
const errors = []
let rejectResponse = false
const storage = {
    getItem: key => records.get(key) ?? null,
    setItem: (key, value) => records.set(key, value),
}
const handler = createHostKeyConfirmationHandler({
    storage,
    confirm: askConfirm,
    respond: async (id, accepted) => {
        responses.push({ id, accepted })
        if (rejectResponse) throw new Error('SSH 主机密钥确认已过期')
    },
    reveal: async id => { reveals.push(id) },
    onError: cause => { errors.push(cause.message) },
})
const request = (id, fingerprint = 'SHA256:current') => ({ id, host: 'server', port: 2222, fingerprint })
const key = 'issh.trustedHostKey.server:2222'

records.set(key, 'SHA256:current')
handler.handle(request(1))
await tick()
assert.deepEqual(responses, [{ id: 1, accepted: true }], 'trusted host connects without a manual SSH session')
assert.deepEqual(reveals, [], 'trusted connection does not foreground the desktop')
assert.equal(get(currentDialog), null)

records.delete(key) // same action as deleting this host in Settings
handler.handle(request(2))
await tick()
assert.deepEqual(reveals, [2])
assert.equal(responses.length, 1, 'no connection approval before user confirms')
assert.match(get(currentDialog).message, /server:2222/)
assert.match(get(currentDialog).message, /SHA256:current/)
resolveDialog(get(currentDialog).id, true)
await tick()
assert.equal(records.get(key), 'SHA256:current', 'first-use approval saves the existing desktop trust key')
assert.deepEqual(responses.at(-1), { id: 2, accepted: true })

handler.handle(request(3, 'SHA256:changed'))
await tick()
assert.equal(get(currentDialog).title, 'SSH 主机密钥已变化')
assert.match(get(currentDialog).message, /原指纹：SHA256:current/)
assert.match(get(currentDialog).message, /当前指纹：SHA256:changed/)
resolveDialog(get(currentDialog).id, false)
await tick()
assert.equal(records.get(key), 'SHA256:current', 'rejected replacement cannot overwrite trusted key')
assert.deepEqual(responses.at(-1), { id: 3, accepted: false })
handler.handle(request(4, 'SHA256:changed'))
await tick()
resolveDialog(get(currentDialog).id, true)
await tick()
assert.equal(records.get(key), 'SHA256:changed')

records.delete(key)
handler.handle(request(5))
handler.handle(request(6))
await tick()
resolveDialog(get(currentDialog).id, true)
await tick()
assert.deepEqual(responses.slice(-2), [{ id: 5, accepted: true }, { id: 6, accepted: true }])
assert.equal(get(currentDialog), null, 'concurrent same-host requests reuse the saved decision')
assert.equal(reveals.filter(id => id === 6).length, 0)

records.delete(key)
handler.handle(request(7))
handler.handle(request(8))
await tick()
handler.cancel(8)
handler.cancel(7)
await tick()
assert.equal(get(currentDialog), null, 'timeout dismisses active and queued fingerprint requests')
assert.equal(records.has(key), false)
assert.equal(responses.some(item => item.id === 7 || item.id === 8), false)

// Cancel a confirm while it is queued behind an unrelated application dialog.
const unrelated = askConfirm('Unrelated operation')
const unrelatedId = get(currentDialog).id
const controller = new AbortController()
const queued = askConfirm('Expired SSH host', 'SSH', controller.signal)
controller.abort()
assert.equal(await queued, false)
assert.equal(get(currentDialog).id, unrelatedId)
resolveDialog(unrelatedId, false)
assert.equal(await unrelated, false)
assert.equal(get(currentDialog), null)

rejectResponse = true
handler.handle(request(9))
await tick()
resolveDialog(get(currentDialog).id, true)
await tick()
assert.equal(records.has(key), false, 'late Rust rejection cannot save host trust')
assert.equal(errors.at(-1), 'SSH 主机密钥确认已过期')
rejectResponse = false

// Known hosts can proceed while a different host is waiting for approval.
handler.handle(request(12))
await tick()
records.set('issh.trustedHostKey.trusted:2222', 'SHA256:current')
handler.handle({ ...request(13), host: 'trusted' })
await tick()
assert.deepEqual(responses.at(-1), { id: 13, accepted: true })
assert.notEqual(get(currentDialog), null, 'unrelated first-use prompt remains pending')
handler.cancel(12)
await tick()

// Startup replay cannot process cancelled or completed request ids again.
const responseCount = responses.length
const revealCount = reveals.length
handler.cancel(15)
handler.handle(request(15))
handler.handle(request(1))
await tick()
assert.equal(responses.length, responseCount)
assert.equal(reveals.length, revealCount)
assert.equal(get(currentDialog), null)

// A cached approval must not resurrect a record deleted during its RPC reply.
records.set(key, 'SHA256:current')
let finishResponse
const delayedHandler = createHostKeyConfirmationHandler({
    storage,
    confirm: askConfirm,
    respond: () => new Promise(resolve => { finishResponse = resolve }),
    reveal: async () => { throw new Error('cached key should not reveal the window') },
    onError: cause => { throw cause },
})
delayedHandler.handle(request(14))
assert.equal(typeof finishResponse, 'function')
records.delete(key)
finishResponse()
await tick()
assert.equal(records.has(key), false, 'Settings deletion persists during a cached connection response')
delayedHandler.dispose()

handler.handle(request(10))
await tick()
handler.dispose()
await tick()
assert.equal(get(currentDialog), null, 'desktop teardown releases a pending confirmation')
handler.handle(request(11))
await tick()
assert.equal(responses.some(item => item.id === 10 || item.id === 11), false)
dismissDialogs()
console.log('SSH host-key confirmation: trusted/first/changed keys, Settings deletion/races, concurrent reuse, independent known hosts, active/queued timeout, replay isolation, stale approval and teardown passed')
