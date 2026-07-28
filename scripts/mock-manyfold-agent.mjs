#!/usr/bin/env node
// Local-only Manyfold A2A + Connector simulator. It lets the Worker flow be
// tested without Anthropic, Composio, OAuth credentials, or a network account.
import http from 'node:http'
import { URL, pathToFileURL } from 'node:url'

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

const DEFAULT_START_DATE = '2027-09-10'

function extractJsonObject(prompt, label) {
  const labelStart = prompt.indexOf(`${label}:`)
  if (labelStart === -1) return null
  const objectStart = prompt.indexOf('{', labelStart)
  if (objectStart === -1) return null
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = objectStart; i < prompt.length; i++) {
    const char = prompt[i]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    else if (char === '{') depth++
    else if (char === '}' && --depth === 0) return JSON.parse(prompt.slice(objectStart, i + 1))
  }
  return null
}

export function extractDestination(sentence) {
  const match = String(sentence).match(/\b(?:in|to|visit|around)\s+(.+?)(?:\s+(?:for|from|with)\b|[.!?]|$)/i)
  return (match?.[1] || 'Mock destination').trim()
}

function addDays(isoDate, days) {
  const date = new Date(`${isoDate}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

function destinationProfile(destination, sentence) {
  const normalized = destination.toLowerCase()
  if (normalized === 'kyoto' || normalized === 'osaka') {
    return {
      destination: 'Japan: Kyoto & Osaka', destination_timezone: 'Asia/Tokyo',
      bases: [{ name: 'Kyoto', nights: 2 }, { name: 'Osaka', nights: 1 }],
      interests: ['food', 'temples'],
    }
  }
  const duration = Number(String(sentence).match(/\b(\d+)\s+days?\b/i)?.[1] || 4)
  const timezone = normalized === 'new york' ? 'America/New_York' : 'UTC'
  return {
    destination, destination_timezone: timezone,
    bases: [{ name: destination, nights: Math.max(duration - 1, 1) }], interests: ['food', 'sights'],
  }
}

export function briefForRequest(sentence) {
  const destination = extractDestination(sentence)
  const profile = destinationProfile(destination, sentence)
  const duration = Number(String(sentence).match(/\b(\d+)\s+days?\b/i)?.[1] || 4)
  return {
    ...profile, home_city: 'Taipei', home_timezone: 'Asia/Taipei',
    start_date: DEFAULT_START_DATE, end_date: addDays(DEFAULT_START_DATE, duration - 1),
    travellers: 2, pace: 'relaxed', no_car: true, language: 'en-GB',
    notes: 'Local Manyfold mock brief.',
  }
}

function discoveryForBrief(brief) {
  const base = brief.bases?.[0]?.name || brief.destination
  const pois = [{ title: `Mock ${base} walk`, base, kind: 'sight', duration_minutes: 90, best_time: 'morning', notes: 'Fixture POI.', source_label: 'Local mock' }]
  const transports = brief.bases?.slice(1).map((next, index) => ({
    from: brief.bases[index].name, to: next.name, mode: 'rail', minutes: 30,
    notes: 'Fixture transfer.', source_label: 'Local mock',
  })) ?? []
  return { pois, transports, sources: [{ label: 'Local mock', url: `http://127.0.0.1:${port}/` }] }
}

function composerForBrief(brief) {
  const base = brief.bases?.[0]?.name || brief.destination
  return {
    summary: `A local mock itinerary for ${brief.destination}.`, warnings: [],
    days: [{ date: brief.start_date, title: `${base} arrival`, base, items: [{ variant: 'both', type: 'sight', title: `Mock ${base} walk`, start_local: '10:00', end_local: '11:30', location: base, transport_minutes: 0, notes: 'Fixture itinerary.', sources: ['Local mock'] }] }],
    alternatives: { relaxed: { notes: 'Keep the morning light.' }, full: { notes: 'Add one local market.' } },
    actions_suggested: [], cover: { title_top: brief.destination.split(':')[0].trim(), title_accent: 'by Rail', eyebrow: 'Local Manyfold test' },
  }
}

function theme() {
  return { name: 'Local mock', tokens: { rail: '#9c322b', 'rail-deep': '#9c322b' }, motifs: { eyebrow: 'Local mock' }, rationale: 'Fixture theme.' }
}

export function agentReply(prompt) {
  if (prompt.includes('Operation:')) return connectorResponse(prompt)
  if (prompt.includes('Trip Brief Agent')) return briefForRequest(prompt.match(/Trip request:\s*(.+?)(?:\n|$)/i)?.[1] || '')
  if (prompt.includes('Local Discovery Agent')) return discoveryForBrief(extractJsonObject(prompt, 'Trip brief') || {})
  if (prompt.includes('Itinerary Composer Agent')) return composerForBrief(extractJsonObject(prompt, 'Trip brief') || {})
  if (prompt.includes('theme generator')) return theme()
  return {}
}

export function startMockServer() {
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
  return server
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) startMockServer()
