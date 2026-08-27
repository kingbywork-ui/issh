export interface SerialPortInfoLike {
    usbVendorId?: number
    usbProductId?: number
}

export interface SerialOptions {
    baudRate: number
    dataBits?: 7 | 8
    stopBits?: 1 | 2
    parity?: 'none' | 'even' | 'odd'
    bufferSize?: number
    flowControl?: 'none' | 'hardware'
}

export const BAUD_RATES = [9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600]

export function serialSupported (): boolean {
    return typeof navigator !== 'undefined' && 'serial' in navigator
}

export async function requestSerialPort (): Promise<SerialPort> {
    if (!serialSupported()) throw new Error('当前浏览器不支持 Web Serial API')
    return await navigator.serial.requestPort({})
}

export async function openSerialPort (port: SerialPort, options: SerialOptions): Promise<SerialPortWriter> {
    await port.open({ baudRate: options.baudRate, dataBits: options.dataBits ?? 8, stopBits: options.stopBits ?? 1, parity: options.parity ?? 'none', bufferSize: options.bufferSize ?? 4096, flowControl: options.flowControl ?? 'none' })
    const writer = port.writable?.getWriter()
    if (!writer) throw new Error('串口不可写')
    return {
        async write (data: Uint8Array): Promise<void> {
            await writer.write(data)
        },
        release (): void {
            try { writer.releaseLock() } catch {}
        },
    }
}

export interface SerialPortWriter {
    write (data: Uint8Array): Promise<void>
    release (): void
}

export function startReading (port: SerialPort, onData: (text: string) => void, onError: (error: unknown) => void): () => void {
    let stopped = false
    const decoder = new TextDecoderStream()
    const readableClosed = port.readable?.pipeTo(decoder.writable)
    void (async () => {
        const reader = decoder.readable.getReader()
        try {
            while (!stopped) {
                const { value, done } = await reader.read()
                if (done || value === undefined) break
                onData(value)
            }
        } catch (cause) {
            if (!stopped) onError(cause)
        } finally {
            try { reader.releaseLock() } catch {}
        }
    })()
    return () => {
        stopped = true
        void readableClosed?.catch(() => {})
    }
}

export async function closeSerialPort (port: SerialPort): Promise<void> {
    try { await port.forget() } catch {}
    try { await port.close() } catch {}
}
