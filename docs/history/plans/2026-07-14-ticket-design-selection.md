# Ticket Design Selection Implementation Plan

> Archived execution plan. The checkboxes below are historical and are not the
> current project backlog.
>
> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Before rendering, ask the user how the ticket should look: 3 destination-smart preset recommendations + a 4th "describe your own" option with a contrast-gated LLM-generated theme.

**Architecture:** Split the orchestrator into `planTrip()` / `renderTicket()` (new `pipeline/trip.mjs`); extract contrast rules into `pipeline/contrast.mjs` (single source of truth shared by the CI script and the runtime gate); add selection metadata + `recommendThemes()` to `themes.mjs`; add ephemeral `customTokens` support to `render.mjs`; new `pipeline/customTheme.mjs` generates+gates custom themes. `orchestrator.mjs` stays the CLI: interactive menu (TTY) or `--design=` flag.

**Tech Stack:** Node 22 (`node:test`, `node:readline`), existing LLM ctx helpers in agents.mjs.

**Spec:** `docs/history/specs/2026-07-14-ticket-design-selection-design.md`
**Depends on:** Composio plan Task 1 (git + `npm test`) only. Can run in parallel with Composio Tasks 2–6 **except** both plans edit `pipeline/orchestrator.mjs` — do this plan's Task 5–6 AFTER the Composio plan is merged.

## Global Constraints

- Custom themes are EPHEMERAL: never written to `themes.mjs`, never registered; promotion to preset stays a manual maintainer ritual.
- Custom themes may override ONLY identity tokens (`rail, rail-deep, rail-press, stamp, night, gold, green, blue, board, board-hi, board-lo, board-edge`) + `motifs` text. NO custom `pattern` (CSS injection surface).
- Every custom value must match `/^#[0-9a-f]{6}$/i` AND pass the 13-pair contrast check before use; one repair retry; then fall back to recommended preset #1 with an honest message.
- Regression iron rule: old JSON re-render, `--mock` runs, and non-interactive paths must produce byte-identical output vs today (default theme untouched, `themeCss('default')` still returns `''`).
- Prompt template lives at `pipeline/prompts/city-theme.txt` (runtime), mirroring `docs/history/notes/2026-07-14-city-theme-generator-prompt.md` (doc).
- **Spec deviation (intentional):** spec §3.2 says pad presets to always-3 with `default`; with only 2 registered themes today that yields duplicates. Implementation returns UNIQUE presets, capped at 3 (today: 2 + custom). Menu renders fine with fewer.

---

### Task 1: Extract `pipeline/contrast.mjs` (single source of truth)

**Files:**
- Create: `pipeline/contrast.mjs`
- Modify: `scripts/check-theme-contrast.mjs` (import instead of local copies)
- Test: `tests/contrast.test.mjs`

**Interfaces:**
- Produces:
  - `ratio(hexA, hexB): number` (WCAG relative-luminance contrast)
  - `contrastPairs(tokens): Array<[fg, bg, min, label]>` (the 13 pairs, same as the script's `PAIRS`)
  - `checkTokens(tokens): { pass: boolean, failures: Array<{label, ratio, need, fg, bg}> }` — `tokens` is a FULL merged token set (`{...DEFAULT_TOKENS, ...overrides}`)
  - `HEX_RE = /^#[0-9a-f]{6}$/i`
  - `validateOverrides(overrides, allowedKeys): { ok: boolean, problems: string[] }` — key-allowlist + hex-format check

- [ ] **Step 1: Failing tests** — `tests/contrast.test.mjs`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkTokens, validateOverrides, ratio } from '../pipeline/contrast.mjs'
import { mergedTokens } from '../pipeline/themes.mjs'

test('ratio: black on white ≈ 21', () => {
  assert.ok(Math.abs(ratio('#000000', '#ffffff') - 21) < 0.01)
})

test('existing themes all pass', () => {
  for (const name of ['default', 'japan']) {
    const r = checkTokens(mergedTokens(name))
    assert.equal(r.pass, true, `${name}: ${JSON.stringify(r.failures)}`)
  }
})

test('gold-on-paper style failure is caught', () => {
  const bad = { ...mergedTokens('default'), 'rail-deep': '#f3c95f' } // light gold as paper text
  const r = checkTokens(bad)
  assert.equal(r.pass, false)
  assert.ok(r.failures.some((f) => f.label.includes('rail-deep')))
})

