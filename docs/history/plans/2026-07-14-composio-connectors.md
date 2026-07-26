# Composio Connectors Implementation Plan

> Archived execution plan. The checkboxes below are historical and are not the
> current project backlog.
>
> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire Gmail / Google Calendar / Notion as read-only context sources into the trip-ticket pipeline via Composio's MCP server, with honest per-agent degradation.

**Architecture:** New zero-dep `pipeline/composio.mjs` is the ONLY file speaking MCP (JSON-RPC over fetch, SSE responses). Three agents in `pipeline/agents.mjs` call it and keep the existing return contract `{status, confidence, notes, ...}`. Orchestrator wires the new Notion agent in parallel with the others. No preflight connection check — run the tool, treat auth/no-connection errors as skip.

**Tech Stack:** Node 22 (`node:test` runner, global `fetch`, `AbortSignal.timeout`), existing `@anthropic-ai/sdk` backend helpers in agents.mjs.

**Spec:** `docs/history/specs/2026-07-14-composio-connectors-design.md`

## Global Constraints

- Zero new dependencies. No `@modelcontextprotocol/sdk`, no `@composio` SDK.
- Endpoint `https://connect.composio.dev/mcp`; auth header `x-consumer-api-key` (NOT `x-api-key`, NOT `Authorization: Bearer`).
- Handshake: POST `initialize` → read `mcp-session-id` response header → POST `notifications/initialized` → `tools/call`. Responses are SSE (`data: {...}` lines).
- NEVER call `COMPOSIO_MANAGE_CONNECTIONS` (side-effect: spawns pending connections).
- No `COMPOSIO_API_KEY` in env → every connector agent returns `status:'skipped'` (zero regression).
- All connectors read-only. Extraction rule: only extract fields truly present in the source; no invention; empty array when nothing found.
- Per-call timeout 20s.
- Verified tool arg shapes (2026-07-14 via GET_TOOL_SCHEMAS):
  - `COMPOSIO_MULTI_EXECUTE_TOOL` args: `{ tools: [{ tool_slug, arguments, account? }], thought?, current_step? }`
  - `GMAIL_FETCH_EMAILS` args: `query, max_results (default 1!), verbose, include_payload, page_token, user_id='me'`
  - `GOOGLECALENDAR_EVENTS_LIST` args: `calendarId='primary', timeMin, timeMax, singleEvents, orderBy, maxResults`
  - `NOTION_SEARCH_NOTION_PAGE` args: `query, page_size=25, filter_value='page'`
- Repo has no git yet — Task 1 initializes it. Commit after every task.

---

### Task 1: Git init + test scaffolding

**Files:**
- Create: `.gitignore`
- Modify: `package.json` (add `test` script)

**Interfaces:**
- Produces: `npm test` runs `node --test tests/`; git repo with initial commit.

- [ ] **Step 1: git init + .gitignore**

```bash
cd "/Users/zack/Desktop/travel ticket/switzerland-itinerary-package"
git init -b main
```

`.gitignore`:
```
node_modules/
.trip_work/
dist/
data/posters/
.env
```

- [ ] **Step 2: add test script to package.json** — in `"scripts"` add:

```json
"test": "node --test tests/"
```

- [ ] **Step 3: smoke the runner**

```bash
mkdir -p tests && node --test tests/ ; echo "exit=$?"
```
Expected: exit=0 (no tests found is fine on Node 22).

- [ ] **Step 4: initial commit**

```bash
git add -A && git commit -m "chore: git init, test runner scaffolding"
```

---

### Task 2: `pipeline/composio.mjs` — zero-dep MCP client

**Files:**
- Create: `pipeline/composio.mjs`
- Test: `tests/composio.test.mjs`

**Interfaces:**
- Produces:
  - `composioEnabled(): boolean`
  - `parseSse(text: string): object` (throws if no `data:` line)
  - `mcpSession({timeoutMs?, fetchImpl?}): Promise<{ callTool, execToolkitTool }>`
  - `callTool(name, args): Promise<any>` — unwraps `result.content[0].text` JSON; throws on `successful === false`
  - `execToolkitTool(slug, args, {account?}): Promise<any>` — runs toolkit tool via `COMPOSIO_MULTI_EXECUTE_TOOL`, returns its `data`
- Consumes: nothing (leaf module). `fetchImpl` param exists ONLY for tests.

- [ ] **Step 1: Write failing tests** — `tests/composio.test.mjs`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseSse, mcpSession, composioEnabled } from '../pipeline/composio.mjs'

const sse = (obj) => `event: message\ndata: ${JSON.stringify(obj)}\n\n`
const okText = (inner) => sse({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: JSON.stringify(inner) }] } })

