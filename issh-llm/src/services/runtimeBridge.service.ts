import { Injectable } from '@angular/core'

interface RuntimeResponse<T> {
    result?: T
    error?: {
        code: number
        message: string
    }
}

/** @hidden */
@Injectable({ providedIn: 'root' })
export class RuntimeBridgeService {
    private nextRequestId = 1

    private getIpcRenderer (): any {
        try {
            const runtimeRequire = eval('require') // eslint-disable-line no-eval
            return runtimeRequire('electron').ipcRenderer
        } catch {
            return null
        }
    }

    async call<T> (method: string, params?: Record<string, unknown>): Promise<T> {
        const ipcRenderer = this.getIpcRenderer()
        if (!ipcRenderer) {
            throw new Error(`Runtime ${method} failed: Electron IPC is not available`)
        }
        const response = await ipcRenderer.invoke('runtime:request', {
            jsonrpc: '2.0',
            id: this.nextRequestId++,
            method,
            params,
        }) as RuntimeResponse<T>
        if (response.error) {
            throw new Error(`Runtime ${method} failed (${response.error.code}): ${response.error.message}`)
        }
        return response.result as T
    }
}
