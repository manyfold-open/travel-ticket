import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { buildItineraryFiles } from '../pipeline/render.mjs'
import { assertBritishEnglish } from '../pipeline/english.mjs'

const CJK_RE = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/u
const fixture = JSON.parse(fs.readFileSync(new URL('../data/final_itinerary.json', import.meta.url), 'utf8'))

function visibleHtml(html) {
  return html
    .replace(/<div class="language-switcher"[\s\S]*?<\/div>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<[^>]+>/g, ' ')
}

test('the checked-in itinerary satisfies the British English content policy', () => {
  assert.doesNotThrow(() => assertBritishEnglish(fixture))
})

test('rendered ticket pages contain no CJK in visible content', async () => {
  const { files } = await buildItineraryFiles(fixture, { hasPoster: false })
  for (const [name, html] of files) {
    if (!name.endsWith('.html')) continue
    assert.match(html, /<html lang="en-GB">/u, name)
    assert.doesNotMatch(visibleHtml(html), CJK_RE, name)
    assert.doesNotMatch(html, /zh-Hant|Noto Sans TC|LXGW WenKai TC/u, name)
  }
})

test('static product pages are British English', () => {
  const pages = [
    ...['index.html', 'access.html', 'connect.html', 'progress.html'].map((name) => new URL(`../worker/public/${name}`, import.meta.url)),
    new URL('../pipeline/studio.html', import.meta.url),
  ]
  for (const page of pages) {
    const html = fs.readFileSync(page, 'utf8')
    const name = page.pathname.split('/').at(-1)
    assert.match(html, /<html lang="en-GB">/u, name)
    assert.doesNotMatch(visibleHtml(html), CJK_RE, name)
  }
  const accessJs = fs.readFileSync(new URL('../worker/public/access.js', import.meta.url), 'utf8')
  assert.doesNotMatch(accessJs, CJK_RE)
})

test('Chinese rendered ticket pages declare Simplified Chinese', async () => {
  const chinese = { ...fixture, language: 'zh-CN' }
  const { files } = await buildItineraryFiles(chinese, { hasPoster: false })
  for (const [name, html] of files) {
    if (name.endsWith('.html')) assert.match(html, /<html lang="zh-CN">/u, name)
  }
})
