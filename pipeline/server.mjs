#!/usr/bin/env node
// Trip Ticket Local Studio — developer-only entry point for the filesystem
// pipeline. The canonical application and /settings live in Wrangler.
//   node pipeline/server.mjs [port]
// GET  /            input page (paste a one-sentence trip request)
// POST /api/plan    { sentence, mock? } → spawns the orchestrator
// GET  /api/status  live pipeline state (polled by the input page)
// GET  /trip/*      serves the generated site in dist/
// GET  /settings    redirects to the canonical Wrangler application
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const packageRoot = path.resolve(here, '..')
const distDir = path.join(packageRoot, 'dist')
const port = Number(process.argv[2] || process.env.PORT || 4747)
const workerDevOrigin = new URL(process.env.WORKER_DEV_URL || 'http://localhost:8788').origin

const TYPES = { '.html': 'text/html; charset=utf-8', '.json': 'application/json', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' }

const state = {
  phase: 'idle', // idle | running | done | error
  sentence: '',
  startedAt: null,
  finishedAt: null,
  log: [],
  agents: {},
  manifest: null,
  error: null,
}

const AGENT_LINE = /^\[orchestrator\] (.+?(?:Agent|Composer)): (completed|failed|timeout|skipped)/

function startRun(sentence, mock) {
  Object.assign(state, {
    phase: 'running', sentence, startedAt: Date.now(), finishedAt: null,
    log: [], agents: {}, manifest: null, error: null,
  })
  const args = [path.join(here, 'orchestrator.mjs')]
  if (mock) args.push('--mock')
  if (sentence) args.push(sentence)
  const child = spawn(process.execPath, args, { cwd: packageRoot })
  let stdout = ''
  let stderrTail = ''
  child.stdout.on('data', (d) => { stdout += d })
  child.stderr.on('data', (d) => {
    stderrTail = (stderrTail + d).slice(-4000)
    for (const line of String(d).split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      state.log.push(trimmed.replace(/^\[orchestrator\]\s*/, ''))
      if (state.log.length > 500) state.log.splice(0, state.log.length - 500)
      const match = trimmed.match(AGENT_LINE)
      if (match) state.agents[match[1]] = match[2]
    }
  })
  child.on('close', (code) => {
    state.finishedAt = Date.now()
    if (code === 0) {
      try { state.manifest = JSON.parse(stdout) } catch { state.manifest = null }
      state.phase = 'done'
    } else {
      state.phase = 'error'
      state.error = `orchestrator exited ${code}: ${stderrTail.split('\n').slice(-4).join(' / ')}`
    }
  })
  child.on('error', (err) => {
    state.phase = 'error'
    state.error = err.message
    state.finishedAt = Date.now()
  })
}

const tripSummary = (j) => ({
  destination: j.destination,
  days: j.days?.length ?? 0,
  trip_id: j.trip_id,
  pages: ['index.html', ...(j.days ?? []).map((d) => `day-${d.date}.html`)],
})

function currentTrip() {
  try {
    return tripSummary(JSON.parse(fs.readFileSync(path.join(packageRoot, 'data', 'final_itinerary.json'), 'utf8')))
  } catch {
    return null
  }
}

// 票夾：data/trips/*.json → 摘要列表（trip_id 內含時間戳，新的排前面）。
function allTrips() {
  const dir = path.join(packageRoot, 'data', 'trips')
  try {
    return fs.readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => {
        try {
          const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))
          return { ...tripSummary(j), dir: f.replace(/\.json$/, '') }
        } catch { return null }
      })
      .filter(Boolean)
      .sort((a, b) => String(b.trip_id).localeCompare(String(a.trip_id)))
  } catch {
    return []
  }
}

const send = (res, code, body, type = 'application/json') => {
  res.writeHead(code, { 'content-type': type })
  res.end(type === 'application/json' ? JSON.stringify(body) : body)
}

// 畸形 percent-encoding（%zz、結尾 %）會讓 decodeURIComponent 丟 URIError，
// handler 沒接住就是整個 server 陣亡——decode 失敗回 null 由呼叫端 404。
const safeDecode = (text) => { try { return decodeURIComponent(text) } catch { return null } }
// CSRF 防護：跨站的 simple POST（<form>／bodyless fetch，無 preflight）一定帶 Origin——
// 不是本機 studio 的一律 403，否則任意網頁都能替使用者啟動昂貴的 agent pipeline。
// 沒帶 Origin 的（curl、同源導航）放行。
const originOk = (req) => {
  const origin = req.headers.origin
  return !origin || origin === `http://localhost:${port}` || origin === `http://127.0.0.1:${port}`
}
// prefix-match traversal 防護：/trips/../trips-evil 會過 startsWith(base)，必須帶分隔符比對。
const insideDir = (file, base) => file === base || file.startsWith(base + path.sep)

