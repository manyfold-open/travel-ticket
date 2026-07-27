import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { DEFAULT_LANGUAGE, SUPPORTED_LANGUAGES, assertSimplifiedChinese, locale, normalizeLanguage } from '../pipeline/language.mjs'
import { localCompose } from '../pipeline/trip-core.mjs'

test('language contract defaults to British English and only supports the requested locales', () => {
  assert.deepEqual(SUPPORTED_LANGUAGES, ['en-GB', 'zh-CN'])
  assert.equal(DEFAULT_LANGUAGE, 'en-GB')
  assert.equal(normalizeLanguage(), 'en-GB')
  assert.equal(normalizeLanguage('zh'), 'zh-CN')
})

test('invalid language values safely fall back to en-GB', () => {
  assert.equal(normalizeLanguage('zh-Hant'), 'en-GB')
  assert.equal(normalizeLanguage('xx-YY'), 'en-GB')
  assert.equal(normalizeLanguage(42), 'en-GB')
})

test('the checked-in final itinerary persists the normalised default language', () => {
  const itinerary = JSON.parse(fs.readFileSync(new URL('../data/final_itinerary.json', import.meta.url), 'utf8'))
  assert.equal(itinerary.language, DEFAULT_LANGUAGE)
})

test('Chinese fallback composer emits Simplified Chinese copy and rejects Traditional output', () => {
  const brief = {
    destination: 'Kyoto', destination_timezone: 'Asia/Tokyo', home_city: 'Beijing', home_timezone: 'Asia/Shanghai',
    start_date: '2027-09-10', end_date: '2027-09-11', travellers: 2, pace: '轻松', no_car: true,
    bases: [{ name: 'Kyoto', nights: 1 }], interests: [], language: 'zh-CN', notes: '测试',
  }
  const output = localCompose(brief, { pois: [], transports: [], sources: [] })
  assert.doesNotThrow(() => assertSimplifiedChinese(output))
  assert.throws(() => assertSimplifiedChinese({ summary: '繁體中文' }), /Simplified Chinese/)
  assert.match(output.summary, /行程|本地/u)
  assert.equal(locale('zh-CN').relaxed, '轻松')
})

test('language selectors are accessible and have a compact mobile-safe control', () => {
  for (const name of ['index.html', 'connect.html', 'progress.html']) {
    const source = fs.readFileSync(new URL(`../worker/public/${name}`, import.meta.url), 'utf8')
    assert.match(source, /class="language-switcher" role="group" aria-label="Language"/u, name)
    assert.match(source, /data-language="en-GB"[^>]*aria-pressed="true"/u, name)
    assert.match(source, /data-language="zh-CN"[^>]*aria-pressed="false"/u, name)
  }
  const css = fs.readFileSync(new URL('../worker/public/ticket.css', import.meta.url), 'utf8')
  assert.match(css, /\.language-switcher[^\n]*position: absolute/u)
  assert.match(css, /\.language-switcher button[^\n]*min-height: 32px/u)
  assert.match(css, /@media \(max-width: 900px\)[\s\S]*\.language-switcher/u)
})

test('production cover applies visible English and Simplified Chinese copy', () => {
  const source = fs.readFileSync(new URL('../worker/public/index.html', import.meta.url), 'utf8')
  assert.match(source, /const HOME_COPY = \{/u)
  assert.match(source, /titleTop: '一句话'/u)
  assert.match(source, /titleAccent: '一叠车票'/u)
  assert.match(source, /trip-ticket-language-change/u)
  assert.match(source, /function applyHomeLanguage\(language\)/u)
})
