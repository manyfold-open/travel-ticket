import { test } from 'node:test'
import assert from 'node:assert/strict'
import { handleCreateTrip } from '../../worker/routes/create-trip.mjs'

class MockKV {
  constructor() { this.store = new Map() }
  async put(key, value) { this.store.set(key, value) }
  async get(key, type) {
    if (!this.store.has(key)) return null
    const value = this.store.get(key)
    return type === 'json' ? JSON.parse(value) : value
  }
}

class MockTripJobs {
  constructor() { this.initialized = [] }
  idFromName(id) { return id }
  get(id) {
    return {
      initialize: async (params) => {
        this.initialized.push({ id, params })
        return { phase: 'draft', trip_id: id }
      },
    }
  }
}

class MockRateLimiter {
  constructor(success = true) { this.success = success; this.calls = [] }
  async limit(opts) { this.calls.push(opts); return { success: this.success } }
}

const makeEnv = () => ({
  TRIPS_KV: new MockKV(),
  TRIPS_SITES: new MockKV(),
  TRIP_JOBS: new MockTripJobs(),
  TURNSTILE_SECRET_KEY: 'sk_test',
})

const VALID_BODY = { sentence: 'a relaxed week in Switzerland', visitor_id: 'visitor_abcdef01', turnstile_token: 'tok_ok' }

const withMockFetch = async (turnstileResult, fn) => {
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url) => {
    assert.equal(url, 'https://challenges.cloudflare.com/turnstile/v0/siteverify')
    return { json: async () => turnstileResult }
  }
  try { await fn() } finally { globalThis.fetch = realFetch }
}

const req = (body) => new Request('https://example.com/api/trips', {
  method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.9' }, body: JSON.stringify(body),
})

test('handleCreateTrip: missing/invalid Turnstile token -> 403', async () => {
  await withMockFetch({ success: false }, async () => {
    const env = makeEnv()
    const res = await handleCreateTrip(req({ ...VALID_BODY, turnstile_token: 'bad' }), env)
    assert.equal(res.status, 403)
    assert.equal(env.TRIP_JOBS.initialized.length, 0)
  })
})

test('handleCreateTrip: no turnstile_token at all -> 403 (never calls siteverify)', async () => {
  const realFetch = globalThis.fetch
  globalThis.fetch = async () => { throw new Error('siteverify should not be called with no token') }
  try {
    const env = makeEnv()
    const { turnstile_token, ...noToken } = VALID_BODY
    const res = await handleCreateTrip(req(noToken), env)
    assert.equal(res.status, 403)
  } finally { globalThis.fetch = realFetch }
})

test('handleCreateTrip: valid token + valid body -> 201, durable job initialized', async () => {
  await withMockFetch({ success: true }, async () => {
    const env = makeEnv()
    const res = await handleCreateTrip(req(VALID_BODY), env)
    assert.equal(res.status, 201)
    const body = await res.json()
    assert.match(body.trip_id, /^trip_/)
    assert.equal(body.phase, 'draft')
    assert.equal(body.links.connect, `/trips/${body.trip_id}/connect`)
    assert.equal(res.headers.get('location'), body.links.connect)
    assert.match(res.headers.get('set-cookie'), /^travel_ticket_visitor=/)

    assert.equal(env.TRIP_JOBS.initialized.length, 1)
    const { id, params } = env.TRIP_JOBS.initialized[0]
    assert.equal(id, body.trip_id)
    assert.equal(params.tripId, body.trip_id)
    assert.equal(params.sentence, VALID_BODY.sentence)
    assert.equal(params.visitorId, VALID_BODY.visitor_id)
    assert.equal(typeof params.todayIso, 'string')
    assert.equal(params.design, undefined)

  })
})

test('handleCreateTrip: creates a cookie-backed visitor when legacy visitor_id is omitted', async () => {
  await withMockFetch({ success: true }, async () => {
    const env = makeEnv()
    const { visitor_id, ...bodyWithoutVisitor } = VALID_BODY
    const res = await handleCreateTrip(req(bodyWithoutVisitor), env)
    assert.equal(res.status, 201)
    assert.match(env.TRIP_JOBS.initialized[0].params.visitorId, /^visitor_[a-f0-9]{32}$/)
    assert.match(res.headers.get('set-cookie'), /HttpOnly; SameSite=Lax/)
  })
})

