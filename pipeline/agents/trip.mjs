import { runMfJson } from '../mf-client.mjs'
import { MODEL, parseStructured } from './runtime.mjs'
import { BRIEF_SCHEMA, COMPOSER_SCHEMA, DISCOVERY_SCHEMA } from './schemas.mjs'

export const BRIEF_SYSTEM = 'You are the Trip Brief Agent in a travel-planning pipeline. Turn a one-sentence trip request into a structured brief. Interpret conservatively; record every assumption (dates, pace, traveller count) in notes. Dates must be in the future relative to today.'

export async function runTripBriefAgent(ctx, sentence, todayIso) {
  const prompt = `Today is ${todayIso}. Trip request: ${sentence}`
  if (ctx.backend === 'mf') {
    return runMfJson(ctx.env, ctx.peerId, { system: BRIEF_SYSTEM, prompt, schema: BRIEF_SCHEMA }, { timeoutMs: ctx.timeoutMs })
  }
  const response = await ctx.client.messages.create({
    model: MODEL,
    max_tokens: 4096,
    thinking: { type: 'adaptive' },
    output_config: { effort: 'medium', format: { type: 'json_schema', schema: BRIEF_SCHEMA } },
    system: BRIEF_SYSTEM,
    messages: [{ role: 'user', content: prompt }],
  })
  return parseStructured(response)
}

export const DISCOVERY_SYSTEM = 'You are the Local Discovery Agent in a travel-planning pipeline. Research the destination with web search: key sights, food areas, and transport legs between bases. Prefer official sources (tourism boards, railway operators, attraction sites). Every transport leg and weather/season-dependent sight should cite a source. Keep the list practical: roughly 3-5 POIs per base, not an encyclopedia.'

export async function runLocalDiscoveryAgent(ctx, brief) {
  const prompt = `Trip brief:\n${JSON.stringify(brief, null, 2)}`
  if (ctx.backend === 'mf') {
    return runMfJson(ctx.env, ctx.peerId, { system: DISCOVERY_SYSTEM, prompt, schema: DISCOVERY_SCHEMA }, { timeoutMs: ctx.timeoutMs })
  }
  const stream = ctx.client.messages.stream({
    model: MODEL,
    max_tokens: 16000,
    thinking: { type: 'adaptive' },
    output_config: { effort: 'high', format: { type: 'json_schema', schema: DISCOVERY_SCHEMA } },
    tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 8 }],
    system: DISCOVERY_SYSTEM,
    messages: [{ role: 'user', content: prompt }],
  })
  return parseStructured(await stream.finalMessage())
}

export const COMPOSER_SYSTEM = [
  'You are the Itinerary Composer Agent in a travel-planning pipeline. Compose a realistic day-by-day itinerary from the agent inputs.',
  'Rules:',
  '- One day object per date from start_date to end_date inclusive; arrival/departure days stay light.',
  '- Day titles must be short (max ~12 characters): the headline theme only, e.g. "嵐山竹林・天龍寺" or "A → B". Put variant details in item notes, never in the day title.',
  '- Times are destination-local HH:MM, chronological, non-overlapping within a variant, roughly 09:00-21:00.',
  '- Provide both a relaxed and a full variant: shared items use variant "both"; upgrades use "full"; low-key alternatives use "relaxed". Include daily meals and at least one rest block on full sightseeing days.',
  '- Use transport legs and POIs from discovery where available; reference discovery source labels in item sources.',
  '- Mark uncertain schedules as planning placeholders in notes and add matching warnings.',
  '- Write summary, notes, warnings and actions in the language of the original request; keep place names in their common form.',
  '- actions_suggested: booking checks, calendar write, checklist draft — all requires_approval true.',
  '- handwritten_note (cover + per-day, optional): one short colloquial line (≤22 chars) a companion would pencil on the stub, e.g. paraphrasing the season/booking warning. Strictly a paraphrase of warnings/notes already present — no new facts; omit rather than invent.',
].join('\n')

export async function runComposerAgent(ctx, { sentence, brief, timezone, discovery, context, calendar }) {
  const prompt = [
    `Original request: ${sentence}`,
    `Trip brief:\n${JSON.stringify(brief, null, 2)}`,
    `Timezone analysis:\n${JSON.stringify(timezone, null, 2)}`,
    `Local discovery:\n${JSON.stringify(discovery, null, 2)}`,
    `Travel context (bookings): ${JSON.stringify(context)}`,
    `Calendar (fixed events): ${JSON.stringify(calendar)}`,
  ].join('\n\n')
  if (ctx.backend === 'mf') {
    return runMfJson(ctx.env, ctx.peerId, { system: COMPOSER_SYSTEM, prompt, schema: COMPOSER_SCHEMA }, { timeoutMs: ctx.timeoutMs })
  }
  const stream = ctx.client.messages.stream({
    model: MODEL,
    max_tokens: 32000,
    thinking: { type: 'adaptive' },
    output_config: { effort: 'high', format: { type: 'json_schema', schema: COMPOSER_SCHEMA } },
    system: COMPOSER_SYSTEM,
    messages: [{ role: 'user', content: prompt }],
  })
  return parseStructured(await stream.finalMessage())
}
