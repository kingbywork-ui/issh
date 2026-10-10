<script lang="ts">
    import { onDestroy } from 'svelte'
    import { currentDialog, dismissDialogs, resolveDialog } from './dialogs'

    let dialog = $state<HTMLDialogElement>()
    let input = $state<HTMLInputElement>()
    let submit = $state<HTMLButtonElement>()
    let value = $state('')
    let presentedId = 0

    $effect(() => {
        const request = $currentDialog
        if (!dialog) return
        if (!request) {
            presentedId = 0
            if (dialog.open) dialog.close()
            return
        }
        value = request.defaultValue
        presentedId = request.id
        if (!dialog.open) dialog.showModal()
        queueMicrotask(() => {
            if ($currentDialog?.id !== request.id) return
            const target = request.kind === 'prompt' ? input : submit
            target?.focus()
            if (request.kind === 'prompt') input?.select()
        })
    })

    function finish (accepted: boolean): void {
        const request = $currentDialog
        if (!request || request.id !== presentedId) return
        presentedId = 0
        resolveDialog(request.id, request.kind === 'prompt' ? accepted ? value : null : accepted)
    }

    onDestroy(dismissDialogs)
</script>

<dialog bind:this={dialog} class="app-dialog" aria-labelledby="app-dialog-title" aria-describedby="app-dialog-message" oncancel={(event) => { event.preventDefault(); finish(false) }} onkeydown={(event) => event.stopPropagation()}>
    {#if $currentDialog}
        <form onsubmit={(event) => { event.preventDefault(); finish(true) }}>
            <h2 id="app-dialog-title">{$currentDialog.title}</h2>
            <p id="app-dialog-message">{$currentDialog.message}</p>
            {#if $currentDialog.kind === 'prompt'}
                <input bind:this={input} bind:value aria-label={$currentDialog.message} autocomplete="off" />
            {/if}
            <div class="app-dialog-actions">
                {#if $currentDialog.kind !== 'alert'}
                    <button type="button" class="secondary" onclick={() => finish(false)}>取消</button>
                {/if}
                <button bind:this={submit} type="submit" class="primary">确定</button>
            </div>
        </form>
    {/if}
</dialog>
