// Trip-scoped wrappers around the user's Manyfold connector agent. Travel Ticket
// never receives Composio credentials and never creates a provider connection.
import { CONNECTOR_NAMES } from '../../pipeline/agents.mjs'
import { jsonResponse } from '../http.mjs'
import { resolveTripVisitorSession, sameOriginRequest } from '../trip-session.mjs'
import { withVisitorSession } from '../visitor-session.mjs'

function defaultProviderReadiness() {
  return Object.fromEntries(CONNECTOR_NAMES.map(provider => [provider, { status: 'not_connected', message: '' }]))
}

function providerError(provider) {
  return CONNECTOR_NAMES.includes(provider) ? null : `unknown connector: ${provider}`
}

function unavailable(provider, message = 'Connect your Manyfold agent first.') {
  return {
    connected: false,
    status: 'configuration_required',
    message,
    provider,
  }
}

async function bindingFor(env, tripId) {
  const job = env.TRIP_JOBS.get(env.TRIP_JOBS.idFromName(tripId))
  return typeof job.getAgentBinding === 'function' ? job.getAgentBinding() : null
}

function providerStatus(binding, provider) {
  const item = binding?.providers?.[provider]
  return item
    ? { connected: item.status === 'connected', status: item.status, message: item.message, provider }
    : unavailable(provider)
}

export async function handleTripConnectorLink(request, env, tripId, provider) {
  if (!sameOriginRequest(request)) return jsonResponse({ error: 'cross-site request rejected' }, 403)
  const error = providerError(provider)
  if (error) return jsonResponse({ error }, 400)
  const visitor = await resolveTripVisitorSession(request, env, tripId)
  if (visitor.response) return visitor.response

  const binding = await bindingFor(env, tripId)
  const result = binding?.status === 'connected'
    ? {
      ...providerStatus(binding, provider),
      connected: false,
      status: 'authorization_required',
      message: 'Provider setup is owned by Manyfold. Reopen the Manyfold install page to change it.',
      setup_in_manyfold: true,
    }
    : unavailable(provider)
  return withVisitorSession(jsonResponse(result, 200), visitor.setCookie)
}

export async function handleTripConnectorStatus(request, env, tripId, provider) {
  const error = providerError(provider)
  if (error) return jsonResponse({ error }, 400)
  const visitor = await resolveTripVisitorSession(request, env, tripId)
  if (visitor.response) return visitor.response

  const result = providerStatus(await bindingFor(env, tripId), provider)
  return withVisitorSession(jsonResponse(result, result.status === 'error' ? 502 : 200), visitor.setCookie)
}

export async function handleTripConnectorsStatus(request, env, tripId) {
  const visitor = await resolveTripVisitorSession(request, env, tripId)
  if (visitor.response) return visitor.response
  const binding = await bindingFor(env, tripId)
  const readiness = binding?.providers ?? defaultProviderReadiness()
  return withVisitorSession(
    jsonResponse({
      agent: binding?.status === 'connected' ? 'connected' : 'not_connected',
      agent_name: binding?.agentName,
      connectors: Object.fromEntries(CONNECTOR_NAMES.map(provider => [provider, {
        ...readiness[provider],
        connected: readiness[provider].status === 'connected',
        provider,
      }])),
    }, 200),
    visitor.setCookie,
  )
}
