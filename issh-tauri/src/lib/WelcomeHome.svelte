<script lang="ts">
    let { onclose }: { onclose: () => void } = $props()

    const welcomeKey = 'issh.enableWelcomeTab'
    let language = $state(localStorage.getItem('issh.language') ?? 'auto')
    let colorScheme = $state(localStorage.getItem('issh.colorScheme') ?? 'dark')
    let analytics = $state(localStorage.getItem('issh.analytics') !== 'false')
    let globalHotkey = $state(localStorage.getItem('issh.globalHotkey') !== 'false')

    function persist (key: string, value: string): void {
        try { localStorage.setItem(key, value) } catch {}
    }

    function closeAndDisable (): void {
        persist(welcomeKey, 'false')
        persist('issh.language', language)
        persist('issh.colorScheme', colorScheme)
        persist('issh.analytics', String(analytics))
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
                <button type="button" class:active={colorScheme === 'auto'} onclick={() => { colorScheme = 'auto'; persist('issh.colorScheme', colorScheme) }}>跟随系统</button>
                <button type="button" class:active={colorScheme === 'dark'} onclick={() => { colorScheme = 'dark'; persist('issh.colorScheme', colorScheme) }}>始终深色</button>
                <button type="button" class:active={colorScheme === 'light'} onclick={() => { colorScheme = 'light'; persist('issh.colorScheme', colorScheme) }}>始终浅色</button>
            </div>
        </div>

        <label class="welcome-toggle"><span><strong>启用匿名统计</strong><small>帮助统计 issh 的安装数量</small></span><input type="checkbox" bind:checked={analytics} onchange={() => persist('issh.analytics', String(analytics))} /></label>
        <label class="welcome-toggle"><span><strong>启用全局快捷键（Ctrl-Space）</strong><small>切换 issh 窗口显示状态</small></span><input type="checkbox" bind:checked={globalHotkey} onchange={() => persist('issh.globalHotkey', String(globalHotkey))} /></label>

        <button class="welcome-close" type="button" onclick={closeAndDisable}>关闭并不再显示</button>
    </div>
</main>
