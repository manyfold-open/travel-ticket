import { test } from 'node:test'
import assert from 'node:assert/strict'
import { handleFetch as workerHandleFetch } from '../../worker/index.mjs'
import { handleTravelTicketAccess } from '../../worker/access-control.mjs'
import { saveTripFiles } from '../../worker/storage.mjs'

class MockKV {
  constructor() { this.store = new Map() }
  async put(key, value) { this.store.set(key, value) }
  async delete(key) { this.store.delete(key) }
  async get(key, type) {
    if (!this.store.has(key)) return null
    const value = this.store.get(key)
    if (type === 'json') return JSON.parse(value)
    if (type === 'arrayBuffer') return typeof value === 'string' ? new TextEncoder().encode(value).buffer : value
    return value
  }
}

class MockTripJobs {
  constructor() {
    this.statuses = new Map()
    this.owners = new Map()
    this.started = []
  }
  idFromName(id) { return id }
  get(id) {
    return {
      getStatus: async () => this.statuses.get(id) ?? null,
      getVisitorId: async () => this.owners.get(id) ?? null,
      start: async () => {
        const current = this.statuses.get(id)
        if (!current) return null
        if (current.phase === 'draft') this.started.push(id)
        const next = current.phase === 'draft' ? { ...current, phase: 'queued' } : current
        this.statuses.set(id, next)
        return next
      },
    }
  }
}

const makeEnv = () => {
  const assetRequests = []
  return {
    TRIPS_KV: new MockKV(),
    TRIPS_SITES: new MockKV(),
    TRIP_JOBS: new MockTripJobs(),
    ADMIN_SETTINGS_PASSWORD: 'test-admin-signing-secret-with-enough-entropy',
    ACCESS_PASSCODE: '246810',
    ASSETS: {
      fetch: async (request) => {
        assetRequests.push(new URL(request.url).pathname)
        return new Response('app shell', { status: 200 })
      },
    },
    assetRequests,
  }
}

async function handleFetch(request, env) {
  const login = await handleTravelTicketAccess(new Request('https://example.com/api/access/login', {
    method: 'POST',
    body: JSON.stringify({ passcode: env.ACCESS_PASSCODE }),
  }), env)
  assert.equal(login.status, 200)
  const accessCookie = login.headers.get('set-cookie').split(';')[0]
  const headers = new Headers(request.headers)
  const existingCookie = headers.get('cookie')
  headers.set('cookie', existingCookie ? `${existingCookie}; ${accessCookie}` : accessCookie)
  return workerHandleFetch(new Request(request, { headers }), env)
}

test('handleFetch: protects visitor pages and APIs while keeping access and settings public', async () => {
  const env = makeEnv()
  const document = await workerHandleFetch(new Request('https://example.com/?trip=abc'), env)
  assert.equal(document.status, 302)
  assert.equal(new URL(document.headers.get('location')).pathname, '/access')
  assert.equal(new URL(document.headers.get('location')).searchParams.get('next'), '/?trip=abc')

  const api = await workerHandleFetch(new Request('https://example.com/api/config'), env)
  assert.equal(api.status, 401)
  assert.equal((await api.json()).code, 'ACCESS_REQUIRED')

  const access = await workerHandleFetch(new Request('https://example.com/access'), env)
  assert.equal(access.status, 200)
  assert.equal(env.assetRequests.at(-1), '/access')

  const settings = await workerHandleFetch(new Request('https://example.com/settings'), env)
  assert.equal(settings.status, 200)
  assert.equal(env.assetRequests.at(-1), '/settings')
})

test('handleFetch: GET /api/config routes to handleConfig', async () => {
  const env = makeEnv()
  const res = await handleFetch(new Request('https://example.com/api/config'), env)
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.ready, false)
  assert.deepEqual(body.services, { manyfold: false, connectors: false })
})

test('handleFetch: unknown API path -> 404 JSON', async () => {
  const env = makeEnv()
  const res = await handleFetch(new Request('https://example.com/api/nonsense'), env)
  assert.equal(res.status, 404)
  assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8')
})

test('handleFetch: canonical GET /api/trips/:id returns the workflow snapshot', async () => {
  const env = makeEnv()
  env.TRIP_JOBS.statuses.set('trip_test', { phase: 'draft', trip_id: 'trip_test' })
  env.TRIP_JOBS.owners.set('trip_test', 'visitor_abcdef01')
  const res = await handleFetch(new Request('https://example.com/api/trips/trip_test'), env)
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.phase, 'draft')
  assert.equal(body.links.connect, '/trips/trip_test/connect')
})

test('handleFetch: legacy GET /api/trips/:id/status remains available', async () => {
  const env = makeEnv()
  env.TRIP_JOBS.statuses.set('trip_test', { phase: 'running', trip_id: 'trip_test' })
  const res = await handleFetch(new Request('https://example.com/api/trips/trip_test/status'), env)
  assert.equal(res.status, 200)
})

test('handleFetch: POST /api/trips/:id/start is idempotent and starts a draft', async () => {
  const env = makeEnv()
  env.TRIP_JOBS.statuses.set('trip_test', { phase: 'draft', trip_id: 'trip_test' })
  env.TRIP_JOBS.owners.set('trip_test', 'visitor_abcdef01')
  const res = await handleFetch(
    new Request('https://example.com/api/trips/trip_test/start', {
      method: 'POST',
      headers: { cookie: 'travel_ticket_visitor=visitor_abcdef01' },
    }),
    env,
  )
  assert.equal(res.status, 202)
  const again = await handleFetch(
    new Request('https://example.com/api/trips/trip_test/start', {
      method: 'POST',
      headers: { cookie: 'travel_ticket_visitor=visitor_abcdef01' },
    }),
    env,
  )
  assert.equal(again.status, 202)
  assert.deepEqual(env.TRIP_JOBS.started, ['trip_test'])
  assert.equal((await res.json()).phase, 'queued')
})

