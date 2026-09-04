<script lang="ts">
    import { mount, unmount } from 'svelte'
    import { onMount } from 'svelte'
    import {
        disablePlugin,
        enablePlugin,
        getSettingsTabs,
        listPlugins,
        loadMarketplacePlugin,
        reloadMarketplacePlugin,
        subscribeUi,
        uninstallPlugin,
        SUPERSEDED_PLUGIN_IDS,
    } from './plugins/pluginHost'
    import type { RegistryEntry } from './plugins/types'
    import { invoke } from '@tauri-apps/api/core'
    import { terminalColorSchemes } from './terminalSchemes'
    import AutoSudoSettings from './AutoSudoSettings.svelte'
    import VaultSettings from './VaultSettings.svelte'
    import { lockHostProfiles, runtimeHealth, checkUpdate, getBuildInfo, type UpdateCheckResult, type BuildInfo } from './runtime'

    let { onclose }: { onclose: () => void } = $props()

    type Section = 'general' | 'vault' | 'auto-sudo' | 'plugins' | 'market' | 'about' | 'plugin-tab'

    interface MarketEntry {
        id: string
        name: string
        version: string
        description: string
        kind: string
        permissions: string[]
        min_app_version?: string | null
        dependencies?: Array<string | { id: string; minVersion?: string }> | null
        download_url: string
        sha256: string
        homepage?: string | null
        repository?: string | null
        signature?: string | null
        downloads?: number | null
        audience?: 'user' | 'developer' | null
    }

    interface InstalledRecord {
        id: string
        name: string
        version: string
        description: string
        kind: string
        permissions: string[]
        entry: string
        directory: string
    }

    const DEFAULT_REGISTRY = 'https://raw.githubusercontent.com/kingbywork-ui/issh-plugin-registry/main/index.json'

    const MARKET_I18N: Record<string, Record<string, string>> = {
        zh: {
            'market.title': '插件商城',
            'market.search': '搜索插件…',
            'market.searchLabel': '搜索插件',
            'market.registry': '索引地址',
            'market.refresh': '刷新',
            'market.refreshing': '加载中…',
            'market.stats.total': '共 {n} 个插件',
            'market.stats.installed': '已安装 {n}',
            'market.stats.updates': '可更新 {n}',
            'market.kind.all': '全部',
            'market.kind.feature': '功能',
            'market.kind.appearance': '外观',
            'market.kind.integration': '集成',
            'market.developerToggle': '显示开发者插件',
            'market.developerBadge': '开发者示例',
            'market.install': '安装',
            'market.update': '更新',
            'market.installed': '已安装',
            'market.installedAt': '已装 v{v}，可更新',
            'market.downloads': '下载 {n}',
            'market.empty': '暂无插件',
            'market.page.prev': '上一页',
            'market.page.next': '下一页',
            'market.page.info': '第 {p} / {total} 页',
            'kind.feature': '功能',
            'kind.appearance': '外观',
            'kind.integration': '集成',
        },
        en: {
            'market.title': 'Plugin Marketplace',
            'market.search': 'Search plugins…',
            'market.searchLabel': 'Search plugins',
            'market.registry': 'Registry URL',
            'market.refresh': 'Refresh',
            'market.refreshing': 'Loading…',
            'market.stats.total': '{n} plugins',
            'market.stats.installed': '{n} installed',
            'market.stats.updates': '{n} updatable',
            'market.kind.all': 'All',
            'market.kind.feature': 'Feature',
            'market.kind.appearance': 'Appearance',
            'market.kind.integration': 'Integration',
            'market.install': 'Install',
            'market.update': 'Update',
            'market.installed': 'Installed',
            'market.installedAt': 'v{v} installed, updatable',
            'market.downloads': '{n} downloads',
            'market.empty': 'No plugins',
            'market.page.prev': 'Prev',
            'market.page.next': 'Next',
            'market.page.info': 'Page {p} / {total}',
            'kind.feature': 'Feature',
            'kind.appearance': 'Appearance',
            'kind.integration': 'Integration',
            'market.developerToggle': 'Show developer plugins',
            'market.developerBadge': 'Developer sample',
        },
    }

    function marketLocale (): 'zh' | 'en' {
        const setting = localStorage.getItem('issh.language') ?? 'auto'
        if (setting === 'zh' || setting === 'zh-CN' || setting === 'en') return setting === 'en' ? 'en' : 'zh'
        return navigator.language.toLowerCase().startsWith('zh') ? 'zh' : 'en'
    }

    function t (key: string, params?: Record<string, string | number>): string {
        const locale = marketLocale()
        let text = MARKET_I18N[locale]?.[key] ?? MARKET_I18N.zh[key] ?? key
        if (params) {
            for (const [name, value] of Object.entries(params)) {
                text = text.replaceAll(`{${name}}`, String(value))
            }
        }
        return text
    }

    let section = $state<Section>('general')
    let language = $state(localStorage.getItem('issh.language') ?? 'auto')
    let colorScheme = $state(localStorage.getItem('issh.colorScheme') ?? 'dark')
    let terminalScheme = $state(localStorage.getItem('issh.terminalScheme') ?? '')
    let enableWelcome = $state(localStorage.getItem('issh.enableWelcomeTab') !== 'false')
    let globalHotkey = $state(localStorage.getItem('issh.globalHotkey') !== 'false')

    let plugins = $state<RegistryEntry[]>([])
    let pluginBusy = $state('')
    let pluginError = $state('')

    let registryUrl = $state(localStorage.getItem('issh.plugins.registryUrl') ?? DEFAULT_REGISTRY)
    let marketEntries = $state<MarketEntry[]>([])
    let marketLoading = $state(false)
    let marketError = $state('')
    let marketSearch = $state('')
    let marketKind = $state<'all' | 'feature' | 'appearance' | 'integration'>('all')
    let showDeveloperPlugins = $state(localStorage.getItem('issh.plugins.showDeveloper') === 'true')
    let marketPage = $state(1)
    const MARKET_PAGE_SIZE = 6
    let detailEntry = $state<MarketEntry | null>(null)
    const permissionLabels: Record<string, string> = {
        'settings:tab': '注册设置页标签（在设置中显示插件配置）',
        'home:card': '注册首页卡片（在欢迎页显示信息卡片）',
        'panel:register': '注册面板（在主界面显示侧边/底部面板）',
        'terminal:decorate': '装饰终端（读取终端内容、拦截按键与写入）',
        'profiles:read': '读取主机配置（含主机名、用户名、端口）',
        'profiles:write': '修改主机配置（创建/更新/删除主机与分组）',
    }
    let installTarget = $state<MarketEntry | null>(null)
    let installBusy = $state(false)
    let installError = $state('')
    let installedFromMarket = $state<InstalledRecord[]>([])

    let appVersion = $state('')
    let runtimeVersion = $state('')
    let isWindows = $state(navigator.userAgent.includes('Windows'))
    let elevateBusy = $state(false)
    let elevateError = $state('')

    const productVersion = '0.0.2'
    let tauriVersion = $state('')
    let webviewVersion = $state('')
    let updateChecking = $state(false)
    let updateError = $state('')
    let updateResult = $state<UpdateCheckResult | null>(null)
    let buildBranch = $state('')

    let tabs = $state(getSettingsTabs())

    // 插件注册的设置页组件是任意框架组件（当前生态为 Svelte 组件对象），
    // 用 mount/unmount 手动挂载到容器节点（Svelte 5 runes 组件不能直接动态 import 后用 <svelte:component>）
    let pluginTabSection = $state('')
    let pluginTabError = $state('')
    let mountedPluginTab = ''
    const mountedComponents = new Map<string, { destroy (): void }>()

    function unmountPluginTab (): void {
        if (!mountedPluginTab) return
        const previous = mountedComponents.get(mountedPluginTab)
        if (previous) {
            try { previous.destroy() } catch { /* 忽略卸载失败 */ }
            mountedComponents.delete(mountedPluginTab)
        }
        mountedPluginTab = ''
    }

    function leaveVault (next: Section): void {
        if (section === 'vault' && next !== 'vault') {
            void lockHostProfiles().catch(() => {})
        }
        section = next
        if (next !== 'plugin-tab') pluginTabSection = ''
        if (next === 'general') loadKnownHosts()
    }

    function closeSettings (): void {
        if (section === 'vault') {
            void lockHostProfiles().catch(() => {})
        }
        onclose()
    }

    function showPluginTab (tabId: string): void {
        const tab = tabs.find((candidate) => (candidate.key ?? candidate.id) === tabId)
        if (!tab) return
        pluginTabError = ''
        pluginTabSection = tabId
        leaveVault('plugin-tab')
    }

    $effect(() => {
        const host = pluginTabContainer
        const activeTab = tabs.find((candidate) => (candidate.key ?? candidate.id) === pluginTabSection)
        if (!host) {
            // 离开插件设置页：销毁手动挂载的组件
            unmountPluginTab()
            return
        }
        const activeId = activeTab ? (activeTab.key ?? activeTab.id) : ''
        if (activeId === mountedPluginTab) return
        unmountPluginTab()
        for (const child of [...host.children]) child.remove()
        if (activeTab?.mount) {
            // 外置插件用自身打包的 svelte runtime 自挂载，避免跨 runtime 触发 effect_orphan
            try {
                const destroy = activeTab.mount(host)
                mountedComponents.set(activeId, { destroy })
                mountedPluginTab = activeId
                pluginTabError = ''
            } catch (cause) {
                pluginTabError = `插件设置页加载失败：${cause instanceof Error ? cause.message : String(cause)}`
                console.warn(`[settings] 插件设置页自挂载失败：${activeId}`, cause)
            }
        } else if (activeTab?.component) {
            try {
                const instance = mount(activeTab.component as Parameters<typeof mount>[0], { target: host })
                mountedComponents.set(activeId, { destroy: () => unmount(instance) })
                mountedPluginTab = activeId
                pluginTabError = ''
            } catch (cause) {
                // 外置插件可能由旧版 Svelte 编译，尝试其 class 组件兼容入口。
                for (const child of [...host.children]) child.remove()
                const LegacyComponent = activeTab.component as unknown as { new (options: { target: HTMLElement }): { $destroy?: () => void } }
                try {
                    const legacy = new LegacyComponent({ target: host })
                    mountedComponents.set(activeId, { destroy: () => { legacy.$destroy?.() } })
                    mountedPluginTab = activeId
                    pluginTabError = ''
                } catch (legacyCause) {
                    pluginTabError = `插件设置页加载失败：${legacyCause instanceof Error ? legacyCause.message : String(legacyCause)}`
                    console.warn(`[settings] 插件设置页挂载失败：${activeId}`, cause, legacyCause)
                }
            }
        }
    })

    let pluginTabContainer = $state<HTMLElement | null>(null)

    const filteredMarket = $derived(
        marketEntries.filter((entry) => {
            if (entry.audience === 'developer' && !showDeveloperPlugins) return false
            if (marketKind !== 'all' && entry.kind !== marketKind) return false
            const keyword = marketSearch.trim().toLowerCase()
            if (!keyword) return true
            return entry.name.toLowerCase().includes(keyword) || entry.id.toLowerCase().includes(keyword) || entry.description.toLowerCase().includes(keyword)
        }),
    )

    const kindCounts = $derived.by(() => {
        const counts = { all: 0, feature: 0, appearance: 0, integration: 0 }
        for (const entry of marketEntries) {
            if (entry.audience === 'developer' && !showDeveloperPlugins) continue
            counts.all += 1
            if (entry.kind === 'feature' || entry.kind === 'appearance' || entry.kind === 'integration') counts[entry.kind] += 1
        }
        return counts
    })

    const marketTotalPages = $derived(Math.max(1, Math.ceil(filteredMarket.length / MARKET_PAGE_SIZE)))
    const marketCurrentPage = $derived(Math.min(marketPage, marketTotalPages))
    const pagedMarket = $derived(filteredMarket.slice((marketCurrentPage - 1) * MARKET_PAGE_SIZE, marketCurrentPage * MARKET_PAGE_SIZE))

    $effect(() => {
        void marketSearch
        void marketKind
        void showDeveloperPlugins
        marketPage = 1
    })

    function toggleDeveloperPlugins (event: Event): void {
        showDeveloperPlugins = (event.currentTarget as HTMLInputElement).checked
        persist('issh.plugins.showDeveloper', String(showDeveloperPlugins))
    }

    onMount(() => {
        plugins = listPlugins()
        tabs = getSettingsTabs()
        const unsubscribe = subscribeUi(() => {
            plugins = listPlugins()
            tabs = getSettingsTabs()
        })
        void loadInstalled()
        void loadAbout()
        return unsubscribe
    })

    function persist (key: string, value: string): void {
        try { localStorage.setItem(key, value) } catch {}
    }

    // A3（R-010）已知主机指纹管理：扫描 localStorage 中 issh.trustedHostKey.{host}:{port} 记录
    interface KnownHostEntry {
        key: string
        host: string
        port: string
        fingerprint: string
    }

    let knownHosts = $state<KnownHostEntry[]>([])

    function loadKnownHosts (): void {
        const entries: KnownHostEntry[] = []
        for (let index = 0; index < localStorage.length; index += 1) {
            const key = localStorage.key(index)
            if (!key?.startsWith('issh.trustedHostKey.')) continue
            const fingerprint = localStorage.getItem(key) ?? ''
            const target = key.slice('issh.trustedHostKey.'.length)
            const colon = target.lastIndexOf(':')
            const host = colon >= 0 ? target.slice(0, colon) : target
            const port = colon >= 0 ? target.slice(colon + 1) : '22'
            entries.push({ key, host, port, fingerprint })
        }
        knownHosts = entries.sort((a, b) => `${a.host}:${a.port}`.localeCompare(`${b.host}:${b.port}`))
    }

    function removeKnownHost (key: string): void {
        localStorage.removeItem(key)
        loadKnownHosts()
    }

    function applyColorScheme (): void {
        document.documentElement.dataset.colorScheme = colorScheme
        document.documentElement.style.colorScheme = colorScheme === 'auto' ? 'light dark' : colorScheme
        persist('issh.colorScheme', colorScheme)
    }

    async function togglePlugin (entry: RegistryEntry, enabled: boolean): Promise<void> {
        pluginBusy = entry.manifest.id
        pluginError = ''
        try {
            if (enabled) await enablePlugin(entry.manifest.id)
            else await disablePlugin(entry.manifest.id)
        } catch (cause) {
            pluginError = cause instanceof Error ? cause.message : String(cause)
        } finally {
            pluginBusy = ''
            plugins = listPlugins()
        }
    }

    async function removePlugin (entry: RegistryEntry): Promise<void> {
        if (entry.source === 'builtin') return
        if (!window.confirm(`确定卸载插件「${entry.manifest.name}」？`)) return
        pluginBusy = entry.manifest.id
        pluginError = ''
        try {
            await uninstallPlugin(entry.manifest.id)
            if (entry.source === 'marketplace') await invoke('plugin_delete', { id: entry.manifest.id })
        } catch (cause) {
            pluginError = cause instanceof Error ? cause.message : String(cause)
        } finally {
            pluginBusy = ''
            plugins = listPlugins()
            void loadInstalled()
        }
    }

    async function loadMarket (): Promise<void> {
        marketLoading = true
        marketError = ''
        try {
            const registry = await invoke<{ plugins: MarketEntry[] }>('plugin_fetch_registry', { url: registryUrl })
            marketEntries = (registry.plugins ?? []).filter((entry) => !SUPERSEDED_PLUGIN_IDS.has(entry.id))
            persist('issh.plugins.registryUrl', registryUrl)
        } catch (cause) {
            marketError = cause instanceof Error ? cause.message : String(cause)
            marketEntries = []
        } finally {
            marketLoading = false
        }
    }

    async function loadInstalled (): Promise<void> {
        try {
            installedFromMarket = await invoke<InstalledRecord[]>('plugin_list_installed')
        } catch {
            installedFromMarket = []
        }
    }

    async function loadAbout (): Promise<void> {
        try {
            const health = await runtimeHealth()
            runtimeVersion = health.runtimeVersion
        } catch { runtimeVersion = '' }
        try {
            const { getVersion, getTauriVersion } = await import('@tauri-apps/api/app')
            appVersion = await getVersion()
            tauriVersion = await getTauriVersion()
        } catch { appVersion = '' }
        // WebView2 版本：Windows 下 UA 形如 ... Edg/xx.x.x
        const edgeMatch = navigator.userAgent.match(/Edg\/([\d.]+)/)
        webviewVersion = edgeMatch ? edgeMatch[1] : ''
        try {
            const info = await getBuildInfo()
            buildBranch = info.branch
        } catch { buildBranch = '' }
    }

    async function runUpdateCheck (): Promise<void> {
        updateChecking = true
        updateError = ''
        updateResult = null
        try {
            updateResult = await checkUpdate(productVersion)
        } catch (cause) {
            // AC3：网络失败静默降级，仅提示、不阻塞设置页
            updateError = cause instanceof Error ? cause.message : String(cause)
        } finally {
            updateChecking = false
        }
    }

    async function relaunchElevated (): Promise<void> {
        elevateBusy = true
        elevateError = ''
        try {
            await invoke('relaunch_elevated')
        } catch (cause) {
            elevateError = cause instanceof Error ? cause.message : String(cause)
        } finally {
            elevateBusy = false
        }
    }

    function beginInstall (entry: MarketEntry): void {
        installTarget = entry
        installError = ''
    }

    function installedVersionOf (entry: MarketEntry): string | null {
        const record = installedFromMarket.find((candidate) => candidate.id === entry.id)
        return record?.version ?? null
    }

    function hasUpdate (entry: MarketEntry): boolean {
        const installedVersion = installedVersionOf(entry)
        if (!installedVersion) return false
        return compareVersions(entry.version, installedVersion) > 0
    }

    function permissionLabel (permission: string): string {
        return permissionLabels[permission] ?? permission
    }

    function normalizeDep (dep: string | { id: string; minVersion?: string }): { id: string; minVersion?: string } {
        return typeof dep === 'string' ? { id: dep } : dep
    }

    function dependencyStatusLabel (entry: MarketEntry): string | null {
        const deps = entry.dependencies ?? []
        if (deps.length === 0) return null
        for (const dep of deps) {
            const { id, minVersion } = normalizeDep(dep)
            const installed = installedFromMarket.find((candidate) => candidate.id === id)
            if (!installed) {
                return `需先安装依赖：${id}`
            }
            if (minVersion && compareVersions(installed.version, minVersion) < 0) {
                return `依赖 ${id} 需 ≥ v${minVersion}（已装 v${installed.version}）`
            }
        }
        return null
    }

    function formatDownloads (count: number | null | undefined): string {
        if (!count) return '—'
        if (count >= 10000) return `${(count / 10000).toFixed(1)}w`
        if (count >= 1000) return `${(count / 1000).toFixed(1)}k`
        return String(count)
    }

    const marketStats = $derived.by(() => {
        const visibleEntries = marketEntries.filter((entry) => entry.audience !== 'developer' || showDeveloperPlugins)
        const total = visibleEntries.length
        let installedCount = 0
        let updateCount = 0
        for (const entry of visibleEntries) {
            const installedVersion = installedVersionOf(entry)
            if (installedVersion) {
                installedCount += 1
                if (compareVersions(entry.version, installedVersion) > 0) updateCount += 1
            }
        }
        return { total, installed: installedCount, updates: updateCount }
    })

    function compareVersions (a: string, b: string): number {
        const pa = a.split('.').map((part) => Number.parseInt(part, 10) || 0)
        const pb = b.split('.').map((part) => Number.parseInt(part, 10) || 0)
        for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
            const diff = (pa[i] ?? 0) - (pb[i] ?? 0)
            if (diff !== 0) return diff
        }
        return 0
    }

    function meetsAppVersion (minAppVersion?: string | null): boolean {
        if (!minAppVersion) return true
        return compareVersions(productVersion, minAppVersion) >= 0
    }

    async function confirmInstall (): Promise<void> {
        if (!installTarget) return
        // appVersion 未加载时先加载，避免 min_app_version 校验误判通过
        if (!appVersion) await loadAbout()
        if (!meetsAppVersion(installTarget.min_app_version)) {
            installError = `需要 issh ${installTarget.min_app_version} 及以上版本（当前 ${appVersion || '未知'}）`
            return
        }
        installBusy = true
        installError = ''
        try {
            const isUpdate = installedFromMarket.some((record) => record.id === installTarget!.id)
            // 更新流程：磁盘文件被 plugin_download 原子替换后，直接重载插件；
            // 不预卸载（避免下载失败后旧版本已被停用）
            const installed = await invoke<InstalledRecord>('plugin_download', {
                id: installTarget.id,
                url: installTarget.download_url,
                sha256: installTarget.sha256,
                signature: installTarget.signature ?? null,
                version: installTarget.version,
            })
            try {
                if (isUpdate) {
                    await reloadMarketplacePlugin(installed.directory, installed.entry, installed.id)
                } else {
                    await loadMarketplacePlugin(installed.directory, installed.entry, installed.id)
                }
            } catch (cause) {
                console.warn('[market] 插件已下载但热加载失败（重启后生效）：', cause)
            }
            installTarget = null
            await loadInstalled()
        } catch (cause) {
            installError = cause instanceof Error ? cause.message : String(cause)
        } finally {
            installBusy = false
        }
    }

    function kindLabel (kind: string): string {
        if (kind === 'appearance') return t('kind.appearance')
        if (kind === 'integration') return t('kind.integration')
        return t('kind.feature')
    }

    function stateLabel (entry: RegistryEntry): string {
        if (entry.state === 'active') return '运行中'
        if (entry.state === 'failed') return '异常'
        return '已停用'
    }
