// Plain, directly Node-testable task functions used by the Queue consumer.
// Each function is self-contained — its own local agentStatuses array plus
// supervise call — so its output can be persisted by the TripJob object.
//
// Mirrors pipeline/trip.mjs's fallback semantics: brief hard-fails while
// timezone, discovery, composer, and theme have explicit fallbacks. The
// Worker omits local mock/poster behavior and serves generated trips from KV.
//
// Zero node: imports (transitively, via agents.mjs/trip-core.mjs/render.mjs/
// customTheme.mjs/themes.mjs/storage.mjs, all already Worker-safe) — guarded
// by tests/worker/pipeline-steps.test.mjs.
import {
  runTripBriefAgent, runLocalDiscoveryAgent, runConnectorAgent,
  emptyConnectorContext, runComposerAgent, runTimezoneAgent,
  runStructuredJson,
} from '../pipeline/agents.mjs'
import { makeSupervisor, localCompose, customMotifsFrom } from '../pipeline/trip-core.mjs'
import { generateCustomTheme } from '../pipeline/customTheme.mjs'
import { resolveTheme } from '../pipeline/themes.mjs'
import { buildItineraryFiles } from '../pipeline/render.mjs'
import { saveTripFiles, saveTripJson } from './storage.mjs'
import { normalizeLanguage } from '../pipeline/language.mjs'

const noopLog = () => {}

export async function runBriefStep(ctx, sentence, todayIso, language = 'en-GB') {
  const statuses = []
  const { supervise } = makeSupervisor(statuses, noopLog)
  const run = await supervise('Trip Brief Agent', () => runTripBriefAgent(ctx, sentence, todayIso, language), { confidence: 0.9 })
  // Carry the underlying cause: this message is what /progress shows the user
  // and what trip-job.ts stores as the terminal error, so dropping it turns
  // every distinct failure (timeout, bad JSON, dead peer) into one dead end.
  if (!run.ok) {
    throw new Error(`Trip Brief Agent failed — cannot continue without a brief. ${run.error?.message ?? ''}`.trim())
  }
  return { statuses, brief: { ...run.result, language: normalizeLanguage(language) } }
}

export async function runTimezoneStep(brief) {
  const statuses = []
  const { supervise } = makeSupervisor(statuses, noopLog)
  const run = await supervise('Timezone Agent', async () => runTimezoneAgent(brief), { confidence: 0.99 })
  const timezone = run.ok ? run.result : runTimezoneAgent({ ...brief, destination_timezone: 'UTC', home_timezone: 'UTC' })
  return { statuses, timezone }
}

export async function runDiscoveryStep(ctx, brief) {
  const statuses = []
  const { supervise } = makeSupervisor(statuses, noopLog)
  const run = await supervise('Local Discovery Agent', () => runLocalDiscoveryAgent(ctx, brief), { confidence: 0.8 })
  const discovery = run.ok ? run.result : { pois: [], transports: [], sources: [] }
  return { statuses, discovery }
}

export async function runContextStep(ctx, brief, visitorId, tripId, agentBinding) {
  const statuses = []
  const { supervise, recordStatus } = makeSupervisor(statuses, noopLog)
  // No user-supplied External Client → honestly skip, mirroring trip.mjs. Only a
  // connected agent that then errors is a 'failed'; never label an absent one so.
  if (!ctx) {
    const notes = 'Manyfold connector agent is not configured.'
    recordStatus('Travel Context Agent', 'skipped', 0, notes)
    return { statuses, context: emptyConnectorContext(notes) }
  }
  const run = await supervise('Travel Context Agent', () => runConnectorAgent(ctx, {
    action: 'fetch_context', visitorId, tripId, brief, agentBinding,
  }))
  return { statuses, context: run.ok ? run.result : emptyConnectorContext(run.error?.message ?? 'Context agent unavailable.') }
}

export async function runComposerStep(ctx, { sentence, brief, timezone, discovery, context, calendar, language }) {
  const statuses = []
  const { supervise, recordStatus } = makeSupervisor(statuses, noopLog)
  const run = await supervise('Itinerary Composer Agent', () => runComposerAgent(ctx, { sentence, brief, timezone, discovery, context, calendar, language }), { confidence: 0.85 })
  if (run.ok) return { statuses, composed: run.result }
  const composed = localCompose({ ...brief, language }, discovery)
  recordStatus('Orchestrator Fallback Composer', 'completed', 0.5, 'Composer agent unavailable; itinerary composed locally.')
  return { statuses, composed }
}

// design: {kind:'preset', name} | {kind:'custom', style} | undefined. Never
// throws — a failed/ungated custom generation falls back to the resolved
// preset, exactly like trip.mjs's renderTicket.
export async function runThemeStep(ctx, { design, brief, promptTemplate, language }) {
  const themeName = resolveTheme({
    theme: design?.kind === 'preset' ? design.name : undefined,
    destination_timezone: brief.destination_timezone,
    destination: brief.destination,
  })
  if (design?.kind !== 'custom') {
    return { themeName, customTokens: null, customMotifs: null, themeUsed: { name: themeName } }
  }
  let result
  try {
    result = await generateCustomTheme({ destination: brief.destination, style: design.style, language, llm: (req) => runStructuredJson(ctx, req), promptTemplate })
  } catch (e) {
    result = { ok: false, reason: `theme generation failed: ${e.message}`, failures: [] }
  }
  if (result.ok) {
    return {
      themeName: 'default', // registered base; custom tokens override at render time
      customTokens: result.tokens,
      customMotifs: customMotifsFrom({ custom_theme: { motifs: result.motifs } }),
      themeUsed: { name: result.name, custom: true, rationale: result.rationale },
    }
  }
  return {
    themeName,
    customTokens: null,
    customMotifs: null,
    themeUsed: { name: themeName, fallback_reason: result.reason, failures: result.failures ?? [] },
  }
}

export async function runRenderStep(env, itinerary, { customTokens, customMotifs }) {
  const { pages, files } = await buildItineraryFiles(itinerary, { customTokens, customMotifs, hasPoster: false })
  await saveTripFiles(env, itinerary.trip_id, files)
  await saveTripJson(env, itinerary.trip_id, itinerary)
  return { pageCount: pages.length }
}
