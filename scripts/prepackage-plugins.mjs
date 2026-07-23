#!/usr/bin/env node
import { rebuild } from '@electron/rebuild'
import sh from 'shelljs'
import path from 'node:path'
import fs from 'node:fs'
import * as vars from './vars.mjs'
import log from 'npmlog'
import './patch-node-gyp-vs18.mjs'

import * as url from 'url'
const __dirname = url.fileURLToPath(new URL('.', import.meta.url))

let target = path.resolve(__dirname, '../builtin-plugins')
sh.rm('-rf', target)
sh.mkdir('-p', target)
fs.writeFileSync(path.join(target, 'package.json'), '{}')
sh.cd(target)

for (const plugin of vars.builtinPlugins) {
    log.info('install', plugin)
    sh.rm('-rf', plugin)
    sh.cp('-r', path.join('..', plugin), '.')
    sh.rm('-rf', path.join(plugin, 'node_modules'))
    sh.cd(plugin)
    sh.exec(`corepack yarn install --force --production --ignore-scripts`, { fatal: true })

    log.info('rebuild', 'native')
    const wptGyp = path.resolve('node_modules/@tabby-gang/windows-process-tree/binding.gyp')
    if (fs.existsSync(wptGyp)) {
        let gyp = fs.readFileSync(wptGyp, 'utf-8')
        if (gyp.includes('SpectreMitigation')) {
            gyp = gyp.replace(/"msvs_configuration_attributes":\s*\{[^}]*"SpectreMitigation":\s*"Spectre"[^}]*\},?\s*/g, '')
            fs.writeFileSync(wptGyp, gyp)
            log.info('patch', 'Removed SpectreMitigation from windows-process-tree binding.gyp')
        }
    }
    if (fs.existsSync('node_modules')) {
        await rebuild({
            buildPath: path.resolve('.'),
            electronVersion: vars.electronVersion,
            arch: process.env.ARCH ?? process.arch,
            force: true,
            useCache: false,
        })
    }
    sh.cd('..')
}
fs.unlinkSync(path.join(target, 'package.json'))
