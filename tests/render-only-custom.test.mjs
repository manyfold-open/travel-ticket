import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { customMotifsFrom, customTokensFrom } from '../pipeline/trip.mjs'
import { renderItinerary } from '../pipeline/render-local.mjs'

const renderedHtml = (dir) => fs.readdirSync(dir)
  .filter((file) => file.endsWith('.html'))
  .map((file) => fs.readFileSync(path.join(dir, file), 'utf8'))
  .join('\n')

const GOOD_TOKENS = { // japan's palette: known to pass all 13 pairs (tests/custom-theme.test.mjs)
  rail: '#0b7d6e', 'rail-deep': '#0a5648', 'rail-press': '#0a5648', stamp: '#a62812',
  night: '#123a33', gold: '#f8b500', green: '#3a6b2f', blue: '#165e83',
  board: '#0f231f', 'board-hi': '#1a3029', 'board-lo': '#081310', 'board-edge': '#040a08',
}

const MIN_ITIN = {
  artifact_type: 'final_itinerary', trip_id: 'trip_test_abcd', destination: 'Testland',
  slug: 'testland-2026', destination_timezone: 'UTC', home_timezone: 'UTC',
  travellers: 1, summary: 's', warnings: [], sources: [], alternatives: {},
  actions_suggested: [], cover: { title_top: 'Test', title_accent: 'Trip' },
  context: { bookings: [], calendar_events: [] },
  days: [{
    date: '2026-01-01', title: 'Test → Testland', base: 'Testland',
    items: [{ variant: 'both', type: 'visit', title: 'Test stop', start_utc: '2026-01-01T10:00:00Z', end_utc: '2026-01-01T11:00:00Z', location: 'Testland', notes: '', sources: [] }],
  }],
}

test('customTokensFrom returns the tokens for a valid custom_theme', () => {
  const itin = { ...MIN_ITIN, custom_theme: { name: 'kyoto-teal', rationale: 'JR teal', tokens: GOOD_TOKENS } }
  const tokens = customTokensFrom(itin)
  assert.deepEqual(tokens, GOOD_TOKENS)
})

test('customTokensFrom returns null for a tampered key', () => {
  const itin = { ...MIN_ITIN, custom_theme: { name: 'x', tokens: { ...GOOD_TOKENS, paper: '#000000' } } }
  assert.equal(customTokensFrom(itin), null)
})

test('customTokensFrom returns null for a tampered value', () => {
  const itin = { ...MIN_ITIN, custom_theme: { name: 'x', tokens: { ...GOOD_TOKENS, rail: 'red; } body{display:none' } } }
  assert.equal(customTokensFrom(itin), null)
})

test('customTokensFrom returns null when custom_theme is absent', () => {
  assert.equal(customTokensFrom(MIN_ITIN), null)
})

test('customMotifsFrom preserves only supported string motifs', () => {
  const itin = { ...MIN_ITIN, custom_theme: { motifs: { stampText: 'VISITED', eyebrow: 'Keepsake Ticket', ignored: 'no', bad: 1 } } }
  assert.deepEqual(customMotifsFrom(itin), { stampText: 'VISITED', eyebrow: 'Keepsake Ticket' })
})

test('end-to-end: renderItinerary restores custom tokens and motifs from a saved itinerary', async () => {
  const itin = { ...MIN_ITIN, custom_theme: { name: 'kyoto-teal', tokens: GOOD_TOKENS, motifs: { stampText: 'VISITED', eyebrow: 'Keepsake Ticket' } } }
  const tokens = customTokensFrom(itin)
  const motifs = customMotifsFrom(itin)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'render-only-'))
  await renderItinerary(itin, { outDir: dir, customTokens: tokens, customMotifs: motifs })
  const html = renderedHtml(dir)
  assert.ok(html.includes('--rail:'))
  assert.ok(html.includes('Keepsake Ticket'))
  assert.ok(html.includes('VISITED'))
})
