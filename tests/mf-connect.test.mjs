import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  cancelConnect,
  disconnectAgent,
  getConnectSession,
  listConnectedAgents,
  pollConnect,
  startConnect,
} from '../worker/mf/connect.mjs'
import {
  autoAssignRoles,
  assignRoles,
  JOB_CREDENTIAL_HORIZON_MS,
  openCredential,
  readConnection,
  resolveRoleCredentials,
} from '../worker/mf/store.mjs'

const BASE = 'https://api.manyfold.test'

function memoryKv(initial = {}) {
  const values = new Map(Object.entries(initial))
  return {
    values,
    async get(key) { return values.get(key) ?? null },
    async put(key, value) { values.set(key, value) },
    async delete(key) { values.delete(key) },
  }
}

function environment(overrides = {}) {
  return {
    TRIPS_KV: memoryKv(),
    ADMIN_SETTINGS_PASSWORD: 'admin-password-with-enough-entropy',
    MF_CONNECT_KEY: 'a-dedicated-connect-key-with-enough-entropy',
    MANYFOLD_API_BASE_URL: BASE,
    ENVIRONMENT: 'production',
    ...overrides,
  }
}

function agentEntry(overrides = {}) {
  return {
    agentId: 'agt_one',
    name: 'Trip Brief Agent',
    rpcUrl: 'https://api.manyfold.test/api/a2a/agents/agt_one/rpc',
    cardUrl: 'https://api.manyfold.test/api/a2a/agents/agt_one/card',
    token: 'nca_agent_one_secret',
    expiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
    ...overrides,
  }
}

async function withFetch(routes, fn) {
  const original = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, init = {}) => {
    const href = String(url)
    calls.push({ url: href, init })
    for (const [match, handler] of Object.entries(routes)) {
      if (href.includes(match)) {
        const [status, body] = await handler(init, href)
        return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
      }
    }
    return new Response(JSON.stringify({ error: { message: 'unrouted' } }), { status: 404 })
  }
  try {
    return await fn(calls)
  } finally {
    globalThis.fetch = original
  }
}

const startOk = () => [200, {
  requestId: 'req-1',
  userCode: 'ABCD-1234',
  authUrl: 'https://manyfold.test/authorize?code=ABCD-1234',
  deviceCode: 'device-code-secret',
  expiresAt: new Date(Date.now() + 900_000).toISOString(),
}]
// A tasks/get for an id that cannot exist: the "not found" answer proves the
// token works without running a billable turn.
const probeOk = () => [200, { jsonrpc: '2.0', error: { code: -32001, message: 'task not found' } }]
const cardOk = () => [200, { description: 'Turns a sentence into a trip brief.' }]

const approvedWith = agents => () => [200, { status: 'approved', userEmail: 'zack@netmind.test', agents }]

const HAPPY = {
  '/api/connect/a2a/start': startOk,
  '/api/connect/a2a/poll': approvedWith([agentEntry()]),
  '/card': cardOk,
  '/rpc': probeOk,
}

test('start seals the device code and never returns it', async () => {
  const env = environment()
  await withFetch({ '/api/connect/a2a/start': startOk }, async () => {
    const session = await startConnect(env, 'https://trip.test/settings')
    assert.equal(session.userCode, 'ABCD-1234')
    assert.ok(!('deviceCode' in session))
  })
  const stored = env.TRIPS_KV.values.get('mf:connect-session:v1')
  assert.ok(stored)
  assert.ok(!stored.includes('device-code-secret'), 'device code was stored in the clear')
})

test('start omits clientUrl for a non-https origin because Manyfold rejects it', async () => {
  const env = environment()
  await withFetch({ '/api/connect/a2a/start': startOk }, async (calls) => {
    await startConnect(env, 'http://127.0.0.1:8787/settings')
    const body = JSON.parse(calls[0].init.body)
    assert.equal(body.clientName, 'Travel Ticket')
    assert.ok(!('clientUrl' in body))
  })
})

test('a 404 on start blames the base URL, not the device code', async () => {
  const env = environment()
  await withFetch({
    '/api/connect/a2a/start': () => [404, { error: { message: 'Cannot POST /api/connect/a2a/start' } }],
  }, async () => {
    await assert.rejects(startConnect(env, 'https://trip.test/settings'), /MANYFOLD_API_BASE_URL/)
  })
})

