import { test } from 'node:test'
import assert from 'node:assert/strict'
import { generateCustomTheme, CUSTOM_ALLOWED_KEYS } from '../pipeline/customTheme.mjs'

const promptTemplate = 'Destination: {{DESTINATION}}. Style: {{USER_STYLE}}.'

const GOOD_TOKENS = { // japan's palette: known to pass all 13 pairs
  rail: '#0b7d6e', 'rail-deep': '#0a5648', 'rail-press': '#0a5648', stamp: '#a62812',
  night: '#123a33', gold: '#f8b500', green: '#3a6b2f', blue: '#165e83',
  board: '#0f231f', 'board-hi': '#1a3029', 'board-lo': '#081310', 'board-edge': '#040a08',
}

test('good llm output passes the gate', async () => {
  const llm = async () => ({ name: 'kyoto-teal', tokens: GOOD_TOKENS, motifs: { stampText: 'VISITED' }, rationale: 'JR teal' })
  const r = await generateCustomTheme({ destination: 'Kyoto', style: '青綠', llm, promptTemplate })
  assert.equal(r.ok, true)
  assert.equal(r.tokens.rail, '#0b7d6e')
})

test('bad contrast → one repair retry → success', async () => {
  let n = 0
  const llm = async (req) => {
    n++
    if (n === 1) return { name: 'x', tokens: { ...GOOD_TOKENS, night: '#e0e0e0' }, motifs: {}, rationale: '' } // light night fails pairs 9-13
    assert.match(req.prompt, /night/) // repair prompt mentions the failing token pairs
    return { name: 'x', tokens: GOOD_TOKENS, motifs: {}, rationale: '' }
  }
  const r = await generateCustomTheme({ destination: 'X', style: 'y', llm, promptTemplate })
  assert.equal(n, 2)
  assert.equal(r.ok, true)
})

test('two failures → ok:false with failures listed', async () => {
  const llm = async () => ({ name: 'x', tokens: { ...GOOD_TOKENS, night: '#ffffff' }, motifs: {}, rationale: '' })
  const r = await generateCustomTheme({ destination: 'X', style: 'y', llm, promptTemplate })
  assert.equal(r.ok, false)
  assert.ok(r.failures.length > 0)
})

test('disallowed keys and bad hex are stripped→rejected before contrast', async () => {
  const llm = async () => ({ name: 'x', tokens: { paper: '#000000', rail: 'javascript:evil' }, motifs: {}, rationale: '' })
  const r = await generateCustomTheme({ destination: 'X', style: 'y', llm, promptTemplate })
  assert.equal(r.ok, false)
})

test('llm resolving undefined twice → resolves ok:false (never rejects)', async () => {
  const llm = async () => undefined
  const r = await generateCustomTheme({ destination: 'X', style: 'y', llm, promptTemplate })
  assert.equal(r.ok, false)
  assert.match(r.reason, /no result/i)
})

test('CUSTOM_ALLOWED_KEYS is exactly the 12-key security allowlist', () => {
  assert.deepEqual(
    [...CUSTOM_ALLOWED_KEYS].sort(),
    ['blue', 'board', 'board-edge', 'board-hi', 'board-lo', 'gold', 'green', 'night', 'rail', 'rail-deep', 'rail-press', 'stamp'],
  )
})

test('llm returns array tokens → ok:false', async () => {
  const llm = async () => ([])
  const r = await generateCustomTheme({ destination: 'X', style: 'y', llm, promptTemplate })
  assert.equal(r.ok, false)
  assert.match(r.reason, /no usable tokens/)
})

test('llm returns empty-object tokens → ok:false', async () => {
  const llm = async () => ({ name: 'x', tokens: {} })
  const r = await generateCustomTheme({ destination: 'X', style: 'y', llm, promptTemplate })
  assert.equal(r.ok, false)
  assert.match(r.reason, /no usable tokens/)
})

test('llm throws twice → ok:false', async () => {
  const llm = async () => { throw new Error('boom') }
  const r = await generateCustomTheme({ destination: 'X', style: 'y', llm, promptTemplate })
  assert.equal(r.ok, false)
  assert.match(r.reason, /boom|failed/i)
})

test('missing promptTemplate → ok:false (never reads fs itself — pure core takes the template as a param)', async () => {
  const llm = async () => ({ name: 'x', tokens: GOOD_TOKENS })
  const r = await generateCustomTheme({ destination: 'X', style: 'y', llm })
  assert.equal(r.ok, false)
  assert.match(r.reason, /prompt template missing/)
})
