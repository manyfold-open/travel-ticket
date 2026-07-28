const PROJECT_ID = 'travel-ticket'
const COOKIE_NAME = 'travel_ticket_admin'
const SETTINGS_KEY = '__admin:runtime-settings:v1'
const SESSION_TTL_SECONDS = 8 * 60 * 60
const AGENT_ROUTING_KEYS = [
  'MF_AGENT_ID',
  'AGENT_BRIEF',
  'AGENT_DISCOVERY',
  'AGENT_COMPOSER',
  'AGENT_THEME_DESIGNER',
]
const LEGACY_GEMINI_AGENT_IDS = new Set([
  'agt_agpzmesx6f5prlyvhg77g4arbu',
  'agt_agpzmetm5ryebfwufjl2h2rb4e',
  'agt_agpzmeuncr33jpcjvlbtf4owmq',
  'agt_agpzmevmgr6ktg2ybz57n5icgm',
  'agt_agpzmewhejz73kqbpembtejhqi',
  'agt_agpzmexfyb4vrkyev46m5e54fy',
])

const FIELDS = [
  {
    key: 'ACCESS_PASSCODE',
    label: 'Application access code',
    description: 'Exactly 6 digits. Visitors must enter it before Travel Ticket or its APIs can be used.',
    secret: true,
    required: true,
    kind: 'passcode',
  },
  {
    key: 'MF_API_URL',
    label: 'Manyfold API URL',
    description: 'Manyfold REST API base URL.',
    required: true,
    kind: 'url',
  },
  {
    key: 'MF_AGENT_ID',
    label: 'Manyfold source agent',
    description: 'Agent identity used when minting peer A2A tokens.',
    required: true,
  },
  {
    key: 'MF_API_TOKEN',
    label: 'Manyfold API token',
    description: 'Secret token for the source agent. Leave blank to keep the current value.',
    secret: true,
    required: true,
  },
  {
    key: 'AGENT_BRIEF',
    label: 'Brief agent',
    description: 'Peer used to turn the request into a structured trip brief.',
    required: true,
  },
  {
    key: 'AGENT_DISCOVERY',
    label: 'Discovery agent',
    description: 'Peer used for local destination research.',
    required: true,
  },
  {
    key: 'AGENT_COMPOSER',
    label: 'Composer agent',
    description: 'Peer used to assemble the final itinerary.',
    required: true,
  },
  {
    key: 'AGENT_THEME_DESIGNER',
    label: 'Theme designer agent',
    description: 'Peer used to generate custom visual themes.',
    required: true,
  },
]
const FIELD_KEYS = new Set(FIELDS.map((field) => field.key))

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

async function deriveBytes(password, purpose) {
  return crypto.subtle.digest('SHA-256', textEncoder.encode(`${PROJECT_ID}:${purpose}:${password}`))
}

async function sign(value, password) {
  const key = await crypto.subtle.importKey(
    'raw',
    await deriveBytes(password, 'session'),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  return bytesToBase64Url(new Uint8Array(await crypto.subtle.sign('HMAC', key, textEncoder.encode(value))))
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

async function encryptSettings(settings, password) {
  const key = await crypto.subtle.importKey(
    'raw',
    await deriveBytes(password, 'settings'),
    'AES-GCM',
    false,
    ['encrypt'],
  )
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    textEncoder.encode(JSON.stringify(settings)),
  )
  return JSON.stringify({
    v: 1,
    iv: bytesToBase64Url(iv),
    ciphertext: bytesToBase64Url(new Uint8Array(encrypted)),
  })
}

async function decryptSettings(raw, password) {
  const envelope = JSON.parse(raw)
  if (envelope?.v !== 1 || !envelope.iv || !envelope.ciphertext) {
    throw new Error('unsupported settings format')
  }
  const key = await crypto.subtle.importKey(
    'raw',
    await deriveBytes(password, 'settings'),
    'AES-GCM',
    false,
    ['decrypt'],
  )
  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: base64UrlToBytes(envelope.iv) },
    key,
    base64UrlToBytes(envelope.ciphertext),
  )
  const parsed = JSON.parse(textDecoder.decode(decrypted))
  if (!parsed || typeof parsed.values !== 'object' || Array.isArray(parsed.values)) {
    throw new Error('invalid settings payload')
  }
  return parsed
}