test('approval stores the agent sealed, assigns roles, and never exposes the token', async () => {
  const env = environment()
  await withFetch(HAPPY, async () => {
    const session = await startConnect(env, 'https://trip.test/settings')
    const outcome = await pollConnect(env, session.connectId)
    assert.equal(outcome.status, 'approved')
    assert.equal(outcome.agents.length, 1)
    assert.equal(outcome.agents[0].verified, true)
    assert.equal(outcome.agents[0].description, 'Turns a sentence into a trip brief.')
    assert.ok(!JSON.stringify(outcome).includes('nca_agent_one_secret'), 'token leaked in the poll response')
  })

  const record = await readConnection(env)
  // One agent takes all four roles, written down rather than left implicit.
  for (const role of ['brief', 'discovery', 'composer', 'theme']) {
    assert.equal(record.roles[role], 'agt_one')
  }
  assert.ok(!env.TRIPS_KV.values.get('mf:connection:v1').includes('nca_agent_one_secret'), 'token stored in the clear')
  assert.ok(!JSON.stringify(await listConnectedAgents(env)).includes('nca_agent_one_secret'))

  const credential = await openCredential(env, record.agents[0])
  assert.equal(credential.token, 'nca_agent_one_secret')
})

test('an agent whose rpcUrl points at a private address is refused, not stored', async () => {
  const env = environment()
  await withFetch({
    ...HAPPY,
    '/api/connect/a2a/poll': approvedWith([
      agentEntry({ agentId: 'agt_evil', name: 'Metadata', rpcUrl: 'https://169.254.169.254/latest/meta-data' }),
      agentEntry(),
    ]),
  }, async () => {
    const session = await startConnect(env, 'https://trip.test/settings')
    const outcome = await pollConnect(env, session.connectId)
    assert.equal(outcome.agents.length, 1)
    assert.equal(outcome.failed.length, 1)
    assert.match(outcome.failed[0].error, /private address/)
  })
  assert.deepEqual((await listConnectedAgents(env)).map(a => a.agentId), ['agt_one'])
})

test('a failed probe keeps the issued credential but records the warning', async () => {
  const env = environment()
  await withFetch({ ...HAPPY, '/rpc': () => [401, { error: { message: 'nope' } }] }, async () => {
    const session = await startConnect(env, 'https://trip.test/settings')
    const outcome = await pollConnect(env, session.connectId)
    // Discarding an already-issued token would leave a live grant nobody can
    // revoke, so it is stored with the failure attached.
    assert.equal(outcome.agents.length, 1)
    assert.equal(outcome.agents[0].verified, false)
    assert.match(outcome.agents[0].warning, /rejected this token/)
  })
})

test('the probe never runs a billable turn', async () => {
  const env = environment()
  await withFetch(HAPPY, async (calls) => {
    const session = await startConnect(env, 'https://trip.test/settings')
    await pollConnect(env, session.connectId)
    const rpcBodies = calls.filter(c => c.url.includes('/rpc')).map(c => JSON.parse(c.init.body))
    assert.ok(rpcBodies.length > 0)
    for (const body of rpcBodies) {
      assert.equal(body.method, 'tasks/get', 'connecting an agent must not send a message')
    }
  })
})

test('a second poll after approval reports expired and does not duplicate agents', async () => {
  const env = environment()
  await withFetch(HAPPY, async () => {
    const session = await startConnect(env, 'https://trip.test/settings')
    await pollConnect(env, session.connectId)
    assert.deepEqual(await pollConnect(env, session.connectId), { status: 'expired' })
  })
  assert.equal((await listConnectedAgents(env)).length, 1)
})

test('a 404 on poll retires the session instead of blaming configuration', async () => {
  const env = environment()
  await withFetch({
    '/api/connect/a2a/start': startOk,
    '/api/connect/a2a/poll': () => [404, { error: { message: 'deviceCode not found' } }],
  }, async () => {
    const session = await startConnect(env, 'https://trip.test/settings')
    assert.deepEqual(await pollConnect(env, session.connectId), { status: 'expired' })
    assert.equal(await getConnectSession(env), null)
  })
})

test('cancel clears the in-flight handshake', async () => {
  const env = environment()
  await withFetch({ '/api/connect/a2a/start': startOk }, async () => {
    const session = await startConnect(env, 'https://trip.test/settings')
    assert.ok(await getConnectSession(env))
    await cancelConnect(env, session.connectId)
    assert.equal(await getConnectSession(env), null)
  })
})

/* ───────── roles ───────── */

const baseRecord = (agents, overrides = {}) => ({
  v: 1,
  updatedAt: '',
  userEmail: null,
  agents,
  roles: { brief: null, discovery: null, composer: null, theme: null },
  roleMode: 'auto',
  ...overrides,
})

