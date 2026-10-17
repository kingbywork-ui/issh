// Phosphor — 荧光粉：VT220 致敬，极深绿黑基底 + 荧光绿晕
export const PHOSPHOR_ID = 'issh-plugin-theme-phosphor'
export const PHOSPHOR_SCHEME_NAME = 'Phosphor'

export const phosphorChromeCss = `
:root{
  --ops-base:#07140F;
  --ops-panel:#0D2218;
  --ops-line:#143326;
  --ops-signal:#00FF88;
  --ops-signal-dim:rgba(0,255,136,.14);
  --ops-signal-hover:rgba(0,255,136,.08);
  --ops-signal-border:rgba(0,255,136,.38);
  --ops-fg:#B8E8C8;
  --ops-fg-muted:rgba(184,232,200,.55);
  /* R-198 补齐：危险/信息/警告/风险语义 + 弹窗蒙层 */
  --ops-danger:#FF5A3C;
  --ops-danger-dim:rgba(255,90,60,.14);
  --ops-info:#40C4FF;
  --ops-info-dim:rgba(64,196,255,.12);
  --ops-warn:#FFD54F;
  --ops-warn-dim:rgba(255,213,79,.13);
  --ops-warn-border:rgba(255,213,79,.35);
  --ops-risk:#FFD54F;
  --ops-risk-dim:rgba(255,213,79,.15);
  --ops-scrim:rgba(1,10,6,.66);
}
:root[data-color-scheme='light']{ color-scheme: dark }
.tab-header.active::before{ background: var(--ops-signal); box-shadow: 0 0 8px rgba(0,255,136,.45) }
.terminal-host .xterm{ text-shadow: 0 0 7px rgba(0,255,136,.18) }
`

export const phosphorTerminalScheme = {
    name: PHOSPHOR_SCHEME_NAME,
    foreground: '#B8E8C8',
    background: '#07140F',
    cursor: '#00FF88',
    colors: [
        '#07140F', '#FF5A3C', '#00E676', '#FFEB3B',
        '#40C4FF', '#E040FB', '#18FFFF', '#B8E8C8',
        '#1A3328', '#FF7A5C', '#9FE870', '#FFF176',
        '#80D8FF', '#EA80FC', '#84FFFF', '#E8FFF0',
    ] as const,
}

export const phosphorPalette = {
    bg: '#07140F',
    fg: '#B8E8C8',
    cursor: '#00FF88',
    accent: '#00E676',
    selection: 'rgba(0,255,136,.16)',
    chrome: '#0D2218',
}
