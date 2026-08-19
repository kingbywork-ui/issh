import { Injectable } from '@angular/core'
import { ipcRenderer } from 'electron'

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

    async call<T> (method: string, params?: Record<string, unknown>): Promise<T> {
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
