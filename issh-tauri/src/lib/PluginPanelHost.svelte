<script lang="ts">
    import { mount, onMount, unmount } from 'svelte'
    import type { PanelDefinition, PanelHostContext } from './plugins/types'

    let { panel, host }: { panel: PanelDefinition; host: PanelHostContext } = $props()
    let container: HTMLDivElement
    let error = $state('')

    onMount(() => {
        try {
            if (panel.mount) return panel.mount(container, host)
            if (panel.component) {
                const instance = mount(panel.component, { target: container })
                return () => { void unmount(instance) }
            }
            error = '插件未提供面板入口'
        } catch (cause) {
            error = cause instanceof Error ? cause.message : String(cause)
        }
    })
</script>

{#if error}<div class="plugin-panel-error" role="alert">{error}</div>{/if}
<div class="plugin-panel-content" bind:this={container}></div>
