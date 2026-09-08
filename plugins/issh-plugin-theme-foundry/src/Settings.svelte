<script lang="ts">
    import css from './theme.css?inline'
    import { foundryPalette, foundryTerminalScheme } from './theme'
    let preview = $state(false)
    const paletteEntries = Object.entries(foundryPalette) as Array<[string,string]>
    function togglePreview(){ preview=!preview; if(preview) inject(true); else inject(false) }
    function inject(on:boolean){
        const id='issh-foundry-preview'
        const ex=document.getElementById(id) as HTMLStyleElement|null
        if(!on){ ex?.remove(); return }
        if(ex) return
        const el=document.createElement('style'); el.id=id
        el.textContent=`:root{--ops-base:${foundryPalette.bg};--ops-panel:${foundryPalette.chrome};--ops-line:#1F3350;--ops-signal:${foundryPalette.cursor};--ops-signal-dim:rgba(255,122,69,.14);--ops-signal-border:rgba(255,122,69,.42);--ops-fg:${foundryPalette.fg}}`
        document.head.appendChild(el)
    }
    async function copyHex(hex:string){ try{ await navigator.clipboard.writeText(hex)}catch{} }
</script>
<svelte:head><style>{css}</style></svelte:head>
<div class="foundry-settings">
    <div class="foundry-hero">
        <div>
            <div class="foundry-eyebrow">Skin 01 · Appearance</div>
            <h3>Foundry — 铸造车间</h3>
            <p class="settings-hint">深海军蓝哑光钢基底，信号橙仅用于活动标签 / 光标 / 选中 — 为全天运维而设的克制暗色常驻。锚定 Tauri 双层：WebView2 chrome 变量 + xterm 16 色。</p>
        </div>
        <button type="button" class:active={preview} onclick={togglePreview}>{preview ? '退出预览' : '预览此皮肤'}</button>
    </div>
    <div class="foundry-meta">
        <span class="foundry-pill">bg {foundryPalette.bg}</span>
        <span class="foundry-pill">fg {foundryPalette.fg}</span>
        <span class="foundry-pill">accent {foundryPalette.cursor}</span>
        <span class="foundry-pill">xterm · {foundryTerminalScheme.name}</span>
    </div>
    <div class="foundry-swatches" aria-label="palette">
        {#each paletteEntries as [name,hex] (name)}
            <button type="button" class="foundry-swatch" style:background={hex} title="{name} {hex}" aria-label="{name} {hex}" onclick={() => void copyHex(hex)}></button>
        {/each}
    </div>
    <div class="foundry-term" style:background={foundryPalette.bg} style:color={foundryPalette.fg}>
        <div class="foundry-term-bar" style:background={foundryPalette.chrome}>
            <span class="dot" style:background="#FF5F56"></span><span class="dot" style:background="#FFBD2E"></span><span class="dot" style:background="#27C93F"></span>
            <span class="foundry-term-title">ssh root@prod-01 — issh · Foundry</span>
        </div>
        <div class="foundry-term-body">
            <div><span style="opacity:.5">$</span> kubectl get pods -n prod | grep api</div>
            <div><span style="color:{foundryPalette.cursor}">api-7d9f8-2xk4p</span> <span style="color:#B1E969">Running</span> <span style="opacity:.6">-- 12 restarts</span></div>
            <div><span style="opacity:.5">$</span> tail -f /var/log/app.log <span style="color:#5DA9F6">| grep ERROR</span></div>
        </div>
    </div>
    <p class="settings-hint">终端配色由 terminal.decorate 注入，重启后仍由插件接管；通用 → 终端配色可查看方案名 <code>{foundryTerminalScheme.name}</code>。</p>
</div>
