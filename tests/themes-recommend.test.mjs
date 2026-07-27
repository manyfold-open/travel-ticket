import { test } from 'node:test'
import assert from 'node:assert/strict'
import { THEMES, recommendThemes, CUSTOM_OPTION } from '../pipeline/themes.mjs'

test('every registered theme has selection metadata', () => {
  for (const [name, t] of Object.entries(THEMES)) {
    assert.ok(t.label, `${name}.label`)
    assert.ok(t.blurb, `${name}.blurb`)
    assert.ok(Array.isArray(t.regions), `${name}.regions`)
    assert.ok(Array.isArray(t.mood), `${name}.mood`)
  }
})

test('recommendThemes: llm picks are validated + deduped', async () => {
  const llm = async () => ({ picks: [
    { name: 'japan', why: 'Best match for the destination' },
    { name: 'japan', why: 'dupe' },
    { name: 'nonexistent', why: 'invalid' },
    { name: 'default', why: 'Versatile option' },
  ] })
  const r = await recommendThemes({ destination: 'Japan: Kyoto', brief: {}, llm })
  assert.deepEqual(r.map((p) => p.name), ['japan', 'default'])
  assert.ok(r[0].why)
  assert.ok(r[0].label)
})

test('recommendThemes: llm failure → deterministic fallback, first = resolveTheme', async () => {
  const llm = async () => { throw new Error('boom') }
  const r = await recommendThemes({ destination: '日本京都', brief: { destination_timezone: 'Asia/Tokyo' }, llm })
  assert.equal(r[0].name, 'japan')
  assert.ok(r.length >= 2)
  assert.equal(new Set(r.map((p) => p.name)).size, r.length) // unique
})

test('custom option shape', () => {
  assert.equal(CUSTOM_OPTION.enabled, true)
  assert.ok(CUSTOM_OPTION.label.includes('Describe your own'))
})