async function readStoredSettings(env) {
  const empty = { updatedAt: '', values: {} }
  if (!env.ADMIN_SETTINGS_PASSWORD) return { settings: empty }
  const raw = await env.TRIPS_KV.get(SETTINGS_KEY)
  if (!raw) return { settings: empty }
  try {
    const settings = await decryptSettings(raw, env.ADMIN_SETTINGS_PASSWORD)
    settings.values = Object.fromEntries(
      Object.entries(settings.values).filter(([key]) => FIELD_KEYS.has(key)),
    )
    settings.values = migrateLegacyAgentSettings(env, settings.values)
    return { settings }
  } catch {
    return {
      settings: empty,
      warning: 'Saved settings could not be decrypted. Re-enter them after changing the admin password.',
    }
  }
}

function envValue(env, key) {
  return typeof env[key] === 'string' ? env[key] : ''
}

function migrateLegacyAgentSettings(env, values) {
  const migrated = { ...values }
  for (const key of AGENT_ROUTING_KEYS) {
    const saved = migrated[key]
    if (!saved || !LEGACY_GEMINI_AGENT_IDS.has(saved)) continue
    const replacement = envValue(env, key)
    if (replacement && !LEGACY_GEMINI_AGENT_IDS.has(replacement)) migrated[key] = replacement
  }
  return migrated
}

function effectiveValue(env, values, key) {
  return Object.prototype.hasOwnProperty.call(values, key) ? values[key] : envValue(env, key)
}

export async function resolveRuntimeEnv(env) {
  if (!env.ADMIN_SETTINGS_PASSWORD) return env
  const { settings } = await readStoredSettings(env)
  return { ...env, ...settings.values }
}

function cookieValue(request) {
  const cookies = request.headers.get('cookie') ?? ''
  for (const part of cookies.split(';')) {
    const [name, ...value] = part.trim().split('=')
    if (name === COOKIE_NAME) return value.join('=')
  }
  return null
}

async function isAuthenticated(request, password) {
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
  if (!parsed.exp || parsed.exp <= Math.floor(Date.now() / 1000)) return false
  return safeEqual(signature, await sign(payload, password))
}

async function makeSession(password) {
  const payload = bytesToBase64Url(textEncoder.encode(JSON.stringify({
    exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS,
    nonce: crypto.randomUUID(),
  })))
  return `${payload}.${await sign(payload, password)}`
}

function adminJson(body, status = 200, headers) {
  const responseHeaders = new Headers(headers)
  responseHeaders.set('content-type', 'application/json; charset=utf-8')
  responseHeaders.set('cache-control', 'no-store')
  responseHeaders.set('x-content-type-options', 'nosniff')
  return new Response(JSON.stringify(body), { status, headers: responseHeaders })
}

function sameOrigin(request) {
  const fetchSite = request.headers.get('sec-fetch-site')
  if (fetchSite === 'cross-site') return false
  const origin = request.headers.get('origin')
  return !origin || origin === new URL(request.url).origin
}

function validateValue(field, value) {
  if (value.length > (field.secret ? 8192 : 2048)) return `${field.label} is too long`
  if (field.kind === 'url' && value) {
    try {
      const url = new URL(value)
      if (url.protocol !== 'https:' && url.protocol !== 'http:') return `${field.label} must use HTTP or HTTPS`
    } catch {
      return `${field.label} must be a valid URL`
    }
  }
  if (field.kind === 'passcode' && value && !/^\d{6}$/.test(value)) {
    return `${field.label} must contain exactly 6 digits`
  }
  return null
}

function sessionCookie(request, token, maxAge) {
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : ''
  return `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`
}

export function isAdminSettingsPath(pathname) {
  return pathname === '/api/admin/settings'
    || pathname === '/api/admin/session'
    || pathname === '/api/admin/settings/login'
    || pathname === '/api/admin/settings/logout'
}

