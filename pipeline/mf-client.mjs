// Manyfold A2A client shared by the local pipeline and Cloudflare Queue tasks.
// A message/send response may be a completed Message or an accepted Task. Task
// responses are polled with tasks/get so slow peers are never parsed before
// their final output exists.

const tokenCache = new Map()
const tokenInflight = new Map()
const DEFAULT_ATTEMPTS = 2
const DEFAULT_TIMEOUT_MS = 240_000
const DEFAULT_POLL_INTERVAL_MS = 1_000
const ERROR_TEXT_LIMIT = 1_000
// Below this much remaining budget a retry can only re-fail on the clock, so it
// would burn another agent session (and another billed turn) for nothing.
const MIN_RETRY_ROOM_MS = 20_000

class A2AError extends Error {
  constructor(message, retryable, refreshCredential = false, retryAfterMs) {
    super(message)
    this.name = 'A2AError'
    this.retryable = retryable
    this.refreshCredential = refreshCredential
    this.retryAfterMs = retryAfterMs
  }
}

function cacheKey(env, peerId) {
  return `${env.MF_API_URL}:${env.MF_AGENT_ID || 'self'}:${peerId}`
}

function forgetPeerToken(env, peerId) {
  tokenCache.delete(cacheKey(env, peerId))
}

function safeErrorText(value) {
  return String(value ?? '')
    .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\b/g, '[redacted-token]')
    .replace(/\s+/g, ' ')
    .slice(0, ERROR_TEXT_LIMIT)
}

function retryAfterMs(response) {
  const raw = response.headers.get('retry-after')
  if (!raw) return undefined
  const seconds = Number(raw)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1_000, 15_000)
  const date = Date.parse(raw)
  return Number.isNaN(date) ? undefined : Math.min(Math.max(0, date - Date.now()), 15_000)
}

function retryableStatus(status) {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500
}

function looksTransient(message) {
  return /\b(timeout|timed out|temporar|unavailable|overload|rate limit|too many|network|fetch failed|connection|socket|internal error|server error|502|503|504|turn_timeout)\b/i.test(message)
    || /\b(runtime|sandbox)\b.*\b(dead|offline|stopped|not alive|not running)\b/i.test(message)
}

function normalizeError(error) {
  if (error instanceof A2AError) return error
  const message = safeErrorText(error instanceof Error ? error.message : error)
  const name = error && typeof error === 'object' && 'name' in error ? String(error.name) : ''
  const timedOut = name === 'AbortError' || /abort|timeout|timed out/i.test(message)
  return new A2AError(
    timedOut ? `Manyfold A2A request timed out. ${message}` : message || 'Unknown Manyfold A2A failure.',
    timedOut || looksTransient(message) || error instanceof TypeError,
  )
}

async function fetchTimeout(url, options, timeoutMs) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...options, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

async function getPeerToken(env, peerId) {
  const key = cacheKey(env, peerId)
  const cached = tokenCache.get(key)
  if (cached && cached.exp > Date.now() + 30_000) return cached

  const pending = tokenInflight.get(key)
  if (pending) return pending

  const mint = (async () => {
    const query = env.MF_AGENT_ID ? `?agentId=${encodeURIComponent(env.MF_AGENT_ID)}` : ''
    const response = await fetchTimeout(
      `${env.MF_API_URL}/agent-self/a2a/peers/${encodeURIComponent(peerId)}/token${query}`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${env.MF_API_TOKEN}`, accept: 'application/json' },
      },
      15_000,
    )
    if (!response.ok) {
      const detail = safeErrorText(await response.text())
      throw new A2AError(
        `Peer credential mint failed: HTTP ${response.status}${detail ? ` · ${detail}` : ''}`,
        retryableStatus(response.status),
        false,
        retryAfterMs(response),
      )
    }

    let body
    try {
      body = await response.json()
    } catch (error) {
      throw new A2AError(`Peer credential response was not valid JSON. ${safeErrorText(error)}`, true)
    }
    if (!body?.token || !body?.rpcUrl) {
      throw new A2AError('Peer credential response omitted token or rpcUrl.', true)
    }
    const parsedExpiry = body.expiresAt ? new Date(body.expiresAt).getTime() : Number.NaN
    const entry = {
      token: body.token,
      rpcUrl: body.rpcUrl,
      exp: Number.isFinite(parsedExpiry) ? parsedExpiry : Date.now() + 10 * 60_000,
    }
    tokenCache.set(key, entry)
    return entry
  })()

  tokenInflight.set(key, mint)
  try {
    return await mint
  } finally {
    if (tokenInflight.get(key) === mint) tokenInflight.delete(key)
  }
}

function taskState(data) {
  return String(data?.result?.status?.state ?? '').trim().toLowerCase().replace(/_/g, '-')
}

function taskId(data) {
  const value = data?.result?.id ?? data?.result?.taskId
  return typeof value === 'string' && value ? value : null
}

function rpcFailure(data, peerId) {
  if (!data?.error) return null
  const code = typeof data.error.code === 'number' ? data.error.code : undefined
  const message = safeErrorText(data.error.message ?? data.error.data ?? JSON.stringify(data.error))
  const permanent = code === -32700 || code === -32600 || code === -32601 || code === -32602
  return new A2AError(
    `Agent ${peerId} RPC error${code === undefined ? '' : ` ${code}`}: ${message}`,
    !permanent && looksTransient(message),
  )
}

async function parseRpcResponse(response, peerId) {
  if (!response.ok) {
    const detail = safeErrorText(await response.text())
    throw new A2AError(
      `Agent ${peerId} failed: HTTP ${response.status}${detail ? ` · ${detail}` : ''}`,
      retryableStatus(response.status) || response.status === 401,
      response.status === 401,
      retryAfterMs(response),
    )
  }
  let data
  try {
    data = await response.json()
  } catch (error) {
    throw new A2AError(`Agent ${peerId} returned invalid JSON. ${safeErrorText(error)}`, true)
  }
  const failure = rpcFailure(data, peerId)
  if (failure) throw failure
  return data
}

function terminalTaskError(data, peerId) {
  const state = taskState(data)
  if (state === 'failed' || state === 'canceled' || state === 'rejected') {
    const detail = safeErrorText(extractAgentText(data))
    return new A2AError(
      `Agent ${peerId} task ${state}: ${detail}`,
      state === 'failed' && looksTransient(detail),
    )
  }
  if (state === 'input-required' || state === 'auth-required') {
    return new A2AError(`Agent ${peerId} task stopped in state "${state}".`, false)
  }
  return null
}

async function cancelTask(credential, peerId, id) {
  try {
    const response = await fetchTimeout(credential.rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${credential.token}` },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'tasks/cancel',
        id: crypto.randomUUID(),
        params: { id },
      }),
    }, 10_000)
    return taskState(await parseRpcResponse(response, peerId)) === 'canceled'
  } catch {
    return false
  }
}

