// Pure trip-pipeline logic shared by the local CLI (trip.mjs) and the
// Cloudflare Worker (worker/pipeline-steps.mjs). Zero node: imports, zero fs —
// trip.mjs itself can't be imported into a Worker (its module-scope node:fs/
// path/crypto/url imports fatally break Worker startup, same lesson as Task
// 2.5/6a), so anything both sides need to share word-for-word lives here.
import { localToUtc } from './timezone.mjs'
import { validateOverrides } from './contrast.mjs'
import { CUSTOM_ALLOWED_KEYS } from './customTheme.mjs'
import { agentBudgetMs } from './agent-budgets.mjs'
import { locale, normalizeLanguage } from './language.mjs'

// 票夾：每份 trip 的資料夾名 = slug + trip id 短碼（同 slug 不同 run 不互撞）。
export const tripDirName = (itin) => `${itin.slug || 'trip'}-${String(itin.trip_id || '').split('_').at(-1).slice(0, 4)}`

// customTokensFrom — reproduces a custom re-render from a saved itinerary JSON:
// only trusts itinerary.custom_theme.tokens if it's a non-empty plain object
// AND passes the same allowlist/hex gate the generator itself is held to.
// Anything else (missing, tampered key, tampered value) → null, so callers
// fall back to the registered theme instead of a corrupted/unsafe override.
export function customTokensFrom(itinerary) {
  const tokens = itinerary?.custom_theme?.tokens
  if (!tokens || typeof tokens !== 'object' || Array.isArray(tokens) || Object.keys(tokens).length === 0) return null
  return validateOverrides(tokens, CUSTOM_ALLOWED_KEYS).ok ? tokens : null
}

// customMotifsFrom — preserves only the two string motifs a saved custom
// theme may carry. The renderer escapes these values at both output boundaries.
export function customMotifsFrom(itinerary) {
  const motifs = itinerary?.custom_theme?.motifs
  if (!motifs || typeof motifs !== 'object' || Array.isArray(motifs)) return null
  const safe = Object.fromEntries(
    ['stampText', 'eyebrow']
      .filter((key) => typeof motifs[key] === 'string')
      .map((key) => [key, motifs[key]]),
  )
  return Object.keys(safe).length ? safe : null
}

// ---------------------------------------------------------------------------
// Agent supervision: every agent runs under a timeout and reports a status
// entry regardless of outcome. Statuses are per-run (or, in the Worker, per
// step.do call) so concurrent/repeated runs never share status arrays.
//
// This timeout is a backstop, not the operative deadline — see
// agent-budgets.mjs. Racing an agent call cannot cancel it, so the budget here
// deliberately sits above the one the A2A client enforces on itself.

export function makeSupervisor(agentStatuses, log) {
  const recordStatus = (agent, status, confidence, notes) => {
    agentStatuses.push({ agent, status, confidence, notes })
  }

  async function supervise(agent, run, { confidence = 0.9 } = {}) {
    const startedAt = Date.now()
    let timer
    try {
      const result = await Promise.race([
        run(),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(Object.assign(new Error('timeout'), { code: 'timeout' })), agentBudgetMs(agent))
        }),
      ])
      const seconds = ((Date.now() - startedAt) / 1000).toFixed(1)
      if (result && typeof result === 'object' && result.status === 'skipped') {
        recordStatus(agent, 'skipped', 0, result.notes)
        log(`${agent}: skipped (${result.notes})`)
      } else {
        recordStatus(agent, 'completed', confidence, `Completed in ${seconds}s.`)
        log(`${agent}: completed in ${seconds}s`)
      }
      return { ok: true, result }
    } catch (error) {
      const status = error.code === 'timeout' ? 'timeout' : 'failed'
      recordStatus(agent, status, 0, `${error.message}`)
      log(`${agent}: ${status} (${error.message})`)
      return { ok: false, error }
    } finally {
      clearTimeout(timer)
    }
  }

  return { supervise, recordStatus }
}

// ---------------------------------------------------------------------------
// Local fallback composer — used when the Composer agent fails (or in the
// CLI's --mock mode). Deterministic and unspectacular, but always yields a
// renderable plan.

const minuteToHHMM = (m) => `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`

