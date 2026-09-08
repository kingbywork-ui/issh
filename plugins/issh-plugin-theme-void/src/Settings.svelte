<script lang="ts">
    import css from './theme.css?inline'
    import { voidPalette, voidTerminalScheme } from './theme'
    let preview=$state(false)
    const entries=Object.entries(voidPalette) as Array<[string,string]>
    function toggle(){ preview=!preview; const id='issh-void-preview'; const ex=document.getElementById(id) as HTMLStyleElement|null; if(!preview){ex?.remove();return} if(ex) return; const el=document.createElement('style'); el.id=id; el.textContent=`:root{--ops-base:${voidPalette.bg};--ops-panel:${voidPalette.chrome};--ops-line:#2A2850;--ops-signal:${voidPalette.cursor};--ops-signal-dim:rgba(255,77,106,.13);--ops-fg:${voidPalette.fg}}`; document.head.appendChild(el) }
    async function copyHex(h:string){ try{await navigator.clipboard.writeText(h)}catch{}}
</script>
<svelte:head><style>{css}</style></svelte:head>
<div class="foundry-settings">
    <div class="foundry-hero">
        <div>
            <div class="foundry-eyebrow">Skin 04 · Appearance</div>
            <h3>Void — 虚空暮色</h3>
            <p class="settings-hint">深靛紫暮色 + 光纤微光：让人在危险操作前慢下来的夜间专注皮肤。玫红信号仅用于确认态。</p>
        </div>
        <button type="button" class:active={preview} onclick={toggle}>{preview?'退出预览':'预览此皮肤'}</button>
    </div>
    <div class="foundry-meta"><span class="foundry-pill">bg {voidPalette.bg}</span><span class="foundry-pill">fg {voidPalette.fg}</span><span class="foundry-pill">accent {voidPalette.cursor}</span><span class="foundry-pill">xterm · {voidTerminalScheme.name}</span></div>
    <div class="foundry-swatches">{#each entries as [n,h] (n)}<button type="button" class="foundry-swatch" style:background={h} title="{n} {h}" aria-label="{n} {h}" onclick={() => void copyHex(h)}></button>{/each}</div>
    <div class="foundry-term" style:background={voidPalette.bg} style:color={voidPalette.fg}>
        <div class="foundry-term-bar" style:background={voidPalette.chrome}><span class="dot" style:background="#2A2850"></span><span class="dot" style:background="#2A2850"></span><span class="dot" style:background="#2A2850"></span><span class="foundry-term-title">ssh deploy@hk-1 — issh · Void</span></div>
        <div class="foundry-term-body"><div><span style="opacity:.5">$</span> git log --oneline -3</div><div><span style="color:{voidPalette.cursor}">8dab80c</span> docs: issh 0.0.4</div><div><span style="opacity:.5">$</span> <span style="color:{voidPalette.cursor}">rm -rf ./dist</span> <span style="opacity:.55">-- guarded: press Ctrl+Y</span></div></div>
    </div>
    <p class="settings-hint">标签栏为靛紫至玫红微渐变，选中与危险操作同源但低饱和，避免模板化的纯黑 + 酸绿。</p>
</div>