test('validateOverrides rejects bad hex, unknown keys', () => {
  const allowed = ['rail', 'night']
  assert.equal(validateOverrides({ rail: '#0b7d6e' }, allowed).ok, true)
  assert.equal(validateOverrides({ rail: 'red' }, allowed).ok, false)
  assert.equal(validateOverrides({ rail: '#0b7d6e; } body{display:none' }, allowed).ok, false)
  assert.equal(validateOverrides({ paper: '#000000' }, allowed).ok, false) // not in allowlist
})
```

- [ ] **Step 2: Run → FAIL** (`npm test`)
- [ ] **Step 3: Implement `pipeline/contrast.mjs`** — move `lum`, `ratio`, and the `PAIRS` list VERBATIM from `scripts/check-theme-contrast.mjs` (lines 5–29):

```js
// docs/design-system.md 對比鐵律的單一真實來源。CI 腳本(scripts/check-theme-contrast.mjs)
// 與 runtime 守門(pipeline/customTheme.mjs)都 import 這裡,規則只此一份。
const lum = (hex) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

export const ratio = (a, b) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

// [前景, 背景, 最低比值, 說明] — 來源:docs/design-system.md「對比鐵律」與現役用法。
export const contrastPairs = (t) => [
  [t.ink, t.paper, 4.5, 'ink on paper'],
  [t.muted, t.paper, 4.5, 'muted on paper'],
  [t['ink-soft'], t.paper, 4.5, 'ink-soft on paper'],
  [t['rail-deep'], t.paper, 4.5, 'rail-deep on paper'],
  [t['rail-deep'], t['paper-bright'], 4.5, 'rail-deep on paper-bright'],
  [t.stamp, t.paper, 4.5, 'stamp on paper (判子)'],
  [t.stamp, t['paper-bright'], 4.5, 'stamp on paper-bright (判子)'],
  ['#ffffff', t['rail-press'], 4.5, 'CTA white on rail-press'],
  [t.gold, t.night, 4.5, 'gold on night (eyebrow)'],
  [t['paper-bright'], t.night, 4.5, 'paper-bright on night'],
  [t['paper-dim'], t.night, 4.5, 'paper-dim on night'],
  [t['paper-faint'], t.night, 4.5, 'paper-faint on night'],
  [t['paper-ghost'], t.night, 4.5, 'paper-ghost on night (weak data)'],
]

export const HEX_RE = /^#[0-9a-f]{6}$/i

export function checkTokens(tokens) {
  const failures = []
  for (const [fg, bg, min, label] of contrastPairs(tokens)) {
    if (!HEX_RE.test(String(fg)) || !HEX_RE.test(String(bg))) {
      failures.push({ label, ratio: 0, need: min, fg, bg })
      continue
    }
    const r = ratio(fg, bg)
    if (r < min) failures.push({ label, ratio: Number(r.toFixed(2)), need: min, fg, bg })
  }
  return { pass: failures.length === 0, failures }
}

export function validateOverrides(overrides, allowedKeys) {
  const problems = []
  for (const [k, v] of Object.entries(overrides ?? {})) {
    if (!allowedKeys.includes(k)) problems.push(`key not allowed: ${k}`)
    else if (!HEX_RE.test(String(v))) problems.push(`bad hex for ${k}: ${String(v).slice(0, 40)}`)
  }
  return { ok: problems.length === 0, problems }
}
```

Rewrite `scripts/check-theme-contrast.mjs` to import (keep the CLI output format identical):

```js
// docs/design-system.md 對比鐵律的可執行版。規則本體在 pipeline/contrast.mjs(單一真實來源)。
// 用法:node scripts/check-theme-contrast.mjs (任何一對不及格 → exit 1)
import { THEMES, mergedTokens } from '../pipeline/themes.mjs'
import { contrastPairs, ratio } from '../pipeline/contrast.mjs'