</script>

<div class="settings-backdrop" role="presentation" onclick={closeSettings} onkeydown={(event) => { if (event.key === 'Escape') closeSettings() }}>
    <div class="settings-panel" role="dialog" aria-label="设置" tabindex="-1" onclick={(event) => { event.stopPropagation() }} onkeydown={(event) => { event.stopPropagation() }}>
        <header class="settings-header">
            <h1>设置</h1>
            <button class="icon-button" type="button" onclick={closeSettings} aria-label="关闭设置">✕</button>
        </header>
        <div class="settings-body">
            <nav class="settings-nav" aria-label="设置分组">
                <button class:active={section === 'general'} type="button" onclick={() => leaveVault('general')}>通用</button>
                <button class:active={section === 'vault'} type="button" onclick={() => leaveVault('vault')}>保险库</button>
                <button class:active={section === 'auto-sudo'} type="button" onclick={() => leaveVault('auto-sudo')}>sudo 密码</button>
                <button class:active={section === 'plugins'} type="button" onclick={() => leaveVault('plugins')}>插件</button>
                <button class:active={section === 'market'} type="button" onclick={() => leaveVault('market')}>插件商城</button>
                <button class:active={section === 'about'} type="button" onclick={() => leaveVault('about')}>关于</button>
                {#each tabs as tab (tab.key ?? tab.id)}
                    <button class:active={pluginTabSection === (tab.key ?? tab.id)} class="settings-nav-plugin" type="button" onclick={() => { showPluginTab(tab.key ?? tab.id) }}>{tab.title}</button>
                {/each}
            </nav>
            <div class="settings-content">
                {#if section === 'general'}
                    <section aria-label="通用设置">
                        <div class="settings-field">
                            <div class="settings-field-title">语言</div>
                            <select bind:value={language} onchange={() => persist('issh.language', language)} aria-label="语言">
                                <option value="auto">自动</option>
                                <option value="zh-CN">简体中文</option>
                                <option value="en">English</option>
                            </select>
                        </div>
                        <div class="settings-field">
                            <div class="settings-field-title">颜色方案</div>
                            <select bind:value={colorScheme} onchange={() => applyColorScheme()} aria-label="颜色方案">
                                <option value="auto">自动</option>
                                <option value="dark">深色</option>
                                <option value="light">浅色</option>
                            </select>
                        </div>
                        <div class="settings-field">
                            <div class="settings-field-title">终端配色</div>
                            <select bind:value={terminalScheme} onchange={() => persist('issh.terminalScheme', terminalScheme)} aria-label="终端配色">
                                <option value="">跟随主题（默认）</option>
                                {#each terminalColorSchemes as scheme (scheme.name)}
                                    <option value={scheme.name}>{scheme.name}</option>
                                {/each}
                            </select>
                        </div>
                        <div class="settings-field">
                            <div class="settings-field-title">本地终端 Shell</div>
                            <select value={localStorage.getItem('issh.localShell') ?? 'cmd'} onchange={(event) => persist('issh.localShell', (event.currentTarget as HTMLSelectElement).value)} aria-label="本地终端 Shell">
                                <option value="cmd">命令提示符（cmd）</option>
                                <option value="powershell">Windows PowerShell</option>
                                <option value="pwsh">PowerShell Core</option>
                                <option value="wsl">WSL</option>
                                <option value="git-bash">Git Bash</option>
                            </select>
                        </div>
                        <div class="settings-field">
                            <div class="settings-field-title">快捷键</div>
                            <div class="hotkey-list">
                                <div class="hotkey-row"><span>新建本地终端</span><kbd>Ctrl+Shift+T</kbd></div>
                                <div class="hotkey-row"><span>关闭当前标签</span><kbd>Ctrl+W</kbd></div>
                                <div class="hotkey-row"><span>下一个标签</span><kbd>Ctrl+Tab</kbd></div>
                                <div class="hotkey-row"><span>上一个标签</span><kbd>Ctrl+Shift+Tab</kbd></div>
                                <div class="hotkey-row"><span>批量输入</span><kbd>Ctrl+Shift+S</kbd></div>
                                <div class="hotkey-row"><span>打开设置</span><kbd>Ctrl+,</kbd></div>
                            </div>
                        </div>
                        <label class="settings-toggle">
                            <input type="checkbox" bind:checked={enableWelcome} onchange={() => persist('issh.enableWelcomeTab', String(enableWelcome))} />
                            <span>启动时显示欢迎页</span>
                        </label>
                        <label class="settings-toggle">
                            <input type="checkbox" bind:checked={globalHotkey} onchange={() => persist('issh.globalHotkey', String(globalHotkey))} />
                            <span>全局快捷键唤起</span>
                        </label>
                        <div class="settings-field">
                            <div class="settings-field-title">已知主机指纹</div>
                            <p class="settings-hint">已信任的 SSH 主机密钥指纹；删除后下次连接将重新走指纹确认。</p>
                            {#if knownHosts.length === 0}
                                <div class="settings-empty">暂无已信任主机。</div>
                            {:else}
                                {#each knownHosts as host (host.key)}
                                    <div class="known-host-row">
                                        <div class="known-host-info">
                                            <strong>{host.host}:{host.port}</strong>
                                            <code class="known-host-fp">{host.fingerprint}</code>
                                        </div>
                                        <button type="button" class="known-host-remove" onclick={() => removeKnownHost(host.key)}>删除</button>
                                    </div>
                                {/each}
                            {/if}
                        </div>
                    </section>
                {:else if section === 'vault'}
                    <VaultSettings />
                {:else if section === 'auto-sudo'}
                    <AutoSudoSettings />
                {:else if section === 'plugins'}
                    <section aria-label="插件管理">
                        {#if pluginError}
                            <div class="settings-error" role="alert">{pluginError}</div>
                        {/if}
                        {#if plugins.length === 0}
                            <div class="settings-empty">尚未安装任何插件，可前往「插件商城」浏览。</div>
                        {/if}
                        {#each plugins as entry (entry.manifest.id)}
                            <div class="plugin-card" class:disabled={!entry.enabled}>
                                <div class="plugin-card-head">
                                    <strong>{entry.manifest.name}</strong>
                                    <span class="plugin-version">v{entry.manifest.version}</span>
                                    <span class="plugin-state" class:active={entry.state === 'active'} class:failed={entry.state === 'failed'}>{stateLabel(entry)}</span>
                                </div>
                                <div class="plugin-card-desc">{entry.manifest.description}</div>
                                {#if entry.error}
                                    <div class="plugin-error">{entry.error}</div>
                                {/if}
                                <div class="plugin-card-actions">
                                    <label class="settings-toggle">
                                        <input
                                            type="checkbox"
                                            checked={entry.enabled}
                                            disabled={pluginBusy === entry.manifest.id}
                                            onchange={(event) => void togglePlugin(entry, (event.currentTarget as HTMLInputElement).checked)}
                                        />
                                        <span>启用</span>
                                    </label>
                                    {#if entry.source === 'marketplace'}
                                        <button class="plugin-remove" type="button" disabled={pluginBusy === entry.manifest.id} onclick={() => void removePlugin(entry)}>卸载</button>
                                    {:else}
                                        <span class="plugin-source">内置</span>
                                    {/if}
                                </div>
                            </div>
                        {/each}
                        {#if marketTotalPages > 1}
                            <div class="market-pagination">
                                <button type="button" class="market-page-btn" disabled={marketCurrentPage <= 1} onclick={() => { marketPage = marketCurrentPage - 1 }}>{t('market.page.prev')}</button>
                                <span class="market-page-info">{t('market.page.info', { p: marketCurrentPage, total: marketTotalPages })}</span>
                                <button type="button" class="market-page-btn" disabled={marketCurrentPage >= marketTotalPages} onclick={() => { marketPage = marketCurrentPage + 1 }}>{t('market.page.next')}</button>
                            </div>
                        {/if}
                        {#if installedFromMarket.length > 0}
                            <h2 class="settings-subtitle">商城安装记录</h2>
                            {#each installedFromMarket as record (record.id)}
                                <div class="plugin-card">
                                    <div class="plugin-card-head">
                                        <strong>{record.name}</strong>
                                        <span class="plugin-version">v{record.version}</span>
                                    </div>
                                    <div class="plugin-card-desc">{record.description}</div>
                                </div>
                            {/each}
                        {/if}
                    </section>
                {:else if section === 'market'}
                    <section aria-label="插件商城">
                        <div class="market-controls">
                            <input class="market-search" type="search" placeholder={t('market.search')} bind:value={marketSearch} aria-label={t('market.searchLabel')} />
                            <input class="market-url" type="url" bind:value={registryUrl} aria-label={t('market.registry')} />
                            <button class="market-refresh" type="button" disabled={marketLoading} onclick={() => void loadMarket()}>{marketLoading ? t('market.refreshing') : t('market.refresh')}</button>
                            <label class="market-developer-toggle">
                                <input type="checkbox" checked={showDeveloperPlugins} onchange={toggleDeveloperPlugins} />
                                <span>{t('market.developerToggle')}</span>
                            </label>
                        </div>
                        {#if !marketLoading && marketEntries.length > 0}
                            <div class="market-stats">
                                <span>{t('market.stats.total', { n: marketStats.total })}</span>
                                <span>{t('market.stats.installed', { n: marketStats.installed })}</span>
                                {#if marketStats.updates > 0}
                                    <span class="market-stats-updates">{t('market.stats.updates', { n: marketStats.updates })}</span>
                                {/if}
                            </div>
                        {/if}
                        <div class="market-kinds" role="tablist" aria-label={t('market.title')}>
                            {#each [['all', t('market.kind.all')], ['feature', t('market.kind.feature')], ['appearance', t('market.kind.appearance')], ['integration', t('market.kind.integration')]] as [kind, label] (kind)}
                                <button
                                    type="button"
                                    class="market-kind"
                                    class:active={marketKind === kind}
                                    aria-pressed={marketKind === kind}
                                    onclick={() => { marketKind = kind as typeof marketKind }}
                                >{label}（{kindCounts[kind as keyof typeof kindCounts]}）</button>
                            {/each}
                        </div>
                        {#if marketError}
                            <div class="settings-error" role="alert">{marketError}</div>
                        {/if}
                        {#if !marketLoading && filteredMarket.length === 0 && !marketError}
                            <div class="settings-empty">{t('market.empty')}</div>
                        {/if}
                        {#if detailEntry}
                            <div class="plugin-detail">
                                <button class="market-back" type="button" onclick={() => { detailEntry = null }}>← 返回列表</button>
                                <div class="plugin-card-head">
                                    <strong>{detailEntry.name}</strong>
                                    <span class="plugin-version">v{detailEntry.version}</span>
                                    <span class="plugin-kind">{kindLabel(detailEntry.kind)}</span>
                                    {#if detailEntry.audience === 'developer'}
                                        <span class="plugin-kind plugin-kind-developer">{t('market.developerBadge')}</span>
                                    {/if}
                                    {#if detailEntry.downloads}
                                        <span class="plugin-downloads">{t('market.downloads', { n: formatDownloads(detailEntry.downloads) })}</span>
                                    {/if}
                                </div>
                                <div class="plugin-card-desc">{detailEntry.description}</div>
                                {#if dependencyStatusLabel(detailEntry)}
                                    <div class="plugin-dep-warning">⚠ {dependencyStatusLabel(detailEntry)}</div>
                                {/if}
                                <div class="plugin-detail-meta">
                                    <div><span class="plugin-detail-label">插件 ID</span><code>{detailEntry.id}</code></div>
                                    {#if detailEntry.min_app_version}
                                        <div><span class="plugin-detail-label">最低客户端版本</span><code>v{detailEntry.min_app_version}</code></div>
                                    {/if}
                                    {#if detailEntry.sha256}
                                        <div><span class="plugin-detail-label">包哈希</span><code class="plugin-detail-hash">{detailEntry.sha256.slice(0, 16)}…</code></div>
                                    {/if}
                                    {#if detailEntry.signature}
                                        <div><span class="plugin-detail-label">签名</span><span class="plugin-signed">已签名（ed25519）</span></div>
                                    {/if}
                                </div>
                                <div class="plugin-detail-perms">
                                    <div class="plugin-detail-label">权限说明</div>
                                    {#each detailEntry.permissions as permission (permission)}
                                        <div class="plugin-detail-perm">• {permissionLabel(permission)}</div>
                                    {:else}
                                        <div class="plugin-detail-perm">无权限声明</div>
                                    {/each}
                                </div>
                                {#if detailEntry.dependencies && detailEntry.dependencies.length > 0}
                                    <div class="plugin-detail-perms">
                                        <div class="plugin-detail-label">依赖插件</div>
                                        {#each detailEntry.dependencies as dep (normalizeDep(dep).id)}
                                            <div class="plugin-detail-perm">• {normalizeDep(dep).id}{normalizeDep(dep).minVersion ? `（≥ v${normalizeDep(dep).minVersion}）` : ''}</div>
                                        {/each}
                                    </div>
                                {/if}
                                <div class="plugin-card-actions">
                                    {#if hasUpdate(detailEntry)}
                                        <span class="plugin-update-hint">已装 v{installedVersionOf(detailEntry)}，可更新</span>
                                        <button class="market-install" type="button" onclick={() => { if (detailEntry) beginInstall(detailEntry) }}>更新</button>
                                    {:else if installedVersionOf(detailEntry)}
                                        <span class="plugin-installed-hint">已安装</span>
                                    {:else}
                                        <button class="market-install" type="button" onclick={() => { if (detailEntry) beginInstall(detailEntry) }}>安装</button>
                                    {/if}
                                </div>
                                <div class="plugin-detail-links">
                                    {#if detailEntry.homepage}
                                        <a href={detailEntry.homepage} target="_blank" rel="noreferrer">主页</a>
                                    {/if}
                                    {#if detailEntry.repository}
                                        <a href={detailEntry.repository} target="_blank" rel="noreferrer">源码仓库</a>
                                    {/if}
                                </div>
                            </div>
                        {:else}
                        {#each pagedMarket as entry (entry.id)}
                            <div class="plugin-card" role="button" tabindex="0" onclick={() => { detailEntry = entry }} onkeydown={(event) => { if (event.key === 'Enter' || event.key === ' ') { detailEntry = entry } }}>
                                <div class="plugin-card-head">
                                    <strong>{entry.name}</strong>
                                    <span class="plugin-version">v{entry.version}</span>
                                    <span class="plugin-kind">{kindLabel(entry.kind)}</span>
                                    {#if entry.audience === 'developer'}
                                        <span class="plugin-kind plugin-kind-developer">{t('market.developerBadge')}</span>
                                    {/if}
                                    {#if entry.downloads}
                                        <span class="plugin-downloads">↓ {formatDownloads(entry.downloads)}</span>
                                    {/if}
                                </div>
                                <div class="plugin-card-desc">{entry.description}</div>
                                {#if dependencyStatusLabel(entry)}
                                    <div class="plugin-dep-warning">⚠ {dependencyStatusLabel(entry)}</div>
                                {/if}
                                <div class="plugin-card-actions">
                                    {#if hasUpdate(entry)}
                                        <span class="plugin-update-hint">{t('market.installedAt', { v: installedVersionOf(entry) ?? '' })}</span>
                                        <button class="market-install" type="button" onclick={(event) => { event.stopPropagation(); beginInstall(entry) }}>{t('market.update')}</button>
                                    {:else if installedVersionOf(entry)}
                                        <span class="plugin-installed-hint">{t('market.installed')}</span>
                                    {:else}
                                        <button class="market-install" type="button" onclick={(event) => { event.stopPropagation(); beginInstall(entry) }}>{t('market.install')}</button>
                                    {/if}
                                </div>
                            </div>
                        {/each}
                        {/if}
                    </section>
                {:else if section === 'about'}
                    <section aria-label="关于">
                        <div class="about-row"><span>issh 版本</span><strong>{productVersion || '未知'}</strong></div>
                        <div class="about-row"><span>构建版本</span><strong>{appVersion || '未知'}</strong></div>
                        <div class="about-row"><span>Tauri 版本</span><strong>{tauriVersion || '未知'}</strong></div>
                        <div class="about-row"><span>WebView2 版本</span><strong>{webviewVersion || '未知'}</strong></div>
                        <div class="about-row"><span>Runtime 版本</span><strong>{runtimeVersion || '未连接'}</strong></div>

                        <div class="settings-field">
                            <div class="settings-field-title">检查更新（GitHub）</div>
                            <div class="about-update-form">
                                <div class="settings-hint">当前分支：<strong>{buildBranch || '未知'}</strong></div>
                                <button
                                    type="button"
                                    disabled={updateChecking}
                                    onclick={() => void runUpdateCheck()}
                                >{updateChecking ? '检查中…' : '检查更新'}</button>
                            </div>
                            {#if updateError}
                                <div class="settings-hint update-error" role="alert">检查失败：{updateError}</div>
                            {:else if updateResult}
                                {#if updateResult.hasUpdate}
                                    <div class="settings-hint update-available">
                                        发现新版本 <strong>v{updateResult.latestVersion}</strong>（当前 {updateResult.currentVersion}，适配 {updateResult.architecture}）
                                        {#if updateResult.releaseUrl}<a href={updateResult.releaseUrl} target="_blank" rel="noreferrer">下载安装包</a>{/if}
                                    </div>
                                {:else}
                                    <div class="settings-hint">已是最新版本（当前 {updateResult.currentVersion}，最新 {updateResult.latestVersion || '未知'}）</div>
                                {/if}
                            {/if}
                        </div>
                    </section>
                {:else if section === 'plugin-tab' && pluginTabSection && tabs.some((tab) => (tab.key ?? tab.id) === pluginTabSection)}
                    <section aria-label={tabs.find((tab) => (tab.key ?? tab.id) === pluginTabSection)?.title ?? '插件设置'}>
                        {#if pluginTabError}
                            <div class="settings-error" role="alert">{pluginTabError}</div>
                        {/if}
                        <div class="plugin-settings-host" bind:this={pluginTabContainer}></div>
                    </section>
                {/if}
            </div>
        </div>

        {#if installTarget}
            <div class="modal-backdrop" role="presentation" onclick={() => { if (!installBusy) installTarget = null }} onkeydown={(event) => { if (event.key === 'Escape' && !installBusy) installTarget = null }}>
                <div class="install-dialog" role="dialog" aria-label="安装确认" tabindex="-1" onclick={(event) => { event.stopPropagation() }} onkeydown={(event) => { event.stopPropagation() }}>
                    <h2>安装 {installTarget.name} v{installTarget.version}</h2>
                    <p class="install-desc">{installTarget.description}</p>
                    <div class="install-permissions">
                        <div class="install-permissions-title">该插件声明以下权限：</div>
                        {#if installTarget.permissions.length === 0}
                            <div class="install-permission">无特殊权限</div>
                        {:else}
                            {#each installTarget.permissions as permission (permission)}
                                <div class="install-permission">{permission}</div>
                            {/each}
                        {/if}
                    </div>
                    {#if installError}
                        <div class="settings-error" role="alert">{installError}</div>
                    {/if}
                    <div class="install-actions">
                        <button type="button" disabled={installBusy} onclick={() => { installTarget = null }}>取消</button>
                        <button class="market-install" type="button" disabled={installBusy} onclick={() => void confirmInstall()}>{installBusy ? '安装中…' : '确认安装'}</button>
                    </div>
                </div>
            </div>
        {/if}
    </div>
</div>