// Agent turns run for minutes, so polling once a second for a whole multi-minute
// budget buys almost nothing and spends ~1 subrequest per second against the
// per-invocation cap — a 460s composer budget would burn 460 of them on tasks/get
// alone. Poll eagerly at first (a short turn is still picked up fast), then
// settle into a slow beat: ~34 polls across 280s instead of 280.
const POLL_BACKOFF_CAP_MS = 10_000
const POLL_EAGER_COUNT = 5

function pollDelayMs(baseMs, polls) {
  if (polls < POLL_EAGER_COUNT) return baseMs
  return Math.min(POLL_BACKOFF_CAP_MS, baseMs * 2 ** Math.min(6, polls - POLL_EAGER_COUNT + 1))
}

async function pollTask(env, credential, peerId, id, deadline, pollIntervalMs, onTaskState) {
  let previousState = ''
  let pollFailures = 0
  // Diagnostics for the timeout message below. A bare "did not complete within
  // its wait budget" cannot distinguish a genuinely slow agent from a poll loop
  // that was failing blind the whole time — and those need opposite fixes.
  const startedAt = Date.now()
  let polls = 0
  let consecutiveFailures = 0
  let lastFailure = ''

  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, pollDelayMs(pollIntervalMs, polls)))
    const remaining = deadline - Date.now()
    if (remaining <= 0) break
    polls += 1

    let data
    try {
      const response = await fetchTimeout(credential.rpcUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${credential.token}` },
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'tasks/get',
          id: crypto.randomUUID(),
          params: { id },
        }),
      }, Math.max(1_000, Math.min(remaining, 15_000)))
      data = await parseRpcResponse(response, peerId)
      pollFailures = 0
      consecutiveFailures = 0
    } catch (error) {
      const failure = normalizeError(error)
      if (!failure.retryable) throw failure
      pollFailures += 1
      consecutiveFailures += 1
      lastFailure = failure.message
      if (failure.refreshCredential) {
        forgetPeerToken(env, peerId)
        try {
          credential = await getPeerToken(env, peerId)
        } catch {
          // The Task already exists. Keep polling it instead of resubmitting.
        }
      }
      onTaskState?.('poll-retrying', id, failure.message)
      const delay = Math.min(retryDelay(failure, pollFailures), Math.max(0, deadline - Date.now()))
      if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay))
      continue
    }

    const state = taskState(data)
    if (state && state !== previousState) {
      previousState = state
      onTaskState?.(state, id)
    }
    const terminal = terminalTaskError(data, peerId)
    if (terminal) throw terminal
    if (!state || state === 'completed') return data
  }

  const canceled = await cancelTask(credential, peerId, id)
  onTaskState?.(canceled ? 'canceled-after-timeout' : 'timed-out', id)
  const waited = Math.round((Date.now() - startedAt) / 1000)
  const blind = consecutiveFailures
    ? ` Last ${consecutiveFailures} poll(s) failed: ${lastFailure}`
    : ` Last observed state: ${previousState || 'none'}.`
  throw new A2AError(
    `Agent ${peerId} task ${id} did not complete within its wait budget`
    + `${canceled ? ' and was canceled' : ''} (waited ${waited}s over ${polls} poll(s)).${blind}`,
    false,
  )
}

async function executeAttempt(env, peerId, body, deadline, pollIntervalMs, onTaskState) {
  const credential = await getPeerToken(env, peerId)
  const response = await fetchTimeout(credential.rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${credential.token}` },
    body,
  }, Math.max(1_000, deadline - Date.now()))
  let data = await parseRpcResponse(response, peerId)
  const state = taskState(data)
  if (state === 'submitted' || state === 'working') {
    const id = taskId(data)
    if (!id) throw new A2AError(`Agent ${peerId} returned state "${state}" without a task id.`, true)
    onTaskState?.(state, id)
    data = await pollTask(env, credential, peerId, id, deadline, pollIntervalMs, onTaskState)
  }

  const terminal = terminalTaskError(data, peerId)
  if (terminal) throw terminal
  const output = extractAgentText(data).trim()
  if (!output) throw new A2AError(`Agent ${peerId} completed without text output.`, true)
  return output
}

