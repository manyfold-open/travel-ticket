import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  handleManyfoldAgentLink,
  handleManyfoldAgentStatus,
} from '../../worker/routes/agent.mjs'

const VISITOR = 'visitor_abcdef01'

class MockTripJobs {
  constructor() {
    this.binding = null
    this.credential = null
  }

  idFromName(id) { return id }

  get() {
    return {
      getVisitorId: async () => VISITOR,
      getStatus: async () => ({ phase: 'draft' }),
      getAgentBinding: async () => this.binding,
      connectDirectAgent: async (rpcUrl, token, agentName) => {
        this.credential = { rpcUrl, token }
        this.binding = { status: 'connected', mode: 'direct', agentName }
        return { phase: 'draft', agent_binding: this.binding }
      },
    }
  }
}

const makeEnv = (overrides = {}) => ({
  TRIP_JOBS: new MockTripJobs(),
  ...overrides,
})

const req = (path, options = {}) => new Request(`https://ticket.example${path}`, {
  ...options,
  headers: { cookie: `travel_ticket_visitor=${VISITOR}`, ...(options.headers ?? {}) },
})

test('agent link verifies and stores a direct A2A RPC URL and bearer token', async () => {
  const env = makeEnv()
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url, options) => {
    assert.equal(url, 'https://agent.example/rpc')
    assert.equal(options.headers.authorization, 'Bearer external-token')
    return new Response(JSON.stringify({ result: { parts: [{ text: 'READY' }] } }), { status: 200 })
  }
  try {
    const res = await handleManyfoldAgentLink(req('/api/trips/trip_x/agent/link', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rpc_url: 'https://agent.example/rpc', bearer_token: 'external-token' }),
    }), env, 'trip_x')
    assert.equal(res.status, 200)
    assert.deepEqual(await res.json(), {
      status: 'connected', connected: true, agent_name: 'agent.example',
    })
    assert.deepEqual(env.TRIP_JOBS.credential, {
      rpcUrl: 'https://agent.example/rpc', token: 'external-token',
    })
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('agent link adds Manyfold RPC suffix when External Client URL is copied without it', async () => {
  const env = makeEnv()
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url, options) => {
    assert.equal(url, 'https://api.manyfold.ai/api/a2a/agents/agt_example/rpc')
    assert.equal(options.headers.authorization, 'Bearer external-token')
    return new Response(JSON.stringify({ result: { parts: [{ text: 'READY' }] } }), { status: 200 })
  }
  try {
    const res = await handleManyfoldAgentLink(req('/api/trips/trip_x/agent/link', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        rpc_url: 'https://api.manyfold.ai/api/a2a/agents/agt_example',
        bearer_token: 'external-token',
      }),
    }), env, 'trip_x')
    assert.equal(res.status, 200)
    assert.equal(env.TRIP_JOBS.credential.rpcUrl, 'https://api.manyfold.ai/api/a2a/agents/agt_example/rpc')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('agent link explains rejected bearer tokens separately from endpoint errors', async () => {
  const env = makeEnv()
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify({ error: 'invalid token' }), { status: 401 })
  try {
    const res = await handleManyfoldAgentLink(req('/api/trips/trip_x/agent/link', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rpc_url: 'https://agent.example/rpc', bearer_token: 'expired-token' }),
    }), env, 'trip_x')
    assert.equal(res.status, 502)
    assert.match((await res.json()).error, /bearer token/i)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('agent link explains a missing or truncated Manyfold endpoint', async () => {
  const env = makeEnv()
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify({
    ok: false,
    error: { code: 'not_found', message: 'agent not found' },
  }), { status: 404 })
  try {
    const res = await handleManyfoldAgentLink(req('/api/trips/trip_x/agent/link', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rpc_url: 'https://api.manyfold.ai/api/a2a/agents/agt_missing/rpc', bearer_token: 'external-token' }),
    }), env, 'trip_x')
    assert.equal(res.status, 502)
    assert.match((await res.json()).error, /complete External Client URL/i)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('agent status reports the direct host-agent binding without exposing credentials', async () => {
  const env = makeEnv()
  env.TRIP_JOBS.binding = { status: 'connected', mode: 'direct', agentName: 'Travel Agent', secret: 'never' }
  const res = await handleManyfoldAgentStatus(req('/api/trips/trip_x/agent'), env, 'trip_x')
  assert.deepEqual(await res.json(), {
    status: 'connected', connected: true, mode: 'direct', agent_name: 'Travel Agent',
  })
})
