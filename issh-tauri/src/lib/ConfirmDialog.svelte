<script lang="ts">
    let { message, onresolve }: { message: string; onresolve: (ok: boolean) => void } = $props()

    function decide (ok: boolean): void {
        onresolve(ok)
    }
</script>

<div class="confirm-backdrop" role="presentation">
    <div class="confirm-dialog" role="alertdialog" aria-modal="true" aria-label="插件操作确认">
        <div class="confirm-title">插件操作确认</div>
        <pre class="confirm-message">{message}</pre>
        <div class="confirm-actions">
            <button class="secondary" onclick={() => decide(false)}>拒绝</button>
            <button class="primary" onclick={() => decide(true)}>允许</button>
        </div>
    </div>
</div>
