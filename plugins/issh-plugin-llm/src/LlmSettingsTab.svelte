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
        <label class="settings-field">
            <span>补全专用模型（留空用主模型）</span>
            <input type="text" bind:value={config.autocompleteModel} onchange={persist} placeholder="与主模型一致" />
        </label>
        <label class="settings-field settings-check">
            <input type="checkbox" bind:checked={config.autocompleteDisableThinking} onchange={persist} />
            <span>补全请求关闭推理思考（deepseek-r1 等）</span>
        </label>
    </div>

    <div class="llm-section">
        <div class="settings-field-title">补全行为</div>
        <label class="settings-field settings-check">
            <input type="checkbox" bind:checked={config.aiAutocompleteEnabled} onchange={persist} />
            <span>AI 命令补全</span>
        </label>
        <label class="settings-field settings-check">
            <input type="checkbox" bind:checked={config.predictionEnabled} onchange={persist} />
            <span>下一条命令预测预取</span>
        </label>
        <label class="settings-field settings-check">
            <input type="checkbox" bind:checked={config.editorAutocompleteEnabled} onchange={persist} />
            <span>编辑器内文本补全（vim/nano，默认关闭）</span>
        </label>
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
        <label class="settings-field settings-check">
            <input type="checkbox" bind:checked={config.historyAutocompleteEnabled} onchange={persist} />
            <span>历史命令补全</span>
        </label>
        <label class="settings-field settings-check">
            <input type="checkbox" bind:checked={config.scriptAutocompleteEnabled} onchange={persist} />
            <span>登录脚本补全（Beta）</span>
        </label>
        <label class="settings-field">
            <span>历史候选上限</span>
            <input type="number" min="1" max="20" step="1" bind:value={config.historyAutocompleteLimit} onchange={persist} />
        </label>
        <label class="settings-field">
            <span>最小触发长度</span>
            <input type="number" min="1" max="10" step="1" bind:value={config.minTriggerLength} onchange={persist} />
        </label>
        <label class="settings-field settings-check">
            <input type="checkbox" bind:checked={config.triggerWithoutSpaceEnabled} onchange={persist} />
            <span>无空格触发</span>
        </label>
        <label class="settings-field settings-check">
            <input type="checkbox" bind:checked={config.executeOnConfirm} onchange={persist} />
            <span>接受补全后立即执行</span>
        </label>
    </div>

    {#if saved}
        <div class="llm-saved">已保存</div>
    {/if}
</div>
