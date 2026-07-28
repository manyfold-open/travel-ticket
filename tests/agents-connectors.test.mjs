import { test } from 'node:test'
import assert from 'node:assert/strict'
import { emptyConnectorContext, providerResult, runConnectorAgent } from '../pipeline/agents.mjs'

const BRIEF = { destination: 'Japan: Kyoto & Osaka', start_date: '2026-09-10', end_date: '2026-09-13' }

const RESULT = {
  status: 'ok', message: '',
  providers: {
    gmail: { status: 'connected', message: '', authorization_url: '' },
    calendar: { status: 'authorization_required', message: 'Connect Calendar in Manyfold.', authorization_url: 'https://manyfold.example/calendar' },
    notion: { status: 'not_connected', message: '', authorization_url: '' },
  },
  bookings: [{ type: 'train', vendor: 'JR', confirmation_no: 'ABC123', start: '2026-09-10', end: '', location: 'Kyoto', pax: 2 }],
  calendar_events: [],
  travel_notes: [],
}

test('connector agent asks the Manyfold context peer for normalized private context', async () => {
  const calls = []
  const ctx = {
    backend: 'sdk',
    client: { messages: { create: async request => {
      calls.push(request)
      return { content: [{ type: 'text', text: JSON.stringify(RESULT) }] }
    } } },
  }
  const result = await runConnectorAgent(ctx, {
    action: 'fetch_context', visitorId: 'visitor_test', tripId: 'trip_test', brief: BRIEF,
    agentBinding: { agentId: 'agt_personal', agentName: 'Personal Travel Agent' },
  })
  assert.equal(result.bookings[0].confirmation_no, 'ABC123')
  assert.equal(result.providers.calendar.status, 'authorization_required')
  assert.match(calls[0].messages[0].content, /travel-ticket:visitor_test/)
  assert.match(calls[0].messages[0].content, /Host Manyfold agent: agt_personal/)
  assert.match(calls[0].system, /Manyfold Connector layer/)
})

test('providerResult exposes an agent-owned authorization URL', () => {
  const result = providerResult(RESULT, 'calendar')
  assert.deepEqual(result, {
    connected: false,
    status: 'authorization_required',
    message: 'Connect Calendar in Manyfold.',
    authorization_url: 'https://manyfold.example/calendar',
  })
})

test('emptyConnectorContext never pretends that private data was read', () => {
  const result = emptyConnectorContext('agent unavailable')
  assert.equal(result.status, 'skipped')
  assert.equal(result.message, 'agent unavailable')
  assert.deepEqual(result.bookings, [])
  assert.equal(result.providers.gmail.status, 'not_connected')
})
