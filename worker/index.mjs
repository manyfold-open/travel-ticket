// Canonical Worker router. Browser pages, JSON APIs and generated trip sites
// share one origin in local Wrangler and production. The old Node Studio is a
// separate local tool and does not participate in this route table.
import { handleCreateTrip } from './routes/create-trip.mjs'
import {
  handleTripConnectorLink,
  handleTripConnectorStatus,
  handleTripConnectorsStatus,
} from './routes/connect.mjs'
import { handleConfig } from './routes/config.mjs'
import { handleStartTrip, handleTripStatus } from './routes/status.mjs'
import {
  handleAdminSettings,
  isAdminSettingsPath,
} from './admin/settings.mjs'
import {
  guardTravelTicketAccess,
  handleTravelTicketAccess,
  isTravelTicketAccessApiPath,
  isTravelTicketAccessPagePath,
} from './access-control.mjs'
import { jsonResponse, methodNotAllowed, redirectResponse } from './http.mjs'
import { getTripFile } from './storage.mjs'

const TRIP_ID_RE = /^[A-Za-z0-9_-]{8,128}$/
const PAGE_METHODS = ['GET', 'HEAD']
const SETTINGS_ASSET_PATHS = new Set(['/settings.css', '/settings.js'])

function validTripId(value) {
  return typeof value === 'string' && TRIP_ID_RE.test(value)
}

function assetRequest(request, url, path) {
  return new Request(new URL(path, url), request)
}

function htmlNotFound(message = 'not found') {
  return new Response(
    `<!doctype html><html lang="en-GB"><meta charset="utf-8"><title>Not found · Trip Ticket</title><body><main><h1>Page not found</h1><p>${message}</p><p><a href="/">Return to Trip Ticket</a></p></main></body></html>`,
    {
      status: 404,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      },
    },
  )
}

function apiTripId(segments) {
  const tripId = segments[1]
  return validTripId(tripId) ? tripId : null
}

async function routeApi(request, env, segments) {
  if (segments.length === 1 && segments[0] === 'config') {
    if (request.method !== 'GET') return methodNotAllowed(['GET'])
    return handleConfig(env)
  }
  if (segments[0] !== 'trips') return jsonResponse({ error: 'not found' }, 404)

  if (segments.length === 1) {
    if (request.method !== 'POST') return methodNotAllowed(['POST'])
    return handleCreateTrip(request, env)
  }

  const tripId = apiTripId(segments)
  if (!tripId) return jsonResponse({ error: 'invalid trip_id' }, 400)

  // Canonical trip resource: its representation is the workflow snapshot.
  if (segments.length === 2) {
    if (request.method !== 'GET') return methodNotAllowed(['GET'])
    return handleTripStatus(env, tripId)
  }

  if (segments.length === 3 && segments[2] === 'start') {
    if (request.method !== 'POST') return methodNotAllowed(['POST'])
    return handleStartTrip(request, env, tripId)
  }

  // Compatibility alias for clients deployed before the route redesign.
  if (segments.length === 3 && segments[2] === 'status') {
    if (request.method !== 'GET') return methodNotAllowed(['GET'])
    return handleTripStatus(env, tripId)
  }

  if (segments.length === 3 && segments[2] === 'connectors') {
    if (request.method !== 'GET') return methodNotAllowed(['GET'])
    return handleTripConnectorsStatus(request, env, tripId)
  }
  if (segments.length === 4 && segments[2] === 'connectors') {
    if (request.method !== 'GET') return methodNotAllowed(['GET'])
    return handleTripConnectorStatus(request, env, tripId, segments[3])
  }
  if (segments.length === 5 && segments[2] === 'connectors' && segments[4] === 'link') {
    if (request.method !== 'POST') return methodNotAllowed(['POST'])
    return handleTripConnectorLink(request, env, tripId, segments[3])
  }

  // Compatibility aliases. The handler validates that the legacy visitor_id
  // belongs to the trip and upgrades it into the HttpOnly visitor cookie.
  if (segments.length === 5 && segments[2] === 'connect' && segments[4] === 'link') {
    if (request.method !== 'POST') return methodNotAllowed(['POST'])
    return handleTripConnectorLink(request, env, tripId, segments[3])
  }
  if (segments.length === 5 && segments[2] === 'connect' && segments[4] === 'status') {
    if (request.method !== 'GET') return methodNotAllowed(['GET'])
    return handleTripConnectorStatus(request, env, tripId, segments[3])
  }

  return jsonResponse({ error: 'not found' }, 404)
}

async function routeTripSite(request, env, tripId, rest) {
  if (!PAGE_METHODS.includes(request.method)) return methodNotAllowed(PAGE_METHODS, { json: false })
  const path = rest.length === 0 ? 'index.html' : rest.join('/')
  const file = await getTripFile(env, tripId, path)

  if (!file && path === 'index.html') {
    const job = env.TRIP_JOBS.get(env.TRIP_JOBS.idFromName(tripId))
    const status = await job.getStatus()
    if (status?.phase === 'draft') return redirectResponse(`/trips/${encodeURIComponent(tripId)}/connect`, 302)
    if (status?.phase === 'queued' || status?.phase === 'running' || status?.phase === 'error') {
      return redirectResponse(`/trips/${encodeURIComponent(tripId)}/progress`, 302)
    }
  }
  if (!file) return htmlNotFound('This itinerary does not exist or has expired.')
  if (request.method === 'HEAD') {
    return new Response(null, { status: file.status, statusText: file.statusText, headers: file.headers })
  }
  return file
}

