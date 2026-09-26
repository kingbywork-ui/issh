export type SplitLayoutNode =
    | { type: 'pane', id: string }
    | { type: 'split', orientation: 'vertical' | 'horizontal', ratios: number[], children: SplitLayoutNode[] }

export function layoutLeaves (node: SplitLayoutNode | null): string[] {
    if (!node) return []
    return node.type === 'pane' ? [node.id] : node.children.flatMap(layoutLeaves)
}

export function insertSplitPane (node: SplitLayoutNode | null, sourceId: string, newId: string, orientation: 'vertical' | 'horizontal'): SplitLayoutNode {
    const branch: SplitLayoutNode = {
        type: 'split', orientation, ratios: [0.5, 0.5],
        children: [{ type: 'pane', id: sourceId }, { type: 'pane', id: newId }],
    }
    if (!node) return branch
    if (node.type === 'pane') return node.id === sourceId ? branch : node
    return {
        ...node,
        children: node.children.map((child) => layoutLeaves(child).includes(sourceId)
            ? insertSplitPane(child, sourceId, newId, orientation)
            : child),
    }
}

export function removeSplitPane (node: SplitLayoutNode | null, id: string): SplitLayoutNode | null {
    if (!node || node.type === 'pane') return node?.id === id ? null : node
    const entries = node.children.map((child, index) => ({ child: removeSplitPane(child, id), ratio: node.ratios[index] ?? 1 }))
        .filter((entry): entry is { child: SplitLayoutNode, ratio: number } => entry.child !== null)
    if (!entries.length) return null
    if (entries.length === 1) return entries[0].child
    const total = entries.reduce((sum, entry) => sum + entry.ratio, 0) || 1
    return { ...node, children: entries.map((entry) => entry.child), ratios: entries.map((entry) => entry.ratio / total) }
}
