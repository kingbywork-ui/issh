<script lang="ts">
    import css from './theme.css?inline'
    import { phosphorPalette, phosphorTerminalScheme } from './theme'
    let preview=$state(false)
    const entries=Object.entries(phosphorPalette) as Array<[string,string]>
    function toggle(){ preview=!preview; const id='issh-phosphor-preview'; const ex=document.getElementById(id) as HTMLStyleElement|null; if(!preview){ex?.remove();return} if(ex) return; const el=document.createElement('style'); el.id=id; el.textContent=`:root{--ops-base:${phosphorPalette.bg};--ops-panel:${phosphorPalette.chrome};--ops-line:#143326;--ops-signal:${phosphorPalette.cursor};--ops-signal-dim:rgba(0,255,136,.14);--ops-fg:${phosphorPalette.fg}}`; document.head.appendChild(el) }
    async function copyHex(h:string){ try{await navigator.clipboard.writeText(h)}catch{}}
</script>
<svelte:head><style>{css}</style></svelte:head>
<div class="foundry-settings">
    <div class="foundry-hero">
        <div>
            <div class="foundry-eyebrow">Skin 03 · Appearance</div>
            <h3>Phosphor — 荧光粉</h3>
            <p class="settings-hint">极深绿黑 + 荧光绿晕与扫描线：向 VT220 致敬的夜间皮肤。屏幕余晖仅在焦点处，克制复刻。</p>
        </div>
        <button type="button" class:active={preview} onclick={toggle}>{preview?'退出预览':'预览此皮肤'}</button>
    </div>
    <div class="foundry-meta"><span class="foundry-pill">bg {phosphorPalette.bg}</span><span class="foundry-pill">fg {phosphorPalette.fg}</span><span class="foundry-pill">accent {phosphorPalette.cursor}</span><span class="foundry-pill">xterm · {phosphorTerminalScheme.name}</span></div>
    <div class="foundry-swatches">{#each entries as [n,h] (n)}<button type="button" class="foundry-swatch" style:background={h} title="{n} {h}" aria-label="{n} {h}" onclick={() => void copyHex(h)}></button>{/each}</div>
    <div class="foundry-term" style:background={phosphorPalette.bg} style:color={phosphorPalette.fg}>
        <div class="foundry-term-bar" style:background={phosphorPalette.chrome}><span class="dot" style:background="#0A3D2A"></span><span class="dot" style:background="#0A3D2A"></span><span class="dot" style:background="#0A3D2A"></span><span class="foundry-term-title">ssh root@vault — issh · Phosphor</span></div>
        <div class="foundry-term-body" style="text-shadow:0 0 7px rgba(0,255,136,.28)"><div><span style="opacity:.5">$</span> htop</div><div><span style="color:{phosphorPalette.cursor}">CPU</span> [||||||||<span style="opacity:.3">····</span>] 42%</div></div>
    </div>
    <p class="settings-hint">荧光晕与扫描线仅在终端焦点态叠加，不影响可读性；与 Tabby 的深色荧光主题等价。</p>
</div>
