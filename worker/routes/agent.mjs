// Direct binding to the user's Manyfold External Client. The bearer token is
// only used server-side for this trip and is never returned to the browser.
import { jsonResponse } from '../http.mjs'
import { resolveTripVisitorSession, sameOriginRequest } from '../trip-session.mjs'
import { withVisitorSession } from '../visitor-session.mjs'
import { callA2AAgent } from '../../pipeline/mf-client.mjs'

function tripJob(env, tripId) {
  return env.TRIP_JOBS.get(env.TRIP_JOBS.idFromName(tripId))
}

function normalizeRpcUrl(value) {
  const parsed = new URL(value)
  // Manyfold displays the agent URL in a compact form in External Client.
  // Its callable A2A route is the same URL with a /rpc suffix.
  if (/^\/api\/a2a\/agents\/[^/]+\/?$/.test(parsed.pathname)) {
    parsed.pathname = `${parsed.pathname.replace(/\/$/, '')}/rpc`
  }
  return parsed
}

function directCredential(body) {
  const rpcUrl = typeof body?.rpc_url === 'string' ? body.rpc_url.trim() : ''
  const token = typeof body?.bearer_token === 'string' ? body.bearer_token.trim() : ''
  if (!rpcUrl || !token) throw new Error('A2A RPC URL and bearer token are required')
  if (token.length > 4096) throw new Error('bearer token is too long')

  let parsed
  try {
    parsed = normalizeRpcUrl(rpcUrl)
  } catch {
    throw new Error('A2A RPC URL is invalid')
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && local)) {
    throw new Error('A2A RPC URL must use HTTPS')
  }
  if (parsed.username || parsed.password) throw new Error('A2A RPC URL must not contain userinfo')
  return { rpcUrl: parsed.toString(), token, agentName: parsed.hostname }
}

function connectionErrorMessage(error) {
  const message = String(error?.message || error || '')
  if (/HTTP 401\b|HTTP 403\b/i.test(message)) {
    return 'Manyfold rejected the bearer token. Copy a fresh token from External Client and make sure this caller is still enabled.'
  }
  if (/HTTP 404\b/i.test(message)) {
    return 'Manyfold could not find this agent endpoint. Copy the complete External Client URL, including the full agent ID and the final /rpc.'
  }
  return `Could not connect to Manyfold agent: ${message}`
}

export async function handleManyfoldAgentLink(request, env, tripId) {
  if (!sameOriginRequest(request)) return jsonResponse({ error: 'cross-site request rejected' }, 403)
  const visitor = await resolveTripVisitorSession(request, env, tripId)
  if (visitor.response) return visitor.response
  const job = tripJob(env, tripId)
  const state = await job.getStatus()
  if (!state) return jsonResponse({ error: 'unknown trip_id' }, 404)
  if (state.phase !== 'draft') return jsonResponse({ error: 'trip is no longer awaiting agent connection' }, 409)

  let credential
  try {
    credential = directCredential(await request.json())
  } catch (error) {
    return jsonResponse({ error: error.message }, 400)
  }

  try {
    await callA2AAgent(
      { rpcUrl: credential.rpcUrl, token: credential.token },
      'Travel Ticket connection test. Reply with a short confirmation that this A2A endpoint is ready.',
      { attempts: 1, timeoutMs: 15_000, peerId: credential.agentName },
    )
  } catch (error) {
    return jsonResponse({ error: connectionErrorMessage(error) }, 502)
  }

  const connected = await job.connectDirectAgent(credential.rpcUrl, credential.token, credential.agentName)
  if (!connected) return jsonResponse({ error: 'trip is no longer awaiting agent connection' }, 409)
  return withVisitorSession(
    jsonResponse({ status: 'connected', connected: true, agent_name: credential.agentName }, 200),
    visitor.setCookie,
  )
}

export async function handleManyfoldAgentStatus(request, env, tripId) {
  const visitor = await resolveTripVisitorSession(request, env, tripId)
  if (visitor.response) return visitor.response
  const binding = await tripJob(env, tripId).getAgentBinding()
  return withVisitorSession(
    jsonResponse({
      status: binding?.status ?? 'not_connected',
      connected: binding?.status === 'connected',
      ...(binding?.mode ? { mode: binding.mode } : {}),
      ...(binding?.agentName ? { agent_name: binding.agentName } : {}),
    }, 200),
    visitor.setCookie,
  )
}
