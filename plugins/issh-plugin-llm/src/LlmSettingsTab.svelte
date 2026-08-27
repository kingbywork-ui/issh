<script lang="ts">
    import { onMount } from 'svelte'
    import llmCss from './llm.css?inline'
    import { loadConfig, saveConfig, type LlmConfig } from './llmApi'

    let config = $state<LlmConfig>(loadConfig())
    let saved = $state(false)

    onMount(() => {
        if (!document.getElementById('issh-plugin-llm-style')) {
            const style = document.createElement('style')
            style.id = 'issh-plugin-llm-style'
            style.textContent = llmCss
            document.head.appendChild(style)
        }
    })

    function persist (): void {
        saveConfig(config)
        saved = true
        setTimeout(() => { saved = false }, 1500)
    }
</script>

<div class="llm-settings">
    <div class="llm-section">
        <div class="settings-field-title">LLM API</div>
        <label class="settings-field">
            <span>Base URL</span>
            <input type="text" bind:value={config.baseUrl} onchange={persist} placeholder="https://api.openai.com/v1" />
        </label>
        <label class="settings-field">
            <span>API Key</span>
            <input type="password" bind:value={config.apiKey} onchange={persist} placeholder="sk-…" autocomplete="off" />
        </label>
        <label class="settings-field">
            <span>模型</span>
            <input type="text" bind:value={config.model} onchange={persist} placeholder="gpt-4o-mini" />
        </label>
    </div>

    <div class="llm-section">
        <div class="settings-field-title">补全行为</div>
        <label class="settings-field">
            <span>防抖延迟（ms）</span>
            <input type="number" min="200" max="3000" step="100" bind:value={config.debounceMs} onchange={persist} />
        </label>
        <label class="settings-field">
            <span>请求超时（ms）</span>
            <input type="number" min="1000" max="10000" step="500" bind:value={config.timeoutMs} onchange={persist} />
        </label>
        <label class="settings-field">
            <span>上下文行数</span>
            <input type="number" min="0" max="50" step="5" bind:value={config.maxContextLines} onchange={persist} />
        </label>
        <label class="settings-field settings-check">
            <input type="checkbox" bind:checked={config.sendContext} onchange={persist} />
            <span>发送终端上下文（脱敏后）</span>
        </label>
    </div>

    {#if saved}
        <div class="llm-saved">已保存</div>
    {/if}
</div>
