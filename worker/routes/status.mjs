// TripJob is the only workflow state source. GET /api/trips/:id is canonical;
// /status remains a temporary compatibility alias.
import { jsonResponse } from '../http.mjs'
import { tripLinks } from '../trip-links.mjs'
import { resolveTripVisitorSession, sameOriginRequest } from '../trip-session.mjs'
import { withVisitorSession } from '../visitor-session.mjs'

export async function handleTripStatus(env, tripId) {
  if (!env.TRIP_JOBS) return jsonResponse({ error: 'unknown trip_id' }, 404)
  const job = env.TRIP_JOBS.get(env.TRIP_JOBS.idFromName(tripId))
  const status = await job.getStatus()
  if (!status) return jsonResponse({ error: 'unknown trip_id' }, 404)
  return jsonResponse({ ...status, links: tripLinks(tripId) }, 200)
}

export async function handleStartTrip(request, env, tripId) {
  if (!sameOriginRequest(request)) return jsonResponse({ error: 'cross-site request rejected' }, 403)
  if (!env.TRIP_JOBS) return jsonResponse({ error: 'unknown trip_id' }, 404)
  const visitor = await resolveTripVisitorSession(request, env, tripId)
  if (visitor.response) return visitor.response
  const job = env.TRIP_JOBS.get(env.TRIP_JOBS.idFromName(tripId))
  const status = await job.start()
  if (!status) return jsonResponse({ error: 'unknown trip_id' }, 404)
  const links = tripLinks(tripId)
  const active = status.phase === 'queued' || status.phase === 'running'
  return withVisitorSession(
    jsonResponse(
      { ...status, links },
      active ? 202 : 200,
      { location: active ? links.progress : status.phase === 'done' ? links.result : links.self },
    ),
    visitor.setCookie,
  )
}
