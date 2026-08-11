import { test } from 'node:test'
import assert from 'node:assert/strict'
import { handleConfig } from '../../worker/routes/config.mjs'

function kvWith(record) {
  const values = new Map(record ? [['mf:connection:v1', JSON.stringify(record)]] : [])
  return {
    async get(key) { return values.get(key) ?? null },
    async put(key, value) { values.set(key, value) },
    async delete(key) { values.delete(key) },
  }
}

const connectedRecord = {
  v: 1,
  updatedAt: '2026-08-11T00:00:00.000Z',
  userEmail: 'operator@example.test',
  agents: [{
    agentId: 'agt_one',
    name: 'Secret Agent Name',
    description: '',
    rpcUrl: 'https://rpc.manyfold-secret.example/agt_one',
    tokenCt: 'manyfold-secret-ciphertext',
    tokenIv: 'iv',
    expiresAt: null,
    verified: true,
    warning: null,
    connectedAt: '2026-08-11T00:00:00.000Z',
  }],
  roles: { brief: 'agt_one', discovery: 'agt_one', composer: 'agt_one', theme: 'agt_one' },
  roleMode: 'auto',
}

const readyEnv = { TRIPS_KV: kvWith(connectedRecord) }

test('handleConfig: reports Manyfold readiness without exposing secrets', async () => {
  const res = await handleConfig(readyEnv)
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.ready, true)
  assert.deepEqual(body.services, { manyfold: true, connectors: false })
  assert.equal(body.manyfold.roles_assigned, 4)
  assert.equal(body.manyfold.needs_reconnect, false)
  // This route is unauthenticated, so it must leak neither the sealed token nor
  // the agent's name or host.
  const serialized = JSON.stringify(body)
  assert.doesNotMatch(serialized, /manyfold-secret/)
  assert.doesNotMatch(serialized, /Secret Agent Name/)
  assert.doesNotMatch(serialized, /rpc\.manyfold-secret/)
})

test('handleConfig: reports incomplete Manyfold configuration', async () => {
  const res = await handleConfig({ TRIPS_KV: kvWith(null) })
  const body = await res.json()
  assert.equal(body.ready, false)
  assert.deepEqual(body.services, { manyfold: false, connectors: false })
  assert.equal(body.manyfold.needs_reconnect, true)
  assert.ok(body.manyfold.problems.length > 0)
})

test('handleConfig: reports a partially assigned connection as not ready', async () => {
  const res = await handleConfig({
    TRIPS_KV: kvWith({
      ...connectedRecord,
      roles: { brief: 'agt_one', discovery: null, composer: 'agt_one', theme: null },
    }),
  })
  const body = await res.json()
  assert.equal(body.ready, false)
  assert.deepEqual(
    body.manyfold.problems.map(problem => problem.role).sort(),
    ['discovery', 'theme'],
  )
})
