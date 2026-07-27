import { assertLanguageOutput, languagePromptInstructions, normalizeLanguage, normalizeLanguageOutput } from './language.mjs'

// Theme registry — theme = a token override set, not a new design system.
// 治理：新 theme 的每個色都要過 scripts/check-theme-contrast.mjs 再登記 docs/design-system.md。
// default 的值必須與 render.mjs :root 完全一致（那邊才是唯一真實來源的實體）。

export const DEFAULT_TOKENS = {
  ink: '#171713', muted: '#69645a', paper: '#fff8ea', line: '#d6c7aa',
  rail: '#e3372d', 'rail-deep': '#9c322b', stamp: '#9c322b', gold: '#f3c95f', blue: '#176b87',
  green: '#1f5d4a', night: '#292a25', board: '#191916', 'rail-press': '#c82018',
  'paper-bright': '#fffdf7', 'paper-dim': '#eee5d5', 'paper-faint': '#e2d8c6',
  'paper-ghost': '#bdb19d', 'ink-soft': '#4d473d', 'line-strong': '#b9aa90',
  'line-btn': '#c8b99e', 'line-coupon': '#c7b89b', desk: '#efe0c3',
  'desk-shade': '#ddd8c8', 'stack-1': '#f3e7cf', 'stack-2': '#eadcc2',
  'stack-edge': '#d1c0a0', 'board-hi': '#2d2c27', 'board-lo': '#11110f',
  'board-edge': '#070706',
}

export const THEMES = {
  default: {
    label: 'Classic · Railway Red',
    blurb: 'Clean red and white ticket stock with a timeless railway feel',
    label_zh: '经典 · 铁路红', blurb_zh: '干净的红白车票配色，带有经典铁路气质',
    regions: ['switzerland', 'europe', 'generic'],
    mood: ['classic', 'bright', 'versatile'],
    tokens: {}, motifs: {},
  },
  japan: {
    label: 'Japan · JR Teal Ticket',
    blurb: 'Teal ink, vermilion stamp and a quiet railway-ticket mood',
    label_zh: '日本 · JR 青绿色车票', blurb_zh: '青绿色油墨、朱红邮戳和安静的铁路车票气质',
    regions: ['japan', 'Asia/Tokyo'],
    mood: ['heritage', 'railway', 'quiet'],
    // JR-inspired teal ink with a vermilion postmark. All colours pass the contrast gate.
    tokens: {
      rail: '#0b7d6e',          // Teal for perforations, bars, headlines and travel marks
      'rail-deep': '#0a5648',   // Deep teal for paper labels and stamps
      'rail-press': '#0a5648',  // CTA background with accessible white text
      stamp: '#a62812',         // Vermilion postmark, decoupled from the teal rail
      night: '#123a33',         // Deep teal cover stock
      gold: '#f8b500',          // Warm yellow reserved for the dark cover
      green: '#3a6b2f',         // Sight text, distinct from the teal rail
      blue: '#165e83',          // Rest text and links
      board: '#0f231f',         // Flip-board background
      'board-hi': '#1a3029', 'board-lo': '#081310', 'board-edge': '#040a08',
    },
    // Subtle seigaiha-inspired CSS pattern derived from the rail colour.
    pattern: 'seigaiha',
    motifs: {
      stampText: 'VISITED',
      eyebrow: 'Keepsake Ticket · UTC-first preview',
    },
  },
}

// 主題底紋 CSS 片段（純 CSS，無圖像）。只有定義 pattern 的主題才輸出。
const PATTERNS = {
  // 青海波：三個 radial-gradient 疊出交疊扇形波紋；色用 color-mix 從 --rail 拉低透明度。
  seigaiha: `
.ticket{
  background-color:var(--paper);
  background-image:
    radial-gradient(circle at 50% 100%, transparent 0 33%, color-mix(in srgb,var(--rail) 8%,transparent) 33% 40%, transparent 40% 66%, color-mix(in srgb,var(--rail) 8%,transparent) 66% 73%, transparent 73%),
    radial-gradient(circle at 0% 100%, transparent 0 33%, color-mix(in srgb,var(--rail) 8%,transparent) 33% 40%, transparent 40% 66%, color-mix(in srgb,var(--rail) 8%,transparent) 66% 73%, transparent 73%),
    radial-gradient(circle at 100% 100%, transparent 0 33%, color-mix(in srgb,var(--rail) 8%,transparent) 33% 40%, transparent 40% 66%, color-mix(in srgb,var(--rail) 8%,transparent) 66% 73%, transparent 73%);
  background-size:56px 28px;
}`,
}

