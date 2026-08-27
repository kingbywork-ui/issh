<script lang="ts">
    import { writeSession, type RuntimeSessionSnapshot } from './runtime'

    let {
        tabs,
        activeId,
        onclose,
        onwrited,
    }: {
        tabs: RuntimeSessionSnapshot[]
        activeId: string
        onclose: () => void
        onwrited: (sessionId: string, bytes: Uint8Array) => void
    } = $props()

    type Scope = 'current' | 'all' | 'selected'

    let scope = $state<Scope>('current')
    let command = $state('')
    let appendNewline = $state(true)
    let collapsed = $state(false)
    let selectedIds = $state<Set<string>>(new Set())
    let sending = $state(false)
    let error = $state('')
    let notice = $state('')

    const openTabs = $derived(tabs.filter((tab) => tab.state !== 'closed'))

    const targets = $derived(openTabs.map((tab) => ({
        id: tab.id,
        title: tab.title,
        description: tab.kind === 'ssh' ? 'SSH 会话' : '本地会话',
    })))

    const selectedTargets = $derived(
        scope === 'selected' ? targets.filter((target) => selectedIds.has(target.id)) : [],
    )

    function scopeLabel (candidate: Scope): string {
        if (candidate === 'current') return '当前会话'
        if (candidate === 'all') return '全部会话'
        return '选择会话'
    }

    function setScope (candidate: Scope): void {
        scope = candidate
        if (candidate === 'selected') {
            selectedIds = new Set(activeId ? [activeId] : [])
        }
    }

    function toggleTarget (id: string): void {
        const next = new Set(selectedIds)
        if (next.has(id)) {
            next.delete(id)
        } else {
            next.add(id)
        }
        selectedIds = next
    }

    const canSend = $derived(
        command.trim().length > 0
        && !sending
        && (scope === 'selected' ? selectedTargets.length > 0 : openTabs.length > 0),
    )

    async function send (): Promise<void> {
        const text = command
        if (!text.trim()) return
        const receivers = scope === 'all'
            ? openTabs
            : scope === 'selected'
                ? openTabs.filter((tab) => selectedIds.has(tab.id))
                : openTabs.filter((tab) => tab.id === activeId)
        if (receivers.length === 0) return
        // all 范围广播到多个会话属高风险操作（可能含 rm 等命令），二次确认
        if (scope === 'all' && receivers.length > 1) {
            const confirmed = window.confirm(`即将把输入发送到全部 ${receivers.length} 个会话，确定继续？`)
            if (!confirmed) return
        }
        sending = true
        error = ''
        const payload = appendNewline && !text.endsWith('\n') ? `${text}\n` : text
        const bytes = new TextEncoder().encode(payload)
        let failed = 0
        for (const tab of receivers) {
            try {
                onwrited(tab.id, bytes)
            } catch {
                failed += 1
            }
        }
        notice = `已发送到 ${receivers.length - failed} 个会话${failed > 0 ? `，${failed} 个失败` : ''}`
        command = ''
        sending = false
    }

    function onKeydown (event: KeyboardEvent): void {
        if (event.ctrlKey && event.key === 'Enter') {
            event.preventDefault()
            void send()
        }
    }
</script>

<div
    class="batch-input-panel"
    role="presentation"
    onmousedown={(event) => event.stopPropagation()}
    onclick={(event) => event.stopPropagation()}
>
    <div class="panel-header">
        <span class="panel-title">Send input to multiple tabs</span>
        <button
            class="panel-collapse"
            type="button"
            onclick={() => { collapsed = !collapsed }}
            title={collapsed ? '展开' : '折叠'}
        >
            {collapsed ? '▴' : '▾'}
        </button>
        <button
            class="panel-close"
            type="button"
            onclick={onclose}
            title="关闭"
        >
            ×
        </button>
    </div>

    {#if !collapsed}
        <div class="panel-body">
            <div class="panel-main">
                <textarea
                    class="batch-input-command"
                    bind:value={command}
                    onkeydown={onKeydown}
                    placeholder="Command or input — Ctrl+Enter 发送"
                ></textarea>
            </div>

            <div class="panel-controls">
                <div class="scope-options">
                    <button
                        type="button"
                        class:primary={scope === 'current'}
                        onclick={() => setScope('current')}
                    >{scopeLabel('current')}</button>
                    <button
                        type="button"
                        class:primary={scope === 'all'}
                        onclick={() => setScope('all')}
                    >{scopeLabel('all')}</button>
                    <button
                        type="button"
                        class:primary={scope === 'selected'}
                        onclick={() => setScope('selected')}
                    >{scopeLabel('selected')}</button>
                </div>

                {#if scope === 'selected'}
                    <div class="target-list">
                        {#each targets as target (target.id)}
                            <label class="target-item">
                                <input
                                    type="checkbox"
                                    checked={selectedIds.has(target.id)}
                                    onchange={() => toggleTarget(target.id)}
                                />
                                <span class="target-copy">
                                    <span class="target-title">{target.title}</span>
                                    <span class="target-description">{target.description}</span>
                                </span>
                            </label>
                        {/each}
                    </div>
                {/if}

                <div class="panel-footer-row">
                    <label class="append-newline">
                        <input type="checkbox" bind:checked={appendNewline} />
                        Append Enter
                    </label>
                    <span class="target-count">
                        {scope === 'selected' ? `${selectedTargets.length} / ${targets.length}` : openTabs.length}
                    </span>
                    {#if error}
                        <span class="panel-error" role="alert">{error}</span>
                    {/if}
                    {#if notice}
                        <span class="panel-notice">{notice}</span>
                    {/if}
                    <button
                        type="button"
                        class="send-button"
                        onclick={() => void send()}
                        disabled={!canSend}
                    >Send</button>
                </div>
            </div>
        </div>
    {/if}
</div>
