/**
 * Admin HTTP surface for the Manyfold connect handshake.
 *
 * Behind the same session cookie and same-origin check as /api/admin/settings,
 * reused rather than duplicated: a second auth surface is a second thing to
 * get wrong. No response ever carries a device code or an agent bearer.
 */

import { A2AError, safeErrorText } from '../../pipeline/mf-client.mjs'
import { adminJson, isAdminAuthenticated, sameOrigin } from '../admin/settings.mjs'
import {
  cancelConnect,
  disconnectAgent,
  getConnectSession,
  listConnectedAgents,
  pollConnect,
  startConnect,
  verifyAgent,
} from '../mf/connect.mjs'
import { assignRoles, MF_ROLES, ROLE_LABELS, readConnection } from '../mf/store.mjs'

const CONNECT_PREFIX = '/api/admin/manyfold/connect'
const AGENTS_PREFIX = '/api/admin/manyfold/agents'
const ROLES_PATH = '/api/admin/manyfold/roles'

export function isMfConnectPath(pathname) {
  return pathname === CONNECT_PREFIX
    || pathname.startsWith(`${CONNECT_PREFIX}/`)
    || pathname === AGENTS_PREFIX
    || pathname.startsWith(`${AGENTS_PREFIX}/`)
    || pathname === ROLES_PATH
}

async function connectState(env) {
  const [agents, record, session] = await Promise.all([
    listConnectedAgents(env),
    readConnection(env),
    getConnectSession(env),
  ])
  return {
    agents,
    roles: record.roles,
    role_mode: record.roleMode,
    role_labels: ROLE_LABELS,
    session,
  }
}

export async function handleMfConnect(request, env) {
  const password = env.ADMIN_SETTINGS_PASSWORD
  if (!password) {
    return adminJson({ error: 'ADMIN_SETTINGS_PASSWORD is not configured for this Worker.' }, 503)
  }
  if (!sameOrigin(request)) return adminJson({ error: 'cross-site request rejected' }, 403)
  if (!await isAdminAuthenticated(request, password)) {
    return adminJson({ error: 'authentication required' }, 401)
  }

  const { pathname } = new URL(request.url)
  const method = request.method

  try {
    if (pathname === AGENTS_PREFIX && method === 'GET') {
      return adminJson(await connectState(env))
    }

    if (pathname === CONNECT_PREFIX && method === 'POST') {
      return adminJson(await startConnect(env, request.url))
    }

    const poll = pathname.match(/^\/api\/admin\/manyfold\/connect\/([^/]+)\/poll$/)
    if (poll && method === 'POST') {
      const outcome = await pollConnect(env, decodeURIComponent(poll[1]))
      return adminJson(
        outcome.status === 'approved' ? { ...outcome, ...(await connectState(env)) } : outcome,
      )
    }

    const cancel = pathname.match(/^\/api\/admin\/manyfold\/connect\/([^/]+)$/)
    if (cancel && method === 'DELETE') {
      await cancelConnect(env, decodeURIComponent(cancel[1]))
      return adminJson({ cancelled: true })
    }

    const verify = pathname.match(/^\/api\/admin\/manyfold\/agents\/([^/]+)\/verify$/)
    if (verify && method === 'POST') {
      await verifyAgent(env, decodeURIComponent(verify[1]))
      return adminJson(await connectState(env))
    }

    const remove = pathname.match(/^\/api\/admin\/manyfold\/agents\/([^/]+)$/)
    if (remove && method === 'DELETE') {
      await disconnectAgent(env, decodeURIComponent(remove[1]))
      return adminJson(await connectState(env))
    }

    if (pathname === ROLES_PATH && method === 'PUT') {
      let body
      try {
        body = await request.json()
      } catch {
        return adminJson({ error: 'invalid JSON body' }, 400)
      }
      if (!body?.roles || typeof body.roles !== 'object' || Array.isArray(body.roles)) {
        return adminJson({ error: 'roles must be an object' }, 400)
      }
      const requested = {}
      for (const role of MF_ROLES) {
        if (!Object.prototype.hasOwnProperty.call(body.roles, role)) continue
        const value = body.roles[role]
        if (value !== null && typeof value !== 'string') {
          return adminJson({ error: `${ROLE_LABELS[role]} must be an agent id or null` }, 400)
        }
        requested[role] = value
      }
      await assignRoles(env, requested)
      return adminJson(await connectState(env))
    }

    return adminJson({ error: 'not found' }, 404)
  } catch (error) {
    if (error instanceof A2AError) {
      return adminJson({ error: error.message }, error.retryable ? 502 : 400)
    }
    return adminJson({ error: safeErrorText(error instanceof Error ? error.message : error) }, 500)
  }
}
