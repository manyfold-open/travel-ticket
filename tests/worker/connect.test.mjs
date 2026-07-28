import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  handleTripConnectorLink,
  handleTripConnectorStatus,
  handleTripConnectorsStatus,
} from '../../worker/routes/connect.mjs'

const VISITOR = 'visitor_abcdef01'

class MockTripJobs {
  constructor(owner = VISITOR) {
    this.owner = owner
    this.binding = {
      status: 'connected',
      agentId: 'agt_host',
      agentName: 'Personal Travel Agent',
      providers: {
        gmail: { status: 'connected', message: '' },
        calendar: { status: 'authorization_required', message: 'Set up in Manyfold.' },
        notion: { status: 'not_connected', message: '' },
      },
    }
  }
  idFromName(id) { return id }
  get() { return { getVisitorId: async () => this.owner, getAgentBinding: async () => this.binding } }
}

const makeEnv = (overrides = {}) => ({
  TRIP_JOBS: new MockTripJobs(),
  MF_API_URL: 'https://api.manyfold.example',
  MF_API_TOKEN: 'manyfold-secret',
  MF_AGENT_ID: 'agt_source',
  AGENT_CONTEXT_EXTRACTOR: 'agt_context',
  ...overrides,
})

const req = ({ visitorId = VISITOR, origin } = {}) => {
  const headers = {}
  if (visitorId) headers.cookie = `travel_ticket_visitor=${visitorId}`
  if (origin) headers.origin = origin
  return new Request('https://example.com/api/trips/trip_x/connectors/gmail/link', { headers })
}

const providerReply = (overrides = {}) => ({
  status: 'ok', message: '',
  providers: {
    gmail: { status: 'connected', message: '', authorization_url: '', ...overrides.gmail },
    calendar: { status: 'not_connected', message: '', authorization_url: '', ...overrides.calendar },
    notion: { status: 'not_connected', message: '', authorization_url: '', ...overrides.notion },
  },
  bookings: [], calendar_events: [], travel_notes: [],
})

async function withFetch(reply, fn) {
  const original = globalThis.fetch
  globalThis.fetch = async (url) => {
    if (String(url).includes('/token')) return new Response(JSON.stringify({ token: 't', rpcUrl: 'https://rpc.example/agt_context' }))
    return new Response(JSON.stringify({ result: { parts: [{ text: JSON.stringify(reply) }] } }))
  }
  try { return await fn() } finally { globalThis.fetch = original }
}

test('handleTripConnectorLink: sends provider setup back to Manyfold', async () => withFetch(providerReply(), async () => {
  const res = await handleTripConnectorLink(req(), makeEnv(), 'trip_x', 'gmail')
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.setup_in_manyfold, true)
  assert.equal(body.status, 'authorization_required')
  assert.equal(body.connected, false)
}))

test('handleTripConnectorLink: a different visitor session cannot access the trip', async () => {
  const res = await handleTripConnectorLink(req({ visitorId: 'visitor_someone_else' }), makeEnv(), 'trip_x', 'gmail')
  assert.equal(res.status, 403)
})

test('handleTripConnectorLink: rejects cross-site writes', async () => {
  const res = await handleTripConnectorLink(req({ origin: 'https://attacker.example' }), makeEnv(), 'trip_x', 'gmail')
  assert.equal(res.status, 403)
})

test('handleTripConnectorLink: unknown connector -> 400', async () => {
  const res = await handleTripConnectorLink(req(), makeEnv(), 'trip_x', 'not-a-real-connector')
  assert.equal(res.status, 400)
})

test('handleTripConnectorStatus: returns the install callback readiness', async () => withFetch(providerReply(), async () => {
  const res = await handleTripConnectorStatus(req(), makeEnv(), 'trip_x', 'gmail')
  const body = await res.json()
  assert.equal(body.connected, true)
  assert.equal(body.status, 'connected')
}))

test('handleTripConnectorStatus: missing host agent -> configuration_required', async () => {
  const env = makeEnv()
  env.TRIP_JOBS.binding = null
  const res = await handleTripConnectorStatus(req(), env, 'trip_x', 'gmail')
  const body = await res.json()
  assert.equal(body.connected, false)
  assert.equal(body.status, 'configuration_required')
})

test('handleTripConnectorsStatus: returns all install callback readiness states', async () => withFetch(providerReply(), async () => {
  const res = await handleTripConnectorsStatus(req(), makeEnv(), 'trip_x')
  const body = await res.json()
  assert.deepEqual(Object.keys(body.connectors).sort(), ['calendar', 'gmail', 'notion'])
  assert.equal(body.connectors.gmail.connected, true)
  assert.equal(body.connectors.calendar.status, 'authorization_required')
}))
