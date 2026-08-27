import { defineConfig } from 'vite'
import { resolve } from 'node:path'
import { readFileSync, copyFileSync } from 'node:fs'
import { join } from 'node:path'

const manifest = JSON.parse(readFileSync(new URL('./plugin.json', import.meta.url), 'utf-8'))

function copySandboxHtml () {
    return {
        name: 'copy-sandbox-html',
        closeBundle () {
            copyFileSync(join(__dirname, 'sandbox.html'), join(__dirname, 'dist', 'sandbox.html'))
        },
    }
}

export default defineConfig({
    plugins: [copySandboxHtml()],
    resolve: {
        alias: {
            '@tauri-apps/api': resolve(__dirname, '../../issh-tauri/node_modules/@tauri-apps/api'),
        },
    },
    build: {
        lib: {
            entry: resolve(__dirname, 'index.ts'),
            formats: ['es'],
            fileName: () => manifest.entry,
        },
        rollupOptions: {
            external: [],
        },
        outDir: 'dist',
        emptyOutDir: true,
        target: 'es2022',
        minify: false,
    },
})
