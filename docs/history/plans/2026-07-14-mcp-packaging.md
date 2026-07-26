# MCP Packaging Implementation Plan

> Archived execution plan. The checkboxes below are historical and are not the
> current project backlog.
>
> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose the trip-ticket workflow as an MCP server so anyone can add it to Claude/Cursor and say "make me a ticket for 5 days in Kyoto".

**Architecture:** Zero-dep stdio MCP server (`pipeline/mcp-server.mjs`, newline-delimited JSON-RPC — same zero-dep philosophy as composio.mjs). Two tools mirroring the two-phase split: `plan_trip` (runs the pipeline, returns a `plan_id` + summary + design options) and `render_ticket` (takes `plan_id` + design choice, renders, returns local paths). Plans persist to `.trip_work/plans/<plan_id>.json` so the server survives restarts between the two calls.

**Tech Stack:** Node 22, `node:readline` for stdin framing, `pipeline/trip.mjs` from the design-selection plan.

**Depends on:** BOTH prior plans fully merged (needs `planTrip`/`renderTicket`/`parseDesignChoice` and the connector agents).

## Global Constraints

- Zero new dependencies (no `@modelcontextprotocol/sdk`).
- MCP protocol version `2024-11-05`; stdio transport = one JSON-RPC message per line on stdin/stdout; ALL logging to stderr (stdout is protocol-only).
- Single-user local tool: user's own `ANTHROPIC_API_KEY`/claude CLI + optional `COMPOSIO_API_KEY` in the environment the MCP client launches the server with.
- Long-task reality: `plan_trip` can take minutes — declare generous timeout guidance in tool descriptions; MCP clients handle waiting. (Progress notifications: YAGNI for v1.)
- Deliverable is local: tool results return absolute `outputDir` + entry `index.html` path (deploy-to-URL stays out of scope for v1, per design-selection spec §7).

---

### Task 1: stdio JSON-RPC server skeleton

**Files:**
- Create: `pipeline/mcp-server.mjs`
- Test: `tests/mcp-server.test.mjs` (spawns the server, speaks JSON-RPC over stdio)

**Interfaces:**
- Produces: executable server responding to `initialize`, `notifications/initialized`, `tools/list`, `tools/call`; unknown methods → JSON-RPC error -32601.
- `package.json` script: `"mcp": "node pipeline/mcp-server.mjs"`.

- [ ] **Step 1: Failing test** — `tests/mcp-server.test.mjs`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// helper: spawn server, send messages, collect responses by id
function rpcSession() {
  const child = spawn('node', [path.join(ROOT, 'pipeline/mcp-server.mjs')], { env: { ...process.env, TRIP_NO_LLM: '1' } })
  let buf = ''
  const pending = new Map()
  child.stdout.on('data', (d) => {
    buf += d
    let idx
    while ((idx = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, idx); buf = buf.slice(idx + 1)
      if (!line.trim()) continue
      const msg = JSON.parse(line)
      if (msg.id != null && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id) }
    }
  })
  const send = (msg) => child.stdin.write(JSON.stringify(msg) + '\n')
  const request = (msg) => new Promise((resolve) => { pending.set(msg.id, resolve); send(msg) })
  return { child, send, request, kill: () => child.kill() }
}

