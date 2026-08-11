import Anthropic from '@anthropic-ai/sdk'
import { runA2AJson } from '../mf-client.mjs'
import { agentCallBudgetMs } from '../agent-budgets.mjs'

export const MODEL = 'claude-opus-4-8'

export async function createContext(preferred) {
  const hasApiCredentials = Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN)
  const backend = preferred ?? (hasApiCredentials ? 'sdk' : null)
  if (backend === 'sdk') return { backend, client: new Anthropic() }
  throw new Error('No LLM backend available: set ANTHROPIC_API_KEY (or `ant auth login`). For the `claude` CLI backend, use createLocalContext from agents-local.mjs.')
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
/**
 * Build the context one DAG task runs against.
 *
 * The credential is resolved and decrypted by the caller (worker/trip-task.ts,
 * from the snapshot the Durable Object took when the trip started), so this
 * layer no longer knows anything about Manyfold identities, peer ids, or
 * minting. It is the same shape the old 'a2a-direct' backend already used —
 * an rpcUrl and a bearer — which is why the cutover deletes a backend rather
 * than adding one.
 *
 * `messageId` makes a retried send idempotent: derived from the trip, the task
 * and the attempt, so a queue redelivery of the same attempt cannot bill a
 * second turn while a genuine new attempt still gets a fresh turn.
 */
export function createAgentContext(credential, role, { messageId } = {}) {
  if (!credential?.rpcUrl || !credential?.token) {
    throw new Error(`Manyfold role "${role}" has no usable credential`)
  }
  const timeoutMs = agentCallBudgetMs(ROLE_SUPERVISED_AS[role] ?? 'Travel Context Agent')
  return {
    backend: 'a2a',
    credential,
    role,
    messageId,
    timeoutMs,
    // Stamped once, when the context is built. One context is created per queue
    // invocation, so every call made through it shares one wall-clock budget.
    deadlineAt: Date.now() + timeoutMs,
    onTaskState: (state, taskId, detail) => {
      console.log(`[a2a] ${role} ${taskId} ${state}${detail ? ` · ${detail}` : ''}`)
    },
  }
}

/**
 * Every mf-backed call needs the role's deadline and its logger; forgetting
 * either is how a stalled agent turn becomes an unexplained failure.
 *
 * timeoutMs shrinks as the context's deadline approaches. It used to be
 * returned whole on every call, which meant the language-policy retry in
 * agents/trip.mjs — a second full call after the first had already spent its
 * budget — could run a role to twice its allowance. For the composer that is
 * 2 x 460s against a 600s Durable Object lease: the lease expires mid-flight,
 * the task is re-dispatched, and a second billed session starts while the
 * first is still running.
 */
export function mfCallOptions(ctx) {
  const deadlineAt = ctx.deadlineAt ?? (Date.now() + ctx.timeoutMs)
  return {
    timeoutMs: Math.max(5_000, Math.min(ctx.timeoutMs, deadlineAt - Date.now())),
    deadlineAt,
    messageId: ctx.messageId,
    onTaskState: ctx.onTaskState,
  }
}

export async function runStructuredJson(ctx, { system, prompt, schema, maxTokens = 4000 }) {
  if (!ctx) throw new Error('no LLM context')
  if (ctx.backend === 'a2a') {
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
