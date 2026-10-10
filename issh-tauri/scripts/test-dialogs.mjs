import assert from 'node:assert/strict'
import { get } from 'svelte/store'
import { askConfirm, askPrompt, currentDialog, dismissDialogs, resolveDialog, showAlert } from '../src/lib/dialogs.ts'

const alert = showAlert('Permission denied', '上传失败')
const alertId = get(currentDialog).id
const confirm = askConfirm('Delete host?')
const prompt = askPrompt('Rename file', 'old.txt')
assert.equal(get(currentDialog).title, '上传失败')
resolveDialog(alertId + 100, true)
assert.equal(get(currentDialog).id, alertId, 'unknown/stale responses cannot resolve another dialog')
resolveDialog(alertId, true)
assert.equal(await alert, undefined)
const confirmation = get(currentDialog)
assert.equal(confirmation.kind, 'confirm', 'concurrent requests are presented in FIFO order')
resolveDialog(alertId, true)
assert.equal(get(currentDialog).id, confirmation.id, 'duplicate responses cannot dismiss the next dialog')
resolveDialog(confirmation.id, false)
assert.equal(await confirm, false)
assert.equal(get(currentDialog).defaultValue, 'old.txt')
resolveDialog(get(currentDialog).id, '')
assert.equal(await prompt, '', 'empty prompt submission differs from cancellation')
assert.equal(get(currentDialog), null)

const accepted = askConfirm('Continue?')
resolveDialog(get(currentDialog).id, true)
assert.equal(await accepted, true)
const named = askPrompt('Enter name')
resolveDialog(get(currentDialog).id, '新目录')
assert.equal(await named, '新目录')
const cancelled = askPrompt('Enter name')
resolveDialog(get(currentDialog).id, null)
assert.equal(await cancelled, null)

const pending = [askConfirm('Pending confirm'), askPrompt('Pending prompt'), showAlert('Pending alert')]
dismissDialogs()
assert.deepEqual(await Promise.all(pending), [false, null, undefined], 'host teardown releases every caller without approving operations')
assert.equal(get(currentDialog), null)
console.log('Dialogs: FIFO, stale-response isolation, confirm decisions, prompt input/cancel and teardown passed')