test('initialize → tools/list shows plan_trip + render_ticket', async () => {
  const s = rpcSession()
  try {
    const init = await s.request({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' } } })
    assert.equal(init.result.protocolVersion, '2024-11-05')
    s.send({ jsonrpc: '2.0', method: 'notifications/initialized' })
    const list = await s.request({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
    const names = list.result.tools.map((t) => t.name)
    assert.ok(names.includes('plan_trip'))
    assert.ok(names.includes('render_ticket'))
  } finally { s.kill() }
})

test('unknown method → -32601', async () => {
  const s = rpcSession()
  try {
    const r = await s.request({ jsonrpc: '2.0', id: 3, method: 'bogus/method' })
    assert.equal(r.error.code, -32601)
  } finally { s.kill() }
})
```

- [ ] **Step 2: Run → FAIL**
- [ ] **Step 3: Implement `pipeline/mcp-server.mjs`** (skeleton; tool handlers land in Task 2):

```js
#!/usr/bin/env node
// trip-ticket MCP server — zero-dep stdio transport (newline-delimited JSON-RPC).
// stdout is protocol-only; all logs go to stderr.
import readline from 'node:readline'

const TOOLS = [] // filled in Task 2: [{ def, handler }]

const write = (msg) => process.stdout.write(JSON.stringify(msg) + '\n')
const reply = (id, result) => write({ jsonrpc: '2.0', id, result })
const replyError = (id, code, message) => write({ jsonrpc: '2.0', id, error: { code, message } })

const handlers = {
  initialize: (params) => ({
    protocolVersion: '2024-11-05',
    capabilities: { tools: {} },
    serverInfo: { name: 'trip-ticket', version: '0.1.0' },
  }),
  'tools/list': () => ({ tools: TOOLS.map((t) => t.def) }),
  'tools/call': async (params) => {
    const tool = TOOLS.find((t) => t.def.name === params?.name)
    if (!tool) throw Object.assign(new Error(`unknown tool: ${params?.name}`), { code: -32602 })
    try {
      const result = await tool.handler(params?.arguments ?? {})
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
    } catch (error) {
      return { content: [{ type: 'text', text: `Error: ${error.message}` }], isError: true }
    }
  },
}

const rl = readline.createInterface({ input: process.stdin })
rl.on('line', async (line) => {
  if (!line.trim()) return
  let msg
  try { msg = JSON.parse(line) } catch { return replyError(null, -32700, 'parse error') }
  if (msg.method?.startsWith('notifications/')) return // no response to notifications
  const handler = handlers[msg.method]
  if (!handler) return replyError(msg.id ?? null, -32601, `method not found: ${msg.method}`)
  try {
    reply(msg.id, await handler(msg.params))
  } catch (error) {
    replyError(msg.id ?? null, error.code ?? -32603, error.message)
  }
})
process.stdin.on('end', () => process.exit(0))
```

Add `"mcp": "node pipeline/mcp-server.mjs"` to package.json scripts. NOTE: tools/list test will still fail until Task 2 registers the two tools — implement Task 2's tool defs (not handlers' full logic) as empty-throwing stubs ONLY if you must split commits; otherwise do Task 1+2 as one commit and keep both tests together. Preferred: proceed straight into Task 2 before committing.

---

### Task 2: `plan_trip` + `render_ticket` tools

**Files:**
- Modify: `pipeline/mcp-server.mjs` (fill `TOOLS`)
- Test: append to `tests/mcp-server.test.mjs`

**Interfaces:**
- Consumes: `planTrip`, `renderTicket`, `parseDesignChoice` from `./trip.mjs`.
- Produces tools:
  - `plan_trip { sentence: string, mock?: boolean }` → `{ plan_id, destination, dates, summary, design_options }` — persists full plan to `.trip_work/plans/<plan_id>.json`
  - `render_ticket { plan_id: string, design?: string }` — `design` uses the SAME string grammar as the CLI flag (`<presetName>` or `custom:<描述>`; omitted → recommended preset #1) → `{ output_dir, entry, theme_used, trip_dir }`

- [ ] **Step 1: Failing test (append):**

```js
test('plan_trip (mock) → render_ticket round-trip', async () => {
  const s = rpcSession()
  try {
    await s.request({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' } } })
    s.send({ jsonrpc: '2.0', method: 'notifications/initialized' })
    const planRes = await s.request({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'plan_trip', arguments: { sentence: '', mock: true } } })
    const planOut = JSON.parse(planRes.result.content[0].text)
    assert.ok(planOut.plan_id)
    assert.ok(planOut.design_options.presets.length >= 1)
    const renderRes = await s.request({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'render_ticket', arguments: { plan_id: planOut.plan_id, design: 'japan' } } })
    const renderOut = JSON.parse(renderRes.result.content[0].text)
    assert.equal(renderOut.theme_used.name, 'japan')
    assert.ok(renderOut.entry.endsWith('index.html'))
  } finally { s.kill() }
})

test('render_ticket with unknown plan_id → isError', async () => {
  const s = rpcSession()
  try {
    await s.request({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' } } })
    s.send({ jsonrpc: '2.0', method: 'notifications/initialized' })
    const r = await s.request({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'render_ticket', arguments: { plan_id: 'nope' } } })
    assert.equal(r.result.isError, true)
  } finally { s.kill() }
})
```

- [ ] **Step 2: Run → FAIL**
- [ ] **Step 3: Implement — fill `TOOLS` in mcp-server.mjs:**

```js
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { planTrip, renderTicket, parseDesignChoice } from './trip.mjs'

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const plansDir = path.join(packageRoot, '.trip_work', 'plans')

const TOOLS = [
  {
    def: {
      name: 'plan_trip',
      description: 'Plan a trip from a one-sentence request (runs LLM agents + optional Gmail/Calendar/Notion context; can take several minutes). Returns a plan_id and ticket design options. Call render_ticket next with the plan_id and a chosen design.',
      inputSchema: {
        type: 'object',
        properties: {
          sentence: { type: 'string', description: 'One-sentence trip request, e.g. "七月中帶另一半去瑞士五天,不租車"' },
          mock: { type: 'boolean', description: 'Use canned data, no LLM calls (testing only)' },
        },
        required: ['sentence'],
      },
    },
    handler: async ({ sentence, mock = false }) => {
      const { plan, designOptions } = await planTrip(sentence, { mock, log: (m) => console.error(`[plan_trip] ${m}`) })
      fs.mkdirSync(plansDir, { recursive: true })
      fs.writeFileSync(path.join(plansDir, `${plan.tripId}.json`), JSON.stringify({ plan, designOptions }))
      return {
        plan_id: plan.tripId,
        destination: plan.brief.destination,
        dates: `${plan.brief.start_date} → ${plan.brief.end_date}`,
        summary: plan.composed.summary,
        design_options: designOptions,
        next_step: `Ask the user which design they want, then call render_ticket with plan_id and design (a preset name, or "custom:<their description>").`,
      }
    },
  },
  {
    def: {
      name: 'render_ticket',
      description: 'Render the ticket site for a planned trip. design = a preset name from plan_trip\'s design_options, or "custom:<style description>" (contrast-gated; falls back honestly), or omit for the top recommendation.',
      inputSchema: {
        type: 'object',
        properties: {
          plan_id: { type: 'string' },
          design: { type: 'string' },
        },
        required: ['plan_id'],
      },
    },
    handler: async ({ plan_id, design }) => {
      const file = path.join(plansDir, `${path.basename(plan_id)}.json`)
      if (!fs.existsSync(file)) throw new Error(`unknown plan_id: ${plan_id} — call plan_trip first`)
      const { plan, designOptions } = JSON.parse(fs.readFileSync(file, 'utf8'))
      const choice = parseDesignChoice(design, designOptions)
      const outDir = path.join(packageRoot, 'dist', 'trips')
      const { manifest, tripDir, themeUsed } = await renderTicket(plan, choice, { log: (m) => console.error(`[render_ticket] ${m}`) })
      return {
        output_dir: path.join(outDir, tripDir),
        entry: path.join(outDir, tripDir, 'index.html'),
        theme_used: themeUsed,
        trip_dir: tripDir,
        pages: manifest.pages?.length ?? 0,
      }
    },
  },
]
```

(Move the `const TOOLS = []` placeholder — this array replaces it; keep skeleton handlers unchanged.)

- [ ] **Step 4: `npm test` → all PASS.**
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat: trip-ticket MCP server (plan_trip / render_ticket)"`

---

### Task 3: docs + client config

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add `## Use as an MCP server` section** with: prerequisites (Node 22+, `ANTHROPIC_API_KEY` or `claude` CLI login, optional `COMPOSIO_API_KEY` for Gmail/Calendar/Notion context), the two-call flow (plan → ask user for design → render), and the client config snippet:

```json
{
  "mcpServers": {
    "trip-ticket": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/TO/switzerland-itinerary-package/pipeline/mcp-server.mjs"],
      "env": { "COMPOSIO_API_KEY": "ck_..." }
    }
  }
}
```

Plus a note: `plan_trip` may run several minutes (LLM + web search) — clients should not time it out aggressively; and everything degrades honestly (no keys → connectors skip, mock mode available).

- [ ] **Step 2: Manual smoke:** add the server to Claude Code (`claude mcp add trip-ticket -- node .../pipeline/mcp-server.mjs`) or run the Task 1 test session by hand; verify `plan_trip {mock:true}` → `render_ticket` produces `dist/trips/<dir>/index.html` and it opens in a browser.

- [ ] **Step 3: Commit** — `git commit -am "docs: MCP server setup"`

---

## Self-review notes (done at plan time)

- Decisions this plan bakes in (were open in brainstorm; minimal-viable v1): local file paths as the deliverable (no auto-deploy); no progress notifications (client waits); plan persistence to `.trip_work/plans/` bridges the two calls across server restarts.
- Two-call design directly reuses `parseDesignChoice` grammar from the design-selection plan — single choice-parsing code path for CLI flag and MCP arg.
- `path.basename(plan_id)` guards path traversal on the plan_id argument.
- Tests run with `TRIP_NO_LLM=1` and `mock:true` — no keys needed in CI.
