import { cp, mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

const root = fileURLToPath(new URL('..', import.meta.url))
const source = resolve(root, 'agent-dashboard', 'dist')
const target = resolve(root, 'agent-dashboard', 'embed')
await mkdir(target, { recursive: true })
for (const file of ['index.html', 'app.js', 'style.css']) {
  await cp(resolve(source, file), resolve(target, file))
}
console.log(`Dashboard embed synced: ${target}`)