http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${port}`)

  if (url.pathname === '/' || url.pathname === '/index.html') {
    return send(res, 200, fs.readFileSync(path.join(here, 'studio.html')), TYPES['.html'])
  }

  if (url.pathname === '/settings' || url.pathname === '/settings/') {
    res.writeHead(307, { location: `${workerDevOrigin}/settings` })
    return res.end()
  }

  if (url.pathname === '/api/status') {
    return send(res, 200, { ...state, elapsed_ms: state.startedAt ? (state.finishedAt ?? Date.now()) - state.startedAt : 0, trip: currentTrip(), trips: allTrips() })
  }

  if (url.pathname === '/api/plan' && req.method === 'POST') {
    if (!originOk(req)) return send(res, 403, { error: 'cross-origin request rejected' })
    if (state.phase === 'running') return send(res, 409, { error: 'a run is already in progress' })
    let body = ''
    let tooBig = false
    req.on('data', (d) => {
      body += d
      if (body.length > 64 * 1024 && !tooBig) { // 一句話需求用不到 64KB——超過就是異常流量
        tooBig = true
        send(res, 413, { error: 'body too large' })
        req.destroy()
      }
    })
    req.on('end', () => {
      if (tooBig) return
      try {
        const { sentence, mock } = JSON.parse(body || '{}')
        if (!sentence && !mock) return send(res, 400, { error: 'sentence is required' })
        startRun((sentence || '').trim(), Boolean(mock))
        send(res, 202, { ok: true })
      } catch (err) {
        send(res, 400, { error: err.message })
      }
    })
    return
  }

  if (url.pathname === '/trip') {
    res.writeHead(308, { location: `/trip/${url.search}` })
    return res.end()
  }
  if (url.pathname === '/trip/') {
    const file = path.join(distDir, 'index.html')
    if (!fs.existsSync(file)) return send(res, 404, '還沒有產生任何行程 — 回 <a href="/">入口</a> 出一張票。', TYPES['.html'])
    return send(res, 200, fs.readFileSync(file), TYPES['.html'])
  }
  if (url.pathname.startsWith('/trip/')) {
    const rel = safeDecode(url.pathname.slice('/trip/'.length))
    const file = rel === null ? null : path.resolve(distDir, rel)
    if (!file || !insideDir(file, distDir) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return send(res, 404, 'not found', 'text/plain')
    return send(res, 200, fs.readFileSync(file), TYPES[path.extname(file)] ?? 'application/octet-stream')
  }

  // 票夾裡的每份手冊：/trips/<dir>/ 與 /trips/<dir>/day-*.html
  if (url.pathname === '/trips' || url.pathname === '/trips/') {
    res.writeHead(302, { location: '/' })
    return res.end()
  }
  if (/^\/trips\/[^/]+$/.test(url.pathname)) {
    res.writeHead(308, { location: `${url.pathname}/${url.search}` })
    return res.end()
  }
  if (url.pathname.startsWith('/trips/')) {
    let rel = safeDecode(url.pathname.slice('/trips/'.length))
    if (rel === null) return send(res, 404, '這個網址壞掉了 — 回 <a href="/">入口</a> 從票夾重新點。', TYPES['.html'])
    if (rel.endsWith('/')) rel += 'index.html'
    if (!rel.includes('/')) rel += '/index.html'
    const base = path.join(distDir, 'trips')
    const file = path.resolve(base, rel)
    if (!insideDir(file, base) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      return send(res, 404, '這本手冊不在票夾裡了（可能被重新產出蓋掉）— 回 <a href="/">入口</a> 看現有的票。', TYPES['.html'])
    }
    return send(res, 200, fs.readFileSync(file), TYPES[path.extname(file)] ?? 'application/octet-stream')
  }

  send(res, 404, 'not found', 'text/plain')
  // 只綁 loopback：Studio 會啟動本機 agent pipeline，不應暴露到區網。
}).listen(port, '127.0.0.1', () => {
  console.log(`Trip Ticket Local Studio → http://localhost:${port}`)
})