// fake fetch: routes by body.method
const fakeFetch = (routes) => async (url, { body }) => {
  const req = JSON.parse(body)
  const route = routes[req.method] ?? (() => { throw new Error(`no route ${req.method}`) })
  return route(req)
}
const res = (text, { status = 200, headers = {} } = {}) => ({
  ok: status < 400, status,
  headers: { get: (k) => headers[k.toLowerCase()] ?? null },
  text: async () => text,
})

test('parseSse extracts last data line', () => {
  assert.deepEqual(parseSse('event: message\ndata: {"a":1}\n'), { a: 1 })
  assert.throws(() => parseSse('no sse here'))
})

test('composioEnabled reflects env', () => {
  const prev = process.env.COMPOSIO_API_KEY
  process.env.COMPOSIO_API_KEY = 'ck_test'
  assert.equal(composioEnabled(), true)
  delete process.env.COMPOSIO_API_KEY
  assert.equal(composioEnabled(), false)
  if (prev) process.env.COMPOSIO_API_KEY = prev
})

test('mcpSession handshake + callTool unwrap', async () => {
  process.env.COMPOSIO_API_KEY = 'ck_test'
  const fetchImpl = fakeFetch({
    initialize: () => res(okText({}), { headers: { 'mcp-session-id': 'sid-1' } }),
    'notifications/initialized': () => res(''),
    'tools/call': () => res(okText({ successful: true, data: { hello: 'world' } })),
  })
  const s = await mcpSession({ fetchImpl })
  assert.deepEqual(await s.callTool('X', {}), { hello: 'world' })
})

test('callTool throws when tool reports failure', async () => {
  process.env.COMPOSIO_API_KEY = 'ck_test'
  const fetchImpl = fakeFetch({
    initialize: () => res(okText({}), { headers: { 'mcp-session-id': 'sid-1' } }),
    'notifications/initialized': () => res(''),
    'tools/call': () => res(okText({ successful: false, error: 'no active connection' })),
  })
  const s = await mcpSession({ fetchImpl })
  await assert.rejects(() => s.callTool('X', {}), /no active connection/)
})

test('mcpSession surfaces 401 with stale-key hint', async () => {
  process.env.COMPOSIO_API_KEY = 'ck_test'
  const fetchImpl = fakeFetch({ initialize: () => res('{"error":"auth"}', { status: 401 }) })
  await assert.rejects(() => mcpSession({ fetchImpl }), /stale|dashboard/i)
})

test('execToolkitTool unwraps MULTI_EXECUTE result item', async () => {
  process.env.COMPOSIO_API_KEY = 'ck_test'
  let captured
  const fetchImpl = fakeFetch({
    initialize: () => res(okText({}), { headers: { 'mcp-session-id': 'sid-1' } }),
    'notifications/initialized': () => res(''),
    'tools/call': (req) => {
      captured = req.params
      return res(okText({ successful: true, data: { results: [{ tool_slug: 'GMAIL_FETCH_EMAILS', successful: true, data: { messages: [] } }] } }))
    },
  })
  const s = await mcpSession({ fetchImpl })
  const out = await s.execToolkitTool('GMAIL_FETCH_EMAILS', { query: 'x' })
  assert.equal(captured.name, 'COMPOSIO_MULTI_EXECUTE_TOOL')
  assert.equal(captured.arguments.tools[0].tool_slug, 'GMAIL_FETCH_EMAILS')
  assert.deepEqual(out, { messages: [] })
})
```

- [ ] **Step 2: Run to verify fail**

Run: `npm test`
Expected: FAIL (cannot find `../pipeline/composio.mjs`).

- [ ] **Step 3: Implement `pipeline/composio.mjs`**

```js
// Zero-dep client for Composio's dynamic-tools MCP server. The ONLY file in the
// pipeline that speaks the MCP protocol. Never calls COMPOSIO_MANAGE_CONNECTIONS
// (it side-effect-spawns pending connections) — connection problems surface as
// tool errors and the caller degrades to skip.
const MCP_URL = 'https://connect.composio.dev/mcp'
const DEFAULT_TIMEOUT_MS = 20_000

export const composioEnabled = () => Boolean(process.env.COMPOSIO_API_KEY)

export const parseSse = (text) => {
  const lines = String(text).split('\n').filter((l) => l.startsWith('data: '))
  if (!lines.length) throw new Error('no SSE data line in MCP response')
  return JSON.parse(lines.at(-1).slice(6))
}

let idCounter = 1

