<script lang="ts">
    import { parseAuditEntries, filterAuditEntries } from './auditLog'

    let {
        show,
        auditText,
        auditBusy,
        autoRefresh,
        onclose,
        onrefresh,
        onclear,
        ontoggleautorefresh,
    }: {
        show: boolean
        auditText: string
        auditBusy: boolean
        autoRefresh: boolean
        onclose: () => void
        onrefresh: () => void
        onclear: () => void
        ontoggleautorefresh: (value: boolean) => void
    } = $props()

    let query = $state('')

    // 时间序列倒序：最新记录排在最上面；无法解析的行沉底。
    let entries = $derived(parseAuditEntries(auditText))

    let filteredEntries = $derived(filterAuditEntries(entries, query))

    let searching = $derived(query.trim().length > 0)

    function formatTime (iso: string): string {
        const d = new Date(iso)
        if (Number.isNaN(d.getTime())) return iso
        return d.toLocaleString(undefined, {
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
        })
    }

    function handleBackdrop (): void {
        onclose()
    }

    function handleKeydown (e: KeyboardEvent): void {
        if (e.key === 'Escape') {
            if (searching) query = ''
            else onclose()
        }
    }
</script>

{#if show}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="audit-backdrop" role="presentation" onclick={handleBackdrop} onkeydown={handleKeydown}>
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div
            class="audit-modal"
            role="dialog"
            aria-modal="true"
            aria-label="Agent Bridge 审计日志"
            tabindex="-1"
            onclick={(e) => e.stopPropagation()}
            onkeydown={handleKeydown}
        >
            <div class="audit-modal-header">
                <div class="audit-modal-title">
                    <h2>Agent Bridge 审计日志</h2>
                    {#if searching}
                        <span class="audit-count">{filteredEntries.length} / {entries.length} 条记录</span>
                    {:else}
                        <span class="audit-count">{entries.length} 条记录</span>
                    {/if}
                </div>
                <div class="audit-modal-actions">
                    <button type="button" disabled={auditBusy} onclick={onrefresh}>刷新</button>
                    <button class="clear-btn" type="button" disabled={auditBusy} onclick={onclear}>清除</button>
                    <button class="close-btn" type="button" onclick={onclose} aria-label="关闭">✕</button>
                </div>
            </div>
            <div class="audit-toolbar">
                <div class="audit-search">
                    <input
                        type="search"
                        class="audit-search-input"
                        placeholder="检索方法 / 错误码 / 参数 / 时间…"
                        aria-label="检索审计日志"
                        bind:value={query}
                    />
                    {#if searching}
                        <button
                            class="audit-search-clear"
                            type="button"
                            aria-label="清空检索"
                            onclick={() => { query = '' }}
                        >✕</button>
                    {/if}
                </div>
                <button
                    class="audit-live-toggle"
                    class:active={autoRefresh}
                    type="button"
                    aria-pressed={autoRefresh}
                    title="实时刷新：新记录自动出现在最上面"
                    onclick={() => ontoggleautorefresh(!autoRefresh)}
                >
                    <span class="audit-live-dot"></span>实时刷新
                </button>
            </div>
            <div class="audit-modal-body">
                {#if entries.length === 0}
                    <div class="audit-empty">暂无审计记录</div>
                {:else if filteredEntries.length === 0}
                    <div class="audit-empty">未找到匹配 “{query.trim()}” 的记录</div>
                {:else}
                    {#each filteredEntries as entry (entry.index)}
                        {#if entry.parsed}
                            <div class="audit-row">
                                <div class="audit-row-head">
                                    <span class="audit-time">{formatTime(entry.timestamp)}</span>
                                    <code class="audit-method">{entry.method}</code>
                                    {#if entry.ok}
                                        <span class="audit-badge audit-ok">OK</span>
                                    {:else}
                                        <span class="audit-badge audit-fail">FAIL</span>
                                    {/if}
                                    {#if entry.errorCode}
                                        <span class="audit-error-code">{entry.errorCode}</span>
                                    {/if}
                                </div>
                                {#if entry.errorMessage}
                                    <div class="audit-detail audit-error-msg">{entry.errorMessage}</div>
                                {/if}
                                {#if entry.params}
                                    <pre class="audit-detail audit-params">{JSON.stringify(entry.params, null, 2)}</pre>
                                {/if}
                                {#if entry.executed !== null || entry.approved !== null}
                                    <div class="audit-detail audit-meta">
                                        {#if entry.executed !== null}
                                            <span>executed: {String(entry.executed)}</span>
                                        {/if}
                                        {#if entry.approved !== null}
                                            <span>approved: {String(entry.approved)}</span>
                                        {/if}
                                        {#if entry.approvedBy}
                                            <span>by: {entry.approvedBy}</span>
                                        {/if}
                                        {#if entry.reason}
                                            <span>reason: {entry.reason}</span>
                                        {/if}
                                    </div>
                                {/if}
                            </div>
                        {:else}
                            <pre class="audit-raw-row">{entry.raw}</pre>
                        {/if}
                    {/each}
                {/if}
            </div>
        </div>
    </div>
{/if}

<style>
    .audit-backdrop {
        position: fixed;
        inset: 0;
        z-index: 300;
        background: rgba(0, 0, 0, 0.5);
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 24px;
    }

    .audit-modal {
        display: flex;
        flex-direction: column;
        width: min(90vw, 860px);
        height: min(85vh, 640px);
        background: var(--ops-base);
        border: 1px solid var(--ops-line);
        border-radius: 8px;
        box-shadow: 0 16px 48px rgba(0, 0, 0, 0.45);
        overflow: hidden;
    }

    .audit-modal-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        flex: none;
        padding: 14px 18px;
        border-bottom: 1px solid var(--ops-line);
    }

    .audit-modal-title {
        display: flex;
        align-items: baseline;
        gap: 10px;
        min-width: 0;
    }

    .audit-modal-title h2 {
        margin: 0;
        font-size: 15px;
        font-weight: 700;
        white-space: nowrap;
    }

    .audit-count {
        color: var(--ops-fg-muted);
        font-size: 12px;
        font-family: var(--ops-font-mono);
        white-space: nowrap;
    }

    .audit-modal-actions {
        display: flex;
        align-items: center;
        gap: 6px;
        flex: none;
    }

    .audit-modal-actions button {
        min-height: 28px;
        padding: 0 12px;
        border: 1px solid var(--ops-line);
        border-radius: var(--ops-radius);
        background: transparent;
        color: var(--ops-fg);
        cursor: pointer;
        font-size: 12px;
        white-space: nowrap;
    }

    .audit-modal-actions button:hover {
        border-color: var(--ops-signal-border);
        color: var(--ops-signal);
    }

    .audit-modal-actions button:disabled {
        opacity: 0.5;
        cursor: wait;
    }

    .clear-btn {
        color: var(--ops-danger) !important;
        border-color: rgba(239, 95, 103, 0.4) !important;
    }

    .clear-btn:hover {
        background: var(--ops-danger-dim) !important;
    }

    .close-btn {
        border: none !important;
        font-size: 18px !important;
        line-height: 1;
        padding: 0 6px !important;
        color: var(--ops-fg-muted) !important;
    }

    .close-btn:hover {
        color: var(--ops-fg) !important;
        background: transparent !important;
        border-color: transparent !important;
    }

    .audit-toolbar {
        display: flex;
        align-items: center;
        gap: 8px;
        flex: none;
        padding: 8px 16px;
        border-bottom: 1px solid var(--ops-line);
    }

    .audit-search {
        position: relative;
        display: flex;
        flex: 1;
        min-width: 0;
        align-items: center;
    }

    .audit-search-input {
        width: 100%;
        min-height: 28px;
        padding: 0 26px 0 10px;
        border: 1px solid var(--ops-line);
        border-radius: var(--ops-radius);
        background: var(--ops-panel);
        color: var(--ops-fg);
        font-size: 12px;
    }

    .audit-search-input:focus {
        outline: none;
        border-color: var(--ops-signal-border);
    }

    .audit-search-input::-webkit-search-cancel-button {
        display: none;
    }

    .audit-search-clear {
        position: absolute;
        right: 4px;
        display: flex;
        align-items: center;
        justify-content: center;
        width: 20px;
        height: 20px;
        padding: 0;
        border: none;
        border-radius: 50%;
        background: transparent;
        color: var(--ops-fg-muted);
        cursor: pointer;
        font-size: 12px;
        line-height: 1;
    }

    .audit-search-clear:hover {
        color: var(--ops-fg);
        background: var(--ops-line);
    }

    .audit-live-toggle {
        display: flex;
        align-items: center;
        gap: 6px;
        flex: none;
        min-height: 28px;
        padding: 0 12px;
        border: 1px solid var(--ops-line);
        border-radius: var(--ops-radius);
        background: transparent;
        color: var(--ops-fg-muted);
        cursor: pointer;
        font-size: 12px;
        white-space: nowrap;
    }

    .audit-live-toggle.active {
        color: var(--ops-signal);
        border-color: var(--ops-signal-border);
    }

    .audit-live-dot {
        width: 7px;
        height: 7px;
        border-radius: 50%;
        background: var(--ops-fg-muted);
        flex: none;
    }

    .audit-live-toggle.active .audit-live-dot {
        background: var(--ops-signal);
        box-shadow: 0 0 0 0 var(--ops-signal);
        animation: audit-pulse 2s ease-out infinite;
    }

    @keyframes audit-pulse {
        0% {
            box-shadow: 0 0 0 0 rgba(61, 214, 140, 0.55);
        }
        70% {
            box-shadow: 0 0 0 6px rgba(61, 214, 140, 0);
        }
        100% {
            box-shadow: 0 0 0 0 rgba(61, 214, 140, 0);
        }
    }

    @media (prefers-reduced-motion: reduce) {
        .audit-live-toggle.active .audit-live-dot {
            animation: none;
        }
    }

    .audit-modal-body {
        flex: 1;
        min-height: 0;
        overflow-y: auto;
        overflow-x: auto;
        padding: 10px 16px;
    }

    .audit-empty {
        padding: 40px 0;
        text-align: center;
        color: var(--ops-fg-muted);
        font-size: 13px;
    }

    .audit-row {
        padding: 10px 12px;
        margin: 6px 0;
        border: 1px solid var(--ops-line);
        border-radius: var(--ops-radius);
        background: var(--ops-panel);
    }

    .audit-row-head {
        display: flex;
        align-items: center;
        gap: 8px;
        flex-wrap: wrap;
    }

    .audit-time {
        color: var(--ops-fg-muted);
        font-size: 11px;
        font-family: var(--ops-font-mono);
        white-space: nowrap;
    }

    .audit-method {
        font-size: 12px;
        font-family: var(--ops-font-mono);
        color: var(--ops-fg);
        word-break: break-all;
    }

    .audit-badge {
        font-size: 10px;
        font-weight: 700;
        padding: 1px 6px;
        border-radius: 3px;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        flex: none;
    }

    .audit-ok {
        color: var(--ops-signal);
        background: var(--ops-signal-dim);
    }

    .audit-fail {
        color: var(--ops-danger);
        background: var(--ops-danger-dim);
    }

    .audit-error-code {
        font-size: 11px;
        font-family: var(--ops-font-mono);
        color: var(--ops-danger);
    }

    .audit-detail {
        margin-top: 6px;
    }

    .audit-error-msg {
        font-size: 12px;
        color: var(--ops-danger);
    }

    .audit-params {
        margin: 0;
        font-size: 11px;
        font-family: var(--ops-font-mono);
        color: var(--ops-fg-muted);
        white-space: pre-wrap;
        word-break: break-all;
        max-height: 120px;
        overflow: auto;
        padding: 6px 8px;
        border-radius: var(--ops-radius);
        background: var(--ops-base);
    }

    .audit-meta {
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
        font-size: 11px;
        color: var(--ops-fg-muted);
        font-family: var(--ops-font-mono);
    }

    .audit-raw-row {
        margin: 4px 0;
        padding: 8px 10px;
        font-size: 11px;
        font-family: var(--ops-font-mono);
        color: var(--ops-fg-muted);
        white-space: pre-wrap;
        word-break: break-all;
        border: 1px solid var(--ops-line);
        border-radius: var(--ops-radius);
        background: var(--ops-panel);
        overflow-x: auto;
    }

    @media (max-width: 600px) {
        .audit-backdrop {
            padding: 8px;
        }

        .audit-modal {
            width: 100%;
            height: 90vh;
        }

        .audit-modal-header {
            flex-direction: column;
            align-items: flex-start;
            gap: 8px;
            padding: 10px 12px;
        }

        .audit-modal-actions {
            width: 100%;
            justify-content: flex-end;
        }

        .audit-toolbar {
            flex-wrap: wrap;
            padding: 8px 12px;
        }

        .audit-search {
            flex: 1 1 100%;
        }
    }
</style>
