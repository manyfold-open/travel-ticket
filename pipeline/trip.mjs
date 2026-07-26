// Core trip pipeline, split out of the orchestrator CLI:
//   planTrip(sentence)          — brief → parallel context agents → composer.
//                                 Stops BEFORE any design decision: no theme,
//                                 no poster, no render, no persistence.
//   renderTicket(plan, choice)  — theme (preset or LLM custom w/ honest
//                                 fallback) → poster → assemble → persist →
//                                 render. Same outputs as the old main().
//
// agentStatuses is per-run (created inside planTrip, carried on the plan) so
// concurrent or repeated runs never share status arrays.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { runTimezoneAgent } from './agents.mjs'
import {
  createLocalContext as createContext,
  runTripBriefAgent,
  runLocalDiscoveryAgent,
  runTravelContextAgent,
  runCalendarAgent,
  runNotionAgent,
  runComposerAgent,
  runPosterAgent,
  runStructuredJson,
} from './agents-local.mjs'
import { THEMES, resolveTheme, recommendThemes, CUSTOM_OPTION } from './themes.mjs'
import { generateCustomTheme } from './customTheme-local.mjs'
import { renderItinerary } from './render-local.mjs'
import {
  tripDirName, customTokensFrom, customMotifsFrom, makeSupervisor, localCompose, assembleItinerary, parseDesignChoice,
} from './trip-core.mjs'

export { tripDirName, customTokensFrom, customMotifsFrom, parseDesignChoice }

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export const tripsDataDir = path.join(packageRoot, 'data', 'trips')
export const saveTripJson = (itin) => {
  fs.mkdirSync(tripsDataDir, { recursive: true })
  fs.writeFileSync(path.join(tripsDataDir, `${tripDirName(itin)}.json`), JSON.stringify(itin, null, 2))
}

// ---------------------------------------------------------------------------
// Mock inputs (plumbing test without API access)

const MOCK_BRIEF = {
  destination: 'Japan: Kyoto & Osaka',
  destination_timezone: 'Asia/Tokyo',
  home_city: 'Taipei',
  home_timezone: 'Asia/Taipei',
  start_date: '2026-09-10',
  end_date: '2026-09-13',
  travellers: 2,
  pace: 'relaxed',
  no_car: true,
  bases: [{ name: 'Kyoto', nights: 2 }, { name: 'Osaka', nights: 1 }],
  interests: ['food', 'temples'],
  language: 'zh-Hant',
  notes: 'Mock brief — fixed data for pipeline testing.',
}

const MOCK_DISCOVERY = {
  pois: [
    { title: 'Fushimi Inari 清晨參道', base: 'Kyoto', kind: 'sight', duration_minutes: 150, best_time: 'morning', notes: '早上人少。', source_label: 'Kyoto tourism' },
    { title: '錦市場午後散步', base: 'Kyoto', kind: 'sight', duration_minutes: 90, best_time: 'afternoon', notes: '邊走邊吃。', source_label: 'Kyoto tourism' },
    { title: '道頓堀晚餐', base: 'Osaka', kind: 'meal', duration_minutes: 120, best_time: 'evening', notes: '', source_label: 'Osaka info' },
    { title: '大阪城公園', base: 'Osaka', kind: 'sight', duration_minutes: 120, best_time: 'morning', notes: '', source_label: 'Osaka info' },
  ],
  transports: [
    { from: 'Kyoto', to: 'Osaka', mode: 'JR', minutes: 30, notes: 'JR 京都線新快速。', source_label: 'JR West' },
  ],
  sources: [
    { label: 'Kyoto tourism', url: 'https://kyoto.travel/en/' },
    { label: 'Osaka info', url: 'https://osaka-info.jp/en/' },
    { label: 'JR West', url: 'https://www.westjr.co.jp/global/en/' },
  ],
}

// ---------------------------------------------------------------------------
// planTrip — everything up to and including the composer. No design decisions.

