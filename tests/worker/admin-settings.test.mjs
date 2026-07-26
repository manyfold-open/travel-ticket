import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  handleAdminSettings,
  resolveRuntimeEnv,
} from '../../worker/admin/settings.mjs'

class MockKV {
  constructor() { this.store = new Map() }
  async put(key, value) { this.store.set(key, value) }
  async get(key) { return this.store.get(key) ?? null }
}

const makeEnv = () => ({
  ADMIN_SETTINGS_PASSWORD: 'correct horse battery staple',
  TRIPS_KV: new MockKV(),
  ACCESS_PASSCODE: '246810',
  MF_API_URL: 'https://api.manyfold.ai/api',
  MF_AGENT_ID: 'agt_source',
  MF_API_TOKEN: 'token-from-environment',
  AGENT_BRIEF: 'agt_brief',
  AGENT_DISCOVERY: 'agt_discovery',
  AGENT_CONTEXT_EXTRACTOR: 'agt_context',
  AGENT_COMPOSER: 'agt_composer',
  AGENT_THEME_DESIGNER: 'agt_theme',
})

async function login(env, password = env.ADMIN_SETTINGS_PASSWORD) {
  const response = await handleAdminSettings(new Request('https://example.com/api/admin/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'https://example.com' },
    body: JSON.stringify({ password }),
  }), env)
  return { response, cookie: response.headers.get('set-cookie')?.split(';')[0] }
}

test('admin settings: refuses access until ADMIN_SETTINGS_PASSWORD is configured', async () => {
  const env = makeEnv()
  delete env.ADMIN_SETTINGS_PASSWORD
  const response = await handleAdminSettings(new Request('https://example.com/api/admin/settings'), env)
  assert.equal(response.status, 503)
})

test('admin settings: rejects an incorrect password without issuing a session', async () => {
  const { response, cookie } = await login(makeEnv(), 'incorrect')
  assert.equal(response.status, 401)
  assert.equal(cookie, undefined)
})

test('admin settings: login issues an HttpOnly, Secure, same-site session', async () => {
  const { response, cookie } = await login(makeEnv())
  assert.equal(response.status, 200)
  assert.match(response.headers.get('set-cookie'), /HttpOnly/)
  assert.match(response.headers.get('set-cookie'), /SameSite=Strict/)
  assert.match(response.headers.get('set-cookie'), /Secure/)
  assert.match(cookie, /^travel_ticket_admin=/)
})

test('admin settings: DELETE session clears the login cookie', async () => {
  const env = makeEnv()
  const { cookie } = await login(env)
  const response = await handleAdminSettings(new Request('https://example.com/api/admin/session', {
    method: 'DELETE',
    headers: { cookie, origin: 'https://example.com' },
  }), env)
  assert.equal(response.status, 200)
  assert.match(response.headers.get('set-cookie'), /Max-Age=0/)
})

test('admin settings: GET never returns a configured secret value', async () => {
  const env = makeEnv()
  const { cookie } = await login(env)
  const response = await handleAdminSettings(new Request('https://example.com/api/admin/settings', {
    headers: { cookie },
  }), env)
  assert.equal(response.status, 200)
  const body = await response.json()
  const passcode = body.fields.find((field) => field.key === 'ACCESS_PASSCODE')
  const token = body.fields.find((field) => field.key === 'MF_API_TOKEN')
  assert.equal(passcode.configured, true)
  assert.equal(passcode.source, 'environment')
  assert.equal(passcode.value, '')
  assert.equal(token.configured, true)
  assert.equal(token.source, 'environment')
  assert.equal(token.value, '')
  assert.doesNotMatch(JSON.stringify(body), /token-from-environment/)
})

test('admin settings: saves encrypted overrides and resolves them for runtime calls', async () => {
  const env = makeEnv()
  const { cookie } = await login(env)
  const response = await handleAdminSettings(new Request('https://example.com/api/admin/settings', {
    method: 'PUT',
    headers: { 'content-type': 'application/json', cookie, origin: 'https://example.com' },
    body: JSON.stringify({
      values: {
        ACCESS_PASSCODE: '654321',
        MF_API_URL: 'https://gateway.example/api',
        MF_API_TOKEN: 'token-from-settings',
      },
    }),
  }), env)
  assert.equal(response.status, 200)

  const stored = [...env.TRIPS_KV.store.values()][0]
  assert.doesNotMatch(stored, /token-from-settings/)
  assert.doesNotMatch(stored, /gateway\.example/)

  const runtime = await resolveRuntimeEnv(env)
  assert.equal(runtime.MF_API_URL, 'https://gateway.example/api')
  assert.equal(runtime.MF_API_TOKEN, 'token-from-settings')
  assert.equal(runtime.ACCESS_PASSCODE, '654321')
  assert.equal(runtime.AGENT_BRIEF, 'agt_brief')
})

test('admin settings: requires an exact 6-digit application access code', async () => {
  const env = makeEnv()
  const { cookie } = await login(env)
  const response = await handleAdminSettings(new Request('https://example.com/api/admin/settings', {
    method: 'PUT',
    headers: { 'content-type': 'application/json', cookie, origin: 'https://example.com' },
    body: JSON.stringify({ values: { ACCESS_PASSCODE: '123' } }),
  }), env)
  assert.equal(response.status, 400)
  const body = await response.json()
  assert.match(body.details.join(' '), /exactly 6 digits/)
})

test('admin settings: ignores unknown runtime fields', async () => {
  const env = makeEnv()
  const { cookie } = await login(env)
  const response = await handleAdminSettings(new Request('https://example.com/api/admin/settings', {
    method: 'PUT',
    headers: { 'content-type': 'application/json', cookie, origin: 'https://example.com' },
    body: JSON.stringify({
      values: {
        UNSUPPORTED_FEATURE_KEY: 'ignored-value',
      },
    }),
  }), env)
  assert.equal(response.status, 200)

  const runtime = await resolveRuntimeEnv(env)
  assert.equal(runtime.UNSUPPORTED_FEATURE_KEY, undefined)
})

test('admin settings: rejects cross-site writes', async () => {
  const env = makeEnv()
  const { cookie } = await login(env)
  const response = await handleAdminSettings(new Request('https://example.com/api/admin/settings', {
    method: 'PUT',
    headers: { 'content-type': 'application/json', cookie, origin: 'https://attacker.example' },
    body: JSON.stringify({ values: {} }),
  }), env)
  assert.equal(response.status, 403)
  assert.equal(env.TRIPS_KV.store.size, 0)
})
