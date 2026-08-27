// 生成 ed25519 签名密钥对：公钥内置到 Rust 端，私钥保存到 ~/.psacowork/issh-plugin-signing.key（勿提交）
import { generateKeyPairSync } from 'node:crypto'
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const keyPath = join(homedir(), '.psacowork', 'issh-plugin-signing.key')

if (existsSync(keyPath)) {
    const existing = JSON.parse(readFileSync(keyPath, 'utf-8'))
    console.log('已有私钥（复用）：')
    console.log('publicKey:', existing.publicKey)
    process.exit(0)
}

const { publicKey, privateKey } = generateKeyPairSync('ed25519')
const pubB64 = publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
const privB64 = privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64')

mkdirSync(join(homedir(), '.psacowork'), { recursive: true })
writeFileSync(keyPath, JSON.stringify({ publicKey: pubB64, privateKey: privB64 }, null, 2) + '\n', { mode: 0o600 })

console.log('密钥对已生成')
console.log('publicKey (SPKI base64):', pubB64)
console.log('privateKey 保存于：', keyPath)
