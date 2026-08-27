#!/usr/bin/env node
// issh 插件一键发布流水线：
//   build → package tgz → subtree split → push 独立仓库 → tag → gh release → 更新 registry index.json → push registry
// 用法：node scripts/publish-plugin.mjs <pluginDirName> [--registry-only]
// 示例：node scripts/publish-plugin.mjs issh-plugin-vault
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFile, writeFile, copyFile, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { createPrivateKey, sign as edSign } from 'node:crypto'

const GITHUB_ORG = 'kingbywork-ui'
const REGISTRY_REPO_URL = `git@github.com:${GITHUB_ORG}/issh-plugin-registry.git`
const REGISTRY_LOCAL_DIR = 'plugins/issh-plugin-registry'

const args = process.argv.slice(2)
const pluginDirName = args[0]
const registryOnly = args.includes('--registry-only')
if (!pluginDirName || !pluginDirName.startsWith('issh-plugin-')) {
    console.error('用法：node scripts/publish-plugin.mjs <pluginDirName> [--registry-only]')
    process.exit(1)
}

function run (command, argv, options = {}) {
    console.log(`$ ${command} ${argv.join(' ')}`)
    const isCmd = command.endsWith('.cmd') || command.endsWith('.bat')
    return execFileSync(isCmd ? command : command, argv, {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'inherit'],
        shell: isCmd,
        ...(isCmd ? { windowsVerbatimArguments: false } : {}),
        ...options,
    }).trim()
}

function sha256Hex (buffer) {
    return createHash('sha256').update(buffer).digest('hex')
}

const pluginRoot = resolve(process.cwd(), 'plugins', pluginDirName)
const manifest = JSON.parse(await readFile(join(pluginRoot, 'plugin.json'), 'utf-8'))
const { id, version, entry } = manifest
console.log(`发布插件：${id} v${version}`)

// 1. build + package
if (!registryOnly) {
    run('npm.cmd', ['run', 'build', '--prefix', `plugins/${pluginDirName}`])
    run('npm.cmd', ['run', 'package', '--prefix', `plugins/${pluginDirName}`])
}

const tarballName = `${id}-${version}.tgz`
const tarballPath = join(pluginRoot, tarballName)
const tarballBytes = await readFile(tarballPath)
const sha256 = sha256Hex(tarballBytes)
console.log(`tgz：${tarballName}（${tarballBytes.length} bytes）`)
console.log(`sha256：${sha256}`)

// 签名（ed25519，私钥在 ~/.psacowork/issh-plugin-signing.key）
const keyPath = join(homedir(), '.psacowork', 'issh-plugin-signing.key')
let signature = null
try {
    const keyFile = JSON.parse(await readFile(keyPath, 'utf-8'))
    const privateKey = createPrivateKey({
        key: Buffer.from(keyFile.privateKey, 'base64'),
        format: 'der',
        type: 'pkcs8',
    })
    const message = Buffer.from(`${id}\n${version}\n${sha256}`, 'utf-8')
    signature = edSign(null, message, privateKey).toString('base64')
    console.log(`signature：${signature.slice(0, 16)}…`)
} catch (cause) {
    console.warn(`签名跳过（${cause instanceof Error ? cause.message : String(cause)}）`)
}

// 2. subtree split + push 独立仓库
if (!registryOnly) {
    const repoUrl = `git@github.com:${GITHUB_ORG}/${id}.git`
    const splitBranch = `${id}-publish`
    run('git', ['subtree', 'split', `--prefix=plugins/${pluginDirName}`, '-b', splitBranch])
    try {
        run('git', ['remote', 'remove', `${id}-remote`])
    } catch {}
    run('git', ['remote', 'add', `${id}-remote`, repoUrl])
    run('git', ['push', `${id}-remote`, `${splitBranch}:main`, '--force'])

    // 3. tag + release
    const tag = `v${version}`
    run('git', ['tag', '-f', tag, splitBranch])
    run('git', ['push', `${id}-remote`, tag, '--force'])
    run('gh', [
        'release', 'create', tag,
        '--repo', `${GITHUB_ORG}/${id}`,
        '--title', `${id} ${tag}`,
        '--notes', `${manifest.description ?? id} ${tag}`,
        tarballPath,
        `${tarballPath}.sha256`,
    ])
    run('git', ['branch', '-D', splitBranch])
    run('git', ['remote', 'remove', `${id}-remote`])
}

// 4. 更新 registry index.json
const downloadUrl = `https://github.com/${GITHUB_ORG}/${id}/releases/download/v${version}/${tarballName}`
const indexPath = resolve(process.cwd(), REGISTRY_LOCAL_DIR, 'index.json')
const index = JSON.parse(await readFile(indexPath, 'utf-8'))
const entryRecord = {
    id,
    name: manifest.name,
    version,
    description: manifest.description ?? '',
    kind: manifest.kind ?? 'feature',
    permissions: manifest.permissions ?? [],
    minAppVersion: manifest.minAppVersion ?? undefined,
    downloadUrl,
    sha256,
    signature,
    homepage: manifest.homepage ?? `https://github.com/${GITHUB_ORG}/${id}`,
    repository: manifest.repository ?? `https://github.com/${GITHUB_ORG}/${id}`,
}
const existing = index.plugins.findIndex((plugin) => plugin.id === id)
if (existing >= 0) index.plugins[existing] = entryRecord
else index.plugins.push(entryRecord)
index.plugins.sort((a, b) => a.id.localeCompare(b.id))
index.updated = new Date().toISOString()
await writeFile(indexPath, JSON.stringify(index, null, 2) + '\n', 'utf-8')
console.log(`索引已更新：${indexPath}`)

// 5. commit monorepo + subtree split 推送 registry 独立仓库
run('git', ['add', REGISTRY_LOCAL_DIR])
try {
    run('git', ['commit', '-m', `chore(registry): publish ${id} v${version}`])
} catch {
    console.log('registry 无变更，跳过 commit')
}
const registrySplit = 'registry-publish'
run('git', ['subtree', 'split', `--prefix=${REGISTRY_LOCAL_DIR}`, '-b', registrySplit])
try {
    run('git', ['remote', 'remove', 'registry-remote'])
} catch {}
run('git', ['remote', 'add', 'registry-remote', REGISTRY_REPO_URL])
run('git', ['push', 'registry-remote', `${registrySplit}:main`, '--force'])
run('git', ['branch', '-D', registrySplit])
run('git', ['remote', 'remove', 'registry-remote'])
console.log('发布完成。')
