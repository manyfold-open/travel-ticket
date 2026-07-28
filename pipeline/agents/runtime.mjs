import Anthropic from '@anthropic-ai/sdk'
import { runA2AJson, runMfJson } from '../mf-client.mjs'
import { agentCallBudgetMs } from '../agent-budgets.mjs'

export const MODEL = 'claude-opus-4-8'

export async function createContext(preferred) {
  const hasApiCredentials = Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN)
  const backend = preferred ?? (hasApiCredentials ? 'sdk' : null)
  if (backend === 'sdk') return { backend, client: new Anthropic() }
  throw new Error('No LLM backend available: set ANTHROPIC_API_KEY (or `ant auth login`). For the `claude` CLI backend, use createLocalContext from agents-local.mjs.')
}

const ROLE_BINDINGS = {
  brief: 'AGENT_BRIEF',
  discovery: 'AGENT_DISCOVERY',
  context: 'AGENT_CONTEXT_EXTRACTOR',
  composer: 'AGENT_COMPOSER',
  theme: 'AGENT_THEME_DESIGNER',
}

// Each role's A2A deadline comes from the same map that supervises it, so the
// client aborts (and cancels the remote task) before the supervisor gives up on
// All private connector work runs on the `context` peer and shares its budget.
const ROLE_SUPERVISED_AS = {
  brief: 'Trip Brief Agent',
  discovery: 'Local Discovery Agent',
  context: 'Travel Context Agent',
  composer: 'Itinerary Composer Agent',
  theme: 'Theme Designer Agent',
}

// The deployed Worker receives this configuration through bindings rather than
// process.env. Every executable role has one explicit peer.
export function createMfContext(env, role) {
  const binding = ROLE_BINDINGS[role]
  if (!binding) throw new Error(`Unsupported Manyfold role: "${role ?? ''}"`)
  const peerId = env?.[binding]
  if (!env?.MF_API_URL || !env?.MF_API_TOKEN || !peerId) {
    throw new Error(`Manyfold backend needs MF_API_URL, MF_API_TOKEN and a peer for role "${role}"`)
  }
  return {
    backend: 'mf',
    env,
    role,
    peerId,
    timeoutMs: agentCallBudgetMs(ROLE_SUPERVISED_AS[role]),
    onTaskState: (state, taskId, detail) => {
      console.log(`[a2a] ${role} ${taskId} ${state}${detail ? ` · ${detail}` : ''}`)
    },
  }
}

export function createDirectA2AContext(credential, role = 'context') {
  if (!credential?.rpcUrl || !credential?.token) {
    throw new Error('Direct Manyfold context needs an A2A RPC URL and bearer token')
  }
  return {
    backend: 'a2a-direct',
    credential,
    role,
    timeoutMs: agentCallBudgetMs(ROLE_SUPERVISED_AS[role] ?? 'Travel Context Agent'),
    onTaskState: (state, taskId, detail) => {
      console.log(`[a2a-direct] ${role} ${taskId} ${state}${detail ? ` · ${detail}` : ''}`)
    },
  }
}

// Every mf-backed call needs the role's deadline and its logger; forgetting
// either is how a stalled agent turn becomes an unexplained failure.
export function mfCallOptions(ctx) {
  return { timeoutMs: ctx.timeoutMs, onTaskState: ctx.onTaskState }
}

export async function runStructuredJson(ctx, { system, prompt, schema, maxTokens = 4000 }) {
  if (!ctx) throw new Error('no LLM context')
  if (ctx.backend === 'mf') {
    return runMfJson(ctx.env, ctx.peerId, { system, prompt, schema }, mfCallOptions(ctx))
  }
  if (ctx.backend === 'a2a-direct') {
    return runA2AJson(ctx.credential, { system, prompt, schema }, mfCallOptions(ctx))
  }
  const response = await ctx.client.messages.create({
    model: MODEL,
    max_tokens: maxTokens,
    output_config: { format: { type: 'json_schema', schema } },
    system,
    messages: [{ role: 'user', content: prompt }],
  })
  return parseStructured(response)
}

export function parseStructured(response) {
  if (response.stop_reason === 'refusal') throw new Error('model refused the request')
  const text = response.content.find(block => block.type === 'text')?.text
  if (!text) throw new Error(`no text block in response (stop_reason=${response.stop_reason})`)
  return JSON.parse(text)
}