const post = (body, { key, sessionId, timeoutMs, fetchImpl }) => fetchImpl(MCP_URL, {
  method: 'POST',
  headers: {
    'x-consumer-api-key': key,
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
  },
  body: JSON.stringify(body),
  signal: AbortSignal.timeout(timeoutMs),
})

export async function mcpSession({ timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl = fetch } = {}) {
  const key = process.env.COMPOSIO_API_KEY
  if (!key) throw new Error('COMPOSIO_API_KEY not set')
  const opts = { key, timeoutMs, fetchImpl }
  const initRes = await post({
    jsonrpc: '2.0', id: idCounter++, method: 'initialize',
    params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'trip-ticket-pipeline', version: '0.1.0' } },
  }, opts)
  if (!initRes.ok) {
    throw new Error(`MCP initialize failed: HTTP ${initRes.status}${initRes.status === 401
      ? ' — COMPOSIO_API_KEY looks stale; the dashboard is the source of truth, copy the current key from it'
      : ''}`)
  }
  const sessionId = initRes.headers.get('mcp-session-id')
  if (!sessionId) throw new Error('MCP initialize returned no mcp-session-id header')
  await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, { ...opts, sessionId })

  const callTool = async (name, args) => {
    const res = await post({
      jsonrpc: '2.0', id: idCounter++, method: 'tools/call',
      params: { name, arguments: args },
    }, { ...opts, sessionId })
    if (!res.ok) throw new Error(`MCP tools/call ${name}: HTTP ${res.status}`)
    const rpc = parseSse(await res.text())
    if (rpc.error) throw new Error(`MCP tools/call ${name}: ${rpc.error.message}`)
    const text = rpc.result?.content?.[0]?.text
    if (text == null) throw new Error(`MCP tools/call ${name}: empty content`)
    const inner = JSON.parse(text)
    if (inner.successful === false) throw new Error(`${name}: ${inner.error || 'tool reported failure'}`)
    return inner.data ?? inner
  }

  const execToolkitTool = async (slug, args, { account } = {}) => {
    const data = await callTool('COMPOSIO_MULTI_EXECUTE_TOOL', {
      tools: [{ tool_slug: slug, arguments: args, ...(account ? { account } : {}) }],
      thought: `trip-ticket pipeline: ${slug}`,
      current_step: slug,
    })
    const item = Array.isArray(data?.results) ? data.results[0] : data
    if (item?.successful === false || item?.error) throw new Error(`${slug}: ${item.error || 'execution failed'}`)
    return item?.data ?? item
  }

  return { callTool, execToolkitTool }
}
```

- [ ] **Step 4: Run tests → all PASS** (`npm test`)

- [ ] **Step 5: Record real-shape fixture (manual, requires key)** — create `scripts/record-composio-fixtures.mjs`:

```js
// Manual helper: records a real MULTI_EXECUTE response shape (sanitized) so the
// unwrap logic in composio.mjs is verified against reality, not guesses.
// Usage: COMPOSIO_API_KEY=... node scripts/record-composio-fixtures.mjs
import fs from 'node:fs'
import { mcpSession } from '../pipeline/composio.mjs'
const s = await mcpSession()
const raw = await s.callTool('COMPOSIO_MULTI_EXECUTE_TOOL', {
  tools: [{ tool_slug: 'GMAIL_FETCH_EMAILS', arguments: { query: 'is:read', max_results: 1, verbose: false, include_payload: false } }],
  thought: 'fixture recording', current_step: 'FIXTURE',
})
fs.mkdirSync('tests/fixtures', { recursive: true })
fs.writeFileSync('tests/fixtures/multi-execute-gmail.json', JSON.stringify(raw, null, 2))
console.log('shape keys:', Object.keys(raw ?? {}))
```

Run it once with the real key (read from `~/.zshrc`). **If the recorded shape's result array is NOT under `results`, adjust the `execToolkitTool` unwrap and the Task 2 test to match reality, and note it in the commit message.** Commit the sanitized fixture.

- [ ] **Step 6: Commit**

```bash
git add pipeline/composio.mjs tests/composio.test.mjs scripts/record-composio-fixtures.mjs tests/fixtures/ && git commit -m "feat: zero-dep Composio MCP client"
```

---

### Task 3: shared LLM JSON helper + Gmail agent

**Files:**
- Modify: `pipeline/agents.mjs` (add `runJson` helper near `runCliJson` ~line 64; replace `runTravelContextAgent` at line 348)
- Test: `tests/agents-connectors.test.mjs`

**Interfaces:**
- Consumes: `mcpSession`, `composioEnabled` from `./composio.mjs`; existing `runCliJson`, `parseStructured`, `MODEL`, ctx objects from `createContext`.
- Produces:
  - `runJson(ctx, {system, prompt, schema, maxTokens=4000})` — backend-agnostic structured call (internal, not exported)
  - `runTravelContextAgent(ctx, brief, deps={}): Promise<{status, confidence, notes, bookings[]}>` — **signature change: now takes `(ctx, brief, deps)`**. `deps.session` (composio session) and `deps.llm` (async ({system,prompt,schema})=>object) are test injection points.
  - `bookings[i] = { type:'flight'|'hotel'|'train'|'car'|'activity', vendor, confirmation_no, start, end, location, pax }`

- [ ] **Step 1: Write failing tests** — `tests/agents-connectors.test.mjs`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runTravelContextAgent } from '../pipeline/agents.mjs'

const BRIEF = { destination: 'Japan: Kyoto & Osaka', start_date: '2026-09-10', end_date: '2026-09-13' }

test('gmail agent skips without COMPOSIO_API_KEY', async () => {
  delete process.env.COMPOSIO_API_KEY
  const r = await runTravelContextAgent(null, BRIEF)
  assert.equal(r.status, 'skipped')
  assert.deepEqual(r.bookings, [])
})

test('gmail agent: session error → skipped with reason', async () => {
  process.env.COMPOSIO_API_KEY = 'ck_test'
  const deps = { session: Promise.reject(new Error('HTTP 401 — stale')) }
  const r = await runTravelContextAgent(null, BRIEF, { session: () => Promise.reject(new Error('HTTP 401 — stale')) })
  assert.equal(r.status, 'skipped')
  assert.match(r.notes, /401/)
})

test('gmail agent: empty inbox → ok + empty bookings', async () => {
  process.env.COMPOSIO_API_KEY = 'ck_test'
  const session = { execToolkitTool: async () => ({ messages: [] }) }
  const r = await runTravelContextAgent(null, BRIEF, { session: async () => session })
  assert.equal(r.status, 'ok')
  assert.deepEqual(r.bookings, [])
})

test('gmail agent: extracts bookings via injected llm', async () => {
  process.env.COMPOSIO_API_KEY = 'ck_test'
  const calls = []
  const session = {
    execToolkitTool: async (slug, args) => {
      calls.push(slug)
      if (slug === 'GMAIL_FETCH_EMAILS') return { messages: [{ messageId: 'm1', subject: 'Your booking', sender: 'jr@example.com', preview: {} }] }
      if (slug === 'GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID') return { subject: 'Your booking', messageText: 'JR pass confirmation ABC123 2026-09-10' }
      throw new Error(`unexpected ${slug}`)
    },
  }
  const llm = async () => ({ bookings: [{ type: 'train', vendor: 'JR', confirmation_no: 'ABC123', start: '2026-09-10', end: '', location: 'Kyoto', pax: 2 }] })
  const r = await runTravelContextAgent(null, BRIEF, { session: async () => session, llm })
  assert.equal(r.status, 'ok')
  assert.equal(r.bookings.length, 1)
  assert.ok(calls.includes('GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID'))
})

test('gmail agent: llm garbage twice → ok + empty bookings (no bad data downstream)', async () => {
  process.env.COMPOSIO_API_KEY = 'ck_test'
  const session = {
    execToolkitTool: async (slug) => slug === 'GMAIL_FETCH_EMAILS'
      ? { messages: [{ messageId: 'm1', subject: 's', sender: 'x' }] }
      : { subject: 's', messageText: 'body' },
  }
  let n = 0
  const llm = async () => { n++; throw new Error('bad json') }
  const r = await runTravelContextAgent(null, BRIEF, { session: async () => session, llm })
  assert.equal(n, 2) // one retry
  assert.equal(r.status, 'ok')
  assert.deepEqual(r.bookings, [])
})
```

