<script lang="ts">
    import { toasts, dismissToast } from './toast.svelte'
</script>

<div class="toast-host" aria-live="polite">
    {#each toasts as item (item.id)}
        <div class="toast toast-{item.kind}" role="status">
            <span class="toast-message">{item.message}</span>
            <button class="toast-close" type="button" aria-label="关闭通知" onclick={() => dismissToast(item.id)}>×</button>
        </div>
    {/each}
</div>