// 从 issh 分支 issh-community-color-schemes/schemes/ 提取的终端配色方案
// 格式与 xterm.js ITheme 兼容（16 色 + foreground/background/cursor）

export interface TerminalColorScheme {
    name: string
    foreground: string
    background: string
    cursor: string
    colors: [string, string, string, string, string, string, string, string, string, string, string, string, string, string, string, string]
}

export const terminalColorSchemes: TerminalColorScheme[] = [
    {
        name: 'Dracula',
        foreground: '#f8f8f2',
        background: '#1e1f29',
        cursor: '#bbbbbb',
        colors: ['#000000', '#ff5555', '#50fa7b', '#f1fa8c', '#bd93f9', '#ff79c6', '#8be9fd', '#bbbbbb', '#555555', '#ff5555', '#50fa7b', '#f1fa8c', '#bd93f9', '#ff79c6', '#8be9fd', '#ffffff'],
    },
    {
        name: 'Solarized Dark',
        foreground: '#839496',
        background: '#002b36',
        cursor: '#839496',
        colors: ['#073642', '#dc322f', '#859900', '#b58900', '#268bd2', '#d33682', '#2aa198', '#eee8d5', '#002b36', '#cb4b16', '#586e75', '#657b83', '#839496', '#6c71c4', '#93a1a1', '#fdf6e3'],
    },
    {
        name: 'Solarized Light',
        foreground: '#657b83',
        background: '#fdf6e3',
        cursor: '#657b83',
        colors: ['#073642', '#dc322f', '#859900', '#b58900', '#268bd2', '#d33682', '#2aa198', '#eee8d5', '#002b36', '#cb4b16', '#586e75', '#657b83', '#839496', '#6c71c4', '#93a1a1', '#fdf6e3'],
    },
    {
        name: 'TokyoNight',
        foreground: '#a9b1d6',
        background: '#1a1b26',
        cursor: '#c0caf5',
        colors: ['#15161e', '#f7768e', '#9ece6a', '#e0af68', '#7aa2f7', '#bb9af7', '#7dcfff', '#a9b1d6', '#414868', '#f7768e', '#9ece6a', '#e0af68', '#7aa2f7', '#bb9af7', '#7dcfff', '#c0caf5'],
    },
    {
        name: 'TokyoNight Storm',
        foreground: '#a9b1d6',
        background: '#24283b',
        cursor: '#c0caf5',
        colors: ['#1d202f', '#f7768e', '#9ece6a', '#e0af68', '#7aa2f7', '#bb9af7', '#7dcfff', '#a9b1d6', '#414868', '#f7768e', '#9ece6a', '#e0af68', '#7aa2f7', '#bb9af7', '#7dcfff', '#c0caf5'],
    },
    {
        name: 'One Half Dark',
        foreground: '#dcdfe4',
        background: '#282c34',
        cursor: '#dcdfe4',
        colors: ['#282c34', '#e06c75', '#98c379', '#e5c07b', '#61afef', '#c678dd', '#56b6c2', '#dcdfe4', '#5d677a', '#e06c75', '#98c379', '#e5c07b', '#61afef', '#c678dd', '#56b6c2', '#ffffff'],
    },
    {
        name: 'One Half Light',
        foreground: '#383a42',
        background: '#fafafa',
        cursor: '#4f525e',
        colors: ['#383a42', '#e45649', '#50a14f', '#c18401', '#4078f2', '#a626a4', '#0184bc', '#fafafa', '#4f525e', '#e06c75', '#98c379', '#e5c07b', '#61afef', '#c678dd', '#56b6c2', '#ffffff'],
    },
    {
        name: 'Ubuntu',
        foreground: '#eeeeec',
        background: '#300a24',
        cursor: '#bbbbbb',
        colors: ['#2e3436', '#cc0000', '#4e9a06', '#c4a000', '#3465a4', '#75507b', '#06989a', '#d3d7cf', '#555753', '#ef2929', '#8ae234', '#fce94f', '#729fcf', '#ad7fa8', '#34e2e2', '#eeeeec'],
    },
    {
        name: 'Monokai',
        foreground: '#f8f8f2',
        background: '#272822',
        cursor: '#f8f8f0',
        colors: ['#272822', '#f92672', '#a6e22e', '#f4bf75', '#66d9ef', '#ae81ff', '#a1efe4', '#f8f8f2', '#75715e', '#f92672', '#a6e22e', '#f4bf75', '#66d9ef', '#ae81ff', '#a1efe4', '#f9f8f5'],
    },
    {
        name: 'Gruvbox Dark',
        foreground: '#ebdbb2',
        background: '#282828',
        cursor: '#ebdbb2',
        colors: ['#282828', '#cc241d', '#98971a', '#d79921', '#458588', '#b16286', '#689d6a', '#a89984', '#928374', '#fb4934', '#b8bb26', '#fabd2f', '#83a598', '#d3869b', '#8ec07c', '#ebdbb2'],
    },
    {
        name: 'Nord',
        foreground: '#d8dee9',
        background: '#2e3440',
        cursor: '#d8dee9',
        colors: ['#3b4252', '#bf616a', '#a3be8c', '#ebcb8b', '#81a1c1', '#b48ead', '#88c0d0', '#e5e9f0', '#4c566a', '#bf616a', '#a3be8c', '#ebcb8b', '#81a1c1', '#b48ead', '#8fbcbb', '#eceff4'],
    },
    {
        name: 'Ayu',
        foreground: '#bfbdb6',
        background: '#0f1419',
        cursor: '#f29718',
        colors: ['#1a1f29', '#ff3333', '#c2d94c', '#ff8f40', '#59c2ff', '#f07178', '#95e6cb', '#c7c7c7', '#1a1f29', '#ff6565', '#aad94c', '#e6b673', '#7ad5ff', '#f28779', '#95e6cb', '#f2f2f2'],
    },
    {
        name: 'Catppuccin Mocha',
        foreground: '#cdd6f4',
        background: '#1e1e2e',
        cursor: '#f5e0dc',
        colors: ['#45475a', '#f38ba8', '#a6e3a1', '#f9e2af', '#89b4fa', '#f5c2e7', '#94e2d5', '#bac2de', '#585b70', '#f38ba8', '#a6e3a1', '#f9e2af', '#89b4fa', '#f5c2e7', '#94e2d5', '#a6adc8'],
    },
    {
        name: 'Rose Pine',
        foreground: '#e0def4',
        background: '#191724',
        cursor: '#e0def4',
        colors: ['#26233a', '#eb6f92', '#31748f', '#f6c177', '#9ccfd8', '#c4a7e7', '#ebbcba', '#e0def4', '#6e6a86', '#eb6f92', '#31748f', '#f6c177', '#9ccfd8', '#c4a7e7', '#ebbcba', '#e0def4'],
    },
    {
        name: 'Tomorrow Night',
        foreground: '#c5c8c6',
        background: '#1d1f21',
        cursor: '#ffffff',
        colors: ['#1d1f21', '#cc6666', '#b5bd68', '#f0c674', '#81a2be', '#b294bb', '#8abeb7', '#c5c8c6', '#969896', '#cc6666', '#b5bd68', '#f0c674', '#81a2be', '#b294bb', '#8abeb7', '#ffffff'],
    },
]

export function findScheme (name: string): TerminalColorScheme | null {
    return terminalColorSchemes.find((scheme) => scheme.name === name) ?? null
}