- [ ] **Step 2: Run → FAIL** (`npm test` — old signature returns skipped-always; extraction tests fail)

- [ ] **Step 3: Implement.** In `pipeline/agents.mjs`: add import at top `import { mcpSession, composioEnabled } from './composio.mjs'`. Add helper after `runCliJson`:

```js
// Backend-agnostic structured-output call (sdk or cli), shared by connector agents.
async function runJson(ctx, { system, prompt, schema, maxTokens = 4000 }) {
  if (!ctx) throw new Error('no LLM context')
  if (ctx.backend === 'cli') return runCliJson({ system, prompt, schema })
  const response = await ctx.client.messages.create({
    model: MODEL,
    max_tokens: maxTokens,
    output_config: { format: { type: 'json_schema', schema } },
    system,
    messages: [{ role: 'user', content: prompt }],
  })
  return parseStructured(response)
}
```

Replace the `runTravelContextAgent` stub with:

```js
const BOOKINGS_SCHEMA = {
  type: 'object',
  properties: {
    bookings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['flight', 'hotel', 'train', 'car', 'activity'] },
          vendor: { type: 'string' },
          confirmation_no: { type: 'string' },
          start: { type: 'string' },
          end: { type: 'string' },
          location: { type: 'string' },
          pax: { type: 'integer' },
        },
        required: ['type', 'vendor'],
      },
    },
  },
  required: ['bookings'],
}

const EXTRACT_SYSTEM = 'You extract travel bookings from emails. Only extract fields literally present in the text; leave missing fields as empty string / omit. NEVER invent vendors, confirmation numbers or dates. If no real bookings, return {"bookings":[]}.'

export async function runTravelContextAgent(ctx, brief, deps = {}) {
  if (!composioEnabled()) {
    return { status: 'skipped', confidence: 0, notes: 'COMPOSIO_API_KEY not set; booking emails were not checked.', bookings: [] }
  }
  try {
    const session = await (deps.session ? deps.session() : mcpSession())
    const destWord = String(brief?.destination || '').split(/[:,&，、]/)[0].trim()
    const query = `(booking OR reservation OR confirmation OR itinerary OR e-ticket OR 訂位 OR 訂房 OR 確認) ${destWord} newer_than:180d`
    const list = await session.execToolkitTool('GMAIL_FETCH_EMAILS', {
      query, max_results: 20, verbose: false, include_payload: false,
    })
    const messages = (list?.messages ?? []).filter((m) => m?.messageId)
    if (!messages.length) return { status: 'ok', confidence: 0.6, notes: 'No booking-looking emails found in the last 180 days.', bookings: [] }

    const shortlist = messages.slice(0, 10)
    const bodies = []
    for (const m of shortlist) {
      try {
        const full = await session.execToolkitTool('GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID', { message_id: m.messageId, format: 'full' })
        const text = full?.messageText ?? full?.snippet ?? JSON.stringify(full).slice(0, 2000)
        bodies.push(`--- EMAIL (subject: ${full?.subject ?? m.subject ?? ''}) ---\n${String(text).slice(0, 4000)}`)
      } catch { /* one bad mail never kills the agent */ }
    }
    if (!bodies.length) return { status: 'ok', confidence: 0.5, notes: 'Emails found but none could be fetched in full.', bookings: [] }

    const llm = deps.llm ?? ((req) => runJson(ctx, req))
    const req = { system: EXTRACT_SYSTEM, prompt: `Trip: ${brief.destination}, ${brief.start_date}→${brief.end_date}.\n\n${bodies.join('\n\n')}`, schema: BOOKINGS_SCHEMA }
    let extracted
    try { extracted = await llm(req) } catch { try { extracted = await llm(req) } catch { extracted = null } }
    const bookings = Array.isArray(extracted?.bookings) ? extracted.bookings : []
    return { status: 'ok', confidence: bookings.length ? 0.75 : 0.6, notes: `Checked ${bodies.length} emails; extracted ${bookings.length} booking(s).`, bookings }
  } catch (error) {
    return { status: 'skipped', confidence: 0, notes: `Gmail check skipped: ${error.message}`, bookings: [] }
  }
}
```

