import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ITINERARY = {
  destination: 'Japan: Kyoto', destination_timezone: 'Asia/Tokyo', home_timezone: 'Europe/London',
  summary: 'Test itinerary', warnings: [], sources: [], actions_suggested: [], alternatives: {},
  days: [{ date: '2026-11-10', title: 'Kyoto arrival', base: 'Kyoto', items: [{
    variant: 'both', type: 'sight', title: 'Gion walk', start_utc: '2026-11-10T08:00:00Z', end_utc: '2026-11-10T09:00:00Z', timezone: 'Asia/Tokyo', location: 'Gion', notes: '', sources: [],
  }] }],
}

function rpcSession() {
  const child = spawn('node', [path.join(ROOT, 'pipeline/mcp-server.mjs')], { env: { ...process.env } })
  let buf = ''
  const pending = new Map()
  child.stdout.on('data', (data) => {
    buf += data
    let index
    while ((index = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, index); buf = buf.slice(index + 1)
      if (!line.trim()) continue
      const message = JSON.parse(line)
      if (message.id != null && pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id) }
    }
  })
  const send = (message) => child.stdin.write(JSON.stringify(message) + '\n')
  const request = (message) => new Promise((resolve) => { pending.set(message.id, resolve); send(message) })
  return { child, send, request, kill: () => child.kill() }
}

async function initialized() {
  const session = rpcSession()
  await session.request({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 't', version: '0' } } })
  session.send({ jsonrpc: '2.0', method: 'notifications/initialized' })
  return session
}

test('initialize → tools/list exposes only mechanical MCP tools', async () => {
  const session = await initialized()
  try {
    const list = await session.request({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
    const names = list.result.tools.map((tool) => tool.name)
    for (const name of ['get_itinerary_schema', 'fetch_travel_context', 'render_ticket']) assert.ok(names.includes(name))
    for (const name of ['create_connector_link', 'fetch_gmail_context', 'fetch_calendar_context', 'fetch_notion_context']) assert.ok(!names.includes(name))
    assert.ok(!names.includes('plan_trip'))
  } finally { session.kill() }
})

test('schema and timezone tools do not need a connector service', async () => {
  const session = await initialized()
  try {
    const schema = await session.request({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'get_itinerary_schema', arguments: {} } })
    const schemaOut = JSON.parse(schema.result.content[0].text)
    assert.ok(schemaOut.schema.properties.days)
    const travel = await session.request({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'fetch_travel_context', arguments: { destination: 'Kyoto', destination_timezone: 'Asia/Tokyo', home_timezone: 'Europe/London', start_date: '2026-11-10', end_date: '2026-11-12' } } })
    const travelOut = JSON.parse(travel.result.content[0].text)
    assert.equal(travelOut.timezone.destination_timezone, 'Asia/Tokyo')
  } finally { session.kill() }
})

test('render_ticket accepts a client-composed itinerary without a prior plan', async () => {
  const session = await initialized()
  try {
    const result = await session.request({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'render_ticket', arguments: { itinerary: ITINERARY, design: 'japan' } } })
    const output = JSON.parse(result.result.content[0].text)
    assert.equal(output.theme_used.name, 'japan')
    assert.ok(output.entry.endsWith('index.html'))
    assert.match(output.poster_status, /skipped/)
  } finally { session.kill() }
})

test('tools/call with unknown tool name → protocol error -32602', async () => {
  const session = await initialized()
  try {
    const result = await session.request({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'bogus_tool', arguments: {} } })
    assert.equal(result.error.code, -32602)
  } finally { session.kill() }
})

test('render_ticket rejects malformed client itineraries as a tool error', async () => {
  const session = await initialized()
  try {
    const result = await session.request({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'render_ticket', arguments: { itinerary: { destination: 'Kyoto' } } } })
    assert.equal(result.result.isError, true)
    assert.match(result.result.content[0].text, /destination_timezone/)
  } finally { session.kill() }
})
