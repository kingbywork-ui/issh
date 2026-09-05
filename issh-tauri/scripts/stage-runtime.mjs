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

// Agent Bridge 的 stdio CLI/MCP 运行时必须随 Tauri 安装包发布。
// 只暂存运行所需文件，避免把测试、文档和未完成的实验性适配器带进发布包。
const agentSourceDir = path.join(repositoryRoot, 'issh-agent')
const agentDestinationDir = path.join(tauriDir, 'src-tauri', 'bin', 'agent-bridge')
const agentRuntimeFiles = [
    'package.json',
    path.join('bin', 'issh-agent.mjs'),
    path.join('bin', 'issh-mcp-server.mjs'),
    path.join('bin', 'tabby-agent.mjs'),
    path.join('bin', 'tabby-mcp-server.mjs'),
    path.join('src', 'client.mjs'),
    path.join('src', 'cli.mjs'),
    path.join('src', 'mcp-server.mjs'),
    path.join('src', 'protocol.js'),
]

for (const relativePath of agentRuntimeFiles) {
    const sourcePath = path.join(agentSourceDir, relativePath)
    if (!existsSync(sourcePath)) {
        console.error(`issh-agent runtime file not found at ${sourcePath}`)
        process.exit(1)
    }
    const destinationPath = path.join(agentDestinationDir, relativePath)
    mkdirSync(path.dirname(destinationPath), { recursive: true })
    copyFileSync(sourcePath, destinationPath)
}
console.log(`staged issh-agent runtime -> ${path.relative(repositoryRoot, agentDestinationDir)} (${agentRuntimeFiles.length} files)`)
