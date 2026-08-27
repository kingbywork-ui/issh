<script lang="ts">
    import { onMount } from 'svelte'
    import serialCss from './serial.css?inline'
    import { BAUD_RATES, closeSerialPort, openSerialPort, requestSerialPort, serialSupported, startReading, type SerialPortWriter } from './serialApi'

    let supported = $state(false)
    let connected = $state(false)
    let busy = $state(false)
    let error = $state('')
    let output = $state('')
    let input = $state('')
    let baudRate = $state(115200)
    let port: SerialPort | null = null
    let writer: SerialPortWriter | null = null
    let stopReading: (() => void) | null = null
    let outputEl: HTMLDivElement | null = $state(null)

    onMount(() => {
        if (!document.getElementById('issh-plugin-serial-style')) {
            const style = document.createElement('style')
            style.id = 'issh-plugin-serial-style'
            style.textContent = serialCss
            document.head.appendChild(style)
        }
        supported = serialSupported()
    })

    async function connect (): Promise<void> {
        busy = true
        error = ''
        try {
            port = await requestSerialPort()
            writer = await openSerialPort(port, { baudRate })
            stopReading = startReading(port, (text) => {
                output += text
                requestAnimationFrame(() => {
                    if (outputEl) outputEl.scrollTop = outputEl.scrollHeight
                })
            }, (cause) => {
                error = cause instanceof Error ? cause.message : String(cause)
                void disconnect()
            })
            connected = true
        } catch (cause) {
            error = cause instanceof Error ? cause.message : String(cause)
        } finally {
            busy = false
        }
    }

    async function disconnect (): Promise<void> {
        busy = true
        try {
            stopReading?.()
            stopReading = null
            writer?.release()
            writer = null
            if (port) await closeSerialPort(port)
            port = null
            connected = false
        } finally {
            busy = false
        }
    }

    async function send (): Promise<void> {
        if (!writer || !input) return
        busy = true
        try {
            await writer.write(new TextEncoder().encode(input + '\r\n'))
            input = ''
        } catch (cause) {
            error = cause instanceof Error ? cause.message : String(cause)
        } finally {
            busy = false
        }
    }

    function clearOutput (): void {
        output = ''
    }
</script>

<div class="serial-panel">
    {#if !supported}
        <div class="serial-unsupported">当前 WebView 不支持 Web Serial API（需要 Chromium 89+ 且 https/localhost 环境）</div>
    {:else}
        <div class="serial-toolbar">
            {#if !connected}
                <select bind:value={baudRate} aria-label="波特率">
                    {#each BAUD_RATES as rate (rate)}
                        <option value={rate}>{rate}</option>
                    {/each}
                </select>
                <button class="serial-btn primary" type="button" disabled={busy} onclick={() => void connect()}>连接串口</button>
            {:else}
                <span class="serial-status">已连接 @ {baudRate}</span>
                <button class="serial-btn" type="button" disabled={busy} onclick={() => void disconnect()}>断开</button>
            {/if}
            <button class="serial-btn" type="button" onclick={clearOutput}>清屏</button>
        </div>
        {#if error}
            <div class="serial-error" role="alert">{error}</div>
        {/if}
        <div class="serial-output" bind:this={outputEl}>{output}</div>
        <div class="serial-input">
            <input
                type="text"
                bind:value={input}
                placeholder={connected ? '输入并发送（Enter）' : '先连接串口'}
                disabled={!connected}
                onkeydown={(event) => { if (event.key === 'Enter') void send() }}
            />
            <button class="serial-btn primary" type="button" disabled={!connected || busy || !input} onclick={() => void send()}>发送</button>
        </div>
    {/if}
</div>
