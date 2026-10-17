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
  /* R-198 补齐：危险/信息/警告/风险语义 + 弹窗蒙层 + 滚动条（浅色纸面适配） */
  --ops-danger:#C82829;
  --ops-danger-dim:rgba(200,40,41,.10);
  --ops-info:#4271AE;
  --ops-info-dim:rgba(66,113,174,.10);
  --ops-warn:#9A6700;
  --ops-warn-dim:rgba(154,103,0,.12);
  --ops-warn-border:rgba(154,103,0,.35);
  --ops-risk:#B45309;
  --ops-risk-dim:rgba(180,83,9,.12);
  --ops-scrim:rgba(64,52,28,.40);
  --ops-scrollbar-track:rgba(64,52,28,.08);
  --ops-scrollbar-thumb:rgba(42,47,54,.30);
  --ops-scrollbar-thumb-hover:rgba(42,47,54,.48);
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
