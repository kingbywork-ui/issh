<script lang="ts">
    import type { SshHostGroup, SshHostProfile } from './runtime'

    let { profile, groups, onconnect, oncancel }: { profile: SshHostProfile, groups: SshHostGroup[], onconnect: (profile: SshHostProfile) => void, oncancel: () => void } = $props()
    // svelte-ignore state_referenced_locally
    let draft = $state({ ...profile, tags: [...profile.tags], privateKeys: [...profile.privateKeys], forwardedPorts: [...(profile.forwardedPorts ?? [])], loginScript: profile.loginScript ?? '', jumpHost: profile.jumpHost ?? '', proxyCommand: profile.proxyCommand ?? '', socksProxyHost: profile.socksProxyHost ?? '', httpProxyHost: profile.httpProxyHost ?? '' })
    let tags = $state(draft.tags.join(', '))
    let forwardedPortsText = $state(JSON.stringify(draft.forwardedPorts, null, 2))
    let forwardingError = $state('')
    let activeTab = $state<'general' | 'advanced' | 'security'>('general')
    const isNew = $derived(!profile.id)

    function save (): void {
        let forwardedPorts = draft.forwardedPorts
        try {
            const parsed = JSON.parse(forwardedPortsText)
            if (!Array.isArray(parsed)) throw new Error('必须是数组')
            if (parsed.some((entry) => !entry || !['Local', 'Remote', 'Dynamic'].includes(entry.type) || typeof entry.host !== 'string' || !Number.isInteger(entry.port) || entry.port < 1 || entry.port > 65535 || (entry.type !== 'Dynamic' && (typeof entry.targetAddress !== 'string' || !Number.isInteger(entry.targetPort) || entry.targetPort < 1 || entry.targetPort > 65535)))) throw new Error('类型或端口范围无效')
            forwardedPorts = parsed
            forwardingError = ''
        } catch (cause) {
            forwardingError = cause instanceof Error ? `端口转发配置无效：${cause.message}` : '端口转发配置无效'
            return
        }
        onconnect({ ...draft, id: draft.id || `profile-${Date.now().toString(36)}`, name: draft.name.trim(), host: draft.host.trim(), user: draft.user.trim(), port: Number(draft.port) || 22, group: draft.group || '', tags: tags.split(',').map((tag) => tag.trim()).filter(Boolean), loginScript: draft.loginScript.trim() || null, jumpHost: draft.jumpHost.trim() || null, proxyCommand: draft.proxyCommand.trim() || null, socksProxyHost: draft.socksProxyHost.trim() || null, httpProxyHost: draft.httpProxyHost.trim() || null, socksProxyPort: Number(draft.socksProxyPort) || null, httpProxyPort: Number(draft.httpProxyPort) || null, forwardedPorts })
    }
</script>

