import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  guardTravelTicketAccess,
  handleTravelTicketAccess,
} from '../../worker/access-control.mjs'

class MockKV {
  constructor() { this.store = new Map() }
  async get(key) { return this.store.get(key) ?? null }
  async put(key, value) { this.store.set(key, value) }
  async delete(key) { this.store.delete(key) }
}

const makeEnv = (passcode = '246810') => ({
  TRIPS_KV: new MockKV(),
  ADMIN_SETTINGS_PASSWORD: 'test-admin-signing-secret-with-enough-entropy',
  ACCESS_PASSCODE: passcode,
})

const request = (path, init = {}) => new Request(`https://example.com${path}`, init)

function responseCookie(response) {
  return response.headers.get('set-cookie')?.split(';')[0]
}

test('access control: redirects documents and rejects APIs before login', async () => {
  const env = makeEnv()
  const documentGuard = await guardTravelTicketAccess(request('/?trip=abc'), env)
  assert.equal(documentGuard.response.status, 302)
  assert.equal(
    new URL(documentGuard.response.headers.get('location')).searchParams.get('next'),
    '/?trip=abc',
  )

  const apiGuard = await guardTravelTicketAccess(request('/api/config'), env)
  assert.equal(apiGuard.response.status, 401)
  assert.equal((await apiGuard.response.json()).code, 'ACCESS_REQUIRED')
})

test('access control: issues a signed cookie and invalidates it after code rotation', async () => {
  const env = makeEnv()
  const denied = await handleTravelTicketAccess(request('/api/access/login', {
    method: 'POST',
    body: JSON.stringify({ passcode: '111111' }),
  }), env)
  assert.equal(denied.status, 401)

  const login = await handleTravelTicketAccess(request('/api/access/login', {
    method: 'POST',
    body: JSON.stringify({ passcode: '246810' }),
  }), env)
  assert.equal(login.status, 200)
  const cookie = responseCookie(login)
  assert.match(cookie, /^travel_ticket_access=/)
  assert.match(login.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/)
  assert.match(login.headers.get('set-cookie'), /Secure/)

  const status = await handleTravelTicketAccess(request('/api/access/status', {
    headers: { cookie },
  }), env)
  assert.deepEqual(await status.json(), {
    configured: true,
    ready: true,
    authenticated: true,
  })
  const allowed = await guardTravelTicketAccess(request('/', { headers: { cookie } }), env)
  assert.equal(allowed.response, undefined)

  env.ACCESS_PASSCODE = '135790'
  const rotated = await handleTravelTicketAccess(request('/api/access/status', {
    headers: { cookie },
  }), env)
  assert.equal((await rotated.json()).authenticated, false)
})

test('access control: reports an unconfigured gate without exposing APIs', async () => {
  const env = makeEnv('')
  const status = await handleTravelTicketAccess(request('/api/access/status'), env)
  assert.deepEqual(await status.json(), {
    configured: false,
    ready: false,
    authenticated: false,
  })
  const guarded = await guardTravelTicketAccess(request('/api/config'), env)
  assert.equal(guarded.response.status, 503)
  assert.equal((await guarded.response.json()).code, 'ACCESS_NOT_CONFIGURED')
})

test('access control: rate-limits repeated incorrect codes by client address', async () => {
  const env = makeEnv()
  const headers = { 'cf-connecting-ip': '203.0.113.15' }
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const denied = await handleTravelTicketAccess(request('/api/access/login', {
      method: 'POST',
      headers,
      body: JSON.stringify({ passcode: '000000' }),
    }), env)
    assert.equal(denied.status, 401)
  }
  const limited = await handleTravelTicketAccess(request('/api/access/login', {
    method: 'POST',
    headers,
    body: JSON.stringify({ passcode: '246810' }),
  }), env)
  assert.equal(limited.status, 429)
  assert.ok(Number(limited.headers.get('retry-after')) > 0)
})

test('access control: rejects cross-site login and unsupported methods', async () => {
  const env = makeEnv()
  const crossSite = await handleTravelTicketAccess(request('/api/access/login', {
    method: 'POST',
    headers: {
      origin: 'https://attacker.example',
      'sec-fetch-site': 'cross-site',
    },
    body: JSON.stringify({ passcode: '246810' }),
  }), env)
  assert.equal(crossSite.status, 403)

  const wrongMethod = await handleTravelTicketAccess(request('/api/access/status', {
    method: 'POST',
  }), env)
  assert.equal(wrongMethod.status, 405)
})

test('access control: logout clears the access cookie', async () => {
  const response = await handleTravelTicketAccess(request('/api/access/logout', {
    method: 'POST',
  }), makeEnv())
  assert.equal(response.status, 200)
  assert.match(response.headers.get('set-cookie'), /^travel_ticket_access=;/)
  assert.match(response.headers.get('set-cookie'), /Max-Age=0/)
})
