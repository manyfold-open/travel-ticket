/**
 * The Manyfold connection record: which agents are connected, which role each
 * serves, and their sealed bearers.
 *
 * Lives in TRIPS_KV rather than a new D1 binding. It is one small
 * single-writer record read once per job start, and adding D1 would mean
 * provisioning a database in CI plus a literal database_id in wrangler.toml,
 * which scripts/validate-repository.mjs rejects on purpose.
 */

import { seal, unseal } from './crypto.mjs'
import { validateA2AUrl } from '../../pipeline/mf-client.mjs'

export const CONNECTION_KEY = 'mf:connection:v1'

/** The four roles the deployed DAG actually runs. */
export const MF_ROLES = ['brief', 'discovery', 'composer', 'theme']

export const ROLE_LABELS = {
  brief: 'Trip Brief',
  discovery: 'Local Discovery',
  composer: 'Itinerary Composer',
  theme: 'Theme Designer',
}

/**
 * How long a credential must still be good for before a trip may be queued.
 *
 * The DAG's critical path is roughly brief 300s + discovery 420s + composer
 * 480s + theme 240s, about 24 minutes, plus queue retry backoff and lease
 * expiries. 45 minutes covers it with room. Connect grants last days, so this
 * normally passes; it exists so a lapsing grant fails as a reconnect prompt
 * instead of dying four tasks in.
 */
export const JOB_CREDENTIAL_HORIZON_MS = 45 * 60_000

const emptyRoles = () => ({ brief: null, discovery: null, composer: null, theme: null })

const emptyRecord = () => ({
  v: 1,
  updatedAt: '',
  userEmail: null,
  agents: [],
  roles: emptyRoles(),
  roleMode: 'auto',
})

export async function readConnection(env) {
  const raw = await env.TRIPS_KV.get(CONNECTION_KEY)
  if (!raw) return emptyRecord()
  try {
    const parsed = JSON.parse(raw)
    if (!parsed || !Array.isArray(parsed.agents)) return emptyRecord()
    return { ...emptyRecord(), ...parsed, roles: { ...emptyRoles(), ...(parsed.roles || {}) } }
  } catch {
    return emptyRecord()
  }
}

export async function writeConnection(env, record) {
  record.updatedAt = new Date().toISOString()
  await env.TRIPS_KV.put(CONNECTION_KEY, JSON.stringify(record))
  return record
}

/** Strips the sealed bearer. Anything reaching an HTTP response goes through this. */
export function publicAgent(agent) {
  const { tokenCt, tokenIv, ...rest } = agent
  return rest
}

const ROLE_HINTS = {
  brief: /brief|intake|plan/,
  discovery: /discover|research|local|search|explore/,
  composer: /compos|itinerar|schedule/,
  theme: /theme|design|visual|style/,
}

/**
 * Decide which agent serves each role.
 *
 * Once the operator has set a role by hand the record flips to roleMode
 * 'manual' and the heuristic stops overwriting choices. A role whose agent
 * disappears is cleared rather than silently reassigned: quietly moving the
 * composer to a different agent mid-product is worse than saying "pick one".
 */
export function autoAssignRoles(record) {
  const connected = new Set(record.agents.map(agent => agent.agentId))
  const roles = { ...emptyRoles(), ...record.roles }

  for (const role of MF_ROLES) {
    if (roles[role] && !connected.has(roles[role])) roles[role] = null
  }
  if (!record.agents.length) return { ...record, roles }
  if (record.roleMode === 'manual') return { ...record, roles }

  const fallback = record.agents.find(agent => agent.verified)?.agentId ?? record.agents[0].agentId
  if (record.agents.length === 1) {
    for (const role of MF_ROLES) roles[role] ??= fallback
    return { ...record, roles }
  }

  const taken = new Set(Object.values(roles).filter(Boolean))
  for (const role of MF_ROLES) {
    if (roles[role]) continue
    const hint = ROLE_HINTS[role]
    const match = record.agents.find(agent => !taken.has(agent.agentId)
      && hint.test(`${agent.name} ${agent.description || ''}`.toLowerCase()))
    if (match) {
      roles[role] = match.agentId
      taken.add(match.agentId)
    }
  }
  for (const role of MF_ROLES) roles[role] ??= fallback
  return { ...record, roles }
}

