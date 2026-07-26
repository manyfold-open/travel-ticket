import { jsonResponse } from './http.mjs'
import { resolveRuntimeEnv } from './admin/settings.mjs'

const PROJECT_ID = 'travel-ticket'
const ACCESS_COOKIE_NAME = 'travel_ticket_access'
const ACCESS_SESSION_TTL_SECONDS = 7 * 24 * 60 * 60
const ACCESS_RATE_LIMIT_ATTEMPTS = 5
const ACCESS_RATE_LIMIT_SECONDS = 10 * 60
const PASSCODE_RE = /^\d{6}$/
const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

function bytesToBase64Url(bytes) {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function base64UrlToBytes(value) {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/')
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4)
  const binary = atob(padded)
  return Uint8Array.from(binary, (character) => character.charCodeAt(0))
}

async function deriveBytes(secret, purpose) {
  return crypto.subtle.digest(
    'SHA-256',
    textEncoder.encode(`${PROJECT_ID}:${purpose}:${secret}`),
  )
}

async function sign(value, secret) {
  const key = await crypto.subtle.importKey(
    'raw',
    await deriveBytes(secret, 'access-session'),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const signature = await crypto.subtle.sign('HMAC', key, textEncoder.encode(value))
  return bytesToBase64Url(new Uint8Array(signature))
}

async function safeEqual(left, right) {
  const [leftHash, rightHash] = await Promise.all([
    crypto.subtle.digest('SHA-256', textEncoder.encode(left)),
    crypto.subtle.digest('SHA-256', textEncoder.encode(right)),
  ])
  const leftBytes = new Uint8Array(leftHash)
  const rightBytes = new Uint8Array(rightHash)
  let difference = leftBytes.length ^ rightBytes.length
  for (let index = 0; index < leftBytes.length; index += 1) {
    difference |= leftBytes[index] ^ (rightBytes[index] ?? 0)
  }
  return difference === 0
}

function sameOrigin(request) {
  const fetchSite = request.headers.get('sec-fetch-site')
  if (fetchSite === 'cross-site') return false
  const origin = request.headers.get('origin')
  return !origin || origin === new URL(request.url).origin
}

function cookieValue(request) {
  const cookies = request.headers.get('cookie') ?? ''
  for (const part of cookies.split(';')) {
    const [name, ...value] = part.trim().split('=')
    if (name === ACCESS_COOKIE_NAME) return value.join('=')
  }
  return null
}

function sessionCookie(request, token, maxAge) {
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : ''
  return `${ACCESS_COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`
}

async function passcodeVersion(signingSecret, passcode) {
  const digest = new Uint8Array(
    await deriveBytes(`${signingSecret}:${passcode}`, 'access-version'),
  )
  return bytesToBase64Url(digest).slice(0, 24)
}

async function makeAccessSession(signingSecret, passcode) {
  const payload = bytesToBase64Url(textEncoder.encode(JSON.stringify({
    exp: Math.floor(Date.now() / 1000) + ACCESS_SESSION_TTL_SECONDS,
    passcodeVersion: await passcodeVersion(signingSecret, passcode),
    nonce: crypto.randomUUID(),
  })))
  return `${payload}.${await sign(payload, signingSecret)}`
}

async function isAccessAuthenticated(request, signingSecret, passcode) {
  const token = cookieValue(request)
  if (!token) return false
  const separator = token.lastIndexOf('.')
  if (separator < 1) return false
  const payload = token.slice(0, separator)
  const signature = token.slice(separator + 1)
  let parsed
  try {
    parsed = JSON.parse(textDecoder.decode(base64UrlToBytes(payload)))
  } catch {
    return false
  }
  if (!parsed?.exp || parsed.exp <= Math.floor(Date.now() / 1000) || !parsed.passcodeVersion) {
    return false
  }
  const [validSignature, currentVersion] = await Promise.all([
    safeEqual(signature, await sign(payload, signingSecret)),
    passcodeVersion(signingSecret, passcode),
  ])
  return validSignature && await safeEqual(parsed.passcodeVersion, currentVersion)
}

async function accessRateLimitKey(request) {
  const address = request.headers.get('cf-connecting-ip')
    || request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    || 'local'
  const digest = new Uint8Array(await crypto.subtle.digest(
    'SHA-256',
    textEncoder.encode(`${PROJECT_ID}:access-rate:${address}`),
  ))
  return `__access:rate:${bytesToBase64Url(digest).slice(0, 24)}`
}

async function readAccessRateLimit(request, env) {
  const key = await accessRateLimitKey(request)
  const now = Math.floor(Date.now() / 1000)
  const raw = await env.TRIPS_KV.get(key)
  if (!raw) return { key, attempts: 0, resetAt: now + ACCESS_RATE_LIMIT_SECONDS }
  try {
    const parsed = JSON.parse(raw)
    if (!parsed?.resetAt || parsed.resetAt <= now) {
      return { key, attempts: 0, resetAt: now + ACCESS_RATE_LIMIT_SECONDS }
    }
    return {
      key,
      attempts: Math.max(0, Number(parsed.attempts) || 0),
      resetAt: parsed.resetAt,
    }
  } catch {
    return { key, attempts: 0, resetAt: now + ACCESS_RATE_LIMIT_SECONDS }
  }
}

async function recordAccessFailure(env, rate) {
  const now = Math.floor(Date.now() / 1000)
  await env.TRIPS_KV.put(
    rate.key,
    JSON.stringify({ attempts: rate.attempts + 1, resetAt: rate.resetAt }),
    { expirationTtl: Math.max(60, rate.resetAt - now + 30) },
  )
}

function accessConfiguration(runtimeEnv, sourceEnv) {
  const passcode = runtimeEnv.ACCESS_PASSCODE?.trim() ?? ''
  const signingSecret = sourceEnv.ADMIN_SETTINGS_PASSWORD ?? ''
  return {
    configured: PASSCODE_RE.test(passcode),
    ready: PASSCODE_RE.test(passcode) && Boolean(signingSecret),
    passcode,
    signingSecret,
  }
}

export function isTravelTicketAccessApiPath(pathname) {
  return pathname === '/api/access/status'
    || pathname === '/api/access/login'
    || pathname === '/api/access/logout'
}

export function isTravelTicketAccessPagePath(pathname) {
  return pathname === '/access'
    || pathname === '/access/'
    || pathname === '/access.html'
    || pathname === '/access.css'
    || pathname === '/access.js'
}

export async function handleTravelTicketAccess(request, env) {
  if (!sameOrigin(request)) return jsonResponse({ error: 'cross-site request rejected' }, 403)
  const url = new URL(request.url)
  const runtimeEnv = await resolveRuntimeEnv(env)
  const configuration = accessConfiguration(runtimeEnv, env)

  if (url.pathname === '/api/access/status') {
    if (request.method !== 'GET') return jsonResponse({ error: 'method not allowed' }, 405)
    const authenticated = configuration.ready
      ? await isAccessAuthenticated(request, configuration.signingSecret, configuration.passcode)
      : false
    return jsonResponse({
      configured: configuration.configured,
      ready: configuration.ready,
      authenticated,
    })
  }

  if (url.pathname === '/api/access/logout') {
    if (request.method !== 'POST') return jsonResponse({ error: 'method not allowed' }, 405)
    return jsonResponse(
      { authenticated: false },
      200,
      { 'set-cookie': sessionCookie(request, '', 0) },
    )
  }

  if (url.pathname !== '/api/access/login') return jsonResponse({ error: 'not found' }, 404)
  if (request.method !== 'POST') return jsonResponse({ error: 'method not allowed' }, 405)
  if (!configuration.configured) {
    return jsonResponse({ error: 'Access code is not configured. Open /settings as an administrator.' }, 503)
  }
  if (!configuration.ready) {
    return jsonResponse({ error: 'ADMIN_SETTINGS_PASSWORD is required to sign access sessions.' }, 503)
  }

  const rate = await readAccessRateLimit(request, env)
  const now = Math.floor(Date.now() / 1000)
  if (rate.attempts >= ACCESS_RATE_LIMIT_ATTEMPTS && rate.resetAt > now) {
    const retryAfter = Math.max(1, rate.resetAt - now)
    return jsonResponse(
      { error: `Too many attempts. Try again in ${Math.ceil(retryAfter / 60)} minute(s).` },
      429,
      { 'retry-after': String(retryAfter) },
    )
  }

  let supplied = ''
  try {
    const body = await request.json()
    supplied = typeof body?.passcode === 'string' ? body.passcode.trim() : ''
  } catch {
    return jsonResponse({ error: 'invalid JSON body' }, 400)
  }
  if (!PASSCODE_RE.test(supplied)) {
    await recordAccessFailure(env, rate)
    return jsonResponse({ error: 'Enter the 6-digit access code.' }, 401)
  }
  if (!await safeEqual(supplied, configuration.passcode)) {
    await recordAccessFailure(env, rate)
    return jsonResponse({ error: 'Incorrect access code.' }, 401)
  }

  await env.TRIPS_KV.delete(rate.key)
  const token = await makeAccessSession(configuration.signingSecret, configuration.passcode)
  return jsonResponse(
    { authenticated: true, expires_in: ACCESS_SESSION_TTL_SECONDS },
    200,
    { 'set-cookie': sessionCookie(request, token, ACCESS_SESSION_TTL_SECONDS) },
  )
}

function accessRedirect(request) {
  const url = new URL(request.url)
  const login = new URL('/access', url)
  login.searchParams.set('next', `${url.pathname}${url.search}`)
  return new Response(null, {
    status: 302,
    headers: {
      location: login.toString(),
      'cache-control': 'no-store',
      vary: 'Cookie',
    },
  })
}

export async function guardTravelTicketAccess(request, env) {
  const runtimeEnv = await resolveRuntimeEnv(env)
  const configuration = accessConfiguration(runtimeEnv, env)
  const authenticated = configuration.ready
    ? await isAccessAuthenticated(request, configuration.signingSecret, configuration.passcode)
    : false
  if (authenticated) return { runtimeEnv }

  const url = new URL(request.url)
  if (url.pathname.startsWith('/api/')) {
    return {
      runtimeEnv,
      response: jsonResponse({
        error: configuration.configured
          ? 'Travel Ticket access code required.'
          : 'Travel Ticket access code is not configured.',
        code: configuration.configured ? 'ACCESS_REQUIRED' : 'ACCESS_NOT_CONFIGURED',
      }, configuration.configured ? 401 : 503),
    }
  }
  return { runtimeEnv, response: accessRedirect(request) }
}
