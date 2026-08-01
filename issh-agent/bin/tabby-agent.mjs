#!/usr/bin/env node
import { main } from '../src/cli.mjs'

console.warn('[deprecated] tabby-agent is deprecated; use issh-agent.')

main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
})
