import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import { test } from 'node:test'
import ts from 'typescript'

function fixture(outcomes) {
    const source = fs.readFileSync('issh-tauri/src/App.svelte', 'utf8').split('<script lang="ts">')[1].split('</script>')[0]
    const ast = ts.createSourceFile('App.ts', source, ts.ScriptTarget.Latest, true)
    const fn = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'pollOutput')
    assert.ok(fn)
    const closed = []
    const notices = []
    const context = {
        subscribeSession: async () => { const value = outcomes.shift(); if (value instanceof Error) throw value; return value },
        closeTab: async tab => { closed.push(tab.session.id) },
        pushToast: (...args) => notices.push(args),
        broadcastSandboxEvent() {}, Uint8Array,
    }
    const code = ts.transpileModule(fn.getText(ast), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
    const poll = vm.runInNewContext(code + '; pollOutput', context)
    const tab = { session: { id: 'ssh-1', title: 'running build', state: 'running' }, sequence: 0, terminal: { write() {} } }
    return { poll, tab, closed, notices }
}
const ok = () => ({ session: { id: 'ssh-1', title: 'running build', state: 'running' }, nextAfterSequence: 1, events: [] })

test('intermittent subscription failures do not close a running shell', async () => {
    const { poll, tab, closed } = fixture([new Error('transient'), ok(), new Error('transient'), ok(), new Error('transient')])
    for (let i = 0; i < 5; i++) await poll(tab)
    assert.deepEqual(closed, [])
    assert.equal(tab.pollErrors, 1)
})
test('transport failures notify once and preserve a possibly live session', async () => {
    const { poll, tab, closed, notices } = fixture(Array.from({ length: 5 }, () => new Error('pipe busy')))
    for (let i = 0; i < 5; i++) await poll(tab)
    assert.deepEqual(closed, [])
    assert.equal(notices.length, 1)
})
test('confirmed shell exit still closes the tab', async () => {
    const result = ok(); result.session.state = 'exited'
    const { poll, tab, closed } = fixture([result])
    await poll(tab)
    assert.deepEqual(closed, ['ssh-1'])
})
test('successful subscription re-arms notification for a later outage', async () => {
    const failure = () => new Error('temporary failure')
    const { poll, tab, notices } = fixture([failure(), failure(), failure(), ok(), failure(), failure(), failure()])
    for (let i = 0; i < 7; i++) await poll(tab)
    assert.equal(notices.length, 2)
})