**Reconcile `message_id`/`format` arg names and the `messageText` field against the Task 2 recorded fixture / `COMPOSIO_GET_TOOL_SCHEMAS` for `GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID` before finishing; adjust if reality differs and update the test fake to match.**

- [ ] **Step 4: Run → PASS.** Also `node pipeline/orchestrator.mjs --mock` must still exit 0 — the orchestrator currently calls `runTravelContextAgent(brief)`; the new first param means the old call passes `brief` as `ctx`. Since the agent only touches `ctx` via `deps.llm ?? runJson(ctx,…)` after the enabled-gate, mock mode (no key) skips before touching ctx. Update the orchestrator call site now: change `supervise('Travel Context Agent', () => runTravelContextAgent(brief))` → `runTravelContextAgent(ctx, brief)` (line ~409).

- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat: Gmail travel-context agent over Composio"`

---

### Task 4: Calendar agent (pure mapping, no LLM)

**Files:**
- Modify: `pipeline/agents.mjs` (replace `runCalendarAgent` at line ~357), `pipeline/orchestrator.mjs` call site → `runCalendarAgent(ctx, brief)` (ctx unused, kept for signature uniformity)
- Test: append to `tests/agents-connectors.test.mjs`

**Interfaces:**
- Produces: `runCalendarAgent(ctx, brief, deps={}): Promise<{status, confidence, notes, events[]}>`; `events[i] = { title, start, end, all_day }`

