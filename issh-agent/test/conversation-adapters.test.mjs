import test from 'node:test'
import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import { JsonLinePeer, PiRpcPeer, ConversationAdapter } from '../src/conversation-adapters.mjs'

function fixture (handler) {
    const input = new PassThrough()
    const output = new PassThrough()
    const seen = []
    let buffer = ''
    const send = message => output.write(JSON.stringify(message) + '\n')
    input.on('data', chunk => {
        buffer += chunk
        while (buffer.includes('\n')) {
            const index = buffer.indexOf('\n')
            const message = JSON.parse(buffer.slice(0, index))
            buffer = buffer.slice(index + 1)
            seen.push(message)
            handler(message, send)
        }
    })
    return { peer: new JsonLinePeer(output, input, { timeoutMs: 1000 }), seen, send, output }
}

test('Codex replies stay on the selected thread even when completion precedes RPC response', async () => {
    const f = fixture((m, send) => {
        if (m.method === 'initialize') send({ id: m.id, result: {} })
        if (m.method === 'thread/resume') send({ id: m.id, result: { thread: { id: m.params.threadId } } })
        if (m.method === 'turn/start') {
            send({ method: 'item/completed', params: { threadId: 'other', turnId: 't1', item: { type: 'agentMessage', text: 'wrong' } } })
            send({ method: 'item/completed', params: { threadId: 'existing', turnId: 't1', item: { type: 'agentMessage', text: 'reply' } } })
            send({ method: 'turn/completed', params: { threadId: 'existing', turn: { id: 't1', status: 'completed' } } })
            send({ id: m.id, result: { turn: { id: 't1' } } })
        }
    })
    const adapter = new ConversationAdapter('codex', f.peer)
    try {
        await adapter.connect({ conversationId: 'existing', cwd: '/tmp' })
        assert.deepEqual(await adapter.prompt('hello'), { conversationId: 'existing', text: 'reply' })
        assert.equal(f.seen.some(m => m.method === 'thread/start'), false)
    } finally { f.peer.close() }
})

test('Hermes loads the exact session and collects only that session message chunks', async () => {
    const f = fixture((m, send) => {
        if (m.method === 'initialize') send({ id: m.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } })
        if (m.method === 'session/load') send({ id: m.id, result: {} })
        if (m.method === 'session/prompt') {
            send({ method: 'session/update', params: { sessionId: 'existing', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hello back' } } } })
            send({ id: m.id, result: { stopReason: 'end_turn' } })
        }
    })
    try {
        const adapter = new ConversationAdapter('hermes', f.peer)
        await adapter.connect({ conversationId: 'existing', cwd: '/tmp' })
        assert.equal((await adapter.prompt('hello')).text, 'hello back')
        assert.equal(f.seen.find(m => m.method === 'session/load').params.sessionId, 'existing')
    } finally { f.peer.close() }
})

test('unsupported resume fails without silently creating a conversation', async () => {
    const f = fixture((m, send) => send({ id: m.id, result: { protocolVersion: 1, agentCapabilities: {} } }))
    try {
        await assert.rejects(new ConversationAdapter('hermes', f.peer).connect({ conversationId: 'existing', cwd: '/tmp' }), /resume/)
        assert.equal(f.seen.length, 1)
    } finally { f.peer.close() }
})

test('disconnect rejects in-flight requests and unsolicited execution requests are refused', async () => {
    const f = fixture(() => {})
    f.send({ id: 'remote-1', method: 'terminal/create', params: { command: 'danger' } })
    assert.equal(f.seen[0].error.code, -32601)
    const pending = f.peer.request('pending', {})
    f.output.end()
    await assert.rejects(pending, /closed/)
    f.peer.close()
})

test('timeout closes transport rather than permitting unsafe automatic retry', async () => {
    const f = fixture(() => {})
    f.peer.timeoutMs = 20
    await assert.rejects(f.peer.request('session/prompt', {}), /outcome unknown/)
    await assert.rejects(f.peer.request('session/prompt', {}), /closed/)
    assert.equal(f.seen.length, 1)
})

function piFixture (handler) {
    const input = new PassThrough()
    const output = new PassThrough()
    const seen = []
    let buffer = ''
    const send = message => output.write(JSON.stringify(message) + '\n')
    input.on('data', chunk => {
        buffer += chunk
        while (buffer.includes('\n')) {
            const index = buffer.indexOf('\n')
            const message = JSON.parse(buffer.slice(0, index))
            buffer = buffer.slice(index + 1)
            seen.push(message)
            handler(message, send)
        }
    })
    return { peer: new PiRpcPeer(output, input, { timeoutMs: 1000 }), seen, send, output }
}

test('Pi loads its session identity and returns the last assistant text', async () => {
    const f = piFixture((m, send) => {
        if (m.type === 'get_state') send({ id: m.id, type: 'response', command: 'get_state', success: true, data: { sessionId: 'pi-session-1' } })
        if (m.type === 'prompt') {
            send({ id: m.id, type: 'response', command: 'prompt', success: true })
            send({ type: 'agent_start' })
            send({ type: 'turn_start' })
            send({ type: 'message_update', usage: {}, assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'pi reply' } })
            send({ type: 'agent_end', messages: [] })
        }
        if (m.type === 'get_last_assistant_text') send({ id: m.id, type: 'response', command: 'get_last_assistant_text', success: true, data: { text: 'pi reply' } })
    })
    try {
        const adapter = new ConversationAdapter('pi', f.peer)
        await adapter.connect({ create: true, cwd: '/home/pi' })
        assert.equal((await adapter.prompt('hello')).text, 'pi reply')
        assert.equal(f.seen.find(m => m.type === 'prompt').message, 'hello')
    } finally { f.peer.close() }
})

test('Pi rejects resume when attached to a different session', async () => {
    const f = piFixture((m, send) => {
        if (m.type === 'get_state') send({ id: m.id, type: 'response', command: 'get_state', success: true, data: { sessionId: 'pi-session-2' } })
    })
    try {
        await assert.rejects(new ConversationAdapter('pi', f.peer).connect({ conversationId: 'pi-session-1', cwd: '/home/pi' }), /different conversation/)
    } finally { f.peer.close() }
})

test('busy Agent rejects concurrent turns and can accept another turn after completion', async () => {
    let finish
    const f = fixture((m, send) => {
        if (m.method === 'initialize') send({ id: m.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } })
        if (m.method === 'session/load') send({ id: m.id, result: {} })
        if (m.method === 'session/prompt') finish = () => {
            send({ method: 'session/update', params: { sessionId: 'existing', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ok' } } } })
            send({ id: m.id, result: { stopReason: 'end_turn' } })
        }
    })
    try {
        const adapter = new ConversationAdapter('hermes', f.peer)
        await adapter.connect({ conversationId: 'existing', cwd: '/tmp' })
        const first = adapter.prompt('first')
        await assert.rejects(adapter.prompt('second'), /busy/)
        finish()
        await first
        const second = adapter.prompt('second')
        finish()
        assert.equal((await second).text, 'ok')
    } finally { f.peer.close() }
})
