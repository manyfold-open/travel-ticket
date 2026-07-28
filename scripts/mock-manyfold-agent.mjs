#!/usr/bin/env node
// Local-only Manyfold A2A + Connector simulator. It lets the Worker flow be
// tested without Anthropic, Composio, OAuth credentials, or a network account.
import http from 'node:http'
import { URL } from 'node:url'

const port = Number(process.env.MOCK_MANYFOLD_PORT || 8789)
const providers = ['gmail', 'calendar', 'notion']

const json = (res, body, status = 200) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

const a2a = (res, body) => json(res, { result: { parts: [{ text: JSON.stringify(body) }] } })

function connectorResponse(prompt) {
  const result = payload()
  return result
}

function payload(overrides = {}) {
  return {
    status: 'ok', message: 'Local Manyfold mock response.',
    providers: Object.fromEntries(providers.map(provider => [provider, {
      status: 'not_connected', message: 'Configure this provider in Manyfold.', authorization_url: '',
      ...(overrides[provider] || {}),
    }])),
    bookings: [], calendar_events: [], travel_notes: [],
  }
}

function brief() {
  return {
    destination: 'Japan: Kyoto & Osaka', destination_timezone: 'Asia/Tokyo', home_city: 'Taipei', home_timezone: 'Asia/Taipei',
    start_date: '2027-09-10', end_date: '2027-09-13', travellers: 2, pace: 'relaxed', no_car: true,
    bases: [{ name: 'Kyoto', nights: 2 }, { name: 'Osaka', nights: 1 }], interests: ['food', 'temples'], language: 'en-GB',
    notes: 'Local Manyfold mock brief.',
  }
}

function discovery() {
  return {
    pois: [{ title: 'Mock shrine walk', base: 'Kyoto', kind: 'sight', duration_minutes: 90, best_time: 'morning', notes: 'Fixture POI.', source_label: 'Local mock' }],
    transports: [{ from: 'Kyoto', to: 'Osaka', mode: 'JR', minutes: 30, notes: 'Fixture transfer.', source_label: 'Local mock' }],
    sources: [{ label: 'Local mock', url: 'http://127.0.0.1:8789/' }],
  }
}

function composer() {
  return {
    summary: 'A local mock itinerary with Manyfold connector context.', warnings: [],
    days: [{ date: '2027-09-10', title: 'Kyoto arrival', base: 'Kyoto', items: [{ variant: 'both', type: 'sight', title: 'Mock shrine walk', start_local: '10:00', end_local: '11:30', location: 'Kyoto', transport_minutes: 0, notes: 'Fixture itinerary.', sources: ['Local mock'] }] }],
    alternatives: { relaxed: { notes: 'Keep the morning light.' }, full: { notes: 'Add one local market.' } },
    actions_suggested: [], cover: { title_top: 'Kyoto', title_accent: 'by Rail', eyebrow: 'Local Manyfold test' },
  }
}

function theme() {
  return { name: 'Local mock', tokens: { rail: '#9c322b', 'rail-deep': '#9c322b' }, motifs: { eyebrow: 'Local mock' }, rationale: 'Fixture theme.' }
}

function agentReply(prompt) {
  if (prompt.includes('Operation:')) return connectorResponse(prompt)
  if (prompt.includes('Trip Brief Agent')) return brief()
  if (prompt.includes('Local Discovery Agent')) return discovery()
  if (prompt.includes('Itinerary Composer Agent')) return composer()
  if (prompt.includes('theme generator')) return theme()
  return {}
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`)
  if (req.method === 'POST' && url.pathname.startsWith('/api/agent-self/a2a/peers/')) {
    json(res, { token: 'local-manyfold-token', rpcUrl: `http://127.0.0.1:${port}/a2a` })
    return
  }
  if (req.method === 'POST' && url.pathname === '/a2a') {
    let body = ''
    for await (const chunk of req) body += chunk
    const prompt = JSON.parse(body).params?.message?.parts?.map(part => part.text || '').join('\n') || ''
    a2a(res, agentReply(prompt))
    return
  }
  json(res, { ok: true, service: 'local-manyfold-mock' })
})

server.listen(port, '127.0.0.1', () => {
  console.log(`[mock-manyfold] A2A endpoint: http://127.0.0.1:${port}/a2a`)
})

function shutdown() { server.close(() => process.exit(0)) }
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