let failed = 0
for (const name of Object.keys(THEMES)) {
  const t = mergedTokens(name)
  console.log(`\n=== theme: ${name} ===`)
  for (const [fg, bg, min, label] of contrastPairs(t)) {
    const r = ratio(fg, bg)
    const ok = r >= min
    if (!ok) failed++
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}: ${r.toFixed(2)} (need ≥${min})  ${fg} on ${bg}`)
  }
}
process.exit(failed ? 1 : 0)
```

- [ ] **Step 4: `npm test` PASS; `node scripts/check-theme-contrast.mjs` still all-green exit 0.**
- [ ] **Step 5: Commit** — `git add -A && git commit -m "refactor: extract contrast rules into pipeline/contrast.mjs"`

---

### Task 2: Theme metadata + `recommendThemes()`

**Files:**
- Modify: `pipeline/themes.mjs`
- Test: `tests/themes-recommend.test.mjs`

**Interfaces:**
- Consumes: `runJson`-style LLM via injected `deps.llm` (same `(req)=>Promise<object>` contract as connector agents; production wiring passes agents.mjs's helper — export `runJson` from agents.mjs as `runStructuredJson` for this, or duplicate the 12-line helper; prefer exporting).
- Produces:
  - `THEMES[name].{label, blurb, regions[], mood[]}` metadata on every registered theme
  - `recommendThemes({ destination, brief, llm }): Promise<Array<{name, label, blurb, why}>>` — 1–3 UNIQUE presets, deterministic fallback, never throws
  - `CUSTOM_OPTION = { enabled: true, label: '✏️ 自己描述', hint: '用一句話講你要的風格' }`

- [ ] **Step 1: Failing tests** — `tests/themes-recommend.test.mjs`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { THEMES, recommendThemes, CUSTOM_OPTION } from '../pipeline/themes.mjs'

test('every registered theme has selection metadata', () => {
  for (const [name, t] of Object.entries(THEMES)) {
    assert.ok(t.label, `${name}.label`)
    assert.ok(t.blurb, `${name}.blurb`)
    assert.ok(Array.isArray(t.regions), `${name}.regions`)
    assert.ok(Array.isArray(t.mood), `${name}.mood`)
  }
})

test('recommendThemes: llm picks are validated + deduped', async () => {
  const llm = async () => ({ picks: [
    { name: 'japan', why: '最貼合目的地' },
    { name: 'japan', why: 'dupe' },
    { name: 'nonexistent', why: 'invalid' },
    { name: 'default', why: '通用' },
  ] })
  const r = await recommendThemes({ destination: 'Japan: Kyoto', brief: {}, llm })
  assert.deepEqual(r.map((p) => p.name), ['japan', 'default'])
  assert.ok(r[0].why)
  assert.ok(r[0].label)
})

test('recommendThemes: llm failure → deterministic fallback, first = resolveTheme', async () => {
  const llm = async () => { throw new Error('boom') }
  const r = await recommendThemes({ destination: '日本京都', brief: { destination_timezone: 'Asia/Tokyo' }, llm })
  assert.equal(r[0].name, 'japan')
  assert.ok(r.length >= 2)
  assert.equal(new Set(r.map((p) => p.name)).size, r.length) // unique
})

test('custom option shape', () => {
  assert.equal(CUSTOM_OPTION.enabled, true)
  assert.ok(CUSTOM_OPTION.label.includes('自己描述'))
})
```

- [ ] **Step 2: Run → FAIL**
- [ ] **Step 3: Implement.** In `themes.mjs` add metadata to both themes:

`default` entry becomes:
```js
default: {
  label: '經典 · 瑞士鐵路紅',
  blurb: '乾淨紅白票面,復古火車票原味,通用耐看',
  regions: ['switzerland', 'europe', '瑞士', 'generic'],
  mood: ['經典', '明快', '通用'],
  tokens: {}, motifs: {},
},
```
`japan` keeps all existing fields and gains:
```js
label: '日本 · JR 青綠票',
blurb: '青綠油墨票面+朱紅判子(済),日本鐵路車票感',
regions: ['japan', '日本', 'Asia/Tokyo'],
mood: ['復古', '鐵道', '沉靜'],
```

Append to `themes.mjs`:

```js
export const CUSTOM_OPTION = { enabled: true, label: '✏️ 自己描述', hint: '用一句話講你要的風格' }

const RECOMMEND_SCHEMA = {
  type: 'object',
  properties: {
    picks: {
      type: 'array',
      items: {
        type: 'object',
        properties: { name: { type: 'string' }, why: { type: 'string' } },
        required: ['name', 'why'],
      },
    },
  },
  required: ['picks'],
}

// 目的地聰明推薦:LLM 只從「已通過對比的註冊 preset」裡挑(零對比風險),
// 失敗走 resolveTheme 確定性 fallback。回 1–3 個 UNIQUE preset,永不 throw。
export async function recommendThemes({ destination, brief = {}, llm }) {
  const catalog = Object.entries(THEMES).map(([name, t]) => ({ name, label: t.label, blurb: t.blurb, regions: t.regions, mood: t.mood }))
  const decorate = (name, why) => ({ name, label: THEMES[name].label, blurb: THEMES[name].blurb, why })
  let picked = []
  if (llm) {
    try {
      const out = await llm({
        system: 'You pick ticket design themes for a travel-ticket product. Pick ONLY from the given catalog names. Rank up to 3, best cultural/mood fit for the destination first, and give a one-sentence reason each, in the language of the destination description.',
        prompt: `Destination: ${destination}\nBrief: ${JSON.stringify(brief)}\nCatalog: ${JSON.stringify(catalog)}`,
        schema: RECOMMEND_SCHEMA,
      })
      const seen = new Set()
      for (const p of out?.picks ?? []) {
        if (THEMES[p.name] && !seen.has(p.name)) { seen.add(p.name); picked.push(decorate(p.name, p.why)) }
      }
    } catch { picked = [] }
  }
  if (!picked.length) {
    const first = resolveTheme({ destination_timezone: brief.destination_timezone, destination })
    const rest = Object.keys(THEMES).filter((n) => n !== first)
    picked = [decorate(first, '依目的地自動判斷最合適'), ...rest.map((n) => decorate(n, '通用備選'))]
  }
  return picked.slice(0, 3)
}
```

- [ ] **Step 4: `npm test` PASS; `node scripts/check-theme-contrast.mjs` still green (metadata must not touch tokens).**
- [ ] **Step 5: Commit** — `git commit -am "feat: theme selection metadata + destination-smart recommendThemes"`

---

### Task 3: `render.mjs` ephemeral `customTokens` support

**Files:**
- Modify: `pipeline/render.mjs` (`renderItinerary` signature at line ~1247 + the point where `themeCss(...)` output is appended to the page CSS — locate with `grep -n 'themeCss' pipeline/render.mjs`)
- Test: `tests/render-custom.test.mjs`

**Interfaces:**
- Produces: `renderItinerary(itinerary, { outDir, customTokens? })` — when `customTokens` is a non-empty object, append `\n:root{--k:v;...}` (built from it) AFTER the theme CSS in every generated page, so custom overrides win the cascade. Omitted → byte-identical output to today.

- [ ] **Step 1: Failing test** — `tests/render-custom.test.mjs`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { renderItinerary } from '../pipeline/render.mjs'

const MIN_ITIN = {
  artifact_type: 'final_itinerary', trip_id: 'trip_test_abcd', destination: 'Testland',
  slug: 'testland-2026', destination_timezone: 'UTC', home_timezone: 'UTC',
  travellers: 1, summary: 's', warnings: [], sources: [], days: [], alternatives: {},
  actions_suggested: [], cover: { title_top: 'Test', title_accent: 'Trip' },
  context: { bookings: [], calendar_events: [] },
}

test('customTokens are injected after theme css', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'render-'))
  renderItinerary(MIN_ITIN, { outDir: dir, customTokens: { rail: '#123456', night: '#0a0b0c' } })
  const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8')
  assert.ok(html.includes('--rail:#123456'))
  assert.ok(html.includes('--night:#0a0b0c'))
})

test('no customTokens → no injection (regression)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'render-'))
  renderItinerary(MIN_ITIN, { outDir: dir })
  const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8')
  assert.ok(!html.includes('--rail:#123456'))
})
```

(If `renderItinerary` requires more itinerary fields to not crash, extend `MIN_ITIN` minimally until the no-custom test passes BEFORE implementing — the fixture must be a valid render input first.)

- [ ] **Step 2: Run → FAIL** (unknown option ignored → first test fails)
- [ ] **Step 3: Implement.** In `renderItinerary(itinerary, { outDir })` → `renderItinerary(itinerary, { outDir, customTokens })`. Where the theme css is appended (the `themeCss(themeName)` call inside), change to:

```js
const customCss = customTokens && Object.keys(customTokens).length
  ? `\n:root{${Object.entries(customTokens).map(([k, v]) => `--${k}:${v}`).join(';')};}`
  : ''
// append customCss immediately after the existing themeCss(...) fragment wherever
// that fragment is concatenated into the page <style> — same variable, one concat:
// e.g. `const themedCss = css + themeCss(themeName)` → `... + themeCss(themeName) + customCss`
```

There is exactly one place `themeCss(` is called in render.mjs; extend that concatenation. Do NOT touch `themes.mjs`.

- [ ] **Step 4: `npm test` PASS. Regression: `node pipeline/orchestrator.mjs --render-only` (if `data/final_itinerary.json` exists) produces output identical to before (`diff -r` against a pre-change copy of `dist/`).**
- [ ] **Step 5: Commit** — `git commit -am "feat: render accepts ephemeral customTokens overrides"`

---

### Task 4: `pipeline/customTheme.mjs` + prompt file (generate → gate → repair → fallback)

**Files:**
- Create: `pipeline/customTheme.mjs`, `pipeline/prompts/city-theme.txt`
- Test: `tests/custom-theme.test.mjs`

**Interfaces:**
- Consumes: `checkTokens`, `validateOverrides` from `./contrast.mjs`; `DEFAULT_TOKENS` from `./themes.mjs`; `llm` injected (`(req)=>Promise<object>`).
- Produces: `generateCustomTheme({ destination, style, llm }): Promise<{ ok:true, tokens, motifs, name, rationale } | { ok:false, reason, failures }>` — never throws. `tokens` is the OVERRIDE set (not merged).
- `CUSTOM_ALLOWED_KEYS = ['rail','rail-deep','rail-press','stamp','night','gold','green','blue','board','board-hi','board-lo','board-edge']`

- [ ] **Step 1: `pipeline/prompts/city-theme.txt`** — copy the prompt body VERBATIM from `docs/history/notes/2026-07-14-city-theme-generator-prompt.md` (the fenced `text` block, including the `{{DESTINATION}}` / `{{USER_STYLE}}` placeholders).

- [ ] **Step 2: Failing tests** — `tests/custom-theme.test.mjs`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { generateCustomTheme, CUSTOM_ALLOWED_KEYS } from '../pipeline/customTheme.mjs'

const GOOD_TOKENS = { // japan's palette: known to pass all 13 pairs
  rail: '#0b7d6e', 'rail-deep': '#0a5648', 'rail-press': '#0a5648', stamp: '#a62812',
  night: '#123a33', gold: '#f8b500', green: '#3a6b2f', blue: '#165e83',
  board: '#0f231f', 'board-hi': '#1a3029', 'board-lo': '#081310', 'board-edge': '#040a08',
}

test('good llm output passes the gate', async () => {
  const llm = async () => ({ name: 'kyoto-teal', tokens: GOOD_TOKENS, motifs: { stampText: '済' }, rationale: 'JR teal' })
  const r = await generateCustomTheme({ destination: 'Kyoto', style: '青綠', llm })
  assert.equal(r.ok, true)
  assert.equal(r.tokens.rail, '#0b7d6e')
})

test('bad contrast → one repair retry → success', async () => {
  let n = 0
  const llm = async (req) => {
    n++
    if (n === 1) return { name: 'x', tokens: { ...GOOD_TOKENS, night: '#e0e0e0' }, motifs: {}, rationale: '' } // light night fails pairs 9-13
    assert.match(req.prompt, /night/) // repair prompt mentions the failing token pairs
    return { name: 'x', tokens: GOOD_TOKENS, motifs: {}, rationale: '' }
  }
  const r = await generateCustomTheme({ destination: 'X', style: 'y', llm })
  assert.equal(n, 2)
  assert.equal(r.ok, true)
})

test('two failures → ok:false with failures listed', async () => {
  const llm = async () => ({ name: 'x', tokens: { ...GOOD_TOKENS, night: '#ffffff' }, motifs: {}, rationale: '' })
  const r = await generateCustomTheme({ destination: 'X', style: 'y', llm })
  assert.equal(r.ok, false)
  assert.ok(r.failures.length > 0)
})

test('disallowed keys and bad hex are stripped→rejected before contrast', async () => {
  const llm = async () => ({ name: 'x', tokens: { paper: '#000000', rail: 'javascript:evil' }, motifs: {}, rationale: '' })
  const r = await generateCustomTheme({ destination: 'X', style: 'y', llm })
  assert.equal(r.ok, false)
})

test('llm throws twice → ok:false', async () => {
  const llm = async () => { throw new Error('boom') }
  const r = await generateCustomTheme({ destination: 'X', style: 'y', llm })
  assert.equal(r.ok, false)
  assert.match(r.reason, /boom|failed/i)
})
```

- [ ] **Step 3: Run → FAIL**
- [ ] **Step 4: Implement `pipeline/customTheme.mjs`:**

```js
// Custom ticket theme: generate via LLM prompt → gate (format + contrast) →
// one repair retry → honest fallback. Ephemeral by design: results are NEVER
// registered into themes.mjs; promotion to preset is a manual maintainer ritual.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkTokens, validateOverrides } from './contrast.mjs'
import { DEFAULT_TOKENS } from './themes.mjs'

export const CUSTOM_ALLOWED_KEYS = ['rail', 'rail-deep', 'rail-press', 'stamp', 'night', 'gold', 'green', 'blue', 'board', 'board-hi', 'board-lo', 'board-edge']

const PROMPT_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'prompts', 'city-theme.txt')

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

export async function generateCustomTheme({ destination, style, llm }) {
  const template = fs.readFileSync(PROMPT_PATH, 'utf8')
  const prompt = template.replace('{{DESTINATION}}', destination).replace('{{USER_STYLE}}', style || '(none)')
  const system = 'You are the theme generator for a retro train-ticket travel product. Respond with strict JSON only.'
  let out
  try { out = await llm({ system, prompt, schema: THEME_SCHEMA }) } catch (e) {
    return { ok: false, reason: `theme generation failed: ${e.message}`, failures: [] }
  }
  let check = gate(out?.tokens ?? {})
  if (check.pass) return { ok: true, tokens: out.tokens, motifs: out.motifs ?? {}, name: out.name, rationale: out.rationale ?? '' }

  // one repair retry: feed the failing pairs back
  const repairPrompt = `${prompt}\n\nYour previous attempt FAILED these contrast checks — darken/desaturate the involved colors and return corrected full JSON:\n${JSON.stringify(check.failures)}\nPrevious tokens: ${JSON.stringify(out?.tokens ?? {})}`
  try { out = await llm({ system, prompt: repairPrompt, schema: THEME_SCHEMA }) } catch (e) {
    return { ok: false, reason: `theme repair failed: ${e.message}`, failures: check.failures }
  }
  check = gate(out?.tokens ?? {})
  if (check.pass) return { ok: true, tokens: out.tokens, motifs: out.motifs ?? {}, name: out.name, rationale: out.rationale ?? '' }
  return { ok: false, reason: 'contrast gate failed after repair', failures: check.failures }
}
```

- [ ] **Step 5: `npm test` PASS. Commit** — `git add -A && git commit -m "feat: contrast-gated custom theme generation"`

---

### Task 5: `pipeline/trip.mjs` — `planTrip` / `renderTicket` split

**Do this AFTER the Composio plan is fully merged (both edit orchestrator.mjs).**

**Files:**
- Create: `pipeline/trip.mjs`
- Modify: `pipeline/orchestrator.mjs` (becomes CLI shell), `pipeline/agents.mjs` (export the `runJson` helper as `runStructuredJson`)
- Test: `tests/trip.test.mjs`

**Interfaces:**
- Produces:
  - `planTrip(sentence, { mock=false, backend, log=console.error } ): Promise<{ plan, designOptions }>`
    - `plan = { tripId, sentence, brief, timezone, discovery, composed, contextResult, calendarResult, notionResult, agentStatuses, posterResult:null }` (serializable)
    - `designOptions = { presets: [{name,label,blurb,why}...], custom: CUSTOM_OPTION }`
  - `renderTicket(plan, choice, { skipRender=false, log } ): Promise<{ itinerary, manifest, tripDir, themeUsed }>`
    - `choice = { kind:'preset', name } | { kind:'custom', style }`
    - custom path: `generateCustomTheme` (llm from plan-time ctx via `createContext` inside; mock/no-backend → immediate fallback) → ok: render with `customTokens` + `itinerary.theme='default'` + `itinerary.custom_theme={name,rationale,tokens}` recorded in JSON for reproducible re-render; fail: fallback preset #1 + `themeUsed.fallback_reason`
    - poster: runs inside `renderTicket` (needs final theme); mock → skipped as today
- **Move (verbatim, no logic edits):** from `orchestrator.mjs` into `trip.mjs`: `TIMEOUTS`, `supervise`+`recordStatus` (statuses become per-run: create the array inside `planTrip`, pass down via closure), `localCompose`, `minuteToHHMM`, `MOCK_BRIEF`, `MOCK_DISCOVERY`, `slugify`, `assembleItinerary` (takes `agentStatuses` as a param now, plus the `themeName` param it already has), `tripDirName`, `saveTripJson`, `tripsDataDir` path helpers.
- `orchestrator.mjs` KEEPS: CLI arg parsing, `--prune`, `--render-only`, and gains the design menu (Task 6). Its main flow becomes: `planTrip` → choose design → `renderTicket` → same JSON stdout as today (same keys: manifest + trip_dir + json_path + agent_statuses + deployment_status).

- [ ] **Step 1: Failing test** — `tests/trip.test.mjs`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { planTrip, renderTicket } from '../pipeline/trip.mjs'

test('planTrip --mock returns plan + designOptions, no dist render', async () => {
  const { plan, designOptions } = await planTrip('', { mock: true, log: () => {} })
  assert.ok(plan.brief.destination.includes('Japan'))
  assert.ok(plan.composed.days.length >= 3)
  assert.ok(designOptions.presets.length >= 1)
  assert.equal(designOptions.presets[0].name, 'japan') // mock brief is Kyoto → japan first (deterministic fallback path in mock)
  assert.ok(designOptions.custom.enabled)
})

test('renderTicket with preset renders and stamps the theme', async () => {
  const { plan } = await planTrip('', { mock: true, log: () => {} })
  const { itinerary, manifest, themeUsed } = await renderTicket(plan, { kind: 'preset', name: 'japan' }, { log: () => {} })
  assert.equal(itinerary.theme, 'japan')
  assert.equal(themeUsed.name, 'japan')
  assert.ok(manifest.pages.length > 0)
})

test('renderTicket custom in mock mode falls back honestly to preset #1', async () => {
  const { plan } = await planTrip('', { mock: true, log: () => {} })
  const { itinerary, themeUsed } = await renderTicket(plan, { kind: 'custom', style: '深藍配金' }, { log: () => {} })
  assert.ok(themeUsed.fallback_reason) // no LLM backend in tests → honest fallback
  assert.equal(itinerary.theme, themeUsed.name)
})
```

(Tests run with no ANTHROPIC key and no `claude` CLI assumption: `renderTicket`'s custom path must catch `createContext()` failure and fall back — that's the honest-degradation contract. If the machine HAS a `claude` CLI, force the fallback in tests via env `TRIP_NO_LLM=1` which `renderTicket` checks before attempting `createContext`.)

- [ ] **Step 2: Run → FAIL**
- [ ] **Step 3: Implement `pipeline/trip.mjs`.** Move the listed functions verbatim. New glue:

```js
export async function planTrip(sentence, { mock = false, backend, log = console.error } = {}) {
  const agentStatuses = []
  // ... moved supervise/recordStatus close over agentStatuses ...
  // stages 1–2 exactly as today's main() up to and including the composer stage (stage 3),
  // INCLUDING the notion agent from the composio plan. NO theme resolution, NO poster, NO render.
  const designOptions = {
    presets: await recommendThemes({
      destination: brief.destination,
      brief,
      llm: (mock || !ctx) ? null : (req) => runStructuredJson(ctx, req),
    }),
    custom: CUSTOM_OPTION,
  }
  return { plan: { tripId, sentence, brief, timezone, discovery, composed, contextResult: contextRun.result, calendarResult: calendarRun.result, notionResult: notionRun.result, agentStatuses, posterResult: null }, designOptions }
}

export async function renderTicket(plan, choice, { skipRender = false, log = console.error } = {}) {
  let themeName = resolveTheme({ destination_timezone: plan.brief.destination_timezone, destination: plan.brief.destination })
  let customTokens = null
  let themeUsed = { name: themeName }
  if (choice?.kind === 'preset' && THEMES[choice.name]) {
    themeName = choice.name
    themeUsed = { name: themeName }
  } else if (choice?.kind === 'custom') {
    const fallbackName = themeName
    let result = { ok: false, reason: 'no LLM backend available' }
    if (!process.env.TRIP_NO_LLM) {
      try {
        const ctx = await createContext()
        result = await generateCustomTheme({ destination: plan.brief.destination, style: choice.style, llm: (req) => runStructuredJson(ctx, req) })
      } catch (e) { result = { ok: false, reason: e.message } }
    }
    if (result.ok) {
      customTokens = result.tokens
      themeName = 'default' // registered base; custom tokens override at render time
      themeUsed = { name: result.name, custom: true, rationale: result.rationale }
    } else {
      themeName = fallbackName
      themeUsed = { name: fallbackName, fallback_reason: result.reason, failures: result.failures ?? [] }
      log(`custom theme failed (${result.reason}) — falling back to ${fallbackName}`)
    }
  }
  // poster stage (moved from main(), mock-aware, uses themeName), then
  // assembleItinerary({ ...plan pieces, themeName, posterResult, agentStatuses: plan.agentStatuses })
  // if (themeUsed.custom) itinerary.custom_theme = { name: themeUsed.name, rationale: themeUsed.rationale, tokens: customTokens }
  // persist .trip_work/data/trips exactly as today; render with { outDir, customTokens } unless skipRender
  return { itinerary, manifest, tripDir: tripDirName(itinerary), themeUsed }
}
```

(The `// ...` lines above mean: the moved code goes there UNCHANGED — see the Move list in Interfaces. Everything new is shown.)

In `agents.mjs`: `export { runJson as runStructuredJson }` (or rename the helper directly to `runStructuredJson` and export — update the two internal call sites).

Rewrite `orchestrator.mjs` main to: `const { plan, designOptions } = await planTrip(sentence, { mock, backend: backendFlag })` → design choice (Task 6; until then, hardcode `{ kind: 'preset', name: designOptions.presets[0].name }`) → `const { manifest, tripDir, itinerary } = await renderTicket(plan, choice, { skipRender })` → print the same JSON stdout as today.

- [ ] **Step 4: `npm test` PASS (with `TRIP_NO_LLM=1` in the test script if needed: change package.json test script to `TRIP_NO_LLM=1 node --test tests/`); `node pipeline/orchestrator.mjs --mock` output JSON has the same keys as before this task; `--render-only` and `--prune` untouched and still work.**
- [ ] **Step 5: Commit** — `git commit -am "refactor: split orchestrator into planTrip/renderTicket (pipeline/trip.mjs)"`

---

### Task 6: CLI design menu + `--design=` flag

**Files:**
- Modify: `pipeline/orchestrator.mjs`
- Test: manual (interactive) + `tests/cli-design-flag.test.mjs` for flag parsing

**Interfaces:**
- Produces CLI behavior:
  - `--design=<themeName>` → preset choice, no prompt
  - `--design=custom:<自由描述>` → custom choice, no prompt
  - no flag + stdin is a TTY + not `--mock` → interactive numbered menu (1..N presets, N+1 = custom → asks one follow-up line for the style)
  - no flag + non-TTY or `--mock` → presets[0], no prompt (keeps CI/mock deterministic)
- Export for testability: `parseDesignChoice(flagValue, designOptions)` from `orchestrator.mjs` is NOT possible (it's a script) — put it in `pipeline/trip.mjs` instead: `parseDesignChoice(flagValue, designOptions): choice`

- [ ] **Step 1: Failing test** — `tests/cli-design-flag.test.mjs`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseDesignChoice } from '../pipeline/trip.mjs'

const OPTS = { presets: [{ name: 'japan' }, { name: 'default' }], custom: { enabled: true } }

test('preset name → preset choice', () => {
  assert.deepEqual(parseDesignChoice('japan', OPTS), { kind: 'preset', name: 'japan' })
})
test('custom:style → custom choice', () => {
  assert.deepEqual(parseDesignChoice('custom:深藍配金', OPTS), { kind: 'custom', style: '深藍配金' })
})
test('unknown name → presets[0] (honest default)', () => {
  assert.deepEqual(parseDesignChoice('nope', OPTS), { kind: 'preset', name: 'japan' })
})
test('empty/undefined → presets[0]', () => {
  assert.deepEqual(parseDesignChoice(undefined, OPTS), { kind: 'preset', name: 'japan' })
})
```

- [ ] **Step 2: Run → FAIL**
- [ ] **Step 3: Implement.** In `trip.mjs`:

```js
export function parseDesignChoice(flagValue, designOptions) {
  const fallback = { kind: 'preset', name: designOptions.presets[0].name }
  if (!flagValue) return fallback
  if (flagValue.startsWith('custom:')) {
    const style = flagValue.slice('custom:'.length).trim()
    return style ? { kind: 'custom', style } : fallback
  }
  return designOptions.presets.some((p) => p.name === flagValue) ? { kind: 'preset', name: flagValue } : fallback
}
```

In `orchestrator.mjs` after `planTrip`:

```js
import readline from 'node:readline/promises'

const designFlag = args.find((a) => a.startsWith('--design='))?.split('=').slice(1).join('=')
let choice
if (designFlag) {
  choice = parseDesignChoice(designFlag, designOptions)
} else if (process.stdin.isTTY && !mock) {
  console.error('\n這趟旅程,你想要哪種票面設計?')
  designOptions.presets.forEach((p, i) => console.error(`  ${i + 1}. ${p.label} —— ${p.why}`))
  console.error(`  ${designOptions.presets.length + 1}. ${designOptions.custom.label} —— ${designOptions.custom.hint}`)
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr })
  const ans = (await rl.question(`選 1-${designOptions.presets.length + 1} (預設 1): `)).trim()
  const n = Number(ans)
  if (n === designOptions.presets.length + 1) {
    const style = (await rl.question('一句話描述你要的風格: ')).trim()
    choice = style ? { kind: 'custom', style } : { kind: 'preset', name: designOptions.presets[0].name }
  } else {
    choice = { kind: 'preset', name: designOptions.presets[Math.min(Math.max(n || 1, 1), designOptions.presets.length) - 1].name }
  }
  rl.close()
} else {
  choice = { kind: 'preset', name: designOptions.presets[0].name }
}
```

(Menu prints to **stderr** — stdout stays pure JSON, same as today's logging convention.)

- [ ] **Step 4: `npm test` PASS. Manual check: `node pipeline/orchestrator.mjs --mock` prints NO menu and exits 0 with same-shaped JSON. Manual interactive run optional (needs real backend).**
- [ ] **Step 5: Commit** — `git commit -am "feat: pre-render design menu + --design flag"`

---

## Self-review notes (done at plan time)

- Spec coverage: §2 two-phase → T5; §3.1 metadata → T2; §3.2 recommend+fallback → T2; §3.3 designOptions → T2/T5; §4.1 generation → T4; §4.2 shared gate → T1+T4; §4.3 degradation → T4+T5; §4.4 ephemeral/no-pattern → T4 (allowlist has no `pattern`; nothing writes themes.mjs); §5 interfaces → match task Interfaces blocks; §6 tests 1–5 → T5/T2/T1/T4/T3+T5 step 4 respectively.
- Deviations recorded: unique-presets-vs-pad-3 (header), `notes[]`→`travel_notes` lives in the Composio plan.
- Type consistency: `choice` shape identical in T5/T6; `llm` injection contract `(req)=>Promise<object>` matches Composio plan's `deps.llm`; `checkTokens` takes MERGED tokens everywhere (gate merges with `DEFAULT_TOKENS`).
- Order constraint: T5/T6 after Composio merge (shared orchestrator.mjs) — stated in T5 header and Depends-on.
