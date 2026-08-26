<script lang="ts">
    import type { SshHostGroup } from './runtime'

    let { group, groups, onsave, oncancel }: { group: SshHostGroup, groups: SshHostGroup[], onsave: (group: SshHostGroup) => void, oncancel: () => void } = $props()
    let name = $state(group.name)
    let parentGroupId = $state(group.parentGroupId ?? '')
    const candidates = $derived(groups.filter((item) => item.id !== group.id))
</script>

<div class="modal-backdrop" role="presentation" onclick={oncancel}>
    <form class="editor-panel" role="dialog" aria-modal="true" onclick={(event) => event.stopPropagation()} onsubmit={(event) => { event.preventDefault(); onsave({ ...group, name: name.trim(), parentGroupId: parentGroupId || null }) }}>
        <div class="editor-header"><h2>{group.id ? '编辑分组' : '新建分组'}</h2><button type="button" class="icon-button" aria-label="关闭" onclick={oncancel}>×</button></div>
        <label>分组名称<input bind:value={name} autofocus required maxlength="120" /></label>
        <label>父分组<select bind:value={parentGroupId}><option value="">未分组</option>{#each candidates as candidate}<option value={candidate.id}>{candidate.name}</option>{/each}</select></label>
        <div class="editor-actions"><button type="button" class="secondary" onclick={oncancel}>取消</button><button type="submit" disabled={!name.trim()}>保存</button></div>
    </form>
</div>
