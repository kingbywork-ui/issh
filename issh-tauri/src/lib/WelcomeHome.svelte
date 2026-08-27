<script lang="ts">
    import { onMount } from 'svelte'
    let { onclose }: { onclose: () => void } = $props()

    const welcomeKey = 'issh.enableWelcomeTab'
    let language = $state(localStorage.getItem('issh.language') ?? 'auto')
    let colorScheme = $state(localStorage.getItem('issh.colorScheme') ?? 'dark')
    let globalHotkey = $state(localStorage.getItem('issh.globalHotkey') !== 'false')

    function applyColorScheme (): void {
        document.documentElement.dataset.colorScheme = colorScheme
        document.documentElement.style.colorScheme = colorScheme === 'auto' ? 'light dark' : colorScheme
        persist('issh.colorScheme', colorScheme)
    }

    function selectColorScheme (scheme: 'auto' | 'dark' | 'light'): void {
        colorScheme = scheme
        applyColorScheme()
    }

    onMount(() => {
        applyColorScheme()
        const media = window.matchMedia('(prefers-color-scheme: light)')
        const update = (): void => { if (colorScheme === 'auto') applyColorScheme() }
        media.addEventListener('change', update)
        return () => media.removeEventListener('change', update)
    })

    function persist (key: string, value: string): void {
        try { localStorage.setItem(key, value) } catch {}
    }

    function closeAndDisable (): void {
        persist(welcomeKey, 'false')
        persist('issh.language', language)
        persist('issh.colorScheme', colorScheme)
        persist('issh.globalHotkey', String(globalHotkey))
        onclose()
    }
</script>

<main class="welcome-home" aria-label="issh 欢迎页">
    <div class="welcome-card">
        <div class="welcome-brand-mark" aria-hidden="true">›_</div>
        <h1>issh</h1>
        <p class="welcome-lead">感谢下载 issh！</p>

        <div class="welcome-setting">
            <div class="welcome-setting-title">语言</div>
            <select bind:value={language} onchange={() => persist('issh.language', language)} aria-label="语言">
                <option value="auto">自动</option>
                <option value="zh-CN">简体中文</option>
                <option value="en">English</option>
            </select>
        </div>

        <div class="welcome-setting">
            <div class="welcome-setting-title">颜色方案</div>
            <div class="welcome-choice-group" role="group" aria-label="颜色方案">
                <button type="button" class:active={colorScheme === 'auto'} onclick={() => selectColorScheme('auto')}>跟随系统</button>
                <button type="button" class:active={colorScheme === 'dark'} onclick={() => selectColorScheme('dark')}>始终深色</button>
                <button type="button" class:active={colorScheme === 'light'} onclick={() => selectColorScheme('light')}>始终浅色</button>
            </div>
        </div>

        <label class="welcome-toggle"><span><strong>启用全局快捷键（Ctrl-Space）</strong><small>切换 issh 窗口显示状态</small></span><input type="checkbox" bind:checked={globalHotkey} onchange={() => persist('issh.globalHotkey', String(globalHotkey))} /></label>

        <button class="welcome-close" type="button" onclick={closeAndDisable}>关闭并不再显示</button>
    </div>
</main>
