export interface HostKeyRequest {
    id: number
    host: string
    port: number
    fingerprint: string
}

interface Dependencies {
    storage: Pick<Storage, 'getItem' | 'setItem'>
    confirm: (message: string, title: string, signal: AbortSignal) => Promise<boolean>
    respond: (id: number, accepted: boolean) => Promise<void>
    reveal: (id: number) => Promise<void>
    onError: (cause: unknown) => void
}

// Keep the existing desktop trust records as the single source of truth,
// including deletions made from Settings. Serialize prompts so simultaneous
// requests for one host reuse the decision that was just saved.
export function createHostKeyConfirmationHandler (dependencies: Dependencies) {
    const pending = new Map<number, AbortController>()
    const settled = new Set<number>()
    let queue = Promise.resolve()
    let disposed = false

    function remember (id: number): void {
        settled.add(id)
        if (settled.size > 512) settled.delete(settled.values().next().value!)
    }

    function handle (request: HostKeyRequest): void {
        if (disposed || pending.has(request.id) || settled.has(request.id)) return
        const controller = new AbortController()
        pending.set(request.id, controller)
        const process = async (): Promise<void> => {
            if (controller.signal.aborted) return
            try {
                const key = `issh.trustedHostKey.${request.host}:${request.port}`
                const trusted = dependencies.storage.getItem(key)
                let accepted = trusted === request.fingerprint
                const alreadyTrusted = accepted
                if (!accepted) {
                    await dependencies.reveal(request.id)
                    if (controller.signal.aborted) return
                    const message = [
                        `MCP 请求连接 ${request.host}:${request.port}。`,
                        trusted ? `原指纹：${trusted}` : '此主机尚未保存信任记录。',
                        `当前指纹：${request.fingerprint}`,
                        trusted ? '主机密钥已变化。确认信任并保存新指纹后继续连接？' : '确认信任并保存此指纹后继续连接？',
                    ].join('\n\n')
                    accepted = await dependencies.confirm(message, trusted ? 'SSH 主机密钥已变化' : '确认 SSH 主机密钥', controller.signal)
                }
                if (controller.signal.aborted) return
                await dependencies.respond(request.id, accepted)
                // A late response rejected by Rust must never create trust.
                if (accepted && !alreadyTrusted && dependencies.storage.getItem(key) === trusted) {
                    dependencies.storage.setItem(key, request.fingerprint)
                }
            } catch (cause) {
                if (!controller.signal.aborted) {
                    await dependencies.respond(request.id, false).catch(() => {})
                    dependencies.onError(cause)
                }
            } finally {
                pending.delete(request.id)
                remember(request.id)
            }
        }
        const key = `issh.trustedHostKey.${request.host}:${request.port}`
        // An unrelated first-use prompt must not stall already trusted hosts.
        try {
            if (dependencies.storage.getItem(key) === request.fingerprint) {
                void process()
                return
            }
        } catch {}
        queue = queue.then(process)
    }

    function cancel (id: number): void {
        pending.get(id)?.abort()
        pending.delete(id)
        remember(id)
    }

    function dispose (): void {
        disposed = true
        for (const controller of pending.values()) controller.abort()
        pending.clear()
    }

    return { handle, cancel, dispose }
}
