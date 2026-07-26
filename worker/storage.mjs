// Generated-site storage adapter for the deployed Worker.
//
// env.TRIPS_SITES (KVNamespace) — rendered site files, key `trips/<id>/<path>`.

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
}

function contentTypeFor(path) {
  const ext = path.slice(path.lastIndexOf('.'))
  return CONTENT_TYPES[ext] ?? 'application/octet-stream'
}

function siteKey(tripId, path) {
  return `trips/${tripId}/${path}`
}

export async function saveTripFiles(env, tripId, fileMap) {
  await Promise.all([...fileMap].map(([path, body]) => env.TRIPS_SITES.put(siteKey(tripId, path), body)))
}

export async function saveTripJson(env, tripId, itinerary) {
  await env.TRIPS_SITES.put(siteKey(tripId, 'itinerary.json'), JSON.stringify(itinerary))
}

export async function getTripFile(env, tripId, path) {
  const body = await env.TRIPS_SITES.get(siteKey(tripId, path), 'arrayBuffer')
  if (body === null) return null
  return new Response(body, { headers: { 'content-type': contentTypeFor(path) } })
}
