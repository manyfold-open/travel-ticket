// POST /api/trips — Turnstile-gated trip creation. The request initializes a
// per-trip Durable Object; that object owns the DAG and publishes executable
// tasks to the queue.
import { jsonResponse } from '../http.mjs'
import { tripLinks } from '../trip-links.mjs'
import { resolveVisitorSession, withVisitorSession } from '../visitor-session.mjs'

const MAX_SENTENCE_LENGTH = 500
const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify'
const DESIGN_PRESET_NAME_RE = /^[a-z0-9_-]{1,64}$/

async function verifyTurnstile(env, token, remoteip) {
  if (typeof token !== 'string' || token.length === 0) return false
  const form = new URLSearchParams()
  form.set('secret', env.TURNSTILE_SECRET_KEY ?? '')
  form.set('response', token)
  if (remoteip) form.set('remoteip', remoteip)
  const res = await fetch(TURNSTILE_VERIFY_URL, { method: 'POST', body: form })
  const result = await res.json()
  return result?.success === true
}

// Design is optional; custom theme work runs only when a visitor selects it.
// When present it must match TripJobParams's union shape; the CLI's
// parseDesignChoice (flag-string parsing) is not reused here since the API
// body carries a structured object, not a --design= flag string.
function validateDesign(design) {
  if (design === undefined) return { ok: true, design: undefined }
  if (design?.kind === 'preset' && typeof design.name === 'string' && DESIGN_PRESET_NAME_RE.test(design.name)) {
    return { ok: true, design: { kind: 'preset', name: design.name } }
  }
  if (design?.kind === 'custom' && typeof design.style === 'string' && design.style.trim().length > 0 && design.style.length <= 200) {
    return { ok: true, design: { kind: 'custom', style: design.style.trim() } }
  }
  return { ok: false }
}

function makeTripId(todayIso) {
  const compact = todayIso.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
  const random = crypto.randomUUID().replace(/-/g, '').slice(0, 8)
  return `trip_${compact}_${random}`
}

export async function handleCreateTrip(request, env) {
  const remoteip = request.headers.get('cf-connecting-ip') ?? undefined

  // Cloudflare's native Workers Rate Limiting binding (per-IP) — a second,
  // cheaper gate ahead of Turnstile's own network round-trip: each trip
  // triggers 5-8 minutes of billed LLM/agent work, so a high-frequency
  // requester (even one that passes Turnstile) shouldn't be able to hammer
  // this endpoint. Binding is optional so local/test envs without it degrade
  // to "not rate limited" rather than crashing.
  if (env.TRIPS_RATE_LIMITER) {
    const { success } = await env.TRIPS_RATE_LIMITER.limit({ key: remoteip ?? 'unknown' })
    if (!success) {
      return jsonResponse({ error: 'too many requests — please wait a minute and try again.' }, 429)
    }
  }

  let body
  try {
    body = await request.json()
  } catch {
    return jsonResponse({ error: 'invalid JSON body' }, 400)
  }

  const { sentence, visitor_id: legacyVisitorId, turnstile_token: turnstileToken, design } = body ?? {}

  const verified = await verifyTurnstile(env, turnstileToken, remoteip)
  if (!verified) {
    return jsonResponse({ error: 'Turnstile verification failed — please retry the challenge.' }, 403)
  }

  if (typeof sentence !== 'string' || sentence.trim().length === 0 || sentence.length > MAX_SENTENCE_LENGTH) {
    return jsonResponse({ error: `sentence must be a non-empty string up to ${MAX_SENTENCE_LENGTH} characters` }, 400)
  }
  const visitor = resolveVisitorSession(request, legacyVisitorId)
  if (visitor.error) return jsonResponse({ error: visitor.error }, 400)
  const designResult = validateDesign(design)
  if (!designResult.ok) {
    return jsonResponse({ error: 'design must be omitted or {kind:"preset",name} / {kind:"custom",style}' }, 400)
  }

  const todayIso = new Date().toISOString()
  const tripId = makeTripId(todayIso)

  const job = env.TRIP_JOBS.get(env.TRIP_JOBS.idFromName(tripId))
  await job.initialize({
    tripId,
    sentence: sentence.trim(),
    todayIso,
    visitorId: visitor.visitorId,
    design: designResult.design,
  })

  const links = tripLinks(tripId)
  return withVisitorSession(
    jsonResponse({ trip_id: tripId, phase: 'draft', links }, 201, { location: links.connect }),
    visitor.setCookie,
  )
}