export async function planTrip(sentence, { mock = false, backend, log = console.error } = {}) {
  const agentStatuses = []
  const { supervise, recordStatus } = makeSupervisor(agentStatuses, log)

  const tripId = `trip_${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}_${crypto.randomBytes(4).toString('hex')}`
  const todayIso = new Date().toISOString().slice(0, 10)
  log(`trip ${tripId}${mock ? ' (mock mode)' : ''}`)

  const ctx = mock ? null : await createContext(backend)
  if (ctx) log(`LLM backend: ${ctx.backend === 'cli' ? 'claude CLI (headless, Claude Code login)' : 'Anthropic API SDK'}`)

  // Stage 1 — brief
  let brief
  if (mock) {
    brief = MOCK_BRIEF
    recordStatus('Trip Brief Agent', 'completed', 1, 'Mock brief.')
    log('Trip Brief Agent: completed (mock)')
  } else {
    const briefRun = await supervise('Trip Brief Agent', () => runTripBriefAgent(ctx, sentence, todayIso), { confidence: 0.9 })
    if (!briefRun.ok) {
      throw new Error('Trip Brief Agent failed — cannot continue without a brief.')
    }
    brief = briefRun.result
  }
  log(`brief: ${brief.destination}, ${brief.start_date} → ${brief.end_date}, ${brief.travellers} traveller(s), pace=${brief.pace}`)

  // Stage 2 — parallel context gathering
  const timezoneRun = await supervise('Timezone Agent', async () => runTimezoneAgent(brief), { confidence: 0.99 })
  const [discoveryRun, contextRun, calendarRun, notionRun] = await Promise.all([
    mock
      ? (recordStatus('Local Discovery Agent', 'completed', 1, 'Mock discovery.'), log('Local Discovery Agent: completed (mock)'), Promise.resolve({ ok: true, result: MOCK_DISCOVERY }))
      : supervise('Local Discovery Agent', () => runLocalDiscoveryAgent(ctx, brief), { confidence: 0.8 }),
    supervise('Travel Context Agent', () => runTravelContextAgent(ctx, brief)),
    supervise('Calendar Agent', () => runCalendarAgent(ctx, brief)),
    supervise('Notion Agent', () => runNotionAgent(ctx, brief)),
  ])

  const timezone = timezoneRun.ok ? timezoneRun.result : runTimezoneAgent({ ...brief, destination_timezone: 'UTC', home_timezone: 'UTC' })
  const discovery = discoveryRun.ok ? discoveryRun.result : { pois: [], transports: [], sources: [] }

  // Stage 3 — composer (LLM with local fallback)
  let composed
  if (mock) {
    composed = localCompose(brief, discovery)
    recordStatus('Itinerary Composer Agent', 'skipped', 0, 'Mock mode: composed locally by the orchestrator.')
    log('Itinerary Composer Agent: skipped (mock mode, composed locally)')
  } else {
    const composerRun = await supervise('Itinerary Composer Agent', () => runComposerAgent(ctx, {
      sentence, brief, timezone, discovery,
      context: { ...(contextRun.result ?? { bookings: [] }), travel_notes: notionRun.result?.travel_notes ?? [] },
      calendar: calendarRun.result,
    }), { confidence: 0.85 })
    if (composerRun.ok) {
      composed = composerRun.result
    } else {
      log('Composer failed — falling back to local composition.')
      composed = localCompose(brief, discovery)
      recordStatus('Orchestrator Fallback Composer', 'completed', 0.5, 'Composer agent unavailable; itinerary composed locally.')
    }
  }

  const designOptions = {
    presets: await recommendThemes({
      destination: brief.destination,
      brief,
      llm: (mock || !ctx) ? null : (req) => runStructuredJson(ctx, req),
    }),
    custom: CUSTOM_OPTION,
  }

  return {
    plan: {
      tripId, sentence, mock, brief, timezone, discovery, composed,
      contextResult: contextRun.result, calendarResult: calendarRun.result, notionResult: notionRun.result,
      agentStatuses,
    },
    designOptions,
  }
}

// ---------------------------------------------------------------------------
// renderTicket — theme choice → poster → assemble → persist → render.

