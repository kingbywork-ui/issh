import { readonly, writable } from 'svelte/store'

export interface DialogRequest {
    id: number
    kind: 'alert' | 'confirm' | 'prompt'
    title: string
    message: string
    defaultValue: string
}

type DialogValue = boolean | string | null
const current = writable<DialogRequest | null>(null)
export const currentDialog = readonly(current)
const queue: Array<{ request: DialogRequest; resolve: (value: DialogValue) => void; cleanup?: () => void }> = []
let nextId = 1

function enqueue (kind: DialogRequest['kind'], title: string, message: string, defaultValue = '', signal?: AbortSignal): Promise<DialogValue> {
    return new Promise((resolve) => {
        if (signal?.aborted) { resolve(kind === 'confirm' ? false : null); return }
        const request = { id: nextId++, kind, title, message, defaultValue }
        const entry: (typeof queue)[number] = { request, resolve }
        if (signal) {
            const abort = (): void => {
                const index = queue.indexOf(entry)
                if (index < 0) return
                queue.splice(index, 1)
                entry.cleanup?.()
                resolve(kind === 'confirm' ? false : null)
                if (index === 0) current.set(queue[0]?.request ?? null)
            }
            signal.addEventListener('abort', abort, { once: true })
            entry.cleanup = () => signal.removeEventListener('abort', abort)
        }
        queue.push(entry)
        if (queue.length === 1) current.set(request)
    })
}

export function resolveDialog (id: number, value: DialogValue): void {
    const pending = queue[0]
    if (!pending || pending.request.id !== id) return
    queue.shift()
    pending.cleanup?.()
    pending.resolve(value)
    current.set(queue[0]?.request ?? null)
}

export function dismissDialogs (): void {
    const pending = queue.splice(0)
    current.set(null)
    for (const entry of pending) {
        entry.cleanup?.()
        entry.resolve(entry.request.kind === 'confirm' ? false : null)
    }
}

export async function showAlert (message: string, title = '提示'): Promise<void> {
    await enqueue('alert', title, message)
}

export async function askConfirm (message: string, title = '确认操作', signal?: AbortSignal): Promise<boolean> {
    return await enqueue('confirm', title, message, '', signal) === true
}

export async function askPrompt (message: string, defaultValue = '', title = '输入'): Promise<string | null> {
    const value = await enqueue('prompt', title, message, defaultValue)
    return typeof value === 'string' ? value : null
}