export async function handleAdminSettings(request, env) {
  const url = new URL(request.url)
  const password = env.ADMIN_SETTINGS_PASSWORD
  if (!password) {
    return adminJson({ error: 'ADMIN_SETTINGS_PASSWORD is not configured for this Worker.' }, 503)
  }
  if (!sameOrigin(request)) return adminJson({ error: 'cross-site request rejected' }, 403)

  if (
    url.pathname === '/api/admin/settings/login'
    || (url.pathname === '/api/admin/session' && request.method === 'POST')
  ) {
    if (request.method !== 'POST') return adminJson({ error: 'method not allowed' }, 405)
    let supplied = ''
    try {
      const body = await request.json()
      supplied = typeof body?.password === 'string' ? body.password : ''
    } catch {
      return adminJson({ error: 'invalid JSON body' }, 400)
    }
    if (!await safeEqual(supplied, password)) return adminJson({ error: 'incorrect password' }, 401)
    const token = await makeSession(password)
    return adminJson(
      { authenticated: true, expires_in: SESSION_TTL_SECONDS },
      200,
      { 'set-cookie': sessionCookie(request, token, SESSION_TTL_SECONDS) },
    )
  }

  if (
    url.pathname === '/api/admin/settings/logout'
    || (url.pathname === '/api/admin/session' && request.method === 'DELETE')
  ) {
    if (request.method !== 'POST' && request.method !== 'DELETE') {
      return adminJson({ error: 'method not allowed' }, 405)
    }
    return adminJson(
      { authenticated: false },
      200,
      { 'set-cookie': sessionCookie(request, '', 0) },
    )
  }

  if (url.pathname === '/api/admin/session') {
    return adminJson({ error: 'method not allowed' }, 405, { allow: 'POST, DELETE' })
  }

  if (!await isAuthenticated(request, password)) {
    return adminJson({ error: 'authentication required' }, 401)
  }

  if (request.method === 'GET') {
    const { settings, warning } = await readStoredSettings(env)
    return adminJson({
      project: 'Travel Ticket',
      updated_at: settings.updatedAt || null,
      warning: warning ?? null,
      fields: FIELDS.map((field) => {
        const saved = Object.prototype.hasOwnProperty.call(settings.values, field.key)
        const environment = Boolean(envValue(env, field.key))
        const value = effectiveValue(env, settings.values, field.key)
        return {
          ...field,
          value: field.secret ? '' : value,
          configured: Boolean(value),
          source: saved ? 'settings' : environment ? 'environment' : 'unset',
        }
      }),
      infrastructure: [
        { name: 'TRIPS_KV', configured: Boolean(env.TRIPS_KV), note: 'KV; encrypted runtime settings' },
        { name: 'TRIPS_SITES', configured: Boolean(env.TRIPS_SITES), note: 'KV; generated itinerary sites' },
        { name: 'TRIP_JOBS', configured: Boolean(env.TRIP_JOBS), note: 'Durable Object workflow coordinator' },
        { name: 'TRIP_TASK_QUEUE', configured: Boolean(env.TRIP_TASK_QUEUE), note: 'Queue worker pool' },
        { name: 'TRIPS_RATE_LIMITER', configured: Boolean(env.TRIPS_RATE_LIMITER), note: '5 trip creations per IP per minute' },
        { name: 'ASSETS', configured: Boolean(env.ASSETS), note: 'Static app-shell binding' },
      ],
    })
  }

  if (request.method !== 'PUT') return adminJson({ error: 'method not allowed' }, 405)

  let body
  try {
    body = await request.json()
  } catch {
    return adminJson({ error: 'invalid JSON body' }, 400)
  }
  if (!body?.values || typeof body.values !== 'object' || Array.isArray(body.values)) {
    return adminJson({ error: 'values must be an object' }, 400)
  }
  const clear = new Set(Array.isArray(body.clear) ? body.clear.filter((key) => typeof key === 'string') : [])
  const { settings } = await readStoredSettings(env)
  const next = { ...settings.values }
  const errors = []

  for (const field of FIELDS) {
    if (clear.has(field.key)) delete next[field.key]
    if (!Object.prototype.hasOwnProperty.call(body.values, field.key)) continue
    if (typeof body.values[field.key] !== 'string') {
      errors.push(`${field.label} must be a string`)
      continue
    }
    const value = body.values[field.key].trim()
    if (field.secret && !value) continue
    const error = validateValue(field, value)
    if (error) {
      errors.push(error)
    } else if (value) {
      next[field.key] = value
    } else {
      delete next[field.key]
    }
  }

  for (const field of FIELDS.filter((candidate) => candidate.required)) {
    if (!effectiveValue(env, next, field.key)) errors.push(`${field.label} is required`)
  }
  if (errors.length) return adminJson({ error: 'validation failed', details: [...new Set(errors)] }, 400)

  const saved = { updatedAt: new Date().toISOString(), values: next }
  await env.TRIPS_KV.put(SETTINGS_KEY, await encryptSettings(saved, password))
  return adminJson({ saved: true, updated_at: saved.updatedAt })
}