export async function renderTicket(plan, choice, { skipRender = false, log = console.error } = {}) {
  const { supervise, recordStatus } = makeSupervisor(plan.agentStatuses, log)

  let themeName = resolveTheme({ destination_timezone: plan.brief.destination_timezone, destination: plan.brief.destination })
  let customTokens = null
  let customMotifs = null
  let themeUsed = { name: themeName }
  if (choice?.kind === 'preset' && THEMES[choice.name]) {
    themeName = choice.name
    themeUsed = { name: themeName }
  } else if (choice?.kind === 'custom') {
    const fallbackName = themeName
    let result = { ok: false, reason: 'no LLM backend available' }
    if (!process.env.TRIP_NO_LLM && !plan.mock) {
      try {
        const ctx = await createContext()
        result = await generateCustomTheme({ destination: plan.brief.destination, style: choice.style, llm: (req) => runStructuredJson(ctx, req) })
      } catch (e) { result = { ok: false, reason: e.message } }
    }
    if (result.ok) {
      customTokens = result.tokens
      customMotifs = customMotifsFrom({ custom_theme: { motifs: result.motifs } })
      themeName = 'default' // registered base; custom tokens override at render time
      themeUsed = { name: result.name, custom: true, rationale: result.rationale }
    } else {
      themeName = fallbackName
      themeUsed = { name: fallbackName, fallback_reason: result.reason, failures: result.failures ?? [] }
      log(`custom theme failed (${result.reason}) — falling back to ${fallbackName}`)
    }
  }

  // Poster stage（記念票畫版）。city 取第一個 base，landmarks 取 Discovery 查證過的 POI。
  const posterCity = plan.composed.days?.[0]?.base
    || String(plan.brief.destination || '').split(':').pop().split(/[&，,]/)[0].trim() || 'Trip'
  const posterLandmarks = (plan.discovery.pois || []).slice(0, 6).map((p) => p.title).filter(Boolean)
  const posterOut = path.join(packageRoot, 'data', 'posters', `${plan.tripId}.png`)
  let posterResult = null
  if (plan.mock) {
    recordStatus('Poster Agent', 'skipped', 0, 'Mock mode: no image generation.')
    log('Poster Agent: skipped (mock)')
  } else {
    const posterRun = await supervise('Poster Agent', () => runPosterAgent({
      city: posterCity, landmarks: posterLandmarks, themeName, outPath: posterOut,
    }), { confidence: 0.7 })
    posterResult = posterRun.ok && !posterRun.result?.status ? posterRun.result : (posterRun.result ?? null)
  }

  // Assemble + persist
  const itinerary = assembleItinerary({
    tripId: plan.tripId, sentence: plan.sentence, brief: plan.brief, timezone: plan.timezone,
    discovery: plan.discovery, composed: plan.composed,
    contextResult: plan.contextResult, calendarResult: plan.calendarResult, notionResult: plan.notionResult,
    themeName, posterResult, agentStatuses: plan.agentStatuses,
  })
  if (themeUsed.custom) {
    // Recorded in the JSON so a --render-only re-print reproduces the custom look.
    itinerary.custom_theme = { name: themeUsed.name, rationale: themeUsed.rationale, tokens: customTokens, motifs: customMotifs ?? {} }
  }

  fs.mkdirSync(path.join(packageRoot, '.trip_work'), { recursive: true })
  fs.mkdirSync(path.join(packageRoot, 'data'), { recursive: true })
  fs.writeFileSync(path.join(packageRoot, '.trip_work', 'final_itinerary.json'), JSON.stringify(itinerary, null, 2))
  fs.writeFileSync(path.join(packageRoot, 'data', 'final_itinerary.json'), JSON.stringify(itinerary, null, 2))
  saveTripJson(itinerary)
  log('wrote .trip_work/final_itinerary.json, data/final_itinerary.json and data/trips/')

  let manifest = { artifact_type: 'final_itinerary', trip_id: plan.tripId, preview_status: 'not_rendered' }
  if (!skipRender) {
    manifest = await renderItinerary(itinerary, { outDir: path.join(packageRoot, 'dist'), customTokens, customMotifs })
    await renderItinerary(itinerary, { outDir: path.join(packageRoot, 'dist', 'trips', tripDirName(itinerary)), customTokens, customMotifs })
    log(`rendered ${manifest.pages.length} pages to dist/ (+ trips/${tripDirName(itinerary)})`)
  }

  return { itinerary, manifest, tripDir: tripDirName(itinerary), themeUsed }
}
