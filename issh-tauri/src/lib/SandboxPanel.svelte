<script lang="ts">
    import { onMount } from 'svelte'
    import { registerSandboxOrigin, unregisterSandboxOrigin, installSandboxBridge } from './plugins/sandboxBridge'
    import type { SandboxPanelDefinition } from './plugins/types'

    let { panel, pluginId }: { panel: SandboxPanelDefinition; pluginId: string } = $props()

    onMount(() => {
        installSandboxBridge()
        registerSandboxOrigin(pluginId, panel.sandboxOrigin)
        return () => {
            unregisterSandboxOrigin(pluginId)
        }
    })
</script>

<div class="sandbox-panel" data-sandbox-plugin={pluginId}>
    <div class="sandbox-panel-title">{panel.title}</div>
    <iframe
        src={panel.sandboxUrl}
        sandbox="allow-scripts"
        title={panel.title}
        data-sandbox-plugin={pluginId}
        style={panel.height ? `height: ${panel.height}px` : ''}
    ></iframe>
</div>
