import { EventEmitter } from 'node:events'

const MAX_BYTES = 1024 * 1024

// Transport-independent JSONL peer: local process pipes or a dedicated SSH exec
// channel, never the user's interactive terminal input stream.
export class JsonLinePeer extends EventEmitter {
    constructor (readable, writable, { timeoutMs = 60000 } = {}) {
        super()
        this.writable = writable
        this.timeoutMs = timeoutMs
        this.pending = new Map()
        this.sequence = 0
        this.closed = false
        let buffer = ''
        readable.setEncoding('utf8')
        readable.on('data', chunk => {
            buffer += chunk
            if (Buffer.byteLength(buffer) > MAX_BYTES) return this.close(new Error('Protocol frame exceeds limit'))
            while (buffer.includes('\n') && !this.closed) {
                const index = buffer.indexOf('\n')
                const line = buffer.slice(0, index)
                buffer = buffer.slice(index + 1)
                if (!line.trim()) continue
                try { this.receive(JSON.parse(line)) } catch { this.close(new Error('Invalid protocol frame')) }
            }
        })
        readable.on('end', () => this.close())
        readable.on('error', () => this.close(new Error('Protocol read failed')))
        writable.on('error', () => this.close(new Error('Protocol write failed')))
    }

    send (message) {
        if (this.closed) throw new Error('Protocol connection closed')
        const line = JSON.stringify(message) + '\n'
        if (Buffer.byteLength(line) > MAX_BYTES) throw new Error('Protocol frame exceeds limit')
        this.writable.write(line)
    }

    request (method, params) {
        if (this.closed) return Promise.reject(new Error('Protocol connection closed'))
        const id = ++this.sequence
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                // A timed-out prompt may still be running: never reuse this
                // connection for another turn or blindly retry the same prompt.
                this.close(new Error(`Protocol timeout: ${method}; delivery outcome unknown`))
            }, this.timeoutMs)
            this.pending.set(id, { resolve, reject, timer })
            try { this.send({ jsonrpc: '2.0', id, method, params }) } catch (error) { this.close(error) }
        })
    }

    notify (method, params = {}) { this.send({ jsonrpc: '2.0', method, params }) }

    receive (message) {
        if (message.method && message.id !== undefined) {
            // This initial adapter does not grant execution/file permissions.
            if (message.method === 'session/request_permission') {
                this.send({ jsonrpc: '2.0', id: message.id, result: { outcome: { outcome: 'cancelled' } } })
            } else if (['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'].includes(message.method)) {
                this.send({ id: message.id, result: { decision: 'decline' } })
            } else {
                this.send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Client capability not enabled' } })
            }
            return
        }
        if (message.method) return this.emit('notification', message)
        const pending = this.pending.get(message.id)
        if (!pending) return
        clearTimeout(pending.timer)
        this.pending.delete(message.id)
        if (message.error) pending.reject(new Error(message.error.message || 'Agent RPC failed'))
        else pending.resolve(message.result)
    }

    close (error = new Error('Protocol connection closed')) {
        if (this.closed) return
        this.closed = true
        for (const pending of this.pending.values()) {
            clearTimeout(pending.timer)
            pending.reject(error)
        }
        this.pending.clear()
        this.emit('closed', error)
    }
}

// Pi coding-agent RPC mode uses a custom JSON protocol over stdin/stdout,
// not JSON-RPC 2.0: commands carry an optional id that responses echo, and
// agent lifecycle events stream as id-less JSON records.
export class PiRpcPeer extends EventEmitter {
    constructor (readable, writable, { timeoutMs = 60000 } = {}) {
        super()
        this.writable = writable
        this.timeoutMs = timeoutMs
        this.pending = new Map()
        this.sequence = 0
        this.closed = false
        let buffer = ''
        readable.setEncoding('utf8')
        readable.on('data', chunk => {
            buffer += chunk
            if (Buffer.byteLength(buffer) > MAX_BYTES) return this.close(new Error('Protocol frame exceeds limit'))
            while (buffer.includes('\n') && !this.closed) {
                const index = buffer.indexOf('\n')
                const line = buffer.slice(0, index)
                buffer = buffer.slice(index + 1)
                if (!line.trim()) continue
                try { this.receive(JSON.parse(line)) } catch { this.close(new Error('Invalid protocol frame')) }
            }
        })
        readable.on('end', () => this.close())
        readable.on('error', () => this.close(new Error('Protocol read failed')))
        writable.on('error', () => this.close(new Error('Protocol write failed')))
    }

