// 主題註冊表 — theme = docs/design-system.md token 的覆寫集，不是新設計系統。
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
    label: '經典 · 瑞士鐵路紅',
    blurb: '乾淨紅白票面,復古火車票原味,通用耐看',
    regions: ['switzerland', 'europe', '瑞士', 'generic'],
    mood: ['經典', '明快', '通用'],
    tokens: {}, motifs: {},
  },
  japan: {
    label: '日本 · JR 青綠票',
    blurb: '青綠油墨票面+朱紅判子(済),日本鐵路車票感',
    regions: ['japan', '日本', 'Asia/Tokyo'],
    mood: ['復古', '鐵道', '沉靜'],
    // 日本 JR 車票感：青綠油墨的票面 + 朱紅判子（済）。全部過 check-theme-contrast.mjs。
    tokens: {
      rail: '#0b7d6e',          // JR 青綠：撕孔、色條、大字、travel 類（非內文用途）
      'rail-deep': '#0a5648',   // 深青綠：紙上小字/label/.stamp（≥4.5:1 on paper & paper-bright）
      'rail-press': '#0a5648',  // CTA 底（白字必須 ≥4.5:1）
      stamp: '#a62812',         // 朱紅判子：済 郵戳（跟票面青綠解耦；on paper ≥4.5:1）
      night: '#123a33',         // 深青綠封面票面
      gold: '#f8b500',          // 山吹：只上深底（eyebrow）
      green: '#3a6b2f',         // 草綠：sight 類（跟 rail 青綠區隔）
      blue: '#165e83',          // 藍：rest 類、連結
      board: '#0f231f',         // 翻牌鐘底（墨青綠）
      'board-hi': '#1a3029', 'board-lo': '#081310', 'board-edge': '#040a08',
    },
    // 底紋：純 CSS 青海波（seigaiha），色從 --rail 衍生（color-mix 低透明度），低調當底。
    pattern: 'seigaiha',
    motifs: {
      stampText: '済',                       // 判子風郵戳中央字（default: VISITED）
      eyebrow: '記念切符 · UTC-first preview', // cover.eyebrow 沒給時的預設
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
