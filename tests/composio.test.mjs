import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  composioEnabled, connectorStatus, createConnectorLink, fetchCalendarContext, fetchGmailContext, mcpSession,
} from '../pipeline/composio.mjs'

const withEnv = async (key, value, run) => {
  const previous = process.env[key]
  if (value == null) delete process.env[key]
  else process.env[key] = value
  try { await run() } finally {
    if (previous == null) delete process.env[key]
    else process.env[key] = previous
  }
}

test('composioEnabled reflects only the server API key', async () => {
  await withEnv('COMPOSIO_API_KEY', 'ck_test', async () => assert.equal(composioEnabled(), true))
  await withEnv('COMPOSIO_API_KEY', null, async () => assert.equal(composioEnabled(), false))
})

test('composioEnabled/createConnectorLink accept an explicit apiKey, ignoring process.env entirely (Worker callers have no process global)', async () => {
  await withEnv('COMPOSIO_API_KEY', null, async () => {
    assert.equal(composioEnabled('ck_explicit'), true)
    const result = await createConnectorLink({ visitorId: 'tt_visitor_1234', connector: 'gmail', apiKey: 'ck_explicit', authConfigId: 'ac_explicit', client: { connectedAccounts: { link: async () => ({ id: 'cr_1', redirectUrl: 'https://connect.example/link' }) } } })
    assert.equal(result.status, 'authorization_required')
  })
})

test('mcpSession accepts an explicit apiKey without reading COMPOSIO_API_KEY from process.env', async () => {
  await withEnv('COMPOSIO_API_KEY', null, async () => {
    const client = { tools: { execute: async (_tool, input) => ({ successful: true, data: input }) } }
    const session = await mcpSession({ userId: 'tt_visitor_1234', apiKey: 'ck_explicit', client })
    assert.deepEqual(await session.execToolkitTool('X', { a: 1 }), { userId: 'tt_visitor_1234', arguments: { a: 1 }, dangerouslySkipVersionCheck: true })
  })
})

test('missing project key returns configuration_required without selecting an account', async () => {
  await withEnv('COMPOSIO_API_KEY', null, async () => {
    const status = await connectorStatus({ visitorId: 'tt_visitor_1234', connector: 'gmail' })
    assert.equal(status.status, 'configuration_required')
    assert.deepEqual(status.accounts, [])
  })
})

test('connectorStatus scopes the connected-account lookup to one visitor and toolkit', async () => {
  let query
  const client = { connectedAccounts: { list: async (input) => { query = input; return { items: [{ id: 'ca_private', alias: 'personal', status: 'ACTIVE' }] } } } }
  const status = await connectorStatus({ visitorId: 'tt_visitor_1234', connector: 'gmail', client })
  assert.deepEqual(query.userIds, ['tt_visitor_1234'])
  assert.deepEqual(query.toolkitSlugs, ['gmail'])
  assert.equal(status.status, 'connected')
  assert.equal(status.accounts[0].id, 'ca_private')
})

test('createConnectorLink never falls back to another user and reports missing auth config', async () => {
  await withEnv('COMPOSIO_GMAIL_AUTH_CONFIG_ID', null, async () => {
    const result = await createConnectorLink({ visitorId: 'tt_visitor_1234', connector: 'gmail', client: {} })
    assert.equal(result.status, 'configuration_required')
    assert.equal(result.visitor_id, 'tt_visitor_1234')
  })
})

test('createConnectorLink uses link() with the supplied visitor id', async () => {
  await withEnv('COMPOSIO_GMAIL_AUTH_CONFIG_ID', 'ac_gmail_readonly', async () => {
    let called
    const client = { connectedAccounts: { link: async (...args) => { called = args; return { id: 'cr_1', redirectUrl: 'https://connect.example/link' } } } }
    const result = await createConnectorLink({ visitorId: 'tt_visitor_1234', connector: 'gmail', client })
    assert.deepEqual(called.slice(0, 2), ['tt_visitor_1234', 'ac_gmail_readonly'])
    assert.equal(result.status, 'authorization_required')
    assert.equal(result.authorization_url, 'https://connect.example/link')
  })
})

test('unconnected calendar returns an honest state without executing a tool', async () => {
  let executed = false
  const client = {
    connectedAccounts: { list: async () => ({ items: [] }) },
    tools: { execute: async () => { executed = true } },
  }
  const result = await fetchCalendarContext({ visitorId: 'tt_visitor_1234', startDate: '2026-07-01', endDate: '2026-07-03', client })
  assert.equal(result.status, 'not_connected')
  assert.equal(executed, false)
})

test('Gmail raw context preserves the requested trip window', async () => {
  const client = {
    connectedAccounts: { list: async () => ({ items: [{ id: 'ca_gmail', alias: null, status: 'ACTIVE' }] }) },
    tools: { execute: async (tool) => tool === 'GMAIL_FETCH_EMAILS' ? { successful: true, data: { messages: [] } } : { successful: true, data: {} } },
  }
  const result = await fetchGmailContext({ visitorId: 'tt_visitor_1234', destination: 'Kyoto', startDate: '2026-11-10', endDate: '2026-11-12', client })
  assert.equal(result.trip_window, '2026-11-10 to 2026-11-12')
  assert.equal(result.messages.length, 0)
})

test('calendar execution pins the active connected account', async () => {
  let body
  const client = {
    connectedAccounts: { list: async () => ({ items: [{ id: 'ca_calendar', alias: null, status: 'ACTIVE' }] }) },
    tools: { execute: async (_tool, input) => { body = input; return { successful: true, data: { items: [] } } } },
  }
  await fetchCalendarContext({ visitorId: 'tt_visitor_1234', startDate: '2026-07-01', endDate: '2026-07-03', client })
  assert.equal(body.userId, 'tt_visitor_1234')
  assert.equal(body.connectedAccountId, 'ca_calendar')
})

test('local CLI adapter requires an explicit user id and forwards it to direct execution', async () => {
  let body
  const client = { tools: { execute: async (_tool, input) => { body = input; return { successful: true, data: { ok: true } } } } }
  const session = await mcpSession({ userId: 'tt_visitor_1234', client })
  assert.deepEqual(await session.execToolkitTool('GMAIL_FETCH_EMAILS', { query: 'Kyoto' }), { ok: true })
  assert.equal(body.userId, 'tt_visitor_1234')
})