- [ ] **Step 1: Failing tests:**

```js
import { runCalendarAgent } from '../pipeline/agents.mjs' // merge into existing import

test('calendar agent skips without key', async () => {
  delete process.env.COMPOSIO_API_KEY
  const r = await runCalendarAgent(null, BRIEF)
  assert.equal(r.status, 'skipped')
})

test('calendar agent maps events deterministically', async () => {
  process.env.COMPOSIO_API_KEY = 'ck_test'
  let captured
  const session = {
    execToolkitTool: async (slug, args) => {
      captured = { slug, args }
      return { items: [
        { summary: 'Board meeting', start: { dateTime: '2026-09-11T09:00:00+09:00' }, end: { dateTime: '2026-09-11T10:00:00+09:00' } },
        { summary: 'Holiday', start: { date: '2026-09-12' }, end: { date: '2026-09-13' } },
      ] }
    },
  }
  const r = await runCalendarAgent(null, BRIEF, { session: async () => session })
  assert.equal(captured.slug, 'GOOGLECALENDAR_EVENTS_LIST')
  assert.equal(captured.args.timeMin, '2026-09-10T00:00:00Z')
  assert.equal(r.status, 'ok')
  assert.equal(r.events.length, 2)
  assert.equal(r.events[1].all_day, true)
})

test('calendar agent: tool error → skipped', async () => {
  process.env.COMPOSIO_API_KEY = 'ck_test'
  const session = { execToolkitTool: async () => { throw new Error('no active connection') } }
  const r = await runCalendarAgent(null, BRIEF, { session: async () => session })
  assert.equal(r.status, 'skipped')
  assert.match(r.notes, /no active connection/)
})
```

- [ ] **Step 2: Run → FAIL**

- [ ] **Step 3: Implement:**

```js
export async function runCalendarAgent(ctx, brief, deps = {}) {
  if (!composioEnabled()) {
    return { status: 'skipped', confidence: 0, notes: 'COMPOSIO_API_KEY not set; fixed events were not checked.', events: [] }
  }
  try {
    const session = await (deps.session ? deps.session() : mcpSession())
    const data = await session.execToolkitTool('GOOGLECALENDAR_EVENTS_LIST', {
      calendarId: 'primary',
      timeMin: `${brief.start_date}T00:00:00Z`,
      timeMax: `${brief.end_date}T23:59:59Z`,
      singleEvents: true,
      orderBy: 'startTime',
      maxResults: 50,
    })
    const items = data?.items ?? data?.events ?? []
    const events = items.map((e) => ({
      title: e.summary ?? '(untitled)',
      start: e.start?.dateTime ?? e.start?.date ?? '',
      end: e.end?.dateTime ?? e.end?.date ?? '',
      all_day: Boolean(e.start?.date && !e.start?.dateTime),
    }))
    return { status: 'ok', confidence: 0.9, notes: `Found ${events.length} calendar event(s) inside the trip window.`, events }
  } catch (error) {
    return { status: 'skipped', confidence: 0, notes: `Calendar check skipped: ${error.message}`, events: [] }
  }
}
```

Update orchestrator call site (line ~410): `supervise('Calendar Agent', () => runCalendarAgent(ctx, brief))`.

- [ ] **Step 4: Run → PASS; `node pipeline/orchestrator.mjs --mock` exits 0.**
- [ ] **Step 5: Commit** — `git commit -am "feat: Calendar agent over Composio (pure mapping)"`

---

### Task 5: Notion agent (new) + orchestrator wiring

**Files:**
- Modify: `pipeline/agents.mjs` (add `runNotionAgent` after `runCalendarAgent`), `pipeline/orchestrator.mjs` (import, TIMEOUTS entry, Promise.all wiring, context merge)
- Test: append to `tests/agents-connectors.test.mjs`

**Interfaces:**
- Produces: `runNotionAgent(ctx, brief, deps={}): Promise<{status, confidence, notes, travel_notes[]}>`; `travel_notes[i] = { title, note, location, url, category }`.
  **Spec deviation (intentional):** spec §5.3 named the array `notes[]`, but `notes` is already the string field every agent uses for supervise logging — the array is `travel_notes` instead. Record this in the commit message.
- Consumes: composer input `context` — orchestrator merges as `context: { ...contextRun.result, travel_notes }` so `runComposerAgent` needs NO change (it already JSON-stringifies the whole context object into the prompt).

- [ ] **Step 1: Failing tests:**