function retryDelay(error, attempt, override) {
  if (override !== undefined) return Math.max(0, override)
  if (error.retryAfterMs !== undefined) return error.retryAfterMs
  return Math.min(4_000, 450 * (2 ** Math.max(0, attempt - 1))) + Math.floor(Math.random() * 250)
}

export async function callMfAgent(env, peerId, prompt, options = {}) {
  const body = JSON.stringify({
    jsonrpc: '2.0',
    method: 'message/send',
    id: crypto.randomUUID(),
    params: {
      message: {
        kind: 'message',
        role: 'user',
        messageId: crypto.randomUUID(),
        parts: [{ kind: 'text', text: prompt }],
      },
      configuration: { blocking: false },
    },
  })

  const attempts = Math.min(3, Math.max(1, options.attempts ?? DEFAULT_ATTEMPTS))
  const timeoutMs = Math.max(5_000, options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  const pollIntervalMs = Math.max(0, options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS)
  // timeoutMs is the budget for the whole call, not per attempt: the caller's
  // supervisor is sized against this number, so N attempts must not be able to
  // spend N × timeoutMs behind its back.
  const deadline = Date.now() + timeoutMs
  let lastError

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await executeAttempt(env, peerId, body, deadline, pollIntervalMs, options.onTaskState)
    } catch (error) {
      const failure = normalizeError(error)
      lastError = failure
      if (failure.refreshCredential) forgetPeerToken(env, peerId)
      if (!failure.retryable || attempt >= attempts) throw failure
      const delay = retryDelay(failure, attempt, options.retryDelayMs)
      // Only retry if a fresh attempt has room to finish inside the budget.
      if (deadline - Date.now() - delay < MIN_RETRY_ROOM_MS) throw failure
      if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay))
    }
  }
  throw lastError ?? new A2AError('Manyfold A2A call failed without an error.', false)
}

export function extractAgentText(data) {
  const result = data?.result
  if (!result) return JSON.stringify(data)
  const direct = textParts(result.parts)
  if (direct) return direct
  const artifacts = result.artifacts
  if (artifacts?.length) {
    const texts = artifacts
      .flatMap(artifact => artifact.parts ?? [])
      .flatMap(part => typeof part.text === 'string' && part.text ? [part.text] : [])
    if (texts.length) return texts.join('\n')
  }
  const status = textParts(result.status?.message?.parts)
  return status || JSON.stringify(result)
}

function textParts(parts) {
  return (parts ?? [])
    .flatMap(part => typeof part.text === 'string' && part.text ? [part.text] : [])
    .join('\n')
}

function extractJson(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const source = fenced ? fenced[1] : text
  const match = source.match(/\{[\s\S]*\}/)
  return (match?.[0] ?? '').trim()
}

function repairInnerQuotes(value) {
  return value.replace(/(?<=[\p{L}\p{N}）)】」』])"(?=[\p{L}\p{N}（(【「『])/gu, '\\"')
}

export async function runMfJson(env, peerId, { system, prompt, schema }, options = {}) {
  const fullPrompt = [
    system,
    prompt,
    'Respond with ONLY a single JSON object that validates against this JSON Schema — no code fences, no commentary:',
    JSON.stringify(schema),
  ].join('\n\n')
  const output = await callMfAgent(env, peerId, fullPrompt, options)
  const json = extractJson(output)
  if (!json) throw new Error('no JSON object in agent response')
  try {
    return JSON.parse(json)
  } catch (strictError) {
    try {
      return JSON.parse(repairInnerQuotes(json))
    } catch {
      throw new Error(`invalid JSON in agent response: ${safeErrorText(strictError)}`)
    }
  }
}
