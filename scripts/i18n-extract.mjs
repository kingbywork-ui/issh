#!/usr/bin/env node
import sh from 'shelljs'
import fs from 'node:fs/promises'
import * as vars from './vars.mjs'
import log from 'npmlog'
import { GettextExtractor, JsExtractors, HtmlExtractors } from 'gettext-extractor'
import gettextParser from 'gettext-parser'

let extractor = new GettextExtractor()

const tempOutput = 'locale/app.new.pot'
const pot = 'locale/app.pot'
const tempHtml = 'locale/tmp-html'
const pugCommand = process.platform === 'win32' ? '.\\node_modules\\.bin\\pug.cmd' : 'yarn pug'

function renameBrand (value = '') {
    return value
        .replaceAll('Tabby', 'issh')
        .replaceAll('tabby_exec_command', 'issh_exec_command')
        .replaceAll('tabby-agent', 'issh-agent')
}

function translationKey (context, msgid) {
    return `${context}\u0000${renameBrand(msgid)}`
}

function decodeUTF8FromLatin1 (value = '') {
    return Buffer.from(value, 'latin1').toString('utf8')
}

function decodeMojibake (value = '') {
    let current = value
    for (let attempt = 0; attempt < 3; attempt++) {
        if ([...current].some(character => character.codePointAt(0) > 0xff)) {
            break
        }
        const decoded = decodeUTF8FromLatin1(current)
        if (decoded === current || decoded.includes('\ufffd')) {
            break
        }
        current = decoded
    }
    return current
}

function repairMisdetectedUTF8 (catalog) {
    if (catalog.charset !== 'iso-8859-1' || !/charset=utf-8/i.test(catalog.headers['Content-Type'] ?? '')) {
        return
    }
    catalog.headers = Object.fromEntries(
        Object.entries(catalog.headers).map(([key, value]) => [key, decodeUTF8FromLatin1(value)]),
    )
    for (const translations of Object.values(catalog.translations)) {
        for (const entry of Object.values(translations)) {
            entry.msgctxt = entry.msgctxt ? decodeUTF8FromLatin1(entry.msgctxt) : entry.msgctxt
            entry.msgid = decodeUTF8FromLatin1(entry.msgid)
            entry.msgid_plural = entry.msgid_plural ? decodeUTF8FromLatin1(entry.msgid_plural) : entry.msgid_plural
            entry.msgstr = entry.msgstr.map(decodeUTF8FromLatin1)
        }
    }
    catalog.charset = 'utf-8'
}

function indexTranslations (catalog) {
    const entries = new Map()
    for (const [context, translations] of Object.entries(catalog.translations)) {
        for (const entry of Object.values(translations)) {
            if (entry.msgid) {
                entries.set(translationKey(entry.msgctxt ?? context, entry.msgid), entry)
            }
        }
    }
    return entries
}

function normalizeReferences (catalog) {
    for (const translations of Object.values(catalog.translations)) {
        for (const entry of Object.values(translations)) {
            if (entry.comments?.reference) {
                entry.comments.reference = entry.comments.reference.replaceAll('\\', '/')
            }
        }
    }
}

function mergeTranslationCatalog (template, existing) {
    const existingEntries = indexTranslations(existing)
    const translations = {}

    for (const [context, templateEntries] of Object.entries(template.translations)) {
        translations[context] = {}
        for (const [msgid, templateEntry] of Object.entries(templateEntries)) {
            if (!msgid) {
                translations[context][msgid] = { ...templateEntry }
                continue
            }
            const existingEntry = existingEntries.get(translationKey(context, msgid))
            translations[context][msgid] = {
                ...templateEntry,
                msgstr: existingEntry?.msgstr?.map(value => renameBrand(decodeMojibake(value))) ?? [''],
            }
        }
    }

    const headers = { ...existing.headers }
    for (const key of Object.keys(headers)) {
        if (key.startsWith('X-Crowdin-')) {
            delete headers[key]
        }
    }
    headers['Project-Id-Version'] = 'issh'

    return {
        charset: 'utf-8',
        headers,
        translations,
    }
}

async function writeNormalizedLocales () {
    const template = gettextParser.po.parse(await fs.readFile(tempOutput))
    normalizeReferences(template)
    template.headers['Project-Id-Version'] = 'issh'
    await fs.writeFile(pot, gettextParser.po.compile(template, { sort: true }))

    const localeFiles = (await fs.readdir('locale')).filter(file => file.endsWith('.po'))
    for (const localeFile of localeFiles) {
        const localePath = `locale/${localeFile}`
        const existing = gettextParser.po.parse(await fs.readFile(localePath))
        repairMisdetectedUTF8(existing)
        const merged = mergeTranslationCatalog(template, existing)
        await fs.writeFile(localePath, gettextParser.po.compile(merged, { sort: true }))
    }

    await fs.unlink(tempOutput)
}

;(async () => {
    sh.mkdir('-p', tempHtml)
    for (const plugin of vars.builtinPlugins) {
        log.info('compile-pug', plugin)

        sh.exec(`${pugCommand} --doctype html -s --pretty -O "{require: function(){}}" -o ${tempHtml}/${plugin} ${plugin}`, { fatal: true })
    }

    log.info('extract-ts')
    extractor.createJsParser([
        JsExtractors.callExpression('this.translate.instant', {
            arguments: { text: 0 },
        }),
        JsExtractors.callExpression('translate.instant', {
            arguments: { text: 0 },
        }),
        JsExtractors.callExpression('_', {
            arguments: { text: 0 },
        }),
    ]).parseFilesGlob('./issh-*/src/**/*.ts')

    log.info('extract-pug')
    const options = {
        attributes: {
            context: 'translatecontext',
        },
    }
    extractor.createHtmlParser([
        HtmlExtractors.elementContent('translate, [translate=""]', options),
        HtmlExtractors.elementAttribute('[translate*=" "]', 'translate', options),
    ]).parseFilesGlob(`${tempHtml}/**/*.html`)

    extractor.savePotFile(tempOutput)
    extractor.printStats()

    sh.rm('-r', tempHtml)
    await writeNormalizedLocales()
})()
