// Custom ticket theme: generate via LLM prompt → gate (format + contrast) →
// one repair retry → honest fallback. Ephemeral by design: results are NEVER
// registered into themes.mjs; promotion to preset is a manual maintainer ritual.
// Pure: no fs, no node: imports. `promptTemplate` is passed in (the fs read of
// prompts/city-theme.txt lives in customTheme-local.mjs, or a Worker text-module
// import) so this function runs unchanged in a Cloudflare Worker.
import { checkTokens, validateOverrides } from './contrast.mjs'
import { DEFAULT_TOKENS } from './themes.mjs'
import { assertLanguageOutput, languagePromptInstructions, normalizeLanguage, normalizeLanguageOutput } from './language.mjs'

export const CUSTOM_ALLOWED_KEYS = ['rail', 'rail-deep', 'rail-press', 'stamp', 'night', 'gold', 'green', 'blue', 'board', 'board-hi', 'board-lo', 'board-edge']

const THEME_SCHEMA = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    tokens: { type: 'object', additionalProperties: { type: 'string' } },
    motifs: { type: 'object', properties: { stampText: { type: 'string' }, eyebrow: { type: 'string' } } },
    rationale: { type: 'string' },
  },
  required: ['name', 'tokens'],
}

const gate = (tokens) => {
  const v = validateOverrides(tokens, CUSTOM_ALLOWED_KEYS)
  if (!v.ok) return { pass: false, failures: v.problems.map((p) => ({ label: p, ratio: 0, need: 0 })) }
  return checkTokens({ ...DEFAULT_TOKENS, ...tokens })
}

// isUsableTokens — an honest pre-gate check: `out.tokens` must be a non-empty
// plain object before we even try validateOverrides/checkTokens. Without this,
// an LLM response with no usable tokens (missing, an array, or {}) can slip
// through gate({}) as "no problems, no failures" → false ok:true.
const isUsableTokens = (t) => t !== null && typeof t === 'object' && !Array.isArray(t) && Object.keys(t).length > 0

export async function generateCustomTheme({ destination, style, language, llm, promptTemplate }) {
  const normalLanguage = normalizeLanguage(language)
  if (!promptTemplate) return { ok: false, reason: 'prompt template missing', failures: [] }
  const prompt = promptTemplate.replace('{{DESTINATION}}', destination).replace('{{USER_STYLE}}', style || '(none)')
  const system = `You are the theme generator for a retro train-ticket travel product. Respond with strict JSON only. ${languagePromptInstructions(normalLanguage)}`
  let out
  try { out = await llm({ system, prompt, schema: THEME_SCHEMA }) } catch (e) {
    return { ok: false, reason: `theme generation failed: ${e.message}`, failures: [] }
  }
  if (!out || typeof out !== 'object') return { ok: false, reason: 'theme generation returned no result', failures: [] }
  if (!isUsableTokens(out.tokens)) return { ok: false, reason: 'theme generation returned no usable tokens', failures: [] }
  out = normalizeLanguageOutput(out, normalLanguage)
  let check = gate(out.tokens)
  if (check.pass) {
    try { assertLanguageOutput({ name: out.name, motifs: out.motifs, rationale: out.rationale }, normalLanguage) } catch { return { ok: false, reason: 'theme copy failed language validation', failures: [] } }
    return { ok: true, tokens: out.tokens, motifs: out.motifs ?? {}, name: out.name, rationale: out.rationale ?? '' }
  }

  // one repair retry: feed the failing pairs back
  const repairPrompt = `${prompt}\n\nYour previous attempt FAILED these contrast checks — darken/desaturate the involved colors and return corrected full JSON:\n${JSON.stringify(check.failures)}\nPrevious tokens: ${JSON.stringify(out?.tokens ?? {})}`
  try { out = await llm({ system, prompt: repairPrompt, schema: THEME_SCHEMA }) } catch (e) {
    return { ok: false, reason: `theme repair failed: ${e.message}`, failures: check.failures }
  }
  if (!out || typeof out !== 'object') return { ok: false, reason: 'theme repair returned no result', failures: check.failures }
  if (!isUsableTokens(out.tokens)) return { ok: false, reason: 'theme generation returned no usable tokens', failures: check.failures }
  out = normalizeLanguageOutput(out, normalLanguage)
  check = gate(out.tokens)
  if (check.pass) {
    try { assertLanguageOutput({ name: out.name, motifs: out.motifs, rationale: out.rationale }, normalLanguage) } catch { return { ok: false, reason: 'theme repair copy failed language validation', failures: [] } }
    return { ok: true, tokens: out.tokens, motifs: out.motifs ?? {}, name: out.name, rationale: out.rationale ?? '' }
  }
  return { ok: false, reason: 'contrast gate failed after repair', failures: check.failures }
}
