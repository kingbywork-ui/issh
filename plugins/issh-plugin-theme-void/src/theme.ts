// Void — 虚空暮色：深靛紫基底 + 光纤粉紫，危险操作的玫红只在确认处出现
export const VOID_ID = 'issh-plugin-theme-void'
export const VOID_SCHEME_NAME = 'Void'

export const voidChromeCss = `
:root{
  --ops-base:#13122A;
  --ops-panel:#1B1A3A;
  --ops-line:#2A2850;
  --ops-signal:#FF4D6A;
  --ops-signal-dim:rgba(255,77,106,.13);
  --ops-signal-hover:rgba(255,77,106,.08);
  --ops-signal-border:rgba(255,77,106,.36);
  --ops-risk:#FF4D6A;
  --ops-risk-dim:rgba(255,77,106,.16);
  --ops-fg:#E0D8FF;
  --ops-fg-muted:rgba(224,216,255,.55);
  /* R-198 补齐：危险/信息/警告语义 + 弹窗蒙层（risk 已有定义，保持玫红原设定） */
  --ops-danger:#FF615A;
  --ops-danger-dim:rgba(255,97,90,.14);
  --ops-info:#9B8CFF;
  --ops-info-dim:rgba(155,140,255,.13);
  --ops-warn:#FFD166;
  --ops-warn-dim:rgba(255,209,102,.13);
  --ops-warn-border:rgba(255,209,102,.35);
  --ops-scrim:rgba(6,5,18,.66);
}
:root[data-color-scheme='light']{ color-scheme: dark }
.tab-header.active::before{ background: linear-gradient(90deg, #7A6CFF, #FF4D6A) }
`

export const voidTerminalScheme = {
    name: VOID_SCHEME_NAME,
    foreground: '#E0D8FF',
    background: '#13122A',
    cursor: '#FF4D6A',
    colors: [
        '#13122A', '#FF615A', '#7ED321', '#FFD166',
        '#7A6CFF', '#FF4D9A', '#4ECDC4', '#E0D8FF',
        '#2A2850', '#FF7A6A', '#A8E05F', '#FFE08A',
        '#9B8CFF', '#FF7AB5', '#7CE8E0', '#FFFFFF',
    ] as const,
}

export const voidPalette = {
    bg: '#13122A',
    fg: '#E0D8FF',
    cursor: '#FF4D6A',
    accent: '#7A6CFF',
    selection: 'rgba(163,140,255,.18)',
    chrome: '#1B1A3A',
}
