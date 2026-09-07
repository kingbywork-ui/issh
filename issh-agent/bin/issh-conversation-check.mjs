#!/usr/bin/env node
// Opt-in live acceptance harness. Config is a local file, never model output.
import fs from 'node:fs/promises'
import { startConversationProcess } from '../src/conversation-process.mjs'

const [configPath] = process.argv.slice(2)
if (!configPath) {
    console.error('Usage: node issh-agent/bin/issh-conversation-check.mjs <config.json>')
    process.exitCode = 2
} else {
    const config = JSON.parse(await fs.readFile(configPath, 'utf8'))
    if (!Array.isArray(config.agents) || config.agents.length !== 2) throw new Error('Exactly two explicit test Agents required')
    const handles = []
    try {
        for (const spec of config.agents) {
            const handle = startConversationProcess(spec)
            handles.push(handle)
            const identity = await handle.adapter.connect(spec)
            console.log(JSON.stringify({ event: 'connected', kind: spec.kind, ...identity }))
        }
        const nonce = `issh-${Date.now()}`
        const first = await handles[0].adapter.prompt(`This is a text-only connectivity test. Do not use tools. Reply with exactly: ${nonce}`)
        if (!first.text.includes(nonce)) throw new Error('Agent A did not return the test marker')
        const second = await handles[1].adapter.prompt(`This is a text-only connectivity test. Do not use tools. Agent A sent this quoted text: ${JSON.stringify(first.text)}. Reply with exactly the same test marker.`)
        if (!second.text.includes(nonce)) throw new Error('Agent B did not return the test marker')
        const returned = await handles[0].adapter.prompt(`Agent B replied with this quoted text: ${JSON.stringify(second.text)}. Do not use tools. Confirm receipt by replying with exactly the test marker from our previous turn.`)
        if (!returned.text.includes(nonce) || first.conversationId !== returned.conversationId) throw new Error('Return message did not reach the original conversation')
        console.log(JSON.stringify({ event: 'roundtrip_completed', conversations: handles.map(h => h.adapter.conversationId), marker: nonce }))
    } finally {
        for (const handle of handles) handle.close()
    }
}
