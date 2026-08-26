<script lang="ts">
    import { onMount } from 'svelte'

    export interface ContextMenuItem {
        label: string
        danger?: boolean
        disabled?: boolean
        action: () => void
    }

    let { x, y, items, onclose }: { x: number, y: number, items: ContextMenuItem[], onclose: () => void } = $props()
    let menu: HTMLDivElement

    onMount(() => {
        const close = (event: MouseEvent) => {
            if (!menu?.contains(event.target as Node)) onclose()
        }
        const keydown = (event: KeyboardEvent) => { if (event.key === 'Escape') onclose() }
        document.addEventListener('mousedown', close)
        document.addEventListener('keydown', keydown)
        return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', keydown) }
    })
</script>

<div class="context-menu" bind:this={menu} style:left={`${x}px`} style:top={`${y}px`} role="menu" tabindex="-1">
    {#each items as item}
        <button class:danger={item.danger} type="button" role="menuitem" disabled={item.disabled} onclick={() => { item.action(); onclose() }}>
            {item.label}
        </button>
    {/each}
</div>