test('handleFetch: start rejects cross-site requests before changing the draft', async () => {
  const env = makeEnv()
  env.TRIP_JOBS.statuses.set('trip_test', { phase: 'draft', trip_id: 'trip_test' })
  env.TRIP_JOBS.owners.set('trip_test', 'visitor_abcdef01')
  const res = await handleFetch(
    new Request('https://example.com/api/trips/trip_test/start', {
      method: 'POST',
      headers: {
        cookie: 'travel_ticket_visitor=visitor_abcdef01',
        origin: 'https://attacker.example',
      },
    }),
    env,
  )
  assert.equal(res.status, 403)
  assert.deepEqual(env.TRIP_JOBS.started, [])
})

test('handleFetch: wrong API method -> 405 with Allow header', async () => {
  const env = makeEnv()
  const res = await handleFetch(
    new Request('https://example.com/api/trips/trip_test/status', { method: 'POST' }),
    env,
  )
  assert.equal(res.status, 405)
  assert.equal(res.headers.get('allow'), 'GET')
})

test('handleFetch: new trip-scoped connector status route verifies the owner cookie', async () => {
  const env = makeEnv()
  env.TRIP_JOBS.owners.set('trip_test', 'visitor_abcdef01')
  const res = await handleFetch(new Request(
    'https://example.com/api/trips/trip_test/connectors/gmail',
    { headers: { cookie: 'travel_ticket_visitor=visitor_abcdef01' } },
  ), env)
  assert.equal(res.status, 200)
  assert.equal(typeof (await res.json()).connected, 'boolean')
})

test('handleFetch: legacy connector route upgrades the query visitor', async () => {
  const env = makeEnv()
  env.TRIP_JOBS.owners.set('trip_test', 'visitor_abcdef01')
  const res = await handleFetch(new Request(
    'https://example.com/api/trips/trip_test/connect/gmail/status?visitor_id=visitor_abcdef01',
  ), env)
  assert.equal(res.status, 200)
  assert.match(res.headers.get('set-cookie'), /^travel_ticket_visitor=/)
})

test('handleFetch: GET /trips/<unknown>/ -> branded HTML 404', async () => {
  const env = makeEnv()
  const res = await handleFetch(new Request('https://example.com/trips/no-such-trip/'), env)
  assert.equal(res.status, 404)
  assert.match(res.headers.get('content-type'), /^text\/html/)
})

test('handleFetch: GET /trips/<known>/ -> 200 index.html', async () => {
  const env = makeEnv()
  await saveTripFiles(env, 'trip_known', new Map([['index.html', '<html><body>hi</body></html>']]))
  const res = await handleFetch(new Request('https://example.com/trips/trip_known/'), env)
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('content-type'), 'text/html; charset=utf-8')
})

test('handleFetch: /trips/<known> redirects to the trailing-slash canonical URL', async () => {
  const env = makeEnv()
  const res = await handleFetch(new Request('https://example.com/trips/trip_known'), env)
  assert.equal(res.status, 308)
  assert.equal(res.headers.get('location'), '/trips/trip_known/')
})

test('handleFetch: draft and active trip roots redirect to the correct UI page', async () => {
  const env = makeEnv()
  env.TRIP_JOBS.statuses.set('trip_draft', { phase: 'draft' })
  env.TRIP_JOBS.statuses.set('trip_active', { phase: 'running' })
  const draft = await handleFetch(new Request('https://example.com/trips/trip_draft/'), env)
  const active = await handleFetch(new Request('https://example.com/trips/trip_active/'), env)
  assert.equal(draft.headers.get('location'), '/trips/trip_draft/connect')
  assert.equal(active.headers.get('location'), '/trips/trip_active/progress')
})

test('handleFetch: generated manifest has the correct content type', async () => {
  const env = makeEnv()
  await saveTripFiles(env, 'trip_known', new Map([['manifest.webmanifest', '{}']]))
  const res = await handleFetch(new Request('https://example.com/trips/trip_known/manifest.webmanifest'), env)
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('content-type'), 'application/manifest+json; charset=utf-8')
})

test('handleFetch: resource-scoped UI pages serve committed assets', async () => {
  const env = makeEnv()
  env.TRIP_JOBS.statuses.set('trip_test', { phase: 'draft', trip_id: 'trip_test' })
  const res = await handleFetch(new Request('https://example.com/trips/trip_test/connect'), env)
  assert.equal(res.status, 200)
  assert.equal(env.assetRequests.at(-1), '/connect')
})

test('handleFetch: legacy page URLs redirect to resource-scoped routes', async () => {
  const env = makeEnv()
  const res = await handleFetch(new Request('https://example.com/progress.html?trip=trip_test'), env)
  assert.equal(res.status, 308)
  assert.equal(res.headers.get('location'), '/trips/trip_test/progress')
})

test('handleFetch: /settings is canonical and restricted to GET/HEAD', async () => {
  const env = makeEnv()
  const get = await handleFetch(new Request('https://example.com/settings'), env)
  const legacy = await handleFetch(new Request('https://example.com/settings.html'), env)
  const post = await handleFetch(new Request('https://example.com/settings', { method: 'POST' }), env)
  assert.equal(get.status, 200)
  assert.equal(env.assetRequests.at(-1), '/settings')
  assert.equal(legacy.status, 308)
  assert.equal(legacy.headers.get('location'), '/settings')
  assert.equal(post.status, 405)
})

test('handleFetch: bare / falls through to the ASSETS binding', async () => {
  const env = makeEnv()
  const res = await handleFetch(new Request('https://example.com/'), env)
  assert.equal(await res.text(), 'app shell')
})
