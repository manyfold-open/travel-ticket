import { test } from 'node:test'
import assert from 'node:assert/strict'
import { handleConfig } from '../../worker/routes/config.mjs'

const readyEnv = {
  TURNSTILE_SITE_KEY: '0x123',
  TURNSTILE_SECRET_KEY: 'turnstile-secret',
  MF_API_URL: 'https://api.manyfold.ai/api',
  MF_AGENT_ID: 'agt_source',
  MF_API_TOKEN: 'manyfold-secret',
  AGENT_BRIEF: 'agt_brief',
  AGENT_DISCOVERY: 'agt_discovery',
  AGENT_CONTEXT_EXTRACTOR: 'agt_context',
  AGENT_COMPOSER: 'agt_composer',
  AGENT_THEME_DESIGNER: 'agt_theme',
}

test('handleConfig: returns public Turnstile configuration and readiness without secrets', async () => {
  const res = await handleConfig(readyEnv)
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.turnstile_site_key, '0x123')
  assert.equal(body.ready, true)
  assert.deepEqual(body.services, { manyfold: true, turnstile: true, connectors: false })
  assert.doesNotMatch(JSON.stringify(body), /manyfold-secret|turnstile-secret/)
})

test('handleConfig: reports incomplete Manyfold and Turnstile configuration', async () => {
  const res = await handleConfig({
    ...readyEnv,
    TURNSTILE_SECRET_KEY: '',
    MF_API_TOKEN: '',
  })
  const body = await res.json()
  assert.equal(body.turnstile_site_key, '0x123')
  assert.equal(body.ready, false)
  assert.deepEqual(body.services, { manyfold: false, turnstile: false, connectors: false })
})