    command (type, fields = {}) {
        if (this.closed) return Promise.reject(new Error('Protocol connection closed'))
        const id = `req-${++this.sequence}`
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                // A timed-out prompt may still be running: never reuse this
                // connection for another turn or blindly retry the same prompt.
                this.close(new Error(`Protocol timeout: ${type}; delivery outcome unknown`))
            }, this.timeoutMs)
            this.pending.set(id, { resolve, reject, timer })
            try { this.writable.write(JSON.stringify({ id, type, ...fields }) + '\n') } catch (error) { this.close(error) }
        })
    }

    receive (message) {
        if (message.type === 'response' && message.id !== undefined) {
            const pending = this.pending.get(message.id)
            if (!pending) return
            clearTimeout(pending.timer)
            this.pending.delete(message.id)
            if (message.success === false) pending.reject(new Error(message.error || `Agent command failed: ${message.command}`))
            else pending.resolve(message)
            return
        }
        if (message.type === 'response') return
        this.emit('notification', message)
    }

    close (error = new Error('Protocol connection closed')) {
        if (this.closed) return
        this.closed = true
        for (const pending of this.pending.values()) {
            clearTimeout(pending.timer)
            pending.reject(error)
        }
        this.pending.clear()
        this.emit('closed', error)
    }
}

export class ConversationAdapter {
    constructor (kind, peer) {
        if (!['codex', 'hermes', 'pi'].includes(kind)) throw new Error('Unsupported Agent protocol')
        this.kind = kind
        this.peer = peer
        this.conversationId = null
        this.busy = false
    }

