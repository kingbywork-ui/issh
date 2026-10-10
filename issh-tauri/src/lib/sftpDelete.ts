import type { SftpEntry, SftpListResult } from './runtime'

type DeleteOperations = {
    list: (path: string, offset: number) => Promise<SftpListResult>
    removeFile: (path: string) => Promise<unknown>
    removeDir: (path: string) => Promise<unknown>
}

/** Delete directory contents before removing the directory itself. */
export async function removeSftpTree (root: SftpEntry, operations: DeleteOperations): Promise<void> {
    const pending: Array<{ entry: SftpEntry, childrenRemoved: boolean }> = [{ entry: root, childrenRemoved: false }]
    while (pending.length > 0) {
        const current = pending.pop()!
        const entry = current.entry
        if (!entry.isDir || entry.isSymlink) {
            await operations.removeFile(entry.path)
            continue
        }
        if (current.childrenRemoved) {
            await operations.removeDir(entry.path)
            continue
        }

        // Read every page before deleting children so offset pagination stays stable.
        const children: SftpEntry[] = []
        let offset = 0
        for (;;) {
            const page = await operations.list(entry.path, offset)
            for (const child of page.entries) {
                const path = `${entry.path.replace(/\/+$/, '')}/${child.name}`
                if (!child.name || child.name === '.' || child.name === '..' || child.name.includes('/') || child.path !== path) {
                    throw new Error(`目录返回无效条目：${entry.path}`)
                }
                children.push(child)
            }
            if (!page.hasMore) break
            if (page.entries.length === 0) throw new Error(`目录分页无进展：${entry.path}`)
            offset += page.entries.length
        }

        pending.push({ entry, childrenRemoved: true })
        for (let index = children.length - 1; index >= 0; index--) {
            pending.push({ entry: children[index], childrenRemoved: false })
        }
    }
}