const agent = (agentId, name, extra = {}) => ({
  agentId, name, description: '', rpcUrl: `https://api.manyfold.test/${agentId}/rpc`,
  tokenCt: 'ct', tokenIv: 'iv', expiresAt: null, verified: true, warning: null,
  connectedAt: '2026-08-11T00:00:00.000Z', ...extra,
})

test('one agent takes every role', () => {
  const record = autoAssignRoles(baseRecord([agent('agt_solo', 'Solo')]))
  for (const role of ['brief', 'discovery', 'composer', 'theme']) {
    assert.equal(record.roles[role], 'agt_solo')
  }
})

test('several agents are matched to roles by name', () => {
  const record = autoAssignRoles(baseRecord([
    agent('agt_b', 'Trip Brief Agent'),
    agent('agt_d', 'Local Discovery Agent'),
    agent('agt_c', 'Itinerary Composer'),
    agent('agt_t', 'Theme Designer'),
  ]))
  assert.deepEqual(record.roles, { brief: 'agt_b', discovery: 'agt_d', composer: 'agt_c', theme: 'agt_t' })
})

test('a manual assignment is never overwritten by the heuristic', async () => {
  const env = environment()
  await env.TRIPS_KV.put('mf:connection:v1', JSON.stringify(baseRecord([
    agent('agt_b', 'Trip Brief Agent'),
    agent('agt_x', 'Something Else'),
  ])))
  await assignRoles(env, { brief: 'agt_x' })
  const record = autoAssignRoles(await readConnection(env))
  // The name heuristic would pick agt_b for brief; the operator outranks it.
  assert.equal(record.roles.brief, 'agt_x')
  assert.equal(record.roleMode, 'manual')
})

test('a role whose agent disconnects is cleared rather than silently reassigned', async () => {
  const env = environment()
  await withFetch(HAPPY, async () => {
    const session = await startConnect(env, 'https://trip.test/settings')
    await pollConnect(env, session.connectId)
  })
  await disconnectAgent(env, 'agt_one')
  const record = await readConnection(env)
  for (const role of ['brief', 'discovery', 'composer', 'theme']) {
    assert.equal(record.roles[role], null)
  }
})

/* ───────── credential resolution ───────── */

test('resolveRoleCredentials reports not-connected before anything is connected', async () => {
  const result = await resolveRoleCredentials(environment())
  assert.equal(result.ok, false)
  assert.match(result.problems[0].reason, /no Manyfold agents are connected/)
})

test('resolveRoleCredentials returns sealed credentials for every role', async () => {
  const env = environment()
  await withFetch(HAPPY, async () => {
    const session = await startConnect(env, 'https://trip.test/settings')
    await pollConnect(env, session.connectId)
  })
  const result = await resolveRoleCredentials(env)
  assert.equal(result.ok, true)
  for (const role of ['brief', 'discovery', 'composer', 'theme']) {
    assert.ok(result.credentials[role].tokenCt, `${role} has no sealed credential`)
    assert.ok(!('token' in result.credentials[role]), 'an open bearer must not reach the DO snapshot')
  }
  assert.ok(result.credentialRev)
})

test('a credential expiring inside the horizon blocks the trip before it is queued', async () => {
  const env = environment()
  await withFetch({
    ...HAPPY,
    '/api/connect/a2a/poll': approvedWith([
      agentEntry({ expiresAt: new Date(Date.now() + 60_000).toISOString() }),
    ]),
  }, async () => {
    const session = await startConnect(env, 'https://trip.test/settings')
    await pollConnect(env, session.connectId)
  })
  // A minute of validity cannot cover a ~24-minute DAG. Failing now is far
  // better than dying four tasks in with three billed sessions spent.
  const result = await resolveRoleCredentials(env, { horizonMs: JOB_CREDENTIAL_HORIZON_MS })
  assert.equal(result.ok, false)
  assert.match(result.problems[0].reason, /expires before this trip could finish/)
})

test('rotating the connect key makes stored credentials unreadable, not corrupt', async () => {
  const env = environment()
  await withFetch(HAPPY, async () => {
    const session = await startConnect(env, 'https://trip.test/settings')
    await pollConnect(env, session.connectId)
  })
  const record = await readConnection(env)
  const rotated = { ...env, MF_CONNECT_KEY: 'a-totally-different-connect-key-with-entropy' }
  await assert.rejects(openCredential(rotated, record.agents[0]), /encryption key changed/)
})
