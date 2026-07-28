import { test } from 'node:test'
import assert from 'node:assert/strict'
import { handleConfig } from '../../worker/routes/config.mjs'

const readyEnv = {
  MF_API_URL: 'https://api.manyfold.ai/api',
  MF_AGENT_ID: 'agt_source',
  MF_API_TOKEN: 'manyfold-secret',
  AGENT_BRIEF: 'agt_brief',
  AGENT_DISCOVERY: 'agt_discovery',
  AGENT_CONTEXT_EXTRACTOR: 'agt_context',
  AGENT_COMPOSER: 'agt_composer',
  AGENT_THEME_DESIGNER: 'agt_theme',
}

test('handleConfig: reports Manyfold readiness without exposing secrets', async () => {
  const res = await handleConfig(readyEnv)
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.ready, true)
  assert.deepEqual(body.services, { manyfold: true, connectors: true })
  assert.doesNotMatch(JSON.stringify(body), /manyfold-secret/)
})

test('handleConfig: reports incomplete Manyfold configuration', async () => {
  const res = await handleConfig({
    ...readyEnv,
    MF_API_TOKEN: '',
  })
  const body = await res.json()
  assert.equal(body.ready, false)
  assert.deepEqual(body.services, { manyfold: false, connectors: false })
})
