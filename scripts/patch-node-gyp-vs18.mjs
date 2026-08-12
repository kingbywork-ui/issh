#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const nodeGypPath = require.resolve('node-gyp/lib/find-visualstudio.js')

let content = fs.readFileSync(nodeGypPath, 'utf-8')
let patched = false

const patch1Marker = 'ret.versionMajor === 18'
const patch2Marker = "parseInt(match[1], 10) >= 18"

if (!content.includes(patch1Marker)) {
  content = content.replace(
    `    if (ret.versionMajor === 17) {
      ret.versionYear = 2022
      return ret
    }
    this.log.silly('- unsupported version:', ret.versionMajor)
    return {}`,
    `    if (ret.versionMajor === 17) {
      ret.versionYear = 2022
      return ret
    }
    if (ret.versionMajor === 18) {
      ret.versionYear = 2022
      return ret
    }
    this.log.silly('- unsupported version:', ret.versionMajor)
    return {}`
  )
  patched = true
}

if (!content.includes(patch2Marker)) {
  content = content.replace(
    `    } else if (versionYear === 2022) {
      return 'v143'
    }`,
    `    } else if (versionYear === 2022) {
      const match = /^(\\d+)\\./.exec(info.version || '')
      if (match && parseInt(match[1], 10) >= 18) {
        return 'v145'
      }
      return 'v143'
    }`
  )
  patched = true
}

if (patched) {
  fs.writeFileSync(nodeGypPath, content)
  console.log('[patch-node-gyp-vs18] Patched find-visualstudio.js for VS 18 BuildTools support')
} else {
  console.log('[patch-node-gyp-vs18] Already patched, skipping')
}