    async connect ({ conversationId, cwd, create = false }) {
        if (this.conversationId) throw new Error('Adapter already connected')
        if (!conversationId && !create) throw new Error('Explicit conversationId or create is required')
        if (conversationId && create) throw new Error('Cannot create and resume simultaneously')
        if (typeof cwd !== 'string' || !cwd.trim()) throw new Error('cwd is required')
        if (this.kind === 'codex') {
            await this.peer.request('initialize', { clientInfo: { name: 'issh_agent_bridge', version: '0.1.0' } })
            this.peer.notify('initialized')
            const params = { cwd, approvalPolicy: 'untrusted', sandbox: 'read-only' }
            const result = await this.peer.request(conversationId ? 'thread/resume' : 'thread/start',
                conversationId ? { ...params, threadId: conversationId } : params)
            const id = result?.thread?.id
            if (!id || (conversationId && id !== conversationId)) throw new Error('Agent returned a different conversation')
            this.conversationId = id
        } else if (this.kind === 'hermes') {
            const initialized = await this.peer.request('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'issh_agent_bridge', version: '0.1.0' } })
            if (initialized?.protocolVersion !== 1) throw new Error('Unsupported ACP protocol version')
            if (conversationId && !initialized?.agentCapabilities?.loadSession) throw new Error('Agent does not support session resume')
            const result = await this.peer.request(conversationId ? 'session/load' : 'session/new',
                { cwd, mcpServers: [], ...(conversationId ? { sessionId: conversationId } : {}) })
            this.conversationId = conversationId || result?.sessionId
            if (!this.conversationId) throw new Error('Agent returned no conversation identity')
        } else {
            // Pi RPC mode starts a fresh session automatically; get_state
            // reports its identity. Session selection happens via pi launch
            // arguments (--session), not through an RPC resume handshake.
            const state = await this.peer.command('get_state')
            const sessionId = state?.data?.sessionId || null
            if (conversationId && sessionId && conversationId !== sessionId) throw new Error('Agent is attached to a different conversation')
            if (!sessionId && create) {
                await this.peer.command('new_session')
                const fresh = await this.peer.command('get_state')
                this.conversationId = fresh?.data?.sessionId || null
            } else {
                this.conversationId = sessionId
            }
            if (!this.conversationId) throw new Error('Agent returned no conversation identity')
        }
        return { conversationId: this.conversationId, kind: this.kind }
    }

    async prompt (text) {
        if (!this.conversationId) throw new Error('Adapter is not connected')
        if (this.busy) throw new Error('Agent is busy; enqueue the message')
        if (typeof text !== 'string' || !text.trim() || text.length > 16000) throw new Error('Message must contain 1-16000 characters')
        this.busy = true
        const notifications = []
        let bytes = 0
        let wake = () => {}
        const collect = this.kind === 'pi'
            ? message => {
                bytes += Buffer.byteLength(JSON.stringify(message))
                if (bytes > MAX_BYTES) return this.peer.close(new Error('Agent response exceeds limit'))
                notifications.push(message)
                wake()
            }
            : message => {
                const p = message.params
                if ((p?.threadId || p?.sessionId) !== this.conversationId) return
                bytes += Buffer.byteLength(JSON.stringify(message))
                if (bytes > MAX_BYTES) return this.peer.close(new Error('Agent response exceeds limit'))
                notifications.push(message)
                wake()
            }
        let closedError
        const closed = error => { closedError = error; wake() }
        this.peer.on('notification', collect)
        this.peer.on('closed', closed)
        const timer = setTimeout(() => this.peer.close(new Error('Agent turn timed out; delivery outcome unknown')), this.peer.timeoutMs)
        try {
            let output
            if (this.kind === 'codex') {
                const started = await this.peer.request('turn/start', { threadId: this.conversationId, input: [{ type: 'text', text }] })
                const turnId = started?.turn?.id
                if (!turnId) throw new Error('Agent returned no turn identity')
                let completed
                while (!(completed = notifications.find(m => m.method === 'turn/completed' && m.params.turn?.id === turnId))) {
                    if (closedError || this.peer.closed) throw closedError || new Error('Protocol connection closed')
                    await new Promise(resolve => { wake = resolve })
                }
                if (completed.params.turn.status !== 'completed') throw new Error(`Agent turn ${completed.params.turn.status}`)
                output = notifications.filter(m => m.method === 'item/completed' && m.params.turnId === turnId && m.params.item?.type === 'agentMessage')
                    .map(m => m.params.item.text).join('\n')
            } else if (this.kind === 'hermes') {
                const result = await this.peer.request('session/prompt', { sessionId: this.conversationId, prompt: [{ type: 'text', text }] })
                if (result?.stopReason !== 'end_turn') throw new Error(`Agent stopped: ${result?.stopReason}`)
                output = notifications.filter(m => m.method === 'session/update' && m.params.update?.sessionUpdate === 'agent_message_chunk' && m.params.update.content?.type === 'text')
                    .map(m => m.params.update.content.text).join('')
            } else {
                await this.peer.command('prompt', { message: text })
                let completed
                while (!(completed = notifications.find(m => m.type === 'agent_end'))) {
                    if (closedError || this.peer.closed) throw closedError || new Error('Protocol connection closed')
                    await new Promise(resolve => { wake = resolve })
                }
                const last = await this.peer.command('get_last_assistant_text')
                output = last?.data?.text || null
            }
            if (!output) throw new Error('Agent completed without a text reply')
            return { conversationId: this.conversationId, text: output }
        } finally {
            clearTimeout(timer)
            this.peer.off('notification', collect)
            this.peer.off('closed', closed)
            this.busy = false
        }
    }
}
