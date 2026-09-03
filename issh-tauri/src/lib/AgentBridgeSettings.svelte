<script lang="ts">
    import { onMount } from 'svelte'
    import {
        agentBridgeAuditClear,
        agentBridgeAuditRead,
        agentBridgeConfigure,
        agentBridgeDisable,
        agentBridgeEnable,
        agentBridgeRotateToken,
        agentBridgeStatus,
        type AgentBridgeStatus,
    } from './runtime'

    const ALL_SCOPES = ['read', 'write', 'exec', 'sftp']
    const READ_SCOPES = ['read']
    const PORT = 59688

    let status = $state<AgentBridgeStatus | null>(null)
    let busy = $state(false)
    let loading = $state(true)
    let error = $state('')
    let notice = $state('')
    let showToken = $state(false)
    let auditText = $state('')
    let showAudit = $state(false)
    let auditBusy = $state(false)
    let testResult = $state('')

    async function refresh (): Promise<void> {
        loading = true
        error = ''
        try {
            status = await agentBridgeStatus()
        } catch (cause) {
            error = cause instanceof Error ? cause.message : String(cause)
        } finally {
            loading = false
        }
    }

    async function toggle (value: boolean): Promise<void> {
        busy = true
        error = ''
        notice = ''
        try {
            status = value ? await agentBridgeEnable() : await agentBridgeDisable()
            notice = value ? `已开启，监听 127.0.0.1:${PORT}` : '已关闭'
        } catch (cause) {
            error = cause instanceof Error ? cause.message : String(cause)
        } finally {
            busy = false
        }
    }

    async function rotateToken (): Promise<void> {
        if (!window.confirm('轮换 token 后，外部 agent 需要更新连接信息才能继续使用。确认轮换？')) return
        busy = true
        error = ''
        notice = ''
        try {
            status = await agentBridgeRotateToken()
            notice = 'token 已轮换'
        } catch (cause) {
            error = cause instanceof Error ? cause.message : String(cause)
        } finally {
            busy = false
        }
    }

    async function savePatch (patch: {
        scopes?: string[]
        sftpRoot?: string | null
        auditLogEnabled?: boolean
        publicDiscovery?: boolean
    }): Promise<void> {
        busy = true
        error = ''
        notice = ''
        try {
            status = await agentBridgeConfigure(patch)
        } catch (cause) {
            error = cause instanceof Error ? cause.message : String(cause)
        } finally {
            busy = false
        }
    }

    function scopesFull (): boolean {
        const current = status?.scopes ?? []
        return ALL_SCOPES.every((scope) => current.includes(scope))
    }

    async function copyText (text: string): Promise<void> {
        try {
            await navigator.clipboard.writeText(text)
            notice = '已复制到剪贴板'
        } catch {
            error = '复制失败：当前环境不支持剪贴板访问'
        }
    }

    async function copyMcpConfig (kind: 'claude' | 'codex'): Promise<void> {
        const discovery = status?.publicDiscovery ? status.discoveryPath ?? '<数据目录>/issh-agent-bridge.json' : '<数据目录>/issh-agent-bridge.json'
        const text = kind === 'claude'
            ? JSON.stringify({
                mcpServers: {
                    issh: {
                        command: 'issh-agent',
                        args: ['mcp'],
                        env: { ISSH_AGENT_BRIDGE_FILE: discovery },
                    },
                },
            }, null, 2)
            : `[mcp_servers.issh]\ncommand = "issh-agent"\nargs = ["mcp"]\nenv = { ISSH_AGENT_BRIDGE_FILE = "${discovery}" }`
        await copyText(text)
    }

    async function runTest (): Promise<void> {
        if (!status?.enabled) return
        busy = true
        error = ''
        testResult = ''
        try {
            const response = await fetch(`http://127.0.0.1:${PORT}/rpc`, {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    authorization: `Bearer ${status.token}`,
                },
                body: JSON.stringify({ id: 'ui-test', method: 'issh_health', params: {} }),
            })
            const payload = await response.json()
            if (response.ok && payload?.result?.ok) {
                testResult = `连接成功：${payload.result.tools.length} 个工具可用`
            } else {
                testResult = `连接失败：${payload?.error?.message ?? `HTTP ${response.status}`}`
            }
        } catch (cause) {
            testResult = `连接失败：${cause instanceof Error ? cause.message : String(cause)}`
        } finally {
            busy = false
        }
    }

    async function loadAudit (): Promise<void> {
        auditBusy = true
        error = ''
        try {
            auditText = await agentBridgeAuditRead()
            showAudit = true
        } catch (cause) {
            error = cause instanceof Error ? cause.message : String(cause)
        } finally {
            auditBusy = false
        }
    }

    async function clearAudit (): Promise<void> {
        if (!window.confirm('清除全部 Agent Bridge 审计日志？此操作不可恢复。')) return
        auditBusy = true
        error = ''
        try {
            await agentBridgeAuditClear()
            auditText = ''
            showAudit = false
            notice = '审计日志已清除'
        } catch (cause) {
            error = cause instanceof Error ? cause.message : String(cause)
        } finally {
            auditBusy = false
        }
    }

    onMount(() => {
        void refresh()
    })
</script>