// theme 解析：明確欄位 > 時區 > 目的地字串 > default。
// 注意：render 端「不」呼叫這個推斷舊 JSON——舊 JSON 無 theme 欄位一律 default
// （否則既有京都手冊一重印就變皮，違反回歸鐵律）。只有 orchestrator 出票時呼叫。
export function resolveTheme({ theme, destination_timezone: dtz, destination } = {}) {
  if (theme && THEMES[theme]) return theme
  if (dtz === 'Asia/Tokyo') return 'japan'
  if (/japan|日本/i.test(destination || '')) return 'japan'
  return 'default'
}

export function mergedTokens(name) {
  return { ...DEFAULT_TOKENS, ...(THEMES[name]?.tokens || {}) }
}

// 附加在 base css 後面的 :root 覆寫 + 主題底紋。default 回空字串 → 輸出逐 byte 不變。
export function themeCss(name) {
  const overrides = THEMES[name]?.tokens || {}
  const entries = Object.entries(overrides)
  const pattern = PATTERNS[THEMES[name]?.pattern] || ''
  if (!entries.length && !pattern) return ''
  const root = entries.length ? `\n:root{${entries.map(([k, v]) => `--${k}:${v}`).join(';')};}` : ''
  return root + pattern
}

export const CUSTOM_OPTION = { enabled: true, label: '✏️ Describe your own', hint: 'Describe the look in one sentence' }

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
export async function recommendThemes({ destination, brief = {}, language, llm }) {
  const normalLanguage = normalizeLanguage(language ?? brief.language)
  const catalog = Object.entries(THEMES).map(([name, t]) => ({ name, label: t.label, blurb: t.blurb, regions: t.regions, mood: t.mood }))
  const decorate = (name, why) => ({
    name,
    label: normalLanguage === 'zh-CN' ? (THEMES[name].label_zh || THEMES[name].label) : THEMES[name].label,
    blurb: normalLanguage === 'zh-CN' ? (THEMES[name].blurb_zh || THEMES[name].blurb) : THEMES[name].blurb,
    why,
  })
  let picked = []
  if (llm) {
    try {
      const out = await llm({
        system: `You pick ticket design themes for a travel-ticket product. Pick ONLY from the given catalog names. Rank up to 3, best cultural/mood fit for the destination first. ${languagePromptInstructions(normalLanguage)}`,
        prompt: `Destination: ${destination}\nBrief: ${JSON.stringify(brief)}\nCatalog: ${JSON.stringify(catalog)}`,
        schema: RECOMMEND_SCHEMA,
      })
      const seen = new Set()
      for (const p of out?.picks ?? []) {
        const normalized = normalizeLanguageOutput(p, normalLanguage)
        let languageOk = true
        try { assertLanguageOutput(normalized, normalLanguage) } catch { languageOk = false }
        if (THEMES[normalized.name] && !seen.has(normalized.name) && languageOk) { seen.add(normalized.name); picked.push(decorate(normalized.name, normalized.why)) }
      }
    } catch { picked = [] }
  }
  if (!picked.length) {
    const first = resolveTheme({ destination_timezone: brief.destination_timezone, destination })
    const rest = Object.keys(THEMES).filter((n) => n !== first)
    const best = normalLanguage === 'zh-CN' ? '最适合这个目的地' : 'Best fit for the destination'
    const alternative = normalLanguage === 'zh-CN' ? '通用备选' : 'Versatile alternative'
    picked = [decorate(first, best), ...rest.map((n) => decorate(n, alternative))]
  }
  return picked.slice(0, 3)
}
