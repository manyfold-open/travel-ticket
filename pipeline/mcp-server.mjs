#!/usr/bin/env node
// Trip Ticket MCP server: mechanical tools only. The connected MCP client's
// model performs discovery, reasoning, and itinerary composition with its own
// credentials; this process never invokes an LLM.
import readline from 'node:readline'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ITINERARY_SCHEMA, ITINERARY_EXAMPLE, normalizeItinerary } from './itinerary-schema.mjs'
import { runTimezoneAgent } from './timezone.mjs'
import { renderItinerary } from './render-local.mjs'
import { THEMES, DEFAULT_TOKENS, resolveTheme } from './themes.mjs'
import { checkTokens, validateOverrides } from './contrast.mjs'
import { CUSTOM_ALLOWED_KEYS } from './customTheme.mjs'

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const tripsDataDir = path.join(packageRoot, 'data', 'trips')
const dateSchema = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' }
const safeMotifs = (motifs) => Object.fromEntries(
  ['stampText', 'eyebrow'].filter((key) => typeof motifs?.[key] === 'string').map((key) => [key, motifs[key]]),
)

function resolveDesign(itinerary, design) {
  if (design == null || design === '') {
    const name = resolveTheme({ destination: itinerary.destination, destination_timezone: itinerary.destination_timezone })
    return { theme: name, theme_used: { name, source: 'deterministic destination fallback' } }
  }
  if (typeof design === 'string') {
    if (!THEMES[design]) throw new Error(`unknown preset design: ${design}`)
    return { theme: design, theme_used: { name: design, source: 'preset' } }
  }
  if (typeof design !== 'object' || Array.isArray(design)) throw new Error('design must be a preset name or a custom design object')
  const tokens = design.tokens
  if (!tokens || typeof tokens !== 'object' || Array.isArray(tokens) || !Object.keys(tokens).length) throw new Error('custom design.tokens must be a non-empty object')
  const allowed = validateOverrides(tokens, CUSTOM_ALLOWED_KEYS)
  if (!allowed.ok) throw new Error(`custom design tokens rejected: ${allowed.problems.join('; ')}`)
  const contrast = checkTokens({ ...DEFAULT_TOKENS, ...tokens })
  if (!contrast.pass) throw new Error(`custom design contrast check failed: ${contrast.failures.map((item) => item.label).join('; ')}`)
  const motifs = safeMotifs(design.motifs)
  return {
    theme: 'default', customTokens: tokens, customMotifs: Object.keys(motifs).length ? motifs : null,
    theme_used: { name: typeof design.name === 'string' ? design.name : 'custom', custom: true, source: 'client-supplied contrast-gated tokens' },
  }
}

async function renderTicket({ itineraryJson, design }) {
  const itinerary = normalizeItinerary(itineraryJson)
  const selected = resolveDesign(itinerary, design)
  itinerary.theme = selected.theme
  if (selected.customTokens) itinerary.custom_theme = { name: selected.theme_used.name, tokens: selected.customTokens, motifs: selected.customMotifs ?? {} }
  const tripDir = `${itinerary.slug}-${itinerary.trip_id.split('_').at(-1).slice(0, 8)}`
  const outDir = path.join(packageRoot, 'dist', 'trips', tripDir)
  const manifest = await renderItinerary(itinerary, { outDir, customTokens: selected.customTokens, customMotifs: selected.customMotifs })
  fs.mkdirSync(tripsDataDir, { recursive: true })
  fs.writeFileSync(path.join(tripsDataDir, `${tripDir}.json`), JSON.stringify(itinerary, null, 2))
  return {
    entry: path.join(outDir, 'index.html'), output_dir: outDir, trip_dir: tripDir, pages: manifest.pages.length,
    theme_used: selected.theme_used,
    poster_status: 'skipped: MCP render_ticket is renderer-only; no image-generation CLI/API was invoked.',
  }
}

const TOOLS = [
  {
    def: {
      name: 'get_itinerary_schema',
      description: 'Return the final_itinerary JSON Schema and a complete example. Compose the itinerary yourself from the user request and optional context tools, then pass it to render_ticket. This server does not plan trips or call an LLM.',
      inputSchema: { type: 'object', properties: {} },
    },
    handler: async () => ({ schema: ITINERARY_SCHEMA, example: ITINERARY_EXAMPLE, guidance: 'Use UTC ISO timestamps for every item. Supply IANA timezones. Keep uncertain facts as warnings or notes with sources.' }),
  },
  {
    def: {
      name: 'fetch_travel_context',
      description: 'Calculate destination/home offsets, DST changes, and body-clock guidance. This is deterministic and does not infer a timezone from a place name or call an LLM.',
      inputSchema: {
        type: 'object', properties: {
          destination: { type: 'string' }, destination_timezone: { type: 'string', description: 'IANA timezone required, e.g. Asia/Tokyo.' },
          home_timezone: { type: 'string', description: 'IANA timezone required, e.g. Europe/London.' }, start_date: dateSchema, end_date: dateSchema,
        }, required: ['destination', 'destination_timezone', 'home_timezone', 'start_date', 'end_date'],
      },
    },
    handler: async (args) => ({ destination: args.destination, dates: `${args.start_date} to ${args.end_date}`, timezone: runTimezoneAgent(args) }),
  },
  {
    def: {
      name: 'render_ticket',
      description: 'Render a client-composed final_itinerary into a static ticket site. This is pure rendering: no planner, web search, LLM, or image-generation call runs here. design is a registered preset name or contrast-gated client-supplied tokens/motifs.',
      inputSchema: {
        type: 'object', properties: {
          itinerary: ITINERARY_SCHEMA,
          design: {
            oneOf: [
              { type: 'string', enum: Object.keys(THEMES) },
              { type: 'object', properties: { name: { type: 'string' }, tokens: { type: 'object', additionalProperties: { type: 'string' } }, motifs: { type: 'object', properties: { stampText: { type: 'string' }, eyebrow: { type: 'string' } } } }, required: ['tokens'] },
            ],
          },
        }, required: ['itinerary'],
      },
    },
    handler: async ({ itinerary, design }) => renderTicket({ itineraryJson: itinerary, design }),
  },
]

const write = (msg) => process.stdout.write(JSON.stringify(msg) + '\n')
const reply = (id, result) => write({ jsonrpc: '2.0', id, result })
const replyError = (id, code, message) => write({ jsonrpc: '2.0', id, error: { code, message } })

const handlers = {
  initialize: () => ({ protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'trip-ticket', version: '0.2.0' } }),
  'tools/list': () => ({ tools: TOOLS.map((tool) => tool.def) }),
  'tools/call': async (params) => {
    const tool = TOOLS.find((item) => item.def.name === params?.name)
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
  if (msg.method?.startsWith('notifications/')) return
  const handler = handlers[msg.method]
  if (!handler) return replyError(msg.id ?? null, -32601, `method not found: ${msg.method}`)
  try { reply(msg.id, await handler(msg.params)) } catch (error) { replyError(msg.id ?? null, error.code ?? -32603, error.message) }
})
process.stdin.on('end', () => process.exit(0))