<section aria-label="Agent Bridge">
    <div class="settings-field">
        <div class="settings-field-title">Agent Bridge（外部 AI Agent 接入）</div>
        <p class="settings-hint">把当前 issh 的终端会话通过本地 HTTP 暴露给 Codex、Cursor、Claude Desktop 等外部 agent，由 agent 安全地读取上下文、执行命令和管理 SFTP 文件。</p>
        <p class="settings-hint"><strong>安全语义</strong>：开关不会持久化，每次使用需手动开启；完全退出 issh 时自动关闭；最小化到托盘保持运行。端口固定为 {PORT}，仅监听本机 127.0.0.1。</p>
    </div>

    {#if error}<div class="settings-error">{error}</div>{/if}
    {#if notice}<div class="settings-hint vault-notice">{notice}</div>{/if}

    {#if loading}
        <div class="settings-empty">正在读取 Agent Bridge 状态…</div>
    {:else if status}
        <div class="settings-field">
            <div class="settings-field-title">
                运行状态
                {#if status.enabled}
                    <span class="host-badge recent">运行中</span>
                {:else}
                    <span class="host-badge">未开启</span>
                {/if}
            </div>
            <div class="sudo-actions">
                {#if status.enabled}
                    <button class="plugin-remove" type="button" disabled={busy} onclick={() => void toggle(false)}>关闭</button>
                {:else}
                    <button type="button" disabled={busy} onclick={() => void toggle(true)}>开启 Agent Bridge</button>
                {/if}
            </div>
            <p class="settings-hint">监听地址：127.0.0.1:{PORT}（固定端口，启动失败说明端口被占用）</p>
        </div>

        <div class="settings-field">
            <div class="settings-field-title">访问令牌</div>
            <p class="settings-hint">外部 agent 每次请求都需要携带此 token（Authorization: Bearer）。token 持久保存，重启后不变；如需失效旧凭据请轮换。</p>
            <div class="sudo-actions">
                <input class="agent-token" type={showToken ? 'text' : 'password'} readonly value={status.token} />
                <button type="button" onclick={() => { showToken = !showToken }}>{showToken ? '隐藏' : '显示'}</button>
                <button type="button" onclick={() => void copyText(status?.token ?? '')}>复制</button>
                <button class="plugin-remove" type="button" disabled={busy} onclick={() => void rotateToken()}>轮换</button>
            </div>
        </div>

        <div class="settings-field">
            <div class="settings-field-title">权限范围（scope）</div>
            <p class="settings-hint">只读模式只允许读取会话/上下文/预览命令；全量模式额外允许写入、执行命令与 SFTP 操作。</p>
            <label class="settings-toggle">
                <input
                    type="checkbox"
                    checked={!scopesFull()}
                    disabled={busy}
                    onchange={(event) => {
                        const readonly = (event.currentTarget as HTMLInputElement).checked
                        void savePatch({ scopes: readonly ? READ_SCOPES : ALL_SCOPES })
                    }}
                />
                <span>只读模式（read only）</span>
            </label>
        </div>

        <div class="settings-field">
            <div class="settings-field-title">SFTP 路径限制</div>
            <p class="settings-hint">留空表示不限制；填写绝对路径后，SFTP 读写仅允许在该目录之内。</p>
            <label>SFTP 根目录
                <input
                    type="text"
                    placeholder="/srv（留空=不限）"
                    value={status.sftpRoot ?? ''}
                    disabled={busy}
                    onblur={(event) => {
                        const root = (event.currentTarget as HTMLInputElement).value.trim()
                        void savePatch({ sftpRoot: root.length > 0 ? root : null })
                    }}
                />
            </label>
        </div>

        <div class="settings-field">
            <div class="settings-field-title">审计与发现</div>
            <label class="settings-toggle">
                <input
                    type="checkbox"
                    checked={status.auditLogEnabled}
                    disabled={busy}
                    onchange={(event) => {
                        void savePatch({ auditLogEnabled: (event.currentTarget as HTMLInputElement).checked })
                    }}
                />
                <span>记录审计日志（agent-bridge-audit.jsonl）</span>
            </label>
            <label class="settings-toggle">
                <input
                    type="checkbox"
                    checked={status.publicDiscovery}
                    disabled={busy}
                    onchange={(event) => {
                        void savePatch({ publicDiscovery: (event.currentTarget as HTMLInputElement).checked })
                    }}
                />
                <span>写 agent 可读的连接文件（discovery file）</span>
            </label>
            {#if status.publicDiscovery}
                <p class="settings-hint">连接文件：{status.discoveryPath}</p>
            {/if}
            <div class="sudo-actions">
                <button type="button" disabled={auditBusy} onclick={() => void loadAudit()}>查看审计日志</button>
                <button class="plugin-remove" type="button" disabled={auditBusy} onclick={() => void clearAudit()}>清除审计日志</button>
            </div>
            {#if showAudit}
                <pre class="agent-audit">{auditText.length > 0 ? auditText : '（暂无审计记录）'}</pre>
            {/if}
        </div>

        <div class="settings-field">
            <div class="settings-field-title">接入外部 agent</div>
            <p class="settings-hint">建议先开启上方「连接文件」开关，然后复制对应配置。issh-agent 的 CLI 与 stdio MCP server 已随安装包发布。</p>
            <div class="sudo-actions">
                <button type="button" onclick={() => void copyMcpConfig('claude')}>复制 Claude Desktop 配置</button>
                <button type="button" onclick={() => void copyMcpConfig('codex')}>复制 Codex 配置</button>
                <button type="button" disabled={busy || !status.enabled} onclick={() => void runTest()}>连接测试</button>
            </div>
            {#if testResult}<p class="settings-hint vault-notice">{testResult}</p>{/if}
        </div>
    {/if}
</section>
