<script lang="ts">
    interface AuditEntry {
        index: number
        parsed: true
        timestamp: string
        method: string
        ok: boolean
        errorCode: string | null
        errorMessage: string | null
        params: unknown
        executed: boolean | null
        approved: boolean | null
        approvedBy: string | null
        reason: string | null
    }

    interface AuditRawEntry {
        index: number
        parsed: false
        raw: string
    }

    type Entry = AuditEntry | AuditRawEntry

    let {
        show,
        auditText,
        auditBusy,
        onclose,
        onrefresh,
        onclear,
    }: {
        show: boolean
        auditText: string
        auditBusy: boolean
        onclose: () => void
        onrefresh: () => void
        onclear: () => void
    } = $props()

    let parsedEntries = $derived.by((): Entry[] => {
        if (!auditText) return []
        const lines = auditText.split('\n').filter((l) => l.trim().length > 0)
        return lines.map((line, i) => {
            try {
                const parsed = JSON.parse(line)
                return {
                    index: i,
                    parsed: true,
                    timestamp: parsed.timestamp ?? '',
                    method: parsed.method ?? '',
                    ok: parsed.ok ?? false,
                    errorCode: parsed.errorCode ?? null,
                    errorMessage: parsed.errorMessage ?? null,
                    params: parsed.params ?? null,
                    executed: parsed.executed ?? null,
                    approved: parsed.approved ?? null,
                    approvedBy: parsed.approvedBy ?? null,
                    reason: parsed.reason ?? null,
                } as AuditEntry
            } catch {
                return { index: i, parsed: false, raw: line } as AuditRawEntry
            }
        })
    })

    function formatTime (iso: string): string {
        try {
            const d = new Date(iso)
            return d.toLocaleString(undefined, {
                year: 'numeric',
                month: '2-digit',
                day: '2-digit',
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit',
            })
        } catch {
            return iso
        }
    }

    function handleBackdrop (): void {
        onclose()
    }

    function handleKeydown (e: KeyboardEvent): void {
        if (e.key === 'Escape') onclose()
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
                    <span class="audit-count">{parsedEntries.length} 条记录</span>
                </div>
                <div class="audit-modal-actions">
                    <button type="button" disabled={auditBusy} onclick={onrefresh}>刷新</button>
                    <button class="clear-btn" type="button" disabled={auditBusy} onclick={onclear}>清除</button>
                    <button class="close-btn" type="button" onclick={onclose} aria-label="关闭">✕</button>
                </div>
            </div>
            <div class="audit-modal-body">
                {#if parsedEntries.length === 0}
                    <div class="audit-empty">暂无审计记录</div>
                {:else}
                    {#each parsedEntries as entry (entry.index)}
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
    }
</style>