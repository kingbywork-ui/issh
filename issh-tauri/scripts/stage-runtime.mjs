#!/usr/bin/env node
import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const tauriDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const repositoryRoot = path.resolve(tauriDir, '..')
const source = path.join(repositoryRoot, 'issh-runtime', 'target', 'release', process.platform === 'win32' ? 'isshd.exe' : 'isshd')
const destination = path.join(tauriDir, 'src-tauri', 'bin', path.basename(source))

if (!existsSync(source)) {
    console.error(`isshd release binary not found at ${source}; run "cargo build --release -p isshd" in issh-runtime first`)
    process.exit(1)
}

mkdirSync(path.dirname(destination), { recursive: true })
copyFileSync(source, destination)
console.log(`staged ${path.relative(repositoryRoot, source)} -> ${path.relative(repositoryRoot, destination)} (${(statSync(destination).size / 1048576).toFixed(2)} MB)`)

// C8 (R-053)：issh-agent SKILL.md 随安装包发布（供外部 agent 加载）
const skillSource = path.join(repositoryRoot, 'issh-agent', 'SKILL.md')
const skillDestination = path.join(tauriDir, 'src-tauri', 'bin', 'SKILL.md')
if (existsSync(skillSource)) {
    copyFileSync(skillSource, skillDestination)
    console.log(`staged ${path.relative(repositoryRoot, skillSource)} -> ${path.relative(repositoryRoot, skillDestination)}`)
} else {
    console.warn(`SKILL.md not found at ${skillSource}; SKILL.md will not be bundled`)
}
