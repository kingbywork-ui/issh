<script lang="ts">
    import { onMount } from 'svelte'
    import { registerSandboxOrigin, unregisterSandboxOrigin, installSandboxBridge } from './plugins/sandboxBridge'
    import type { SandboxPanelDefinition } from './plugins/types'

    let { panel, pluginId }: { panel: SandboxPanelDefinition; pluginId: string } = $props()

    const MIN_HEIGHT = 80
    const MAX_HEIGHT = 480
    let height = $state(panel.height ?? 160)
    let resizing = $state(false)

    const storageKey = `issh.plugin.${pluginId}.panelHeight.${panel.id}`

    onMount(() => {
        installSandboxBridge()
        registerSandboxOrigin(pluginId, panel.sandboxOrigin)
        const saved = Number.parseInt(localStorage.getItem(storageKey) ?? '', 10)
        if (Number.isFinite(saved) && saved >= MIN_HEIGHT && saved <= MAX_HEIGHT) height = saved
        return () => {
            unregisterSandboxOrigin(pluginId)
        }
    })

    function onResizeStart (event: MouseEvent): void {
        event.preventDefault()
        resizing = true
        const startY = event.clientY
        const startHeight = height
        const onMove = (moveEvent: MouseEvent) => {
            height = Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, startHeight - (moveEvent.clientY - startY)))
        }
        const onUp = () => {
            resizing = false
            localStorage.setItem(storageKey, String(height))
            window.removeEventListener('mousemove', onMove)
            window.removeEventListener('mouseup', onUp)
        }
        window.addEventListener('mousemove', onMove)
        window.addEventListener('mouseup', onUp)
    }
</script>

<div class="sandbox-panel" data-sandbox-plugin={pluginId}>
    <div class="sandbox-panel-title" class:resizing onmousedown={onResizeStart} role="separator" aria-orientation="horizontal" tabindex="0">
        <span>{panel.title}</span>
        <span class="sandbox-panel-resize-hint">{resizing ? '松开保存高度' : '拖拽调整高度'}</span>
    </div>
    <iframe
        src={panel.sandboxUrl}
        sandbox="allow-scripts"
        title={panel.title}
        data-sandbox-plugin={pluginId}
        style="height: {height}px"
    ></iframe>
</div>
