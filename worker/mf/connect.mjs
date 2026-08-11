/**
 * Manyfold connect: the operator authorizes on Manyfold's own page and picks
 * which agents to share.
 *
 *   POST {base}/api/connect/a2a/start  {clientName, clientUrl?}
 *        → { requestId, userCode, authUrl, deviceCode, expiresAt }
 *   the operator opens authUrl, checks userCode matches, ticks agents
 *   POST {base}/api/connect/a2a/poll   {deviceCode}
 *        → pending | denied | expired
 *        | approved { userEmail, agents[{ agentId, name, rpcUrl, cardUrl, token, expiresAt }] }
 *
 * Invariants:
 *  - the device code is the only thing that can redeem agent tokens, so it
 *    stays server-side and sealed; the browser sees an opaque connectId;
 *  - the confirmation code must be shown to the operator. Comparing it against
 *    Manyfold's page is the only anti-phishing check in this flow;
 *  - every agent rpcUrl goes through validateA2AUrl before it is stored;
 *  - connectivity is checked with a tasks/get probe for an id that cannot
 *    exist, never a real turn, so connecting N agents never bills N turns;
 *  - a failed probe warns but does not discard the credential: the token has
 *    already been issued, and dropping it would leave a live grant nobody can
 *    revoke.
 *
 * STORAGE CAVEAT: the reference implementation burns the one-time credential
 * with an atomic D1 update guarded on status='pending'. KV has no
 * compare-and-set, so two polls landing in different isolates can both reach
 * Manyfold. Manyfold releases credentials once, so the loser sees 'expired'
 * and no duplicate agent is stored — but that is Manyfold's guarantee, not
 * ours, and it should not be described as equivalent.
 */

import { A2AError, fetchTimeout, safeErrorText } from '../../pipeline/mf-client.mjs'
import { seal, unseal } from './crypto.mjs'
import {
  addOrReplaceAgent,
  autoAssignRoles,
  markAgentState,
  openCredential,
  publicAgent,
  readConnection,
  removeAgent,
  sealCredential,
  writeConnection,
} from './store.mjs'

const DEFAULT_API_BASE = 'https://api.manyfold.ai'
const CLIENT_NAME = 'Travel Ticket'
const START_TIMEOUT_MS = 20_000
const POLL_TIMEOUT_MS = 30_000
const SESSION_TTL_MS = 15 * 60_000
const CARD_TIMEOUT_MS = 10_000
const PROBE_TIMEOUT_MS = 20_000
const SESSION_KEY = 'mf:connect-session:v1'

const apiBase = env => String(env?.MANYFOLD_API_BASE_URL || DEFAULT_API_BASE).replace(/\/+$/, '')
const isProduction = env => env?.ENVIRONMENT === 'production'
const now = () => new Date().toISOString()

/** Thrown on a poll 404 that means "device code gone", not "wrong base URL". */
class DeviceCodeGone extends Error {}

