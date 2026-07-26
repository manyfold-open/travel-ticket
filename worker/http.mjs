export function jsonResponse(body, status = 200, headers) {
  const responseHeaders = new Headers(headers)
  responseHeaders.set('content-type', 'application/json; charset=utf-8')
  responseHeaders.set('cache-control', 'no-store')
  responseHeaders.set('x-content-type-options', 'nosniff')
  return new Response(JSON.stringify(body), {
    status,
    headers: responseHeaders,
  })
}

export function methodNotAllowed(allowed, { json = true } = {}) {
  const headers = { allow: allowed.join(', ') }
  return json
    ? jsonResponse({ error: 'method not allowed' }, 405, headers)
    : new Response('method not allowed', { status: 405, headers })
}

export function redirectResponse(location, status = 308) {
  return new Response(null, {
    status,
    headers: {
      location,
      'cache-control': status === 308 ? 'public, max-age=3600' : 'no-store',
    },
  })
}
