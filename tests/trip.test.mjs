import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { planTrip, renderTicket } from '../pipeline/trip.mjs'

test('planTrip --mock returns plan + designOptions, no dist render', async () => {
  const { plan, designOptions } = await planTrip('', { mock: true, log: () => {} })
  assert.ok(plan.brief.destination.includes('Japan'))
  assert.ok(plan.composed.days.length >= 3)
  assert.ok(designOptions.presets.length >= 1)
  assert.equal(designOptions.presets[0].name, 'japan') // mock brief is Kyoto → japan first (deterministic fallback path in mock)
  assert.ok(designOptions.custom.enabled)
})

test('planTrip --mock: connector agent skips honestly when Manyfold is not configured', async () => {
  const { plan } = await planTrip('', { mock: true, log: () => {} })
  const byName = Object.fromEntries(plan.agentStatuses.map((s) => [s.agent, s]))
  assert.equal(byName['Travel Context Agent'].status, 'skipped')
})

test('renderTicket with preset renders and stamps the theme', async () => {
  const { plan } = await planTrip('', { mock: true, log: () => {} })
  const { itinerary, manifest, themeUsed } = await renderTicket(plan, { kind: 'preset', name: 'japan' }, { log: () => {} })
  assert.equal(itinerary.theme, 'japan')
  assert.equal(themeUsed.name, 'japan')
  assert.ok(manifest.pages.length > 0)
})

test('renderTicket custom in mock mode falls back honestly to preset #1', async () => {
  const { plan } = await planTrip('', { mock: true, log: () => {} })
  const { itinerary, themeUsed } = await renderTicket(plan, { kind: 'custom', style: '深藍配金' }, { log: () => {} })
  assert.ok(themeUsed.fallback_reason) // no LLM backend in tests → honest fallback
  assert.equal(itinerary.theme, themeUsed.name)
})
