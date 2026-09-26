// P0：极简 toast 通知。模块级 $state，任意组件 pushToast 触发，ToastHost 单点渲染。
export type ToastKind = 'ok' | 'error' | 'info'

export interface ToastItem {
    id: number
    kind: ToastKind
    message: string
}

let nextId = 1
export const toasts = $state<ToastItem[]>([])

export function pushToast (kind: ToastKind, message: string, ttlMs = 5000): void {
    const item = { id: nextId++, kind, message }
    toasts.push(item)
    if (ttlMs > 0) setTimeout(() => dismissToast(item.id), ttlMs)
}

export function dismissToast (id: number): void {
    const index = toasts.findIndex((item) => item.id === id)
    if (index >= 0) toasts.splice(index, 1)
}
