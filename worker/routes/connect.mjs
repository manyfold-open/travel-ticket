// Trip-scoped HTTP wrappers around Composio's per-visitor connector helpers.
// The trip owns the visitor identity; clients use an HttpOnly visitor cookie
// instead of carrying visitor_id in every URL. Legacy query IDs are accepted
// only to migrate an existing browser into the cookie-backed session.
import { createConnectorLink, connectorStatus, connectorNames } from '../../pipeline/composio.mjs'
import { jsonResponse } from '../http.mjs'
import { resolveTripVisitorSession, sameOriginRequest } from '../trip-session.mjs'
import { withVisitorSession } from '../visitor-session.mjs'

const AUTH_CONFIG_ENV_KEY = {
  gmail: 'COMPOSIO_GMAIL_AUTH_CONFIG_ID',
  calendar: 'COMPOSIO_CALENDAR_AUTH_CONFIG_ID',
  notion: 'COMPOSIO_NOTION_AUTH_CONFIG_ID',
}

function providerError(provider) {
  return connectorNames().includes(provider) ? null : `unknown connector: ${provider}`
}

async function statusFor(env, provider, visitorId, deps) {
  const result = await connectorStatus({
    visitorId,
    connector: provider,
    apiKey: env.COMPOSIO_API_KEY,
    client: deps.client,
  })
  return { connected: result.status === 'connected', status: result.status }
}

export async function handleTripConnectorLink(request, env, tripId, provider, deps = {}) {
  if (!sameOriginRequest(request)) return jsonResponse({ error: 'cross-site request rejected' }, 403)
  const error = providerError(provider)
  if (error) return jsonResponse({ error }, 400)
  const visitor = await resolveTripVisitorSession(request, env, tripId)
  if (visitor.response) return visitor.response

  const result = await createConnectorLink({
    visitorId: visitor.visitorId,
    connector: provider,
    apiKey: env.COMPOSIO_API_KEY,
    authConfigId: env[AUTH_CONFIG_ENV_KEY[provider]],
    client: deps.client,
  })
  return withVisitorSession(jsonResponse(result, 200), visitor.setCookie)
}

export async function handleTripConnectorStatus(request, env, tripId, provider, deps = {}) {
  const error = providerError(provider)
  if (error) return jsonResponse({ error }, 400)
  const visitor = await resolveTripVisitorSession(request, env, tripId)
  if (visitor.response) return visitor.response

  const result = await statusFor(env, provider, visitor.visitorId, deps)
  return withVisitorSession(jsonResponse(result, 200), visitor.setCookie)
}

export async function handleTripConnectorsStatus(request, env, tripId, deps = {}) {
  const visitor = await resolveTripVisitorSession(request, env, tripId)
  if (visitor.response) return visitor.response

  const entries = await Promise.all(
    connectorNames().map(async provider => [
      provider,
      await statusFor(env, provider, visitor.visitorId, deps),
    ]),
  )
  return withVisitorSession(
    jsonResponse({ connectors: Object.fromEntries(entries) }, 200),
    visitor.setCookie,
  )
}