export async function assignRoles(env, requested) {
  const record = await readConnection(env)
  const connected = new Set(record.agents.map(agent => agent.agentId))
  for (const role of MF_ROLES) {
    if (!Object.prototype.hasOwnProperty.call(requested, role)) continue
    const value = requested[role]
    if (value === null || value === '') {
      record.roles[role] = null
      continue
    }
    if (!connected.has(value)) {
      throw new Error(`"${value}" is not a connected agent, so it cannot serve ${ROLE_LABELS[role]}.`)
    }
    record.roles[role] = value
  }
  // An explicit choice ends automatic reassignment for this record.
  record.roleMode = 'manual'
  return writeConnection(env, record)
}

export async function addOrReplaceAgent(env, agent) {
  const record = await readConnection(env)
  const index = record.agents.findIndex(candidate => candidate.agentId === agent.agentId)
  if (index >= 0) record.agents[index] = agent
  else record.agents.push(agent)
  return writeConnection(env, autoAssignRoles(record))
}

export async function removeAgent(env, agentId) {
  const record = await readConnection(env)
  record.agents = record.agents.filter(agent => agent.agentId !== agentId)
  return writeConnection(env, autoAssignRoles(record))
}

export async function markAgentState(env, agentId, { verified, warning }) {
  const record = await readConnection(env)
  const agent = record.agents.find(candidate => candidate.agentId === agentId)
  if (!agent) return record
  agent.verified = verified
  agent.warning = warning ?? null
  return writeConnection(env, record)
}

export async function sealCredential(env, { rpcUrl, token, name, expiresAt, production }) {
  const sealed = await seal(env, token)
  return {
    rpcUrl: validateA2AUrl(rpcUrl, { production, label: "the agent's rpcUrl" }),
    tokenCt: sealed.ciphertext,
    tokenIv: sealed.iv,
    name,
    expiresAt: expiresAt ?? null,
  }
}

/** Decrypts a stored credential into the { rpcUrl, token } the client wants. */
export async function openCredential(env, sealed) {
  return {
    rpcUrl: sealed.rpcUrl,
    token: await unseal(env, sealed.tokenCt, sealed.tokenIv),
    label: sealed.name || 'Manyfold agent',
  }
}

/**
 * Resolve every role to a credential good for the next `horizonMs`.
 *
 * Returns sealed credentials, not open ones: they are snapshotted into the
 * Durable Object so the whole DAG runs against one consistent set, and an
 * unsealed bearer has no business sitting in DO storage.
 */
export async function resolveRoleCredentials(env, { horizonMs = JOB_CREDENTIAL_HORIZON_MS } = {}) {
  const record = await readConnection(env)
  const byId = new Map(record.agents.map(agent => [agent.agentId, agent]))
  const credentials = {}
  const problems = []
  const deadline = Date.now() + horizonMs

  for (const role of MF_ROLES) {
    const agentId = record.roles[role]
    const agent = agentId ? byId.get(agentId) : null
    if (!agent) {
      problems.push({ role, reason: agentId ? 'assigned agent is no longer connected' : 'no agent assigned' })
      continue
    }
    const expiresAt = agent.expiresAt ? Date.parse(agent.expiresAt) : Number.NaN
    if (Number.isFinite(expiresAt) && expiresAt <= Date.now()) {
      problems.push({ role, reason: 'authorization expired' })
      continue
    }
    if (Number.isFinite(expiresAt) && expiresAt <= deadline) {
      problems.push({ role, reason: 'authorization expires before this trip could finish' })
      continue
    }
    credentials[role] = {
      rpcUrl: agent.rpcUrl,
      tokenCt: agent.tokenCt,
      tokenIv: agent.tokenIv,
      name: agent.name,
      expiresAt: agent.expiresAt,
    }
  }

  return {
    ok: problems.length === 0 && record.agents.length > 0,
    credentialRev: record.updatedAt,
    credentials,
    problems: record.agents.length
      ? problems
      : [{ role: 'brief', reason: 'no Manyfold agents are connected' }],
  }
}
