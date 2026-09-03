<script lang="ts">
    import { onMount } from 'svelte'
    import { SearchAddon } from '@xterm/addon-search'
    import type { Terminal } from '@xterm/xterm'

    let { terminal, onclose }: { terminal: Terminal, onclose: () => void } = $props()

    let query = $state('')
    let caseSensitive = $state(false)
    let regex = $state(false)
    let wholeWord = $state(false)
    let resultIndex = $state(0)
    let resultCount = $state(0)

    let inputEl: HTMLInputElement
    let searchAddon: SearchAddon

    onMount(() => {
        searchAddon = new SearchAddon()
        terminal.loadAddon(searchAddon)
        searchAddon.onDidChangeResults((result) => {
            resultIndex = result.resultIndex
            resultCount = result.resultCount
        })
        inputEl.focus()
        return () => {
            // 关闭时清除高亮
            try { searchAddon.clearDecorations() } catch {}
        }
    })

    function searchOptions () {
        return { caseSensitive, regex, wholeWord, incremental: false }
    }

    function findNext (): void {
        if (!query) return
        searchAddon.findNext(query, searchOptions())
    }

    function findPrevious (): void {
        if (!query) return
        searchAddon.findPrevious(query, searchOptions())
    }

    function onInput (): void {
        if (query) searchAddon.findNext(query, { ...searchOptions(), incremental: true })
        else {
            resultIndex = 0
            resultCount = 0
            searchAddon.clearDecorations()
        }
    }

    function onKeydown (event: KeyboardEvent): void {
        if (event.key === 'Escape') { event.preventDefault(); onclose() }
        else if (event.key === 'Enter' && event.shiftKey) { event.preventDefault(); findPrevious() }
        else if (event.key === 'Enter') { event.preventDefault(); findNext() }
    }
</script>

<div class="search-panel" role="search" aria-label="终端内搜索">
    <input
        bind:this={inputEl}
        bind:value={query}
        oninput={onInput}
        onkeydown={onKeydown}
        placeholder="搜索当前终端缓冲…"
        aria-label="搜索关键字"
    />
    <span class="search-count" aria-live="polite">{query ? `${resultIndex}/${resultCount}` : ''}</span>
    <button type="button" class="search-nav" onclick={findPrevious} disabled={!query} title="上一个（Shift+Enter）" aria-label="上一个匹配">▲</button>
    <button type="button" class="search-nav" onclick={findNext} disabled={!query} title="下一个（Enter）" aria-label="下一个匹配">▼</button>
    <label class="search-opt"><input type="checkbox" bind:checked={caseSensitive} onchange={findNext} />Aa</label>
    <label class="search-opt"><input type="checkbox" bind:checked={regex} onchange={findNext} />.*</label>
    <label class="search-opt"><input type="checkbox" bind:checked={wholeWord} onchange={findNext} />ab</label>
    <button type="button" class="search-close" onclick={onclose} aria-label="关闭搜索">×</button>
</div>
