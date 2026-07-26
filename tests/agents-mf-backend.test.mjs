import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createMfContext, runTripBriefAgent, runLocalDiscoveryAgent, runComposerAgent } from '../pipeline/agents.mjs'

const ENV = {
  MF_API_URL: 'https://api-staging.manyfold.ai/api',
  MF_API_TOKEN: 'self-token',
  MF_AGENT_ID: 'agt_self',
  AGENT_BRIEF: 'agt_peer',
  AGENT_DISCOVERY: 'agt_peer',
  AGENT_COMPOSER: 'agt_peer',
}

function withFetch(handler, fn) {
  const original = globalThis.fetch
  globalThis.fetch = handler
  return fn().finally(() => { globalThis.fetch = original })
}

function mfReply(json) {
  return async (url) => {
    if (String(url).includes('/token')) return new Response(JSON.stringify({ token: 't', rpcUrl: 'https://rpc.example/agt_peer' }), { status: 200 })
    return new Response(JSON.stringify({ result: { parts: [{ text: JSON.stringify(json) }] } }), { status: 200 })
  }
}

test('createMfContext: requires an explicit supported role and its peer', () => {
  assert.throws(() => createMfContext(ENV), /Unsupported Manyfold role/)
  assert.throws(() => createMfContext({}, 'brief'), /MF_API_URL/)
  assert.throws(() => createMfContext({ MF_API_URL: 'x', MF_API_TOKEN: 'y' }, 'brief'), /peer/)
})

test('createMfContext: returns an mf-backed context', () => {
  const ctx = createMfContext(ENV, 'brief')
  assert.equal(ctx.backend, 'mf')
  assert.equal(ctx.env, ENV)
  assert.equal(ctx.peerId, 'agt_peer')
})

test('createMfContext: routes a role to its dedicated A2A peer', () => {
  const env = { ...ENV, AGENT_BRIEF: 'agt_brief' }
  const ctx = createMfContext(env, 'brief')
  assert.equal(ctx.peerId, 'agt_brief')
  assert.equal(ctx.role, 'brief')
})

test('runTripBriefAgent: mf backend calls the brief peer and returns parsed brief', () => withFetch(mfReply({
  destination: 'Japan: Kyoto', destination_timezone: 'Asia/Tokyo', home_city: 'Taipei', home_timezone: 'Asia/Taipei',
  start_date: '2026-09-10', end_date: '2026-09-13', travellers: 2, pace: 'balanced', no_car: false,
  bases: [{ name: 'Kyoto', nights: 3 }], interests: ['food'], language: 'zh-Hant', notes: '',
}), async () => {
  const ctx = createMfContext(ENV, 'brief')
  const brief = await runTripBriefAgent(ctx, '京都四天三夜', '2026-07-21')
  assert.equal(brief.destination, 'Japan: Kyoto')
  assert.equal(brief.bases[0].nights, 3)
}))

test('runLocalDiscoveryAgent: mf backend returns parsed discovery', () => withFetch(mfReply({
  pois: [], transports: [], sources: [],
}), async () => {
  const ctx = createMfContext(ENV, 'discovery')
  const discovery = await runLocalDiscoveryAgent(ctx, { destination: 'Japan: Kyoto' })
  assert.deepEqual(discovery, { pois: [], transports: [], sources: [] })
}))

test('runComposerAgent: mf backend returns parsed itinerary', () => withFetch(mfReply({
  summary: 'ok', warnings: [], days: [], alternatives: { relaxed: { notes: '' }, full: { notes: '' } },
  actions_suggested: [], cover: { title_top: 'Kyoto', title_accent: 'Autumn', eyebrow: 'preview' },
}), async () => {
  const ctx = createMfContext(ENV, 'composer')
  const result = await runComposerAgent(ctx, { sentence: '京都四天三夜', brief: {}, timezone: {}, discovery: {}, context: {}, calendar: {} })
  assert.equal(result.summary, 'ok')
  assert.equal(result.cover.title_top, 'Kyoto')
}))
