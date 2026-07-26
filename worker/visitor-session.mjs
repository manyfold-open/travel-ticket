const COOKIE_NAME = 'travel_ticket_visitor'
const MAX_AGE_SECONDS = 365 * 24 * 60 * 60

export const VISITOR_ID_RE = /^[A-Za-z0-9_-]{8,128}$/

function cookieValue(request) {
  for (const part of (request.headers.get('cookie') ?? '').split(';')) {
    const [name, ...value] = part.trim().split('=')
    if (name === COOKIE_NAME) return value.join('=')
  }
  return null
}

function makeVisitorId() {
  return `visitor_${crypto.randomUUID().replace(/-/g, '')}`
}

function sessionCookie(request, visitorId) {
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : ''
  return `${COOKIE_NAME}=${visitorId}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${MAX_AGE_SECONDS}${secure}`
}

export function resolveVisitorSession(request, legacyVisitorId) {
  const existing = cookieValue(request)
  if (existing && VISITOR_ID_RE.test(existing)) {
    return { visitorId: existing, setCookie: null }
  }
  if (legacyVisitorId !== undefined && legacyVisitorId !== null && legacyVisitorId !== '') {
    if (typeof legacyVisitorId !== 'string' || !VISITOR_ID_RE.test(legacyVisitorId)) {
      return {
        error: 'visitor_id must be an 8-128 character identifier containing only letters, numbers, _ or -',
      }
    }
    return { visitorId: legacyVisitorId, setCookie: sessionCookie(request, legacyVisitorId) }
  }
  const visitorId = makeVisitorId()
  return { visitorId, setCookie: sessionCookie(request, visitorId) }
}

export function withVisitorSession(response, setCookie) {
  if (!setCookie) return response
  const headers = new Headers(response.headers)
  headers.append('set-cookie', setCookie)
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
}
