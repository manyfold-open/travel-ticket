// Manyfold A2A client shared by the local pipeline and Cloudflare Queue tasks.
// A message/send response may be a completed Message or an accepted Task. Task
// responses are polled with tasks/get so slow peers are never parsed before
// their final output exists.

const tokenCache = new Map()
const tokenInflight = new Map()
const DEFAULT_ATTEMPTS = 2
const DEFAULT_TIMEOUT_MS = 240_000
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
    .replace(/([?&](?:token|key|secret)=)[^&\s]+/gi, '$1[redacted]')
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

/**
 * A URL handed back by Manyfold is still untrusted input.
 *
 * Without this the Worker will POST a bearer token to whatever host a
 * handshake response names, turning one spoofed or compromised response into
 * credential exfiltration, or into a request against the cloud metadata
 * endpoint from inside the network boundary.
 */
export function validateA2AUrl(raw, { production = true, label = 'the agent RPC URL' } = {}) {
  let url
  try {
    url = new URL(raw)
  } catch {
    throw new A2AError(`${label} is not a valid URL.`, false)
  }
  if (url.username || url.password) {
    throw new A2AError(`${label} must not carry credentials in the URL.`, false)
  }
  if (url.protocol !== 'https:' && !(!production && url.protocol === 'http:')) {
    throw new A2AError(`${label} must use https.`, false)
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  const blocked = host === 'localhost'
    || host === '0.0.0.0'
    || host === '::'
    || host === '::1'
    || host.endsWith('.local')
    || /^127\./.test(host)
    || /^10\./.test(host)
    || /^192\.168\./.test(host)
    || /^169\.254\./.test(host)
    || /^172\.(1[6-9]|2\d|3[01])\./.test(host)
    || /^f[cd][0-9a-f]{2}:/i.test(host)
    || /^fe[89ab][0-9a-f]:/i.test(host)
  if (blocked && production) throw new A2AError(`${label} points at a private address.`, false)
  url.hash = ''
  return url.toString()
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

// Recovery is now the exception, not the main loop: the stream delivers the
// Task's whole life. These delays only cover a stream that broke after the Task
// was accepted, so the schedule is short and sparse — at most seven tasks/get
// requests, all clamped to the call deadline.
const RECOVERY_POLL_DELAYS_MS = [0, 2_000, 5_000, 10_000, 20_000, 40_000, 60_000]

async function recoverTask(env, credential, peerId, id, deadline, onTaskState, refreshCredential, initialState = '') {
  let previousState = initialState
  let pollFailures = 0
  // Diagnostics for the timeout message below. A bare "did not complete" cannot
  // distinguish a genuinely slow agent from a recovery loop that was failing
  // blind the whole time, and those need opposite fixes.
  const startedAt = Date.now()
  let polls = 0
  let consecutiveFailures = 0
  let lastFailure = ''

  for (const delay of RECOVERY_POLL_DELAYS_MS) {
    if (Date.now() >= deadline) break
    if (delay > 0) {
      await new Promise(resolve => setTimeout(resolve, Math.min(delay, Math.max(0, deadline - Date.now()))))
    }
    const remaining = deadline - Date.now()
    if (remaining <= 0) break
    polls += 1

    let data
    try {
      const response = await fetchTimeout(credential.rpcUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${credential.token}` },
        redirect: 'manual',
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
      if (failure.refreshCredential && env && refreshCredential) {
        forgetPeerToken(env, peerId)
        try {
          credential = await refreshCredential()
        } catch {
          // The Task already exists. Keep following it rather than resubmitting.
        }
      }
      onTaskState?.('poll-retrying', id, failure.message)
      const backoff = Math.min(retryDelay(failure, pollFailures), Math.max(0, deadline - Date.now()))
      if (backoff > 0) await new Promise(resolve => setTimeout(resolve, backoff))
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
    ? ` Last ${consecutiveFailures} recovery request(s) failed: ${lastFailure}`
    : ` Last observed state: ${previousState || 'none'}.`
  throw new A2AError(
    `Agent ${peerId} task ${id} did not complete within its wait budget`
    + `${canceled ? ' and was canceled' : ''} (waited ${waited}s over ${polls} recovery request(s)).${blind}`,
    false,
  )
}

/* ───────── SSE ───────── */

function createStreamAccumulator() {
  return { taskId: null, state: '', artifacts: new Map(), artifactOrder: [], directText: '', statusText: '' }
}

// Accepts the protobuf-style TASK_STATE_COMPLETED as well as the hyphenated
// wire form. Deliberately not whitelisted: an unrecognised state must stay
// truthy, because an empty state reads as "task finished, take the result".
function normalizeState(value) {
  return String(value ?? '').trim().toLowerCase().replace(/^task_state_/, '').replace(/_/g, '-')
}

function rememberArtifact(accumulator, artifact, append = false) {
  const artifactId = (typeof artifact.artifactId === 'string' && artifact.artifactId)
    || (typeof artifact.id === 'string' && artifact.id)
    || 'artifact'
  const text = textParts(Array.isArray(artifact.parts) ? artifact.parts : undefined)
  if (!accumulator.artifactOrder.includes(artifactId)) accumulator.artifactOrder.push(artifactId)
  accumulator.artifacts.set(
    artifactId,
    append ? `${accumulator.artifacts.get(artifactId) ?? ''}${text}` : text,
  )
}

function applyStreamResult(accumulator, raw) {
  if (!raw || typeof raw !== 'object') return
  const id = raw.taskId ?? raw.id
  if (typeof id === 'string' && id) accumulator.taskId = id
  const kind = String(raw.kind ?? '').trim().toLowerCase()

  if (kind === 'artifact-update' || raw.artifact) {
    if (raw.artifact && typeof raw.artifact === 'object') {
      rememberArtifact(accumulator, raw.artifact, raw.append === true)
    }
  }
  for (const artifact of Array.isArray(raw.artifacts) ? raw.artifacts : []) {
    rememberArtifact(accumulator, artifact)
  }
  if (kind === 'message' || (raw.role && raw.parts)) {
    accumulator.directText = textParts(Array.isArray(raw.parts) ? raw.parts : undefined) || accumulator.directText
  }
  const status = raw.status && typeof raw.status === 'object' ? raw.status : undefined
  const state = normalizeState(status?.state ?? raw.state)
  if (state) accumulator.state = state
  if (status?.message && typeof status.message === 'object') {
    accumulator.statusText = textParts(
      Array.isArray(status.message.parts) ? status.message.parts : undefined,
    ) || accumulator.statusText
  }
}

// Re-serialise into the exact envelope tasks/get returns, so extractAgentText,
// taskState, taskId and terminalTaskError serve the streaming path and the
// recovery path without special-casing either.
function streamTaskData(accumulator) {
  const artifacts = accumulator.artifactOrder
    .map(id => ({ artifactId: id, parts: [{ kind: 'text', text: accumulator.artifacts.get(id) ?? '' }] }))
    .filter(artifact => artifact.parts[0].text)
  return {
    jsonrpc: '2.0',
    result: {
      kind: 'task',
      status: {
        state: accumulator.state,
        ...(accumulator.statusText
          ? { message: { kind: 'message', role: 'agent', parts: [{ kind: 'text', text: accumulator.statusText }] } }
          : {}),
      },
      ...(accumulator.taskId ? { id: accumulator.taskId } : {}),
      ...(artifacts.length ? { artifacts } : {}),
      ...(!artifacts.length && accumulator.directText
        ? { parts: [{ kind: 'text', text: accumulator.directText }] }
        : {}),
    },
  }
}

function isTerminalTaskState(state) {
  return state === 'completed' || state === 'failed' || state === 'canceled'
    || state === 'rejected' || state === 'input-required' || state === 'auth-required'
}

/** Test helper: fold a sequence of JSON-RPC results into one task envelope. */
export function foldStreamResults(results) {
  const accumulator = createStreamAccumulator()
  for (const result of results) applyStreamResult(accumulator, result)
  return streamTaskData(accumulator)
}

/**
 * Read one message/stream response.
 *
 * Returns { data, interrupted } rather than throwing on a broken stream. Once
 * the agent has accepted a Task the turn is already being billed, so only the
 * caller can decide whether to follow it via tasks/get or give up; throwing
 * here would invite a resend and a second charge.
 */
async function readTaskStream(response, peerId, onTaskState) {
  if (!response.body) throw new A2AError(`Agent ${peerId} streaming response had no body.`, true)
  const accumulator = createStreamAccumulator()
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let received = false
  let previousState = ''
  let interrupted

  const applyBlock = (block) => {
    const payload = block
      .split(/\r?\n/)
      .filter(line => line.startsWith('data:'))
      .map(line => line.slice(5).trimStart())
      .join('\n')
    if (!payload || payload === '[DONE]') return
    let envelope
    try {
      envelope = JSON.parse(payload)
    } catch (error) {
      throw new A2AError(`Agent ${peerId} stream emitted invalid JSON. ${safeErrorText(error)}`, true)
    }
    const failure = rpcFailure(envelope, peerId)
    if (failure) throw failure
    applyStreamResult(accumulator, envelope.result)
    received = true
    if (accumulator.taskId && accumulator.state && accumulator.state !== previousState) {
      previousState = accumulator.state
      onTaskState?.(accumulator.state, accumulator.taskId)
    }
  }

  try {
    while (!isTerminalTaskState(accumulator.state)) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let boundary = buffer.match(/\r?\n\r?\n/)
      while (boundary?.index !== undefined) {
        applyBlock(buffer.slice(0, boundary.index))
        buffer = buffer.slice(boundary.index + boundary[0].length)
        if (isTerminalTaskState(accumulator.state)) break
        boundary = buffer.match(/\r?\n\r?\n/)
      }
    }
    buffer += decoder.decode()
    if (!isTerminalTaskState(accumulator.state) && buffer.trim()) applyBlock(buffer)
  } catch (error) {
    interrupted = normalizeError(error)
  } finally {
    if (isTerminalTaskState(accumulator.state)) await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }

  // Nothing arrived at all: no Task was accepted, so a retry is safe.
  if (!received && interrupted) throw interrupted
  if (!received) throw new A2AError(`Agent ${peerId} stream ended without A2A events.`, true)
  if (!isTerminalTaskState(accumulator.state) && !interrupted) {
    interrupted = new A2AError(`Agent ${peerId} stream ended before the Task reached a terminal state.`, true)
  }
  return { data: streamTaskData(accumulator), interrupted }
}

async function executeCredentialAttempt(env, credential, peerId, body, deadline, onTaskState, refreshCredential) {
  const response = await fetchTimeout(credential.rpcUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'text/event-stream',
      authorization: `Bearer ${credential.token}`,
    },
    // Never follow a redirect: a 3xx would replay the bearer against a host
    // that was never validated.
    redirect: 'manual',
    body,
  }, Math.max(1_000, deadline - Date.now()))

  let data
  let interrupted
  const contentType = (response.headers.get('content-type') ?? '').toLowerCase()
  if (!response.ok || !contentType.includes('text/event-stream')) {
    // A non-SSE 200 is still a usable answer: some deployments, and the local
    // mock, reply to a stream request with a plain JSON-RPC task envelope.
    data = await parseRpcResponse(response, peerId)
  } else {
    const outcome = await readTaskStream(response, peerId, onTaskState)
    data = outcome.data
    interrupted = outcome.interrupted
  }

  let state = taskState(data)
  const id = taskId(data)
  // An interruption with a task id means the turn is already running and being
  // billed, so follow it. Without an id nothing was accepted and the error can
  // propagate, leaving a retry safe.
  if (interrupted && id) {
    onTaskState?.('stream-recovering', id, interrupted.message)
  } else if (interrupted) {
    throw interrupted
  }
  if ((state === 'submitted' || state === 'working') && !id) {
    throw new A2AError(`Agent ${peerId} returned state "${state}" without a task id.`, true)
  }
  if (id && (state === 'submitted' || state === 'working' || !state)) {
    if (!interrupted && state) onTaskState?.(state, id)
    data = await recoverTask(env, credential, peerId, id, deadline, onTaskState, refreshCredential, state)
    state = taskState(data)
  }

  const terminal = terminalTaskError(data, peerId)
  if (terminal) throw terminal
  const output = extractAgentText(data).trim()
  if (!output) throw new A2AError(`Agent ${peerId} completed without text output.`, true)
  return output
}

async function executeAttempt(env, peerId, body, deadline, onTaskState) {
  const credential = await getPeerToken(env, peerId)
  return executeCredentialAttempt(
    env,
    credential,
    peerId,
    body,
    deadline,
    onTaskState,
    () => getPeerToken(env, peerId),
  )
}

// One SSE stream carries Task status and artifact updates, replacing the
// one-request-per-second tasks/get loop. A composer turn used to spend ~34
// subrequests on polling alone; it now spends one on the stream.
//
// messageId is A2A's idempotency key. Callers pass something derived from
// stable state rather than a fresh UUID, so a retried send of the same logical
// message cannot bill a second turn.
function messageBody(prompt, messageId) {
  return JSON.stringify({
    jsonrpc: '2.0',
    method: 'message/stream',
    id: crypto.randomUUID(),
    params: {
      message: {
        kind: 'message',
        role: 'user',
        messageId: messageId ?? crypto.randomUUID(),
        parts: [{ kind: 'text', text: prompt }],
      },
      configuration: { acceptedOutputModes: ['text/plain'] },
    },
  })
}

function retryDelay(error, attempt, override) {
  if (override !== undefined) return Math.max(0, override)
  if (error.retryAfterMs !== undefined) return error.retryAfterMs
  return Math.min(4_000, 450 * (2 ** Math.max(0, attempt - 1))) + Math.floor(Math.random() * 250)
}

export async function callMfAgent(env, peerId, prompt, options = {}) {
  const body = messageBody(prompt, options.messageId)

  const attempts = Math.min(3, Math.max(1, options.attempts ?? DEFAULT_ATTEMPTS))
  const timeoutMs = Math.max(5_000, options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  // timeoutMs is the budget for the whole call, not per attempt: the caller's
  // supervisor is sized against this number, so N attempts must not be able to
  // spend N × timeoutMs behind its back.
  const deadline = Date.now() + timeoutMs
  let lastError

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await executeAttempt(env, peerId, body, deadline, options.onTaskState)
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

export async function callA2AAgent(credential, prompt, options = {}) {
  if (!credential?.rpcUrl || !credential?.token) throw new Error('A2A RPC URL and bearer token are required')
  const body = messageBody(prompt, options.messageId)
  const attempts = Math.min(2, Math.max(1, options.attempts ?? 1))
  const timeoutMs = Math.max(5_000, options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  const peerId = options.peerId ?? 'external Manyfold agent'
  const deadline = Date.now() + timeoutMs
  let lastError

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await executeCredentialAttempt(
        null,
        credential,
        peerId,
        body,
        deadline,
        options.onTaskState,
      )
    } catch (error) {
      const failure = normalizeError(error)
      lastError = failure
      if (!failure.retryable || attempt >= attempts) throw failure
      const delay = retryDelay(failure, attempt, options.retryDelayMs)
      if (deadline - Date.now() - delay < MIN_RETRY_ROOM_MS) throw failure
      if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay))
    }
  }
  throw lastError ?? new A2AError('Direct Manyfold A2A call failed without an error.', false)
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

export async function runA2AJson(credential, { system, prompt, schema }, options = {}) {
  const fullPrompt = [
    system,
    prompt,
    'Respond with ONLY a single JSON object that validates against this JSON Schema — no code fences, no commentary:',
    JSON.stringify(schema),
  ].join('\n\n')
  const output = await callA2AAgent(credential, fullPrompt, options)
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