async function routeTripUi(request, env, url, tripId, page) {
  if (!PAGE_METHODS.includes(request.method)) return methodNotAllowed(PAGE_METHODS, { json: false })
  if (url.pathname.endsWith('/')) return redirectResponse(url.pathname.slice(0, -1) + url.search, 308)

  const job = env.TRIP_JOBS.get(env.TRIP_JOBS.idFromName(tripId))
  const status = await job.getStatus()
  if (!status) return htmlNotFound('This itinerary does not exist or has expired.')

  const encoded = encodeURIComponent(tripId)
  if (page === 'connect' && status.phase !== 'draft') {
    return redirectResponse(
      status.phase === 'done' ? `/trips/${encoded}/` : `/trips/${encoded}/progress`,
      302,
    )
  }
  if (page === 'progress' && status.phase === 'draft') {
    return redirectResponse(`/trips/${encoded}/connect`, 302)
  }
  if (page === 'progress' && status.phase === 'done') {
    return redirectResponse(`/trips/${encoded}/`, 302)
  }
  return env.ASSETS.fetch(assetRequest(request, url, `/${page}`))
}

function legacyTripPage(url, page) {
  const tripId = url.searchParams.get('trip')
  return validTripId(tripId)
    ? redirectResponse(`/trips/${encodeURIComponent(tripId)}/${page}`, 308)
    : redirectResponse('/', 302)
}

export async function handleFetch(request, env) {
  const url = new URL(request.url)
  const { pathname } = url
  const segments = pathname.split('/').filter(Boolean)

  if (isAdminSettingsPath(pathname)) return handleAdminSettings(request, env)

  if (pathname === '/settings.html' || pathname === '/settings/') {
    if (!PAGE_METHODS.includes(request.method)) return methodNotAllowed(PAGE_METHODS, { json: false })
    return redirectResponse('/settings', 308)
  }
  if (pathname === '/settings') {
    if (!PAGE_METHODS.includes(request.method)) return methodNotAllowed(PAGE_METHODS, { json: false })
    return env.ASSETS.fetch(assetRequest(request, url, '/settings'))
  }
  if (SETTINGS_ASSET_PATHS.has(pathname)) {
    if (!PAGE_METHODS.includes(request.method)) return methodNotAllowed(PAGE_METHODS, { json: false })
    return env.ASSETS.fetch(assetRequest(request, url, pathname))
  }

  if (isTravelTicketAccessApiPath(pathname)) {
    return handleTravelTicketAccess(request, env)
  }
  if (isTravelTicketAccessPagePath(pathname)) {
    if (!PAGE_METHODS.includes(request.method)) return methodNotAllowed(PAGE_METHODS, { json: false })
    if (pathname === '/access.html' || pathname === '/access/') {
      return redirectResponse(`/access${url.search}`, 308)
    }
    const assetPath = pathname === '/access' ? '/access' : pathname
    return env.ASSETS.fetch(assetRequest(request, url, assetPath))
  }

  const access = await guardTravelTicketAccess(request, env)
  if (access.response) return access.response
  const runtimeEnv = access.runtimeEnv

  if (pathname === '/connect' || pathname === '/connect.html') {
    if (!PAGE_METHODS.includes(request.method)) return methodNotAllowed(PAGE_METHODS, { json: false })
    return legacyTripPage(url, 'connect')
  }
  if (pathname === '/progress' || pathname === '/progress.html') {
    if (!PAGE_METHODS.includes(request.method)) return methodNotAllowed(PAGE_METHODS, { json: false })
    return legacyTripPage(url, 'progress')
  }

  if (pathname === '/index.html') {
    if (!PAGE_METHODS.includes(request.method)) return methodNotAllowed(PAGE_METHODS, { json: false })
    return redirectResponse('/', 308)
  }

  if (segments[0] === 'api') {
    return routeApi(request, runtimeEnv, segments.slice(1))
  }

  if (segments[0] === 'trips') {
    if (segments.length === 1) return redirectResponse('/', 302)
    const tripId = segments[1]
    if (!validTripId(tripId)) return htmlNotFound('The trip ID format is invalid.')

    if (segments.length === 3 && (segments[2] === 'connect' || segments[2] === 'progress')) {
      return routeTripUi(request, runtimeEnv, url, tripId, segments[2])
    }

    if (segments.length === 2 && !pathname.endsWith('/')) {
      if (!PAGE_METHODS.includes(request.method)) return methodNotAllowed(PAGE_METHODS, { json: false })
      return redirectResponse(`${pathname}/${url.search}`, 308)
    }
    return routeTripSite(request, runtimeEnv, tripId, segments.slice(2))
  }

  return runtimeEnv.ASSETS.fetch(request)
}

export default { fetch: handleFetch }
