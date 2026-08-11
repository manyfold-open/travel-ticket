import { test } from 'node:test'
import assert from 'node:assert/strict'
import { handleStartTrip, handleTripStatus } from '../../worker/routes/status.mjs'

class MockTripJobs {
  constructor(status = null, owner = 'visitor_abcdef01') { this.status = status; this.owner = owner }
  idFromName(id) { return id }
  get() {
    return {
      getStatus: async () => this.status,
      getVisitorId: async () => this.status ? this.owner : null,
      start: async (credentials, credentialRev) => {
        if (!this.status) return null
        this.startedWith = { credentials, credentialRev }
        if (this.status.phase === 'draft') this.status = { ...this.status, phase: 'queued' }
        return this.status
      },
    }
  }
}

/** A connection record with one agent serving all four roles. */
function connectedKv() {
  const agent = {
    agentId: 'agt_one',
    name: 'Test agent',
    description: '',
    rpcUrl: 'https://rpc.example/agt_one',
    tokenCt: 'ct',
    tokenIv: 'iv',
    expiresAt: null,
    verified: true,
    warning: null,
    connectedAt: '2026-08-11T00:00:00.000Z',
  }
  const record = {
    v: 1,
    updatedAt: '2026-08-11T00:00:00.000Z',
    userEmail: null,
    agents: [agent],
    roles: { brief: 'agt_one', discovery: 'agt_one', composer: 'agt_one', theme: 'agt_one' },
    roleMode: 'auto',
  }
  const values = new Map([['mf:connection:v1', JSON.stringify(record)]])
  return {
    values,
    async get(key) { return values.get(key) ?? null },
    async put(key, value) { values.set(key, value) },
    async delete(key) { values.delete(key) },
  }
}

const emptyKv = () => {
  const values = new Map()
  return {
    values,
    async get(key) { return values.get(key) ?? null },
    async put(key, value) { values.set(key, value) },
    async delete(key) { values.delete(key) },
  }
}

const makeEnv = (status = null, kv = connectedKv()) => ({ TRIP_JOBS: new MockTripJobs(status), TRIPS_KV: kv })
const ownerRequest = () => new Request('https://example.com/api/trips/trip_abc/start', {
  method: 'POST',
  headers: { cookie: 'travel_ticket_visitor=visitor_abcdef01' },
})
test('handleTripStatus: unknown trip_id -> 404', async () => {
  const env = makeEnv()
  const res = await handleTripStatus(env, 'trip_does_not_exist')
  assert.equal(res.status, 404)
})

test('handleTripStatus: known trip_id -> 200 with status and canonical links', async () => {
  const written = {
    phase: 'running',
    trip_id: 'trip_abc',
    agents: { 'Trip Brief Agent': 'completed' },
    log: ['Trip Brief Agent: Completed in 2s.'],
    manifest: null,
    error: null,
  }
  const res = await handleTripStatus(makeEnv(written), 'trip_abc')
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.deepEqual(
    Object.fromEntries(Object.entries(body).filter(([key]) => key !== 'links')),
    written,
  )
  assert.equal(body.links.self, '/api/trips/trip_abc')
  assert.equal(body.links.result, '/trips/trip_abc/')
})

test('handleStartTrip: starts a draft and returns the progress location', async () => {
  const res = await handleStartTrip(
    ownerRequest(),
    makeEnv({ phase: 'draft', trip_id: 'trip_abc' }),
    'trip_abc',
  )
  assert.equal(res.status, 202)
  assert.equal(res.headers.get('location'), '/trips/trip_abc/progress')
  assert.equal((await res.json()).phase, 'queued')
})

test('handleStartTrip: refuses to queue a trip when no agent is connected', async () => {
  // Without this gate the trip queues, burns three billed sessions, and dies
  // four tasks in with nothing to show the visitor.
  const res = await handleStartTrip(
    ownerRequest(),
    makeEnv({ phase: 'draft', trip_id: 'trip_abc' }, emptyKv()),
    'trip_abc',
  )
  assert.equal(res.status, 409)
  const body = await res.json()
  assert.equal(body.code, 'manyfold_reconnect_required')
  assert.ok(body.problems.length > 0)
})

test('handleStartTrip: snapshots the sealed credentials into the job', async () => {
  const env = makeEnv({ phase: 'draft', trip_id: 'trip_abc' })
  await handleStartTrip(ownerRequest(), env, 'trip_abc')
  const snapshot = env.TRIP_JOBS.get().startedWith ?? env.TRIP_JOBS.startedWith
  const credentials = snapshot?.credentials ?? env.TRIP_JOBS.get().startedWith?.credentials
  assert.ok(credentials, 'start() was not given a credential snapshot')
  for (const role of ['brief', 'discovery', 'composer', 'theme']) {
    assert.ok(credentials[role].tokenCt, `${role} was not snapshotted`)
    assert.ok(!('token' in credentials[role]), 'an open bearer must not reach the job')
  }
})

test('handleStartTrip: unknown trip_id -> 404', async () => {
  const res = await handleStartTrip(ownerRequest(), makeEnv(), 'trip_missing')
  assert.equal(res.status, 404)
})
