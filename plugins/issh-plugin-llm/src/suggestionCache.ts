// 移植自 issh 分支 suggestionCache.service.ts（去 Angular 依赖，纯 LRU + TTL）
interface CacheEntry<T> {
    value: T
    expiresAt: number
}

/** 补全结果 LRU 缓存：maxSize=100，ttl=5min */
export class SuggestionCache<T> {
    private store = new Map<string, CacheEntry<T>>()
    private maxSize = 100
    private ttlMs = 5 * 60 * 1000

    get (key: string): T | null {
        const entry = this.store.get(key)
        if (!entry) {
            return null
        }
        if (Date.now() > entry.expiresAt) {
            this.store.delete(key)
            return null
        }
        // 命中后移到末尾（最近使用）
        this.store.delete(key)
        this.store.set(key, entry)
        return entry.value
    }

    set (key: string, value: T): void {
        if (!this.store.has(key) && this.store.size >= this.maxSize) {
            const firstKey = this.store.keys().next().value
            if (firstKey) {
                this.store.delete(firstKey)
            }
        }
        this.store.set(key, { value, expiresAt: Date.now() + this.ttlMs })
    }

    makeKey (parts: Record<string, string | null | undefined>): string {
        return Object.keys(parts)
            .sort()
            .map((name) => {
                const value = parts[name]
                let encoded: string
                if (value === undefined) {
                    encoded = '<undefined>'
                } else if (value === null) {
                    encoded = '<null>'
                } else if (value === '') {
                    encoded = '<empty>'
                } else {
                    encoded = JSON.stringify(value)
                }
                return `${name}=${encoded}`
            })
            .join('\u0000')
    }
}
