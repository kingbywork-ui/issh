<script module lang="ts">
    export type SplitLayoutNode =
        | { type: 'pane', id: string }
        | { type: 'split', orientation: 'vertical' | 'horizontal', ratios: number[], children: SplitLayoutNode[] }
</script>

<script lang="ts">
    import type { Snippet } from 'svelte'
    import SplitLayoutSelf from './SplitLayout.svelte'

    let { node, pane, onratiochange }: { node: SplitLayoutNode, pane: Snippet<[string]>, onratiochange?: () => void } = $props()
    const ratios = $derived(node.type === 'split' ? node.ratios.flatMap((ratio, index) => index < node.ratios.length - 1 ? [`${Math.max(0.05, ratio)}fr`, '4px'] : [`${Math.max(0.05, ratio)}fr`]).join(' ') : '')
    function resize (event: PointerEvent, index: number): void {
        if (node.type !== 'split') return
        event.preventDefault()
        const host = event.currentTarget as HTMLElement
        const rect = host.parentElement?.getBoundingClientRect()
        if (!rect) return
        const start = node.orientation === 'vertical' ? event.clientX : event.clientY
        const total = node.orientation === 'vertical' ? rect.width : rect.height
        const initial = [...node.ratios]
        const move = (next: PointerEvent): void => {
            const delta = ((node.orientation === 'vertical' ? next.clientX : next.clientY) - start) / total
            const amount = Math.max(-initial[index] + 0.05, Math.min(initial[index + 1] - 0.05, delta))
            node.ratios = initial.map((ratio, position) => position === index ? ratio + amount : position === index + 1 ? ratio - amount : ratio)
            onratiochange?.()
        }
        const up = (): void => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up) }
        window.addEventListener('pointermove', move)
        window.addEventListener('pointerup', up, { once: true })
    }
</script>

{#if node.type === 'pane'}
    {@render pane(node.id)}
{:else}
    <div class:split-node-vertical={node.orientation === 'vertical'} class:split-node-horizontal={node.orientation === 'horizontal'} class="split-node" style={`--split-ratios: ${ratios}`}>
        {#each node.children as child, index (child.type === 'pane' ? child.id : child)}
            <div class="split-node-child" style={`${node.orientation === 'vertical' ? `grid-column: ${index * 2 + 1}` : `grid-row: ${index * 2 + 1}`}`}>
                <SplitLayoutSelf node={child} {pane} {onratiochange} />
            </div>
            {#if index < node.children.length - 1}
                <button class:split-node-divider-vertical={node.orientation === 'vertical'} class:split-node-divider-horizontal={node.orientation === 'horizontal'} class="split-node-divider" type="button" aria-label="调整分屏比例" onpointerdown={(event) => resize(event, index)}></button>
            {/if}
        {/each}
    </div>
{/if}
