import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  handleTripConnectorLink,
  handleTripConnectorStatus,
  handleTripConnectorsStatus,
} from '../../worker/routes/connect.mjs'

const VISITOR = 'visitor_abcdef01'

class MockTripJobs {
  constructor(owner = VISITOR) { this.owner = owner }
  idFromName(id) { return id }
  get() {
    return { getVisitorId: async () => this.owner }
  }
}

const makeEnv = (overrides = {}) => ({
  TRIP_JOBS: new MockTripJobs(),
  COMPOSIO_API_KEY: 'ck_test',
  COMPOSIO_GMAIL_AUTH_CONFIG_ID: 'ac_gmail',
  ...overrides,
})

const req = ({
  visitorId = VISITOR,
  queryVisitorId,
  origin,
} = {}) => {
  const query = queryVisitorId === undefined ? '' : `?visitor_id=${encodeURIComponent(queryVisitorId)}`
  const headers = {}
  if (visitorId) headers.cookie = `travel_ticket_visitor=${visitorId}`
  if (origin) headers.origin = origin
  return new Request(`https://example.com/api/trips/trip_x/connectors/gmail/link${query}`, { headers })
}

test('handleTripConnectorLink: returns an authorization_url for the trip owner', async () => {
  const env = makeEnv()
  const client = { connectedAccounts: { link: async () => ({ id: 'cr_1', redirectUrl: 'https://connect.example/link' }) } }
  const res = await handleTripConnectorLink(req(), env, 'trip_x', 'gmail', { client })
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.authorization_url, 'https://connect.example/link')
  assert.equal(body.status, 'authorization_required')
  assert.equal(body.visitor_id, VISITOR)
})

test('handleTripConnectorLink: a legacy query visitor is upgraded to an HttpOnly cookie', async () => {
  const env = makeEnv()
  const client = { connectedAccounts: { link: async () => ({ id: 'cr_1', redirectUrl: 'https://connect.example/link' }) } }
  const res = await handleTripConnectorLink(
    req({ visitorId: null, queryVisitorId: VISITOR }),
    env,
    'trip_x',
    'gmail',
    { client },
  )
  assert.equal(res.status, 200)
  assert.match(res.headers.get('set-cookie'), /^travel_ticket_visitor=visitor_abcdef01/)
})

test('handleTripConnectorLink: missing auth config -> configuration_required, never calls link()', async () => {
  const env = makeEnv({ COMPOSIO_GMAIL_AUTH_CONFIG_ID: undefined })
  let called = false
  const client = { connectedAccounts: { link: async () => { called = true; return {} } } }
  const res = await handleTripConnectorLink(req(), env, 'trip_x', 'gmail', { client })
  const body = await res.json()
  assert.equal(body.status, 'configuration_required')
  assert.equal(called, false)
})

test('handleTripConnectorLink: unknown trip -> 404', async () => {
  const env = makeEnv({ TRIP_JOBS: new MockTripJobs(null) })
  const res = await handleTripConnectorLink(req(), env, 'trip_missing', 'gmail')
  assert.equal(res.status, 404)
})

test('handleTripConnectorLink: a different visitor session cannot access the trip', async () => {
  const env = makeEnv()
  const res = await handleTripConnectorLink(req({ visitorId: 'visitor_someone_else' }), env, 'trip_x', 'gmail')
  assert.equal(res.status, 403)
})

test('handleTripConnectorLink: rejects cross-site writes', async () => {
  const env = makeEnv()
  const res = await handleTripConnectorLink(
    req({ origin: 'https://attacker.example' }),
    env,
    'trip_x',
    'gmail',
  )
  assert.equal(res.status, 403)
})

test('handleTripConnectorLink: unknown connector -> 400', async () => {
  const env = makeEnv()
  const res = await handleTripConnectorLink(req(), env, 'trip_x', 'not-a-real-connector')
  assert.equal(res.status, 400)
})

test('handleTripConnectorStatus: connected account -> {connected:true}', async () => {
  const env = makeEnv()
  const client = { connectedAccounts: { list: async () => ({ items: [{ id: 'ca_1', alias: null, status: 'ACTIVE' }] }) } }
  const res = await handleTripConnectorStatus(req(), env, 'trip_x', 'gmail', { client })
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.connected, true)
  assert.equal(body.status, 'connected')
})

test('handleTripConnectorStatus: no connected account -> {connected:false}', async () => {
  const env = makeEnv()
  const client = { connectedAccounts: { list: async () => ({ items: [] }) } }
  const res = await handleTripConnectorStatus(req(), env, 'trip_x', 'gmail', { client })
  const body = await res.json()
  assert.equal(body.connected, false)
  assert.equal(body.status, 'not_connected')
})

test('handleTripConnectorStatus: no Composio API key -> configuration_required', async () => {
  const env = makeEnv({ COMPOSIO_API_KEY: undefined })
  const res = await handleTripConnectorStatus(req(), env, 'trip_x', 'gmail')
  const body = await res.json()
  assert.equal(body.connected, false)
  assert.equal(body.status, 'configuration_required')
})

test('handleTripConnectorsStatus: returns all connector states in one response', async () => {
  const env = makeEnv()
  const client = { connectedAccounts: { list: async () => ({ items: [] }) } }
  const res = await handleTripConnectorsStatus(req(), env, 'trip_x', { client })
  const body = await res.json()
  assert.deepEqual(Object.keys(body.connectors).sort(), ['calendar', 'gmail', 'notion'])
})
