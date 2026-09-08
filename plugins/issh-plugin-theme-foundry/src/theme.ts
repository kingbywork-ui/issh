// Foundry 主题 — 材料语义与 6 锚点：bg/fg/cursor/accent(selection)/border/panel
export const FOUNDRY_ID = 'issh-plugin-theme-foundry'
export const FOUNDRY_SCHEME_NAME = 'Foundry'

export const foundryChromeCss = `
:root{
  --ops-base:#0F1A26;
  --ops-panel:#132132;
  --ops-line:#1F3350;
  --ops-signal:#FF7A45;
  --ops-signal-dim:rgba(255,122,69,.14);
  --ops-signal-hover:rgba(255,122,69,.08);
  --ops-signal-border:rgba(255,122,69,.42);
  --ops-fg:#E8E0C8;
  --ops-fg-muted:rgba(232,224,200,.58);
}
:root[data-color-scheme='light']{
  --ops-base:#0F1A26;
  --ops-panel:#132132;
  --ops-line:#243A5A;
  --ops-signal:#FF7A45;
  --ops-fg:#E8E0C8;
}
/* 标签栏与状态点的哑光钢质感 */
.tab-header.active::before{ background: var(--ops-signal) }
.status-dot.open, .tab-status.open{ background: var(--ops-signal) }
.tab-header.active .tab-index{ color: var(--ops-signal) }
`

export const foundryTerminalScheme = {
    name: FOUNDRY_SCHEME_NAME,
    foreground: '#E8E0C8',
    background: '#0F1A26',
    cursor: '#FF7A45',
    colors: [
        '#0B1420', '#FF615A', '#B1E969', '#EBD99C',
        '#5DA9F6', '#E86AFF', '#82FFF7', '#E8E0C8',
        '#313131', '#F58C80', '#DDF88F', '#EEE5B2',
        '#A5C7FF', '#DDAAFF', '#B7FFF9', '#FFFFFF',
    ] as const,
}

export const foundryPalette = {
    bg: '#0F1A26',
    fg: '#E8E0C8',
    cursor: '#FF7A45',
    accent: '#5DA9F6',
    selection: 'rgba(255,122,69,.18)',
    chrome: '#132132',
}
