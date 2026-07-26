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
      start: async () => {
        if (!this.status) return null
        if (this.status.phase === 'draft') this.status = { ...this.status, phase: 'queued' }
        return this.status
      },
    }
  }
}

const makeEnv = (status = null) => ({ TRIP_JOBS: new MockTripJobs(status) })
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

test('handleStartTrip: unknown trip_id -> 404', async () => {
  const res = await handleStartTrip(ownerRequest(), makeEnv(), 'trip_missing')
  assert.equal(res.status, 404)
})
