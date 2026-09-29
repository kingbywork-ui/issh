import type { SshHostGroup } from './runtime'

export interface GroupOption {
    id: string
    label: string
}

export function groupOptions (groups: readonly SshHostGroup[]): GroupOption[] {
    const byId = new Map(groups.map((group) => [group.id, group]))
    const children = new Map<string, SshHostGroup[]>()
    const roots: SshHostGroup[] = []
    for (const group of groups) {
        const parentId = group.parentGroupId
        if (!parentId || parentId === group.id || !byId.has(parentId)) {
            roots.push(group)
        } else {
            const siblings = children.get(parentId) ?? []
            siblings.push(group)
            children.set(parentId, siblings)
        }
    }

    const result: GroupOption[] = []
    const visited = new Set<string>()
    function visit (group: SshHostGroup, path: string[]): void {
        if (visited.has(group.id)) return
        visited.add(group.id)
        const nextPath = [...path, group.name]
        result.push({ id: group.id, label: nextPath.join(' › ') })
        for (const child of children.get(group.id) ?? []) visit(child, nextPath)
    }
    for (const root of roots) visit(root, [])
    for (const group of groups) visit(group, [])
    return result
}
