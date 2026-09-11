import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { startConversationProcess } from './conversation-process.mjs'

const copy = value => structuredClone(value)
const text = (value, max = 16000) => typeof value === 'string' && value.trim() && value.length <= max

// One owner (the management sidecar) writes this file. Never route messages
// through the interactive terminal, and never replay an uncertain delivery.
export class ConversationService {
    constructor (file, factory = startConversationProcess) {
        this.file = file
        this.factory = factory
        this.handles = new Map()
        this.activeAgents = new Set()
        this.state = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { version: 1, configs: {}, rooms: [] }
        if (this.state.version !== 1 || !Array.isArray(this.state.rooms)) throw new Error('不支持的会话记录格式')
        for (const room of this.state.rooms) {
            if (room.status === 'running') {
                room.status = 'interrupted'
                room.error = '服务已重启，上一条消息的投递结果未知；未自动重发。'
            }
        }
        this.save()
    }
    save () {
        fs.mkdirSync(path.dirname(this.file), { recursive: true })
        const data = JSON.stringify(this.state)
        if (Buffer.byteLength(data) > 32 * 1024 * 1024) throw new Error('会话记录已达到 32 MB，请先备份历史记录')
        fs.writeFileSync(this.file + '.tmp', data, { mode: 0o600 })
        // Windows scanners can briefly hold the destination without delete
        // sharing. Keep the old file intact and retry the atomic replacement.
        for (let attempt = 0; ; attempt++) {
            try { fs.renameSync(this.file + '.tmp', this.file); break } catch (error) {
                if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt >= 10) throw error
                Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20)
            }
        }
    }
    room (id, registry) {
        const room = this.state.rooms.find(room => room.id === id)
        if (!room || room.workspaceId !== registry.workspaceId) throw new Error('当前工作区中找不到此会话')
        return room
    }
    agent (id, registry) {
        const agent = registry.agents.find(agent => agent.id === id && agent.workspaceId === registry.workspaceId)
        if (!agent) throw new Error('Agent 未注册在当前工作区')
        return agent
    }
    call (method, params, registry) {
        if (!text(registry?.workspaceId, 200) || !Array.isArray(registry.agents)) throw new Error('需要有效工作区')
        if (method === 'conversation.configs') return copy(Object.fromEntries(registry.agents.map(a => [a.id, this.state.configs[a.id] ?? null])))
        if (method === 'conversation.configure') {
            this.agent(params.agentId, registry)
            if (this.activeAgents.has(params.agentId)) throw new Error('Agent 正在通讯，请完成后修改配置')
            const c = params.config
            if (!c || !['pi', 'hermes', 'codex'].includes(c.kind) || !text(c.executable, 4096) || !text(c.cwd, 4096) || !Array.isArray(c.args) || c.args.length > 100 || c.args.some(a => typeof a !== 'string' || a.length > 4096)) throw new Error('请填写协议、可执行文件、参数数组和工作目录')
            if (c.launchCwd && !text(c.launchCwd, 4096)) throw new Error('本地启动目录无效')
            this.state.configs[params.agentId] = { kind: c.kind, executable: c.executable.trim(), args: c.args, cwd: c.cwd.trim(), launchCwd: c.launchCwd?.trim() || '', timeoutMs: Math.min(300000, Math.max(10000, Number(c.timeoutMs) || 120000)) }
            this.dropAgent(params.agentId)
            this.save()
            return copy(this.state.configs[params.agentId])
        }
        if (method === 'conversation.list') return copy(this.state.rooms.filter(room => room.workspaceId === registry.workspaceId).map(({ messages, ...room }) => ({ ...room, messageCount: messages.length })).reverse())
        if (method === 'conversation.create') {
            const ids = params.agentIds
            if (!Array.isArray(ids) || ids.length !== 2 || ids[0] === ids[1]) throw new Error('请选择两个不同的已注册 Agent')
            const names = Object.fromEntries(ids.map(id => [id, this.agent(id, registry).name]))
            if (this.state.rooms.length >= 200) throw new Error('最多保存 200 个会话，请先备份历史记录')
            const room = { id: randomUUID(), workspaceId: registry.workspaceId, title: text(params.title, 100) ? params.title.trim() : `${names[ids[0]]} ↔ ${names[ids[1]]}`, agentIds: ids, names, nativeSessions: {}, status: 'idle', messages: [], requests: [], createdAt: Date.now(), updatedAt: Date.now(), error: '' }
            this.state.rooms.push(room)
            this.save()
            return copy(room)
        }
        if (method === 'conversation.invalidate') {
            const agentId = text(params.agentId, 200) ? params.agentId : null
            const reason = text(params.reason, 500) ? params.reason.trim() : 'Agent 注册或工作区已变更，已停止后续转发。'
            let cancelled = 0
            for (const room of this.state.rooms) {
                if (room.workspaceId !== registry.workspaceId || (agentId && !room.agentIds.includes(agentId))) continue
                if (room.status === 'running') {
                    room.status = 'cancelled'
                    room.error = reason
                    room.activeAgentId = null
                    room.updatedAt = Date.now()
                    cancelled += 1
                }
                this.dropRoom(room.id)
                for (const id of room.agentIds) this.activeAgents.delete(id)
            }
            this.save()
            return { cancelled }
        }
        const room = this.room(params.conversationId, registry)
        if (method === 'conversation.read') {
            const invalid = room.status === 'running' && room.agentIds.find(id => {
                const agent = registry.agents.find(candidate => candidate.id === id && candidate.workspaceId === registry.workspaceId)
                return !agent?.scopes?.includes('llm.prompt')
            })
            if (invalid) {
                room.status = 'cancelled'
                room.error = 'Agent 已注销或失去发送提示词权限，已停止后续转发。'
                room.activeAgentId = null
                room.updatedAt = Date.now()
                this.dropRoom(room.id)
                for (const id of room.agentIds) this.activeAgents.delete(id)
                this.save()
            }
            return copy(room)
        }
        if (method === 'conversation.cancel') {
            if (room.status === 'running') {
                room.status = 'cancelled'
                room.error = '已停止后续转发并断开协议连接；不自动重发，外部工具的已发生操作不会回滚。'
                this.dropRoom(room.id)
                this.save()
            }
            return copy(room)
        }
        if (method !== 'conversation.send') throw new Error('不支持的会话操作')
        if (!text(params.requestId, 100)) throw new Error('消息缺少请求标识')
        if (room.requests.includes(params.requestId)) return copy(room)
        if (room.status === 'running' || room.agentIds.some(id => this.activeAgents.has(id))) throw new Error('Agent 正在处理其他消息，请等待完成')
        if (!text(params.text) || !Number.isInteger(params.turns) || params.turns < 1 || params.turns > 6) throw new Error('请输入 1–16000 字符的消息，回复次数为 1–6')
        if (room.messages.length > 900) throw new Error('此会话消息过多，请新建会话')
        for (const id of room.agentIds) {
            const agent = this.agent(id, registry)
            if (!agent.scopes?.includes('llm.prompt')) throw new Error(`${agent.name} 缺少发送提示词权限`)
            if (!this.state.configs[id]) throw new Error(`请先配置 ${agent.name} 的通讯方式`)
        }
        room.status = 'running'
        room.error = ''
        room.requests.push(params.requestId)
        const runId = params.requestId
        room.runId = runId
        this.message(room, { kind: 'prompt', from: 'user', to: room.agentIds[0], text: params.text.trim(), runId })
        this.save()
        for (const id of room.agentIds) this.activeAgents.add(id)
        void this.run(room, params.text.trim(), params.turns, runId)
        return copy(room)
    }
    message (room, message) {
        room.messages.push({ id: randomUUID(), ...message, createdAt: Date.now() })
        room.updatedAt = Date.now()
    }
    async connection (room, id) {
        const key = room.id + ':' + id
        const existing = this.handles.get(key)
        if (existing && !existing.peer?.closed) return existing
        const spec = copy(this.state.configs[id])
        const conversationId = room.nativeSessions[id]
        // Pi selects its saved conversation through launch argv, not an RPC.
        if (conversationId && spec.kind === 'pi') spec.args.push('--session', conversationId)
        const remoteTransport = /^(ssh|wsl)(\.exe)?$/i.test(path.basename(spec.executable))
        const handle = this.factory({ ...spec, cwd: spec.launchCwd || (remoteTransport ? process.cwd() : spec.cwd) })
        this.handles.set(key, handle)
        try {
            const identity = await handle.adapter.connect({ ...spec, ...(conversationId ? { conversationId } : { create: true }) })
            room.nativeSessions[id] = identity.conversationId
            this.save()
            return handle
        } catch (error) {
            handle.close()
            this.handles.delete(key)
            throw error
        }
    }
    async run (room, initial, turns, runId) {
        let content = initial
        try {
            for (let index = 0; index < turns; index++) {
                if (room.status !== 'running' || room.runId !== runId) break
                const id = room.agentIds[index % 2]
                room.activeAgentId = id
                this.save()
                const handle = await this.connection(room, id)
                if (room.status !== 'running') break
                const instruction = index === 0 ? content : `来自协作 Agent ${room.names[room.agentIds[(index - 1) % 2]]} 的消息：\n${content}\n\n请直接回复对方，继续处理本次协作议题。`
                const result = await handle.adapter.prompt(instruction)
                if (room.status !== 'running') break
                content = result.text
                this.message(room, { kind: 'reply', from: id, to: index + 1 < turns ? room.agentIds[(index + 1) % 2] : 'user', text: content, nativeConversationId: room.nativeSessions[id], runId })
                this.save()
            }
            if (room.status === 'running') room.status = 'completed'
        } catch (error) {
            if (room.status === 'running') {
                room.status = 'failed'
                room.error = error.message || '通讯失败'
                this.message(room, { kind: 'error', from: room.activeAgentId, to: 'user', text: room.error, runId })
            }
            this.dropRoom(room.id)
        } finally {
            room.activeAgentId = null
            room.updatedAt = Date.now()
            for (const id of room.agentIds) this.activeAgents.delete(id)
            this.dropRoom(room.id)
            try { this.save() } catch (error) { room.status = 'failed'; room.error = `保存会话失败：${error.message}` }
        }
    }
    dropRoom (roomId) {
        const prefix = roomId + ':'
        for (const [key, handle] of this.handles) {
            if (key.startsWith(prefix)) { handle.close(); this.handles.delete(key) }
        }
    }
    dropAgent (id) {
        for (const [key, handle] of this.handles) {
            if (key.endsWith(':' + id)) { handle.close(); this.handles.delete(key) }
        }
    }
    close () {
        for (const room of this.state.rooms) if (room.status === 'running') { room.status = 'interrupted'; room.error = '通讯服务已停止；未自动重发。' }
        for (const handle of this.handles.values()) handle.close()
        this.handles.clear()
        this.save()
    }
}