<div class="modal-backdrop" role="presentation" onclick={(event) => { if (event.target === event.currentTarget) oncancel() }}>
    <div class="editor-panel editor-panel-wide" role="dialog" aria-modal="true" tabindex="-1">
        <form onsubmit={(event) => { event.preventDefault(); save() }}>
            <div class="editor-header"><h2>{isNew ? '新建 SSH 主机' : '编辑 SSH 主机'}</h2><button type="button" class="icon-button" aria-label="关闭" onclick={oncancel}>×</button></div>
            <div class="editor-tabs" role="tablist" aria-label="SSH 主机设置">
                <button type="button" class:active={activeTab === 'general'} role="tab" aria-selected={activeTab === 'general'} onclick={() => { activeTab = 'general' }}>常规</button>
                <button type="button" class:active={activeTab === 'advanced'} role="tab" aria-selected={activeTab === 'advanced'} onclick={() => { activeTab = 'advanced' }}>高级连接</button>
                <button type="button" class:active={activeTab === 'security'} role="tab" aria-selected={activeTab === 'security'} onclick={() => { activeTab = 'security' }}>安全与算法</button>
            </div>
            {#if activeTab === 'general'}
                <div class="editor-grid">
                    <label>名称<input bind:value={draft.name} required maxlength="160" /></label>
                    <label>分组<select bind:value={draft.group}><option value="">未分组</option>{#each groups as group}<option value={group.id}>{group.name}</option>{/each}</select></label>
                    <label>主机<input bind:value={draft.host} required placeholder="192.168.1.10" /></label>
                    <label>端口<input type="number" bind:value={draft.port} min="1" max="65535" required /></label>
                    <label>用户名<input bind:value={draft.user} required /></label>
                    <label>认证方式<select bind:value={draft.auth}><option value="">自动</option><option value="password">密码</option><option value="publicKey">私钥</option><option value="agent">Agent</option><option value="keyboardInteractive">交互式</option></select></label>
                    <label>私钥路径<input bind:value={draft.privateKeys[0]} placeholder="C:\\Users\\me\\.ssh\\id_ed25519" /></label>
                    <label>环境<input bind:value={draft.environment} placeholder="prod / test / dev" /></label>
                </div>
                <label>标签<input bind:value={tags} placeholder="使用逗号分隔" /></label>
                <label>备注<textarea bind:value={draft.remark} rows="3"></textarea></label>
                <label>登录脚本（连接后自动执行，供补全参考；多行或 && 分隔）<textarea bind:value={draft.loginScript} rows="2" placeholder="cd /var/www && docker compose ps"></textarea></label>
                <label class="check-line"><input type="checkbox" bind:checked={draft.favorite} /> 收藏并优先显示</label>
            {:else if activeTab === 'advanced'}
                <fieldset class="editor-fieldset">
                    <legend>高级连接</legend>
                    <div class="editor-grid">
                        <label>跳板机配置 ID<input bind:value={draft.jumpHost} placeholder="jump-profile-id" /></label>
                        <label>ProxyCommand<input bind:value={draft.proxyCommand} placeholder="ssh -W %h:%p jump" /></label>
                        <label>SOCKS 代理主机<input bind:value={draft.socksProxyHost} /></label>
                        <label>SOCKS 代理端口<input type="number" bind:value={draft.socksProxyPort} min="1" max="65535" /></label>
                        <label>HTTP 代理主机<input bind:value={draft.httpProxyHost} /></label>
                        <label>HTTP 代理端口<input type="number" bind:value={draft.httpProxyPort} min="1" max="65535" /></label>
                    </div>
                    <label class="check-line"><input type="checkbox" bind:checked={draft.x11} /> X11 转发</label>
                    <label class="check-line"><input type="checkbox" bind:checked={draft.agentForward} /> SSH Agent 转发</label>
                    <label>端口转发（JSON）<textarea bind:value={forwardedPortsText} rows="6" placeholder="Local forwarding entries as JSON"></textarea></label>
                    {#if forwardingError}<p class="form-error">{forwardingError}</p>{/if}
                </fieldset>
            {:else}
                <fieldset class="editor-fieldset">
                    <legend>安全与算法</legend>
                    <p class="settings-hint">当前由 SSH Runtime 使用经过验证的默认安全算法，主机配置暂不支持覆盖算法列表。</p>
                    <div class="algorithm-list" aria-label="当前安全算法">
                        <div><strong>主机密钥</strong><span>Runtime 默认协商</span></div>
                        <div><strong>密钥交换</strong><span>Runtime 默认协商</span></div>
                        <div><strong>加密与 MAC</strong><span>Runtime 默认协商</span></div>
                    </div>
                </fieldset>
            {/if}
            <div class="editor-actions"><button type="button" class="secondary" onclick={oncancel}>取消</button><button type="submit" disabled={!draft.name.trim() || !draft.host.trim() || !draft.user.trim()}>保存</button></div>
        </form>
    </div>
</div>