test('handleCreateTrip: an explicit design choice is passed through to the durable job', async () => {
  await withMockFetch({ success: true }, async () => {
    const env = makeEnv()
    const res = await handleCreateTrip(req({ ...VALID_BODY, design: { kind: 'preset', name: 'japan' } }), env)
    assert.equal(res.status, 201)
    assert.deepEqual(env.TRIP_JOBS.initialized[0].params.design, { kind: 'preset', name: 'japan' })
  })
})

test('handleCreateTrip: malformed design choice -> 400', async () => {
  await withMockFetch({ success: true }, async () => {
    const env = makeEnv()
    const res = await handleCreateTrip(req({ ...VALID_BODY, design: { kind: 'nonsense' } }), env)
    assert.equal(res.status, 400)
    assert.equal(env.TRIP_JOBS.initialized.length, 0)
  })
})

test('handleCreateTrip: oversized sentence -> 400', async () => {
  await withMockFetch({ success: true }, async () => {
    const env = makeEnv()
    const res = await handleCreateTrip(req({ ...VALID_BODY, sentence: 'x'.repeat(501) }), env)
    assert.equal(res.status, 400)
    assert.equal(env.TRIP_JOBS.initialized.length, 0)
  })
})

test('handleCreateTrip: empty sentence -> 400', async () => {
  await withMockFetch({ success: true }, async () => {
    const env = makeEnv()
    const res = await handleCreateTrip(req({ ...VALID_BODY, sentence: '   ' }), env)
    assert.equal(res.status, 400)
  })
})

test('handleCreateTrip: malformed visitor_id (too short) -> 400', async () => {
  await withMockFetch({ success: true }, async () => {
    const env = makeEnv()
    const res = await handleCreateTrip(req({ ...VALID_BODY, visitor_id: 'short' }), env)
    assert.equal(res.status, 400)
    assert.equal(env.TRIP_JOBS.initialized.length, 0)
  })
})

test('handleCreateTrip: malformed visitor_id (bad characters) -> 400', async () => {
  await withMockFetch({ success: true }, async () => {
    const env = makeEnv()
    const res = await handleCreateTrip(req({ ...VALID_BODY, visitor_id: 'has spaces!!' }), env)
    assert.equal(res.status, 400)
  })
})

test('handleCreateTrip: malformed JSON body -> 400', async () => {
  await withMockFetch({ success: true }, async () => {
    const env = makeEnv()
    const badReq = new Request('https://example.com/api/trips', { method: 'POST', body: 'not json' })
    const res = await handleCreateTrip(badReq, env)
    assert.equal(res.status, 400)
  })
})

test('handleCreateTrip: rate limiter blocks -> 429, never reaches Turnstile or the durable job', async () => {
  const realFetch = globalThis.fetch
  globalThis.fetch = async () => { throw new Error('siteverify should not be called when rate-limited') }
  try {
    const env = makeEnv()
    env.TRIPS_RATE_LIMITER = new MockRateLimiter(false)
    const res = await handleCreateTrip(req(VALID_BODY), env)
    assert.equal(res.status, 429)
    assert.equal(env.TRIP_JOBS.initialized.length, 0)
    assert.deepEqual(env.TRIPS_RATE_LIMITER.calls, [{ key: '203.0.113.9' }])
  } finally { globalThis.fetch = realFetch }
})

test('handleCreateTrip: rate limiter allows -> proceeds as normal, keyed by cf-connecting-ip', async () => {
  await withMockFetch({ success: true }, async () => {
    const env = makeEnv()
    env.TRIPS_RATE_LIMITER = new MockRateLimiter(true)
    const res = await handleCreateTrip(req(VALID_BODY), env)
    assert.equal(res.status, 201)
    assert.deepEqual(env.TRIPS_RATE_LIMITER.calls, [{ key: '203.0.113.9' }])
  })
})

test('handleCreateTrip: no rate limiter binding configured -> not rate limited (local/dev degrade)', async () => {
  await withMockFetch({ success: true }, async () => {
    const env = makeEnv()
    assert.equal(env.TRIPS_RATE_LIMITER, undefined)
    const res = await handleCreateTrip(req(VALID_BODY), env)
    assert.equal(res.status, 201)
  })
})
