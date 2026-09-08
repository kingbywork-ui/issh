<script lang="ts">
    import css from './theme.css?inline'
    import { fieldPalette, fieldTerminalScheme } from './theme'
    let preview=$state(false)
    const entries=Object.entries(fieldPalette) as Array<[string,string]>
    function toggle(){ preview=!preview; const id='issh-field-preview'; const ex=document.getElementById(id) as HTMLStyleElement|null; if(!preview){ex?.remove();return} if(ex) return; const el=document.createElement('style'); el.id=id; el.textContent=`:root{--ops-base:${fieldPalette.bg};--ops-panel:${fieldPalette.chrome};--ops-line:#E0D9C6;--ops-signal:${fieldPalette.cursor};--ops-signal-dim:rgba(46,124,246,.10);--ops-fg:${fieldPalette.fg}}`; document.head.appendChild(el) }
    async function copyHex(h:string){ try{await navigator.clipboard.writeText(h)}catch{}}
</script>
<svelte:head><style>{css}</style></svelte:head>
<div class="foundry-settings">
    <div class="foundry-hero">
        <div>
            <div class="foundry-eyebrow">Skin 02 · Appearance · Light</div>
            <h3>Field — 现场纸与蓝图</h3>
            <p class="settings-hint">暖纸低对比 + 蓝图蓝选中：白天、投屏与长阅读的浅色皮肤。双层：chrome 纸色 + xterm Terminal Light 变体。</p>
        </div>
        <button type="button" class:active={preview} onclick={toggle}>{preview?'退出预览':'预览此皮肤'}</button>
    </div>
    <div class="foundry-meta">
        <span class="foundry-pill">bg {fieldPalette.bg}</span><span class="foundry-pill">fg {fieldPalette.fg}</span><span class="foundry-pill">accent {fieldPalette.cursor}</span><span class="foundry-pill">xterm · {fieldTerminalScheme.name}</span>
    </div>
    <div class="foundry-swatches">{#each entries as [n,h] (n)}<button type="button" class="foundry-swatch" style:background={h} title="{n} {h}" aria-label="{n} {h}" onclick={() => void copyHex(h)}></button>{/each}</div>
    <div class="foundry-term" style:background={fieldPalette.bg} style:color={fieldPalette.fg}>
        <div class="foundry-term-bar" style:background={fieldPalette.chrome}><span class="dot" style:background="#D9CFC0"></span><span class="dot" style:background="#D9CFC0"></span><span class="dot" style:background="#D9CFC0"></span><span class="foundry-term-title" style:color={fieldPalette.fg}>ssh field@edge-03 — issh · Field</span></div>
        <div class="foundry-term-body"><div><span style="opacity:.45">$</span> cat /etc/issh/profiles.yaml</div><div><span style="color:{fieldPalette.cursor}">hosts:</span> edge-03: <span style="color:#718C00">192.168.10.31</span></div></div>
    </div>
    <p class="settings-hint">浅色皮肤在 dark chrome 下以 light xterm 呈现；与 Tabby 的 light Theme/followsColorScheme 语义对齐。</p>
</div>
