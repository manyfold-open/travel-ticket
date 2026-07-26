import { jsonResponse } from './http.mjs'
import { resolveVisitorSession } from './visitor-session.mjs'

export function sameOriginRequest(request) {
  const fetchSite = request.headers.get('sec-fetch-site')
  if (fetchSite === 'cross-site') return false
  const origin = request.headers.get('origin')
  return !origin || origin === new URL(request.url).origin
}

export async function resolveTripVisitorSession(request, env, tripId) {
  const legacyVisitorId = new URL(request.url).searchParams.get('visitor_id')
  const visitor = resolveVisitorSession(request, legacyVisitorId)
  if (visitor.error) return { response: jsonResponse({ error: visitor.error }, 400) }

  const job = env.TRIP_JOBS.get(env.TRIP_JOBS.idFromName(tripId))
  const ownerVisitorId = await job.getVisitorId()
  if (!ownerVisitorId) {
    return { response: jsonResponse({ error: 'unknown trip_id' }, 404) }
  }
  if (ownerVisitorId !== visitor.visitorId) {
    return { response: jsonResponse({ error: 'trip does not belong to this browser session' }, 403) }
  }
  return visitor
}
