<script lang="ts">
    import type { SshHostGroup, SshHostProfile } from './runtime'

    let { profile, groups, onconnect, oncancel }: { profile: SshHostProfile, groups: SshHostGroup[], onconnect: (profile: SshHostProfile) => void, oncancel: () => void } = $props()
    let draft = $state({ ...profile, tags: [...profile.tags], privateKeys: [...profile.privateKeys] })
    let tags = $state(draft.tags.join(', '))
    const isNew = $derived(!profile.id)

    function save (): void {
        onconnect({ ...draft, id: draft.id || `profile-${Date.now().toString(36)}`, name: draft.name.trim(), host: draft.host.trim(), user: draft.user.trim(), port: Number(draft.port) || 22, group: draft.group || '', tags: tags.split(',').map((tag) => tag.trim()).filter(Boolean) })
    }
</script>

<div class="modal-backdrop" role="presentation" onclick={oncancel}>
    <form class="editor-panel editor-panel-wide" role="dialog" aria-modal="true" onclick={(event) => event.stopPropagation()} onsubmit={(event) => { event.preventDefault(); save() }}>
        <div class="editor-header"><h2>{isNew ? '新建 SSH 主机' : '编辑 SSH 主机'}</h2><button type="button" class="icon-button" aria-label="关闭" onclick={oncancel}>×</button></div>
        <div class="editor-tabs"><span class="active">常规</span><span>高级连接</span><span>安全与算法</span></div>
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
        <label class="check-line"><input type="checkbox" bind:checked={draft.favorite} /> 收藏并优先显示</label>
        <div class="editor-actions"><button type="button" class="secondary" onclick={oncancel}>取消</button><button type="submit" disabled={!draft.name.trim() || !draft.host.trim() || !draft.user.trim()}>保存</button></div>
    </form>
</div>