export function localCompose(brief, discovery) {
  const language = normalizeLanguage(brief.language)
  const copy = locale(language)
  const days = []
  const start = new Date(`${brief.start_date}T00:00:00Z`)
  const end = new Date(`${brief.end_date}T00:00:00Z`)
  const totalDays = Math.round((end - start) / 86_400_000) + 1

  // Assign a base to each day from brief.bases (nights), last day = returning.
  const baseByDay = []
  let cursor = 0
  for (const base of brief.bases ?? []) {
    for (let n = 0; n < base.nights; n++) baseByDay[cursor++] = base.name
  }
  while (baseByDay.length < totalDays) baseByDay.push(baseByDay.at(-1) ?? brief.destination)

  const poisByBase = new Map()
  for (const poi of discovery?.pois ?? []) {
    if (!poisByBase.has(poi.base)) poisByBase.set(poi.base, [])
    poisByBase.get(poi.base).push(poi)
  }

  for (let i = 0; i < totalDays; i++) {
    const date = new Date(start.getTime() + i * 86_400_000).toISOString().slice(0, 10)
    const base = baseByDay[i]
    const previousBase = i === 0 ? brief.home_city : baseByDay[i - 1]
    const isArrival = i === 0
    const isDeparture = i === totalDays - 1
    const isTransfer = !isArrival && !isDeparture && base !== previousBase
    const items = []
    const pois = poisByBase.get(base) ?? []

    if (isArrival) {
      items.push({ variant: 'both', type: 'travel', title: `${brief.home_city} → ${base}`, start_local: '09:00', end_local: '16:00', location: `${brief.home_city} → ${base}`, transport_minutes: 420, notes: copy.fallbackArrivalNote, sources: [] })
      items.push({ variant: 'both', type: 'rest', title: copy.fallbackArrivalRest, start_local: '16:30', end_local: '18:00', location: `${base} accommodation TBD`, transport_minutes: 0, notes: copy.fallbackAccommodationNote, sources: [] })
      items.push({ variant: 'both', type: 'meal', title: copy.fallbackDinner, start_local: '18:30', end_local: '20:00', location: base, transport_minutes: 0, notes: copy.fallbackArrivalDay, sources: [] })
    } else if (isDeparture) {
      items.push({ variant: 'both', type: 'travel', title: `${base} → ${brief.home_city}`, start_local: '09:00', end_local: '17:00', location: `${base} → ${brief.home_city}`, transport_minutes: 480, notes: copy.fallbackDepartureNote, sources: [] })
      items.push({ variant: 'both', type: 'rest', title: copy.fallbackHomeBuffer, start_local: '18:00', end_local: '19:00', location: brief.home_city, transport_minutes: 0, notes: copy.fallbackNoEvening, sources: [] })
    } else {
      let clock = 9 * 60
      if (isTransfer) {
        const leg = (discovery?.transports ?? []).find((t) => t.from.includes(previousBase) && t.to.includes(base))
        const minutes = leg?.minutes ?? 120
        items.push({ variant: 'both', type: 'travel', title: `${previousBase} → ${base}`, start_local: '09:00', end_local: minuteToHHMM(9 * 60 + minutes), location: `${previousBase} → ${base}`, transport_minutes: minutes, notes: leg?.notes ?? copy.fallbackArrivalNote, sources: leg?.source_label ? [leg.source_label] : [] })
        clock = 9 * 60 + minutes + 30
      }
      const [morningPoi, afternoonPoi] = [pois[(i * 2) % Math.max(pois.length, 1)], pois[(i * 2 + 1) % Math.max(pois.length, 1)]]
      if (morningPoi) {
        items.push({ variant: 'both', type: morningPoi.kind === 'meal' ? 'meal' : 'sight', title: morningPoi.title, start_local: minuteToHHMM(clock), end_local: minuteToHHMM(clock + (morningPoi.duration_minutes || 120)), location: base, transport_minutes: 0, notes: morningPoi.notes, sources: morningPoi.source_label ? [morningPoi.source_label] : [] })
        clock += (morningPoi.duration_minutes || 120) + 15
      }
      items.push({ variant: 'both', type: 'meal', title: copy.fallbackLunch, start_local: minuteToHHMM(Math.max(clock, 12 * 60)), end_local: minuteToHHMM(Math.max(clock, 12 * 60) + 75), location: base, transport_minutes: 0, notes: '', sources: [] })
      clock = Math.max(clock, 12 * 60) + 75 + 15
      items.push({ variant: 'relaxed', type: 'rest', title: copy.fallbackCoffee, start_local: minuteToHHMM(clock), end_local: minuteToHHMM(clock + 90), location: base, transport_minutes: 0, notes: copy.fallbackRelaxedNote, sources: [] })
      if (afternoonPoi && afternoonPoi !== morningPoi) {
        items.push({ variant: 'full', type: afternoonPoi.kind === 'meal' ? 'meal' : 'sight', title: afternoonPoi.title, start_local: minuteToHHMM(clock), end_local: minuteToHHMM(clock + (afternoonPoi.duration_minutes || 150)), location: base, transport_minutes: 0, notes: afternoonPoi.notes, sources: afternoonPoi.source_label ? [afternoonPoi.source_label] : [] })
      }
      items.push({ variant: 'both', type: 'meal', title: copy.fallbackDinnerShort, start_local: '19:00', end_local: '20:30', location: base, transport_minutes: 0, notes: copy.fallbackEvening, sources: [] })
    }

    days.push({
      date,
      title: isArrival ? `${brief.home_city} → ${base}` : isDeparture ? `${base} → ${brief.home_city}` : isTransfer ? `${previousBase} → ${base}` : language === 'zh-CN' ? `${base} 第${i + 1}天` : `${base} day`,
      base: isDeparture ? brief.home_city : base,
      items,
    })
  }

  return {
    summary: copy.fallbackSummary(brief.destination, totalDays, brief.pace, brief.notes),
    warnings: [
      copy.fallbackWarning,
      copy.fallbackNoBookings,
    ],
    days,
    alternatives: {
      relaxed: { notes: copy.fallbackRelaxed },
      full: { notes: copy.fallbackFull },
    },
    actions_suggested: [
      { type: 'booking_check', title: copy.fallbackTransportTitle, description: copy.fallbackTransportDescription, requires_approval: true },
      { type: 'booking_check', title: copy.fallbackAccommodationTitle, description: language === 'zh-CN' ? `驻地：${(brief.bases ?? []).map((b) => b.name).join('、')}` : `Bases: ${(brief.bases ?? []).map((b) => b.name).join(', ')}`, requires_approval: true },
    ],
    cover: {
      title_top: brief.destination.split(':')[0].trim(),
      title_accent: language === 'zh-CN' ? '行程' : 'Itinerary',
      eyebrow: language === 'zh-CN' ? '旅行车票 · UTC 预览' : 'Ticket stack · UTC-first preview',
    },
  }
}

