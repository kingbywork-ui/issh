import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ConversationService } from '../src/conversation-service.mjs'

const registry = { workspaceId: 'w1', agents: ['a', 'b'].map(id => ({ id, name: id, workspaceId: 'w1', scopes: ['llm.prompt'] })) }
const config = { kind: 'pi', executable: 'pi', args: ['--mode', 'rpc'], cwd: '/tmp' }
function fixture(t, factory) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'issh-conversation-'))
    const file = path.join(dir, 'history.json')
    const service = new ConversationService(file, factory || (() => ({ adapter: { connect: async () => ({ conversationId: 'native-1' }), prompt: async text => ({ text: 'reply:' + text, conversationId: 'native-1' }) }, close () {} })))
    t.after(() => { service.close(); fs.rmSync(dir, { recursive: true, force: true }) })
    service.call('conversation.configure', { agentId: 'a', config }, registry)
    service.call('conversation.configure', { agentId: 'b', config }, registry)
    return { service, file }
}
async function finished(service, id) {
    for (let n = 0; n < 100; n++) {
        const room = service.call('conversation.read', { conversationId: id }, registry)
        if (room.status !== 'running') return room
        await new Promise(resolve => setTimeout(resolve, 5))
    }
    throw new Error('room did not finish')
}
test('registered A -> B -> A preserves native sessions and durable history', async t => {
    const { service, file } = fixture(t)
    const room = service.call('conversation.create', { agentIds: ['a', 'b'], title: 'Pair' }, registry)
    service.call('conversation.send', { conversationId: room.id, requestId: 'request-1', text: 'hello', turns: 3 }, registry)
    const done = await finished(service, room.id)
    assert.equal(done.status, 'completed')
    assert.deepEqual(done.messages.filter(m => m.kind === 'reply').map(m => m.from), ['a', 'b', 'a'])
    assert.equal(done.nativeSessions.a, 'native-1')
    service.call('conversation.send', { conversationId: room.id, requestId: 'request-1', text: 'hello', turns: 3 }, registry)
    assert.equal(service.call('conversation.read', { conversationId: room.id }, registry).messages.length, done.messages.length)
    const reopened = new ConversationService(file)
    assert.deepEqual(reopened.call('conversation.read', { conversationId: room.id }, registry).messages, done.messages)
    reopened.close()
})
test('rejects unregistered/cross-workspace agents, missing permission and overlapping turns', async t => {
    let release
    const { service } = fixture(t, () => ({ adapter: { connect: async () => ({ conversationId: 'native' }), prompt: () => new Promise(resolve => { release = resolve }) }, close () {} }))
    assert.throws(() => service.call('conversation.create', { agentIds: ['a', 'other'] }, registry), /注册/)
    const room = service.call('conversation.create', { agentIds: ['a', 'b'] }, registry)
    assert.throws(() => service.call('conversation.read', { conversationId: room.id }, { ...registry, workspaceId: 'w2' }), /工作区/)
    assert.throws(() => service.call('conversation.send', { conversationId: room.id, requestId: 'x', text: 'test', turns: 2 }, { ...registry, agents: registry.agents.map(a => ({ ...a, scopes: [] })) }), /权限/)
    service.call('conversation.send', { conversationId: room.id, requestId: 'x', text: 'test', turns: 2 }, registry)
    assert.throws(() => service.call('conversation.send', { conversationId: room.id, requestId: 'y', text: 'other', turns: 2 }, registry), /正在/)
    await new Promise(resolve => setTimeout(resolve, 5))
    service.call('conversation.cancel', { conversationId: room.id }, registry)
    release?.({ text: 'late reply' })
    assert.equal((await finished(service, room.id)).status, 'cancelled')
})
test('delivery errors remain visible and are not automatically replayed', async t => {
    const { service } = fixture(t, () => ({ adapter: { connect: async () => ({ conversationId: 'native' }), prompt: async () => { throw new Error('delivery outcome unknown') } }, close () {} }))
    const room = service.call('conversation.create', { agentIds: ['a', 'b'] }, registry)
    service.call('conversation.send', { conversationId: room.id, requestId: 'x', text: 'test', turns: 2 }, registry)
    const done = await finished(service, room.id)
    assert.equal(done.status, 'failed')
    assert.match(done.error, /delivery outcome unknown/)
    assert.equal(done.messages.filter(m => m.kind === 'reply').length, 0)
})

test('completed conversations release protocol processes and resume from native ids', async t => {
    let closes = 0
    const { service } = fixture(t, () => ({
        adapter: {
            connect: async () => ({ conversationId: 'native' }),
            prompt: async text => ({ text: 'reply:' + text, conversationId: 'native' }),
        },
        close () { closes += 1 },
    }))
    const room = service.call('conversation.create', { agentIds: ['a', 'b'] }, registry)
    service.call('conversation.send', { conversationId: room.id, requestId: 'release-1', text: 'test', turns: 2 }, registry)
    assert.equal((await finished(service, room.id)).status, 'completed')
    assert.equal(closes, 2)
    assert.equal(service.handles.size, 0)
    service.call('conversation.send', { conversationId: room.id, requestId: 'release-2', text: 'again', turns: 1 }, registry)
    assert.equal((await finished(service, room.id)).status, 'completed')
    assert.equal(closes, 3)
})

test('registry invalidation stops an active multi-turn conversation', async t => {
    let release
    let prompts = 0
    let closes = 0
    const { service } = fixture(t, () => ({
        adapter: {
            connect: async () => ({ conversationId: 'native' }),
            prompt: () => { prompts += 1; return new Promise(resolve => { release = resolve }) },
        },
        close () { closes += 1 },
    }))
    const room = service.call('conversation.create', { agentIds: ['a', 'b'] }, registry)
    service.call('conversation.send', { conversationId: room.id, requestId: 'invalidate-1', text: 'test', turns: 6 }, registry)
    await new Promise(resolve => setTimeout(resolve, 5))
    const result = service.call('conversation.invalidate', { agentId: 'a', reason: 'Agent 已注销' }, registry)
    assert.equal(result.cancelled, 1)
    release?.({ text: 'late reply' })
    const stopped = await finished(service, room.id)
    assert.equal(stopped.status, 'cancelled')
    assert.equal(prompts, 1)
    assert.ok(closes >= 1)
})
