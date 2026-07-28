import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  runBriefStep, runTimezoneStep, runDiscoveryStep, runContextStep,
  runComposerStep, runThemeStep, runRenderStep,
} from '../../worker/pipeline-steps.mjs'

// A ctx whose LLM calls always fail — exercises every stage's honest-fallback
// path without needing to mock a real Manyfold/Anthropic response.
const brokenCtx = { backend: 'sdk' } // no .client — any runJson call throws

const BRIEF = {
  destination: 'Switzerland: Zürich & Interlaken',
  start_date: '2027-03-01',
  end_date: '2027-03-04',
  travellers: 2,
  pace: 'relaxed',
  notes: 'test brief',
  home_city: 'Taipei',
  home_timezone: 'Asia/Taipei',
  destination_timezone: 'Europe/Zurich',
  bases: [{ name: 'Zürich', nights: 3 }],
}

class MockKV {
  constructor() { this.store = new Map() }
  async put(key, value) { this.store.set(key, value) }
  async get(key, type) {
    if (!this.store.has(key)) return null
    const value = this.store.get(key)
    if (type === 'json') return JSON.parse(value)
    return value
  }
}
const makeEnv = () => ({ TRIPS_SITES: new MockKV() })

test('runBriefStep: throws when the Trip Brief Agent fails (no fallback, matches trip.mjs)', async () => {
  await assert.rejects(
    () => runBriefStep(brokenCtx, 'a week in Switzerland', '2027-01-01'),
    /Trip Brief Agent failed/,
  )
})

test('runBriefStep: persists the requested language even when the brief agent output differs', async () => {
  const ctx = {
    backend: 'sdk',
    client: {
      messages: {
        create: async () => ({
          content: [{ type: 'text', text: JSON.stringify({
            destination: 'Kyoto', destination_timezone: 'Asia/Tokyo', home_city: 'Beijing', home_timezone: 'Asia/Shanghai',
            start_date: '2027-09-10', end_date: '2027-09-11', travellers: 2, pace: 'relaxed', no_car: true,
            bases: [], interests: [], language: 'en-GB', notes: '',
          }) }],
        }),
      },
    },
  }
  const result = await runBriefStep(ctx, 'a trip to Kyoto', '2027-01-01', 'zh-CN')
  assert.equal(result.brief.language, 'zh-CN')
})

// The terminal error stored by trip-job.ts is all the user sees on /progress, so
// it has to name the actual cause rather than only the generic dead end.
test('runBriefStep: the thrown error carries the underlying cause', async () => {
  await assert.rejects(
    () => runBriefStep(brokenCtx, 'a week in Switzerland', '2027-01-01'),
    (error) => {
      assert.match(error.message, /Trip Brief Agent failed/)
      assert.ok(error.message.length > 'Trip Brief Agent failed — cannot continue without a brief.'.length)
      return true
    },
  )
})

test('runTimezoneStep: resolves timezone from the brief', async () => {
  const { statuses, timezone } = await runTimezoneStep(BRIEF)
  assert.equal(statuses[0].agent, 'Timezone Agent')
  assert.equal(statuses[0].status, 'completed')
  assert.ok(timezone.body_clock_rule)
})

test('runDiscoveryStep: falls back to empty discovery when the agent fails', async () => {
  const { statuses, discovery } = await runDiscoveryStep(brokenCtx, BRIEF)
  assert.equal(statuses[0].status, 'failed')
  assert.deepEqual(discovery, { pois: [], transports: [], sources: [] })
})

test('runContextStep: records skipped (not failed) when no External Client is connected', async () => {
  const context = await runContextStep(null, BRIEF, 'visitor_test', 'trip_test')
  assert.equal(context.statuses[0].agent, 'Travel Context Agent')
  assert.equal(context.statuses[0].status, 'skipped')
  assert.deepEqual(context.context.bookings, [])
  assert.deepEqual(context.context.calendar_events, [])
  assert.deepEqual(context.context.travel_notes, [])
})

test('runContextStep: records failed when a connected agent errors mid-call', async () => {
  const context = await runContextStep(brokenCtx, BRIEF, 'visitor_test', 'trip_test')
  assert.equal(context.statuses[0].status, 'failed')
  assert.deepEqual(context.context.bookings, [])
  assert.deepEqual(context.context.calendar_events, [])
  assert.deepEqual(context.context.travel_notes, [])
})

test('runComposerStep: falls back to localCompose plus a fallback status entry when the agent fails', async () => {
  const { statuses, composed } = await runComposerStep(brokenCtx, {
    sentence: 'a week in Switzerland', brief: BRIEF, timezone: { body_clock_rule: 'x' },
    discovery: { pois: [], transports: [], sources: [] }, context: { bookings: [] }, calendar: { events: [] },
  })
  assert.equal(statuses.at(-1).agent, 'Orchestrator Fallback Composer')
  assert.ok(composed.days.length > 0)
})

test('runThemeStep: no design choice resolves the default preset, no LLM call', async () => {
  const res = await runThemeStep(brokenCtx, { design: undefined, brief: BRIEF, promptTemplate: 'irrelevant' })
  assert.equal(res.themeName, 'default')
  assert.equal(res.themeUsed.custom, undefined)
  assert.equal(res.customTokens, null)
})

test('runThemeStep: an explicit preset choice is honored', async () => {
  const res = await runThemeStep(brokenCtx, { design: { kind: 'preset', name: 'japan' }, brief: BRIEF, promptTemplate: 'irrelevant' })
  assert.equal(res.themeName, 'japan')
})

test('runThemeStep: a custom choice that fails generation falls back to the resolved preset, never throws', async () => {
  const res = await runThemeStep(brokenCtx, { design: { kind: 'custom', style: 'art deco' }, brief: BRIEF, promptTemplate: 'irrelevant' })
  assert.equal(res.themeName, 'default')
  assert.equal(res.customTokens, null)
  assert.ok(res.themeUsed.fallback_reason)
})

test('runRenderStep: writes rendered files and itinerary JSON into KV', async () => {
  const env = makeEnv()
  const itinerary = {
    trip_id: 'trip_test_0001',
    slug: 'zurich-2027',
    status: 'complete',
    destination: 'Switzerland',
    theme: 'default',
    cover: { title_top: 'Switzerland', title_accent: 'by Rail', eyebrow: 'test' },
    days: [],
    warnings: [],
    alternatives: { relaxed: { notes: '' }, full: { notes: '' } },
    actions_suggested: [],
    agent_statuses: [{ agent: 'Trip Brief Agent', status: 'completed', confidence: 0.9, notes: '' }],
    context: { bookings: [], calendar_events: [], travel_notes: [] },
    sources: [],
  }
  const { pageCount } = await runRenderStep(env, itinerary, { customTokens: null, customMotifs: null })
  assert.ok(pageCount > 0)
  const savedJson = await env.TRIPS_SITES.get('trips/trip_test_0001/itinerary.json', 'json')
  assert.equal(savedJson.trip_id, 'trip_test_0001')
  const savedIndex = await env.TRIPS_SITES.get('trips/trip_test_0001/index.html', 'text')
  assert.ok(savedIndex.includes('<html'))
})
