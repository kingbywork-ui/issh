// Field — 现场：牛皮纸与蓝图，浅色皮肤但 chrome 仍受插件接管（与 Tabby 浅色 Theme 差异）
export const FIELD_ID = 'issh-plugin-theme-field'
export const FIELD_SCHEME_NAME = 'Field'

export const fieldChromeCss = `
:root{
  --ops-base:#F6F1E7;
  --ops-panel:#FFFFFF;
  --ops-line:#E0D9C6;
  --ops-signal:#2E7CF6;
  --ops-signal-dim:rgba(46,124,246,.10);
  --ops-signal-hover:rgba(46,124,246,.07);
  --ops-signal-border:rgba(46,124,246,.34);
  --ops-fg:#1E2329;
  --ops-fg-muted:#6B7280;
}
:root[data-color-scheme='dark']{ color-scheme: light }
.tab-header.active::before{ background: var(--ops-signal) }
`

export const fieldTerminalScheme = {
    name: FIELD_SCHEME_NAME,
    foreground: '#2A2F36',
    background: '#F6F1E7',
    cursor: '#2E7CF6',
    colors: [
        '#2A2F36', '#C82829', '#718C00', '#EAB700',
        '#4271AE', '#8959A8', '#3E999F', '#F6F1E7',
        '#5A5E66', '#C82829', '#718C00', '#EAB700',
        '#4271AE', '#8959A8', '#3E999F', '#1E2329',
    ] as const,
}

export const fieldPalette = {
    bg: '#F6F1E7',
    fg: '#2A2F36',
    cursor: '#2E7CF6',
    accent: '#C82829',
    selection: 'rgba(46,124,246,.14)',
    chrome: '#FFFFFF',
}
