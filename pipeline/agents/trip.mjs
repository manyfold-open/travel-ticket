import { runMfJson } from '../mf-client.mjs'
import { MODEL, mfCallOptions, parseStructured } from './runtime.mjs'
import { BRIEF_SCHEMA, COMPOSER_SCHEMA, DISCOVERY_SCHEMA } from './schemas.mjs'
import { languagePromptInstructions, normalizeLanguage, assertLanguageOutput } from '../language.mjs'

export const BRIEF_SYSTEM = 'You are the Trip Brief Agent in a travel-planning pipeline. Turn a one-sentence trip request into a structured brief. Interpret conservatively; record every assumption (dates, pace, traveller count) in notes. Dates must be in the future relative to today.'

export async function runTripBriefAgent(ctx, sentence, todayIso, language = 'en-GB') {
  const normalLanguage = normalizeLanguage(language)
  const prompt = `Today is ${todayIso}. Requested output language: ${normalLanguage}. Trip request: ${sentence}`
  const system = `${BRIEF_SYSTEM}\n${languagePromptInstructions(normalLanguage)}`
  const call = async (retry = false) => {
    const retryText = retry ? '\nPrevious output failed the language policy. Return a corrected JSON object.' : ''
    if (ctx.backend === 'mf') return runMfJson(ctx.env, ctx.peerId, { system, prompt: prompt + retryText, schema: BRIEF_SCHEMA }, mfCallOptions(ctx))
    const response = await ctx.client.messages.create({
      model: MODEL, max_tokens: 4096, thinking: { type: 'adaptive' },
      output_config: { effort: 'medium', format: { type: 'json_schema', schema: BRIEF_SCHEMA } },
      system, messages: [{ role: 'user', content: prompt + retryText }],
    })
    return parseStructured(response)
  }
  try { const out = await call(); return { ...assertLanguageOutput(out, normalLanguage), language: normalLanguage } } catch (error) {
    const out = await call(true)
    return { ...assertLanguageOutput(out, normalLanguage), language: normalLanguage }
  }
}

export const DISCOVERY_SYSTEM = 'You are the Local Discovery Agent in a travel-planning pipeline. Research the destination with web search: key sights, food areas, and transport legs between bases. Prefer official sources (tourism boards, railway operators, attraction sites). Every transport leg and weather/season-dependent sight should cite a source. Keep the list practical: roughly 3-5 POIs per base, not an encyclopedia.'

export async function runLocalDiscoveryAgent(ctx, brief) {
  const language = normalizeLanguage(brief?.language)
  const prompt = `Requested output language: ${language}\nTrip brief:\n${JSON.stringify(brief, null, 2)}`
  const system = `${DISCOVERY_SYSTEM}\n${languagePromptInstructions(language)}`
  const call = async (retry = false) => {
    const retryText = retry ? '\nPrevious output failed the language policy. Return corrected JSON.' : ''
    if (ctx.backend === 'mf') return runMfJson(ctx.env, ctx.peerId, { system, prompt: prompt + retryText, schema: DISCOVERY_SCHEMA }, mfCallOptions(ctx))
    const stream = ctx.client.messages.stream({
    model: MODEL,
    max_tokens: 16000,
    thinking: { type: 'adaptive' },
    output_config: { effort: 'high', format: { type: 'json_schema', schema: DISCOVERY_SCHEMA } },
    tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 8 }],
      system, messages: [{ role: 'user', content: prompt + retryText }],
    })
    return parseStructured(await stream.finalMessage())
  }
  try { const out = await call(); return assertLanguageOutput(out, language) } catch (error) {
    const out = await call(true)
    return assertLanguageOutput(out, language)
  }
}

export const COMPOSER_SYSTEM = [
  'You are the Itinerary Composer Agent in a travel-planning pipeline. Compose a realistic day-by-day itinerary from the agent inputs.',
  'Rules:',
  '- One day object per date from start_date to end_date inclusive; arrival/departure days stay light.',
  '- Follow the requested output language instruction below for every human-readable field. Keep proper nouns and source labels safe.',
  '- Day titles must be short (max ~12 characters): the headline theme only, e.g. "Bamboo Forest" or "A → B". Put variant details in item notes, never in the day title.',
  '- Times are destination-local HH:MM, chronological, non-overlapping within a variant, roughly 09:00-21:00.',
  '- Provide both a relaxed and a full variant: shared items use variant "both"; upgrades use "full"; low-key alternatives use "relaxed". Include daily meals and at least one rest block on full sightseeing days.',
  '- Use transport legs and POIs from discovery where available; reference discovery source labels in item sources.',
  '- Mark uncertain schedules as planning placeholders in notes and add matching warnings.',
  '- Write summary, notes, warnings, actions, cover copy, and handwritten notes in the requested output language.',
  '- actions_suggested: booking checks, calendar write, checklist draft — all requires_approval true.',
  '- handwritten_note (cover + per-day, optional): one short colloquial line (≤22 chars) in the requested output language, paraphrasing an existing season/booking warning. Strictly a paraphrase of warnings/notes already present — no new facts; omit rather than invent.',
].join('\n')

export async function runComposerAgent(ctx, { sentence, brief, timezone, discovery, context, calendar, language: requestedLanguage }) {
  const language = normalizeLanguage(requestedLanguage ?? brief?.language)
  const prompt = [
    `Original request: ${sentence}`,
    `Trip brief:\n${JSON.stringify(brief, null, 2)}`,
    `Timezone analysis:\n${JSON.stringify(timezone, null, 2)}`,
    `Local discovery:\n${JSON.stringify(discovery, null, 2)}`,
    `Travel context (bookings): ${JSON.stringify(context)}`,
    `Calendar (fixed events): ${JSON.stringify(calendar)}`,
  ].join('\n\n')
  const system = `${COMPOSER_SYSTEM}\n${languagePromptInstructions(language)}\nRequested output language: ${language}`
  const call = async (retry = false) => {
    const retryText = retry ? '\nPrevious output failed the language policy. Return corrected JSON.' : ''
    if (ctx.backend === 'mf') return runMfJson(ctx.env, ctx.peerId, { system, prompt: prompt + retryText, schema: COMPOSER_SCHEMA }, mfCallOptions(ctx))
    const stream = ctx.client.messages.stream({
    model: MODEL,
    max_tokens: 32000,
    thinking: { type: 'adaptive' },
    output_config: { effort: 'high', format: { type: 'json_schema', schema: COMPOSER_SCHEMA } },
      system, messages: [{ role: 'user', content: prompt + retryText }],
    })
    return parseStructured(await stream.finalMessage())
  }
  try { const out = await call(); return assertLanguageOutput(out, language) } catch (error) {
    const out = await call(true)
    return assertLanguageOutput(out, language)
  }
}