```js
import { runNotionAgent } from '../pipeline/agents.mjs' // merge into existing import

test('notion agent skips without key', async () => {
  delete process.env.COMPOSIO_API_KEY
  const r = await runNotionAgent(null, BRIEF)
  assert.equal(r.status, 'skipped')
  assert.deepEqual(r.travel_notes, [])
})

test('notion agent: no connection error → skipped honestly', async () => {
  process.env.COMPOSIO_API_KEY = 'ck_test'
  const session = { execToolkitTool: async () => { throw new Error('notion: no active connection') } }
  const r = await runNotionAgent(null, BRIEF, { session: async () => session })
  assert.equal(r.status, 'skipped')
})

test('notion agent: search→markdown→llm extraction', async () => {
  process.env.COMPOSIO_API_KEY = 'ck_test'
  const session = {
    execToolkitTool: async (slug) => {
      if (slug === 'NOTION_SEARCH_NOTION_PAGE') return { results: [{ id: 'p1', title: 'Kyoto trip notes' }] }
      if (slug === 'NOTION_GET_PAGE_MARKDOWN') return { markdown: '# Kyoto\n- 想吃:一蘭拉麵\n' }
      throw new Error(`unexpected ${slug}`)
    },
  }
  const llm = async () => ({ travel_notes: [{ title: '一蘭拉麵', note: '想吃', location: 'Kyoto', url: '', category: 'meal' }] })
  const r = await runNotionAgent(null, BRIEF, { session: async () => session, llm })
  assert.equal(r.status, 'ok')
  assert.equal(r.travel_notes.length, 1)
})

test('notion agent: zero pages → ok + empty', async () => {
  process.env.COMPOSIO_API_KEY = 'ck_test'
  const session = { execToolkitTool: async () => ({ results: [] }) }
  const r = await runNotionAgent(null, BRIEF, { session: async () => session })
  assert.equal(r.status, 'ok')
  assert.deepEqual(r.travel_notes, [])
})
```

- [ ] **Step 2: Run → FAIL**
- [ ] **Step 3: Implement in agents.mjs:**

```js
const NOTES_SCHEMA = {
  type: 'object',
  properties: {
    travel_notes: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          note: { type: 'string' },
          location: { type: 'string' },
          url: { type: 'string' },
          category: { type: 'string' },
        },
        required: ['title'],
      },
    },
  },
  required: ['travel_notes'],
}

export async function runNotionAgent(ctx, brief, deps = {}) {
  if (!composioEnabled()) {
    return { status: 'skipped', confidence: 0, notes: 'COMPOSIO_API_KEY not set; Notion notes were not checked.', travel_notes: [] }
  }
  try {
    const session = await (deps.session ? deps.session() : mcpSession())
    const destWord = String(brief?.destination || '').split(/[:,&，、]/)[0].trim()
    const found = await session.execToolkitTool('NOTION_SEARCH_NOTION_PAGE', { query: destWord, page_size: 5, filter_value: 'page' })
    const pages = (found?.results ?? []).filter((p) => p?.id)
    if (!pages.length) return { status: 'ok', confidence: 0.6, notes: 'No Notion pages matched the destination.', travel_notes: [] }
    const mds = []
    for (const p of pages.slice(0, 3)) {
      try {
        const md = await session.execToolkitTool('NOTION_GET_PAGE_MARKDOWN', { page_id: p.id })
        mds.push(`--- PAGE: ${p.title ?? p.id} ---\n${String(md?.markdown ?? '').slice(0, 6000)}`)
      } catch { /* one bad page never kills the agent */ }
    }
    if (!mds.length) return { status: 'ok', confidence: 0.5, notes: 'Notion pages found but none readable.', travel_notes: [] }
    const llm = deps.llm ?? ((req) => runJson(ctx, req))
    const req = {
      system: 'You extract travel-relevant notes (POIs, restaurants, bookings, checklists) from the user\'s own Notion pages. Only extract what is literally present; never invent. Empty array if nothing relevant.',
      prompt: `Trip: ${brief.destination}, ${brief.start_date}→${brief.end_date}.\n\n${mds.join('\n\n')}`,
      schema: NOTES_SCHEMA,
    }
    let extracted
    try { extracted = await llm(req) } catch { try { extracted = await llm(req) } catch { extracted = null } }
    const travel_notes = Array.isArray(extracted?.travel_notes) ? extracted.travel_notes : []
    return { status: 'ok', confidence: travel_notes.length ? 0.7 : 0.6, notes: `Read ${mds.length} Notion page(s); extracted ${travel_notes.length} note(s).`, travel_notes }
  } catch (error) {
    return { status: 'skipped', confidence: 0, notes: `Notion check skipped: ${error.message}`, travel_notes: [] }
  }
}
```

