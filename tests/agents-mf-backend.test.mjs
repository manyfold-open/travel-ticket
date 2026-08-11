import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createAgentContext, runTripBriefAgent, runLocalDiscoveryAgent, runComposerAgent } from '../pipeline/agents.mjs'

const CREDENTIAL = { rpcUrl: 'https://rpc.example/agt_peer', token: 'connected-agent-token', label: 'Test agent' }

function withFetch(handler, fn) {
  const original = globalThis.fetch
  globalThis.fetch = handler
  return fn().finally(() => { globalThis.fetch = original })
}

// The agent answers over SSE now; the accumulator folds it back into the same
// task envelope the JSON path produced.
function mfReply(json) {
  return async () => new Response(
    [
      { kind: 'artifact-update', taskId: 't', artifact: { artifactId: 'a', parts: [{ text: JSON.stringify(json) }] } },
      { kind: 'status-update', taskId: 't', status: { state: 'completed' }, final: true },
    ].map(result => `data: ${JSON.stringify({ jsonrpc: '2.0', result })}\r\n\r\n`).join(''),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  )
}

test('createAgentContext refuses a role with no usable credential', () => {
  assert.throws(() => createAgentContext(null, 'brief'), /no usable credential/)
})

test('createAgentContext returns an a2a-backed context', () => {
  const ctx = createAgentContext(CREDENTIAL, 'brief')
  assert.equal(ctx.backend, 'a2a')
  assert.equal(ctx.credential.token, 'connected-agent-token')
})

test('runTripBriefAgent: mf backend calls the brief peer and returns parsed brief', () => withFetch(mfReply({
  destination: 'Japan: Kyoto', destination_timezone: 'Asia/Tokyo', home_city: 'Taipei', home_timezone: 'Asia/Taipei',
  start_date: '2026-09-10', end_date: '2026-09-13', travellers: 2, pace: 'balanced', no_car: false,
  bases: [{ name: 'Kyoto', nights: 3 }], interests: ['food'], language: 'zh-Hant', notes: '',
}), async () => {
  const ctx = createAgentContext(CREDENTIAL, 'brief')
  const brief = await runTripBriefAgent(ctx, '京都四天三夜', '2026-07-21')
  assert.equal(brief.destination, 'Japan: Kyoto')
  assert.equal(brief.bases[0].nights, 3)
}))

test('runLocalDiscoveryAgent: mf backend returns parsed discovery', () => withFetch(mfReply({
  pois: [], transports: [], sources: [],
}), async () => {
  const ctx = createAgentContext(CREDENTIAL, 'discovery')
  const discovery = await runLocalDiscoveryAgent(ctx, { destination: 'Japan: Kyoto' })
  assert.deepEqual(discovery, { pois: [], transports: [], sources: [] })
}))

test('runComposerAgent: mf backend returns parsed itinerary', () => withFetch(mfReply({
  summary: 'ok', warnings: [], days: [], alternatives: { relaxed: { notes: '' }, full: { notes: '' } },
  actions_suggested: [], cover: { title_top: 'Kyoto', title_accent: 'Autumn', eyebrow: 'preview' },
}), async () => {
  const ctx = createAgentContext(CREDENTIAL, 'composer')
  const result = await runComposerAgent(ctx, { sentence: '京都四天三夜', brief: {}, timezone: {}, discovery: {}, context: {}, calendar: {} })
  assert.equal(result.summary, 'ok')
  assert.equal(result.cover.title_top, 'Kyoto')
}))