// ---------------------------------------------------------------------------
// Assembly

// Non-Latin destination names fall back to 'trip', keeping slugs stable and safe.
export const slugify = (text) => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'trip'

export function assembleItinerary({ tripId, sentence, brief, timezone, discovery, composed, contextResult, calendarResult, notionResult, themeName, posterResult, agentStatuses, language }) {
  const normalLanguage = normalizeLanguage(language ?? brief.language)
  const copy = locale(normalLanguage)
  const dtz = brief.destination_timezone
  const days = composed.days.map((day) => ({
    date: day.date,
    title: day.title,
    base: day.base,
    items: day.items.map((it) => ({
      variant: it.variant,
      type: it.type,
      title: it.title,
      start_utc: localToUtc(day.date, it.start_local, dtz),
      end_utc: localToUtc(day.date, it.end_local, dtz),
      timezone: dtz,
      location: it.location,
      transport_minutes: it.transport_minutes ?? 0,
      notes: it.notes ?? '',
      sources: it.sources ?? [],
    })),
  }))

  const itinerary = {
    artifact_type: 'final_itinerary',
    trip_id: tripId,
    status: agentStatuses.every((s) => s.status === 'completed') ? 'complete' : 'partial',
    destination: brief.destination,
    language: normalLanguage,
    slug: `${slugify(brief.destination)}-${brief.start_date.slice(0, 4)}`,
    home_timezone: brief.home_timezone,
    destination_timezone: dtz,
    utc_timezone: 'UTC',
    travellers: brief.travellers,
    body_clock: {
      label: copy.bodyClock,
      based_on_timezone: brief.home_timezone,
      rule: timezone.body_clock_rule,
    },
    summary: composed.summary,
    request: { sentence, brief },
    agent_statuses: agentStatuses,
    warnings: composed.warnings,
    sources: (discovery?.sources ?? []).map((s) => ({ ...s, agent: 'local_discovery', confidence: 0.72 })),
    days,
    alternatives: composed.alternatives,
    actions_suggested: composed.actions_suggested,
    theme: themeName,
    cover: {
      ...composed.cover,
      ...(posterResult?.backend ? { poster: 'poster.png' } : {}),
      ...(posterResult?.prompt ? { poster_prompt: posterResult.prompt } : {}),
    },
    context: { bookings: contextResult?.bookings ?? [], calendar_events: calendarResult?.events ?? [], travel_notes: notionResult?.travel_notes ?? [] },
  }

  itinerary.timeline_json = {
    timezones: [
      { id: dtz, label: copy.destination },
      { id: brief.home_timezone, label: copy.homeTimezone },
      { id: 'UTC', label: 'UTC' },
      { id: 'body_clock', label: copy.bodyClock, based_on: brief.home_timezone },
    ],
    events: days.flatMap((day) => day.items.map((it) => ({
      date: day.date,
      title: it.title,
      type: it.type,
      variant: it.variant,
      start_utc: it.start_utc,
      end_utc: it.end_utc,
      location: it.location,
      transport_minutes: it.transport_minutes,
    }))),
  }

  return itinerary
}

// ---------------------------------------------------------------------------
// parseDesignChoice — CLI --design= flag parsing, shared by the orchestrator
// so its own tests can exercise this without spawning a subprocess.

export function parseDesignChoice(flagValue, designOptions) {
  const fallback = { kind: 'preset', name: designOptions.presets[0].name }
  if (!flagValue) return fallback
  if (flagValue.startsWith('custom:')) {
    const style = flagValue.slice('custom:'.length).trim()
    return style ? { kind: 'custom', style } : fallback
  }
  return designOptions.presets.some((p) => p.name === flagValue) ? { kind: 'preset', name: flagValue } : fallback
}
