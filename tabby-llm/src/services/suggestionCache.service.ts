interface CacheEntry<T> {
    value: T
    expiresAt: number
}

/** @hidden */
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
        // Move to end (most recently used) by re-inserting
        this.store.delete(key)
        this.store.set(key, entry)
        return entry.value
    }

    set (key: string, value: T): void {
        if (this.store.size >= this.maxSize) {
            const firstKey = this.store.keys().next().value
            if (firstKey) {
                this.store.delete(firstKey)
            }
        }
        this.store.set(key, {
            value,
            expiresAt: Date.now() + this.ttlMs,
        })
    }

    makeKey (...parts: (string | null | undefined)[]): string {
        return parts.filter(Boolean).join('|')
    }
}