**Verify `NOTION_GET_PAGE_MARKDOWN`'s arg name (`page_id`) and response field (`markdown`) via `COMPOSIO_GET_TOOL_SCHEMAS` once (extend `scripts/record-composio-fixtures.mjs`); adjust code+tests if reality differs.**

Orchestrator wiring (`pipeline/orchestrator.mjs`):
1. Import: add `runNotionAgent` to the import list from `./agents.mjs`.
2. `TIMEOUTS`: add `'Notion Agent': 60_000,`.
3. Stage 2 `Promise.all`: add 4th entry `supervise('Notion Agent', () => runNotionAgent(ctx, brief))` → `const [discoveryRun, contextRun, calendarRun, notionRun] = await Promise.all([...])`.
4. Composer call: `context: { ...(contextRun.result ?? { bookings: [] }), travel_notes: notionRun.result?.travel_notes ?? [] },`
5. `assembleItinerary` call: pass `notionResult: notionRun.result`; inside `assembleItinerary`, change the context line to:
   `context: { bookings: contextResult?.bookings ?? [], calendar_events: calendarResult?.events ?? [], travel_notes: notionResult?.travel_notes ?? [] },` and add `notionResult` to the destructured params.

- [ ] **Step 4: Run → PASS; `node pipeline/orchestrator.mjs --mock` exits 0 and its JSON output now contains a `Notion Agent` entry with status `skipped`.**
- [ ] **Step 5: Commit** — `git commit -am "feat: Notion agent + orchestrator wiring (travel_notes naming deviation from spec, see plan)"`

---

### Task 6: live smoke script + setup docs

**Files:**
- Create: `scripts/composio-smoke.mjs`
- Modify: `package.json` (script `composio:smoke`), `README.md` (setup section)

**Interfaces:**
- Consumes: `runTravelContextAgent`, `runCalendarAgent`, `runNotionAgent`, `createContext`.

- [ ] **Step 1: `scripts/composio-smoke.mjs`:**

```js
// Live smoke: real Composio + real LLM. Not part of `npm test` (needs real keys).
// Usage: COMPOSIO_API_KEY=... node scripts/composio-smoke.mjs
import { createContext, runTravelContextAgent, runCalendarAgent, runNotionAgent } from '../pipeline/agents.mjs'
const brief = { destination: 'Switzerland: Lucerne', start_date: '2026-07-20', end_date: '2026-07-25' }
const ctx = await createContext().catch(() => null)
for (const [name, fn] of [['gmail', runTravelContextAgent], ['calendar', runCalendarAgent], ['notion', runNotionAgent]]) {
  const t0 = Date.now()
  const r = await fn(ctx, brief)
  const count = (r.bookings ?? r.events ?? r.travel_notes ?? []).length
  console.log(`${name}: status=${r.status} items=${count} (${((Date.now() - t0) / 1000).toFixed(1)}s) — ${r.notes}`)
}
```

`package.json` scripts: `"composio:smoke": "node scripts/composio-smoke.mjs"`.

- [ ] **Step 2: Run it with the real key** (`COMPOSIO_API_KEY="$(sed -n 's/^export COMPOSIO_API_KEY="\(.*\)"/\1/p' ~/.zshrc)" npm run composio:smoke`).
Expected: gmail `ok`, calendar `ok`, notion `skipped` (no active connection). Paste the output into the commit message.

- [ ] **Step 3: README setup section** — add under a `## Connectors (Composio)` heading: where to get the key (Composio dashboard MCP page — key rotates, dashboard is source of truth), export line for `~/.zshrc`, note that with no key everything degrades to skip, and the smoke command. Single-account tool: each user brings their own key.

- [ ] **Step 4: `npm test` all green. Commit** — `git commit -am "feat: composio smoke script + setup docs"`

---

## Self-review notes (done at plan time)

- Spec coverage: §4 → T2; §5.1 → T3; §5.2 → T4; §5.3+wiring → T5; §5.4 → T3/T5 (shared rules in system prompts, retry-once in code); §6 layers 1–5 → gate/catch/retry/empty paths in T3–T5 tests; §7.1–7.4 → tests in T2–T5 + T6 smoke. §9 open items resolved: exact schemas pinned in Global Constraints (verified live 2026-07-14); composer consumes notes with zero interface change (context object pass-through).
- Naming deviation from spec (notes[] → travel_notes) documented in T5 Interfaces.
- Type consistency: `{status, confidence, notes:string, <items>}` uniform; `deps.session` is `() => Promise<session>` in all three agents; `deps.llm` is `(req) => Promise<object>`.
