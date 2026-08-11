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

// The client now asks for text/event-stream. Answering with a real SSE stream
// means local development exercises the streaming and artifact-accumulation
// path rather than the plain-JSON fallback, which is where the bugs live.
const a2aStream = (res, body) => {
  const taskId = `mock-${Date.now()}`
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
  })
  const frame = result => res.write(`data: ${JSON.stringify({ jsonrpc: '2.0', id: 'rpc', result })}\r\n\r\n`)
  frame({ kind: 'status-update', taskId, status: { state: 'working' } })
  // Two chunks with append, so the accumulator is genuinely exercised.
  const text = JSON.stringify(body)
  const split = Math.ceil(text.length / 2)
  frame({ kind: 'artifact-update', taskId, artifact: { artifactId: 'answer', parts: [{ kind: 'text', text: text.slice(0, split) }] }, append: false })
  frame({ kind: 'artifact-update', taskId, artifact: { artifactId: 'answer', parts: [{ kind: 'text', text: text.slice(split) }] }, append: true })
  frame({ kind: 'status-update', taskId, status: { state: 'completed' }, final: true })
  res.end()
}

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

function datesBetween(startDate, endDate) {
  const dates = []
  const start = new Date(`${startDate}T00:00:00Z`)
  const end = new Date(`${endDate}T00:00:00Z`)
  for (let date = start; date <= end; date.setUTCDate(date.getUTCDate() + 1)) {
    dates.push(date.toISOString().slice(0, 10))
  }
  return dates
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
  const labels = ['walk', 'market stop', 'park visit', 'neighbourhood meal']
  const pois = labels.map((label, index) => ({
    title: `Mock ${base} ${label}`, base,
    kind: index === labels.length - 1 ? 'meal' : 'sight',
    duration_minutes: index === labels.length - 1 ? 90 : 120,
    best_time: index === 0 ? 'morning' : index === labels.length - 1 ? 'evening' : 'afternoon',
    notes: 'Fixture POI; local mock does not perform web search.', source_label: 'Local mock',
  }))
  const transports = brief.bases?.slice(1).map((next, index) => ({
    from: brief.bases[index].name, to: next.name, mode: 'rail', minutes: 30,
    notes: 'Fixture transfer.', source_label: 'Local mock',
  })) ?? []
  return { pois, transports, sources: [{ label: 'Local mock', url: `http://127.0.0.1:${port}/` }] }
}

function composerForBrief(brief) {
  const base = brief.bases?.[0]?.name || brief.destination
  const dates = datesBetween(brief.start_date, brief.end_date)
  const dayLabels = ['arrival walk', 'market day', 'park day', 'neighbourhood day', 'departure day']
  const days = dates.map((date, index) => {
    const label = dayLabels[index] || `day ${index + 1}`
    const itemType = index === dates.length - 1 ? 'meal' : 'sight'
    return {
      date, title: `${base} ${label}`, base,
      items: [{
        variant: 'both', type: itemType, title: `Mock ${base} ${label}`,
        start_local: index === dates.length - 1 ? '18:00' : '10:00',
        end_local: index === dates.length - 1 ? '19:30' : '12:00',
        location: base, transport_minutes: 0,
        notes: 'Fixture itinerary; local mock does not perform web search.', sources: ['Local mock'],
      }],
    }
  })
  return {
    summary: `A local mock itinerary for ${brief.destination}.`, warnings: [],
    days,
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

// One in-memory connect handshake, so local development exercises the real
// device-code flow rather than a shortcut.
const connectSessions = new Map()

export function startMockServer() {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`)

    if (req.method === 'POST' && url.pathname === '/api/connect/a2a/start') {
      const deviceCode = `mock-device-${Date.now()}`
      const userCode = 'MOCK-1234'
      connectSessions.set(deviceCode, { approved: false, userCode })
      json(res, {
        requestId: `mock-req-${Date.now()}`,
        userCode,
        authUrl: `http://127.0.0.1:${port}/consent?device=${encodeURIComponent(deviceCode)}`,
        deviceCode,
        expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
      })
      return
    }

    // Stands in for Manyfold's own consent page, including showing the
    // confirmation code the operator is supposed to compare.
    if (req.method === 'GET' && url.pathname === '/consent') {
      const deviceCode = url.searchParams.get('device') || ''
      const session = connectSessions.get(deviceCode)
      if (!session) {
        res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' })
        res.end('<p>Unknown authorization request.</p>')
        return
      }
      session.approved = true
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(`<!doctype html><meta charset="utf-8"><title>Mock Manyfold consent</title>`
        + `<body style="font:16px system-ui;padding:2rem">`
        + `<h1>Approved</h1><p>Confirmation code <strong>${session.userCode}</strong></p>`
        + `<p>Local mock. Return to Travel Ticket; it will pick this up on the next poll.</p>`)
      return
    }

    if (req.method === 'POST' && url.pathname === '/api/connect/a2a/poll') {
      let raw = ''
      for await (const chunk of req) raw += chunk
      const deviceCode = JSON.parse(raw || '{}').deviceCode
      const session = connectSessions.get(deviceCode)
      if (!session) {
        json(res, { error: { message: 'deviceCode not found' } }, 404)
        return
      }
      if (!session.approved) {
        json(res, { status: 'pending' })
        return
      }
      // Credentials are released exactly once.
      connectSessions.delete(deviceCode)
      json(res, {
        status: 'approved',
        userEmail: 'local@mock.test',
        agents: [{
          agentId: 'mock-agent',
          name: 'Local Mock Agent',
          rpcUrl: `http://127.0.0.1:${port}/a2a`,
          cardUrl: `http://127.0.0.1:${port}/card`,
          token: 'local-manyfold-token',
          expiresAt: null,
        }],
      })
      return
    }

    if (req.method === 'GET' && url.pathname === '/card') {
      json(res, { name: 'Local Mock Agent', description: 'Local Manyfold mock agent.' })
      return
    }
    if (req.method === 'POST' && url.pathname.startsWith('/api/agent-self/a2a/peers/')) {
      json(res, { token: 'local-manyfold-token', rpcUrl: `http://127.0.0.1:${port}/a2a` })
      return
    }
    if (req.method === 'POST' && url.pathname === '/a2a') {
      let body = ''
      for await (const chunk of req) body += chunk
      const rpc = JSON.parse(body)
      const prompt = rpc.params?.message?.parts?.map(part => part.text || '').join('\n') || ''
      if (rpc.method === 'tasks/cancel') {
        json(res, { result: { id: rpc.params?.id, status: { state: 'canceled' } } })
        return
      }
      if (rpc.method === 'tasks/get') {
        json(res, { result: { id: rpc.params?.id, status: { state: 'completed' }, parts: [{ text: JSON.stringify(agentReply(prompt)) }] } })
        return
      }
      const wantsStream = (req.headers.accept || '').includes('text/event-stream')
      if (wantsStream) a2aStream(res, agentReply(prompt))
      else a2a(res, agentReply(prompt))
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