async function connectFetch(env, path, body, timeoutMs) {
  const response = await fetchTimeout(`${apiBase(env)}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    redirect: 'manual',
    body: JSON.stringify(body),
  }, timeoutMs)

  const text = await response.text()
  let parsed = null
  try {
    parsed = text ? JSON.parse(text) : null
  } catch {
    /* not JSON */
  }

  if (!response.ok) {
    const message = String(parsed?.error?.message ?? `Manyfold returned ${response.status}.`)
    if (response.status === 404) {
      // A 404 means two different things and only the body tells them apart: a
      // dead device code answers "deviceCode not found", a mistyped base URL
      // answers with the router's "Cannot POST /…". start never carries a
      // device code, so any 404 there is configuration.
      const wrongPath = path.endsWith('/start') || /cannot\s+(post|get)/i.test(message)
      if (!wrongPath) throw new DeviceCodeGone(message)
      throw new A2AError(
        `${apiBase(env)}${path} does not exist (404). Check MANYFOLD_API_BASE_URL in wrangler.toml.`,
        false,
      )
    }
    throw new A2AError(`Manyfold rejected the request: ${safeErrorText(message)}`, response.status >= 500)
  }
  return parsed
}

async function readSession(env) {
  const raw = await env.TRIPS_KV.get(SESSION_KEY)
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw)
    if (!parsed?.deviceCodeCt) return parsed
    return { ...parsed, deviceCode: await unseal(env, parsed.deviceCodeCt, parsed.deviceCodeIv) }
  } catch {
    return null
  }
}

async function writeSession(env, session) {
  const { deviceCode, ...rest } = session
  const sealed = deviceCode ? await seal(env, deviceCode) : { ciphertext: '', iv: '' }
  const ttlSeconds = Math.max(60, Math.ceil((Date.parse(session.expiresAt) - Date.now()) / 1000) + 60)
  await env.TRIPS_KV.put(
    SESSION_KEY,
    JSON.stringify({ ...rest, deviceCodeCt: sealed.ciphertext, deviceCodeIv: sealed.iv }),
    { expirationTtl: ttlSeconds },
  )
}

/** Best-effort description from the public agent card; no bearer is sent. */
async function describeFromCard(cardUrl) {
  try {
    const response = await fetchTimeout(
      cardUrl,
      { method: 'GET', headers: { accept: 'application/json' }, redirect: 'manual' },
      CARD_TIMEOUT_MS,
    )
    if (!response.ok) return ''
    const card = await response.json()
    return typeof card.description === 'string' ? card.description.slice(0, 240) : ''
  } catch {
    return ''
  }
}

/**
 * Auth-only probe: ask for a task id that cannot exist.
 *
 * Never message/stream. Verifying N agents must not bill N turns; a JSON-RPC
 * "no such task" answer already proves the token and endpoint work.
 */
async function probeAgentAuth({ rpcUrl, token, label }) {
  const response = await fetchTimeout(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    redirect: 'manual',
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'tasks/get',
      id: crypto.randomUUID(),
      params: { id: `probe-${crypto.randomUUID()}` },
    }),
  }, PROBE_TIMEOUT_MS)
  if (response.status === 401 || response.status === 403) {
    throw new A2AError(`${label} rejected this token (HTTP ${response.status}).`, false, true)
  }
  if (!response.ok && response.status >= 500) {
    throw new A2AError(`${label} is temporarily unavailable (HTTP ${response.status}).`, true)
  }
}

export async function startConnect(env, requestUrl) {
  const origin = new URL(requestUrl).origin
  // clientUrl is optional and Manyfold requires https, so a local http origin
  // is omitted rather than rejected.
  const clientUrl = origin.startsWith('https://') ? origin : undefined

  const started = await connectFetch(
    env,
    '/api/connect/a2a/start',
    { clientName: CLIENT_NAME, ...(clientUrl ? { clientUrl } : {}) },
    START_TIMEOUT_MS,
  )
  if (!started?.deviceCode || !started.authUrl || !started.userCode) {
    throw new A2AError('Manyfold returned an incomplete handshake.', true)
  }

  const remote = Date.parse(started.expiresAt ?? '')
  const expiresAt = Number.isFinite(remote)
    ? new Date(remote).toISOString()
    : new Date(Date.now() + SESSION_TTL_MS).toISOString()
  const connectId = crypto.randomUUID()

  await writeSession(env, {
    v: 1,
    connectId,
    requestId: started.requestId,
    userCode: started.userCode,
    authUrl: started.authUrl,
    deviceCode: started.deviceCode,
    status: 'pending',
    createdAt: now(),
    expiresAt,
  })

  // deviceCode is deliberately not returned.
  return { connectId, userCode: started.userCode, authUrl: started.authUrl, expiresAt }
}

export async function getConnectSession(env) {
  const session = await readSession(env)
  if (!session || session.status !== 'pending') return null
  if (Date.parse(session.expiresAt) <= Date.now()) return null
  return {
    connectId: session.connectId,
    userCode: session.userCode,
    authUrl: session.authUrl,
    expiresAt: session.expiresAt,
  }
}

export async function cancelConnect(env, connectId) {
  const session = await readSession(env)
  if (session && session.connectId !== connectId) return
  await env.TRIPS_KV.delete(SESSION_KEY)
}

// Isolate-local single-flight. Not the atomic burn D1 gives (see the header);
// it only collapses a browser polling faster than one round trip completes.
const inflight = new Map()

export async function pollConnect(env, connectId) {
  const pending = inflight.get(connectId)
  if (pending) return pending
  const run = pollOnce(env, connectId).finally(() => {
    if (inflight.get(connectId) === run) inflight.delete(connectId)
  })
  inflight.set(connectId, run)
  return run
}

async function pollOnce(env, connectId) {
  const session = await readSession(env)
  if (!session || session.connectId !== connectId) {
    throw new A2AError('That authorization session no longer exists.', false)
  }
  if (session.status !== 'pending') return { status: 'expired' }
  if (Date.parse(session.expiresAt) <= Date.now()) {
    await writeSession(env, { ...session, status: 'expired', deviceCode: '' })
    return { status: 'expired' }
  }

  let result
  try {
    result = await connectFetch(env, '/api/connect/a2a/poll', { deviceCode: session.deviceCode }, POLL_TIMEOUT_MS)
  } catch (error) {
    if (error instanceof DeviceCodeGone) {
      await writeSession(env, { ...session, status: 'expired', deviceCode: '' })
      return { status: 'expired' }
    }
    throw error
  }

  if (result.status !== 'approved') {
    if (result.status !== 'pending') {
      await writeSession(env, { ...session, status: result.status, deviceCode: '' })
    }
    return { status: result.status }
  }

  // Credentials are delivered once. Burn the session and wipe the used device
  // code before consuming them, so a replayed poll cannot re-enter this branch.
  await writeSession(env, { ...session, status: 'exchanged', deviceCode: '' })

  const saved = []
  const failed = []
  for (const entry of result.agents ?? []) {
    try {
      saved.push(publicAgent(await storeApprovedAgent(env, entry)))
    } catch (error) {
      failed.push({
        name: entry?.name || 'unknown agent',
        error: safeErrorText(error instanceof Error ? error.message : error),
      })
    }
  }

  const record = await readConnection(env)
  record.userEmail = result.userEmail ?? record.userEmail ?? null
  await writeConnection(env, record)

  return { status: 'approved', userEmail: record.userEmail, agents: saved, failed }
}

async function storeApprovedAgent(env, entry) {
  if (!entry?.agentId || !entry.token) {
    throw new A2AError('Manyfold returned an agent without an id or token.', false)
  }
  const name = (entry.name || 'Manyfold agent').slice(0, 80)
  const sealed = await sealCredential(env, {
    rpcUrl: entry.rpcUrl,
    token: entry.token,
    name,
    expiresAt: entry.expiresAt ?? null,
    production: isProduction(env),
  })
  const description = entry.cardUrl ? await describeFromCard(entry.cardUrl) : ''

  let verified = true
  let warning = null
  try {
    await probeAgentAuth({ rpcUrl: sealed.rpcUrl, token: entry.token, label: name })
  } catch (error) {
    verified = false
    warning = safeErrorText(error instanceof Error ? error.message : error)
  }

  const agent = {
    agentId: entry.agentId,
    name,
    description,
    ...sealed,
    verified,
    warning,
    connectedAt: now(),
  }
  await addOrReplaceAgent(env, agent)
  return agent
}

export async function listConnectedAgents(env) {
  const record = await readConnection(env)
  return record.agents.map(publicAgent)
}

export async function verifyAgent(env, agentId) {
  const record = await readConnection(env)
  const agent = record.agents.find(candidate => candidate.agentId === agentId)
  if (!agent) throw new A2AError('That agent is not connected.', false)
  try {
    const credential = await openCredential(env, agent)
    await probeAgentAuth({ ...credential, label: agent.name })
    await markAgentState(env, agentId, { verified: true, warning: null })
  } catch (error) {
    await markAgentState(env, agentId, {
      verified: false,
      warning: safeErrorText(error instanceof Error ? error.message : error),
    })
  }
  return publicAgent((await readConnection(env)).agents.find(candidate => candidate.agentId === agentId))
}

export async function disconnectAgent(env, agentId) {
  await removeAgent(env, agentId)
}

export { autoAssignRoles }
