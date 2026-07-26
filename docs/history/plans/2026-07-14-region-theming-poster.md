# 地區主題換皮 ＋ 記念票城市海報 — Implementation Plan

> Archived execution plan. The checkboxes below are historical and are not the
> current project backlog.
>
> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 日本行程的手冊自動換成日式配色（theme registry），且封面票可印 AI 生成的城市海報（記念切符規格），三層 backend（codex CLI → Gemini API → manual prompt）誠實降級。

**Architecture:** 新增 `pipeline/themes.mjs`（token 覆寫註冊表＋theme 解析）；`render.mjs` 在 `<style>` 注入 theme 覆寫、封面渲染 poster 畫版；`agents.mjs` 新增 Poster Agent；orchestrator 在 Composer 後跑 poster、把 theme 寫進 final JSON。海報存 `data/posters/<trip_id>.png`，`--render-only` 只重用不重生。

**Tech Stack:** 純 Node（ESM，零新依賴）。生圖走 codex CLI（spawn）或 Gemini REST API（fetch）。

**Spec:** `docs/history/specs/2026-07-14-region-theming-poster-design.md`（先讀）。

## Global Constraints

- **本目錄不是 git repo** — 所有「commit」步驟以「驗證通過」代替，不跑任何 git 指令。
- **iCloud 地雷（本機特有）**：檔案讀取若報 `EDEADLK` / `Resource deadlock avoided` / `Unknown system error -11`，代表檔案是 iCloud 雲端佔位檔——跑 `brctl download "<path>"` 等幾秒再讀，不要當成程式 bug。
- **docs/design-system.md 是設計唯一真實來源**：新色只能進 `themes.mjs` ＋ 登記 docs/design-system.md，禁止其他檔案出現裸 hex。
- **對比鐵律**：紙上文字 ≥4.5:1、`--gold` 禁上紙、CTA 白字底 ≥4.5:1。Task 1 的腳本是硬 gate。
- **server.mjs 安全邊界不動**：`127.0.0.1` bind、`originOk`、`safeDecode`、body 上限，一行都不准簡化。
- 每改一個 `.mjs` 檔一律 `node --check <file>` 再繼續。
- **回歸鐵律**：default 主題（無 `theme` 欄位的舊 JSON）重印輸出必須逐 byte 不變。
- 改動語言慣例：註解/文案跟現有檔案一致（繁中註解、票面 label 英文大寫）。
- 工作目錄：`/Users/zack/Desktop/travel ticket/switzerland-itinerary-package`。

---

### Task 0: 回歸基準快照（動工前）

**Files:** 無（只產生 `/tmp` 快照）

- [ ] **Step 1: 記錄既有兩份手冊的渲染 hash**

```bash
cd "/Users/zack/Desktop/travel ticket/switzerland-itinerary-package"
node pipeline/orchestrator.mjs --render-only --trip=switzerland
node pipeline/orchestrator.mjs --render-only --trip=japan-kyoto-osaka
find dist/trips/switzerland-lucerne-interlaken-lauterbrunnen-2026-470b dist/trips/japan-kyoto-osaka-2026-5c9f -type f | sort | xargs md5 > /tmp/baseline-render.md5
cat /tmp/baseline-render.md5
```

Expected: 每個檔案一行 md5。這份清單是 Task 9 回歸比對的基準。
（若 `--render-only --trip=` 用法有疑問，先 `grep -n "render-only\|--trip" pipeline/orchestrator.mjs` 看旗標解析。）

---

### Task 1: 對比驗證腳本 ＋ themes.mjs

**Files:**
- Create: `scripts/check-theme-contrast.mjs`
- Create: `pipeline/themes.mjs`

**Interfaces:**
- Produces: `resolveTheme(itinerary) -> string`（theme 名）、`THEMES`（註冊表）、
  `themeCss(name) -> string`（`:root` 覆寫 CSS，default 回空字串）、
  `mergedTokens(name) -> object`（完整 token map，poster prompt 用）。

- [ ] **Step 1: 寫 `pipeline/themes.mjs`**

```js
// 主題註冊表 — theme = docs/design-system.md token 的覆寫集，不是新設計系統。
// 治理：新 theme 的每個色都要過 scripts/check-theme-contrast.mjs 再登記 docs/design-system.md。
// default 的值必須與 render.mjs :root 完全一致（那邊才是唯一真實來源的實體）。

export const DEFAULT_TOKENS = {
  ink: '#171713', muted: '#69645a', paper: '#fff8ea', line: '#d6c7aa',
  rail: '#e3372d', 'rail-deep': '#9c322b', gold: '#f3c95f', blue: '#176b87',
  green: '#1f5d4a', night: '#292a25', board: '#191916', 'rail-press': '#c82018',
  'paper-bright': '#fffdf7', 'paper-dim': '#eee5d5', 'paper-faint': '#e2d8c6',
  'paper-ghost': '#bdb19d', 'ink-soft': '#4d473d', 'line-strong': '#b9aa90',
  'line-btn': '#c8b99e', 'line-coupon': '#c7b89b', desk: '#efe0c3',
  'desk-shade': '#ddd8c8', 'stack-1': '#f3e7cf', 'stack-2': '#eadcc2',
  'stack-edge': '#d1c0a0', 'board-hi': '#2d2c27', 'board-lo': '#11110f',
  'board-edge': '#070706',
}

export const THEMES = {
  default: { tokens: {}, motifs: {} },
  japan: {
    // 候選值（朱色/藍染/山吹/松葉）——check-theme-contrast.mjs 全綠後才是定案值。
    tokens: {
      rail: '#d3381c',          // 朱色：撕孔、色條、大字
      'rail-deep': '#8f2a14',   // 深朱：紙上紅色小字（必須 ≥4.5:1 on paper）
      'rail-press': '#a62812',  // CTA 底（白字必須 ≥4.5:1）
      night: '#1f3a4d',         // 藍染：封面深色票面
      gold: '#f8b500',          // 山吹：只上深底
      green: '#2f5d3a',         // 松葉：sight 類
      blue: '#165e83',          // 藍：rest 類、連結
      board: '#16211c',         // 翻牌鐘底往墨綠靠
      'board-hi': '#22312a', 'board-lo': '#0c1310', 'board-edge': '#050807',
    },
    motifs: {
      stampText: '済',                       // 判子風郵戳中央字（default: VISITED）
      eyebrow: '記念切符 · UTC-first preview', // cover.eyebrow 沒給時的預設
    },
  },
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

// 附加在 base css 後面的 :root 覆寫。default 回空字串 → 輸出逐 byte 不變。
export function themeCss(name) {
  const overrides = THEMES[name]?.tokens || {}
  const entries = Object.entries(overrides)
  if (!entries.length) return ''
  return `\n:root{${entries.map(([k, v]) => `--${k}:${v}`).join(';')};}`
}
```

- [ ] **Step 2: `node --check pipeline/themes.mjs`** — Expected: 無輸出（過）。

- [ ] **Step 3: 寫 `scripts/check-theme-contrast.mjs`**

```js
// docs/design-system.md 對比鐵律的可執行版。所有 theme（含 default）都要全綠。
// 用法：node scripts/check-theme-contrast.mjs   （任何一對不及格 → exit 1）
import { THEMES, mergedTokens } from '../pipeline/themes.mjs'

const lum = (hex) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
const ratio = (a, b) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

// [前景, 背景, 最低比值, 說明] — 來源：docs/design-system.md「對比鐵律」與現役用法。
const PAIRS = (t) => [
  [t.ink, t.paper, 4.5, 'ink on paper'],
  [t.muted, t.paper, 4.5, 'muted on paper'],
  [t['ink-soft'], t.paper, 4.5, 'ink-soft on paper'],
  [t['rail-deep'], t.paper, 4.5, 'rail-deep on paper'],
  [t['rail-deep'], t['paper-bright'], 4.5, 'rail-deep on paper-bright'],
  ['#ffffff', t['rail-press'], 4.5, 'CTA white on rail-press'],
  [t.gold, t.night, 4.5, 'gold on night (eyebrow)'],
  [t['paper-bright'], t.night, 4.5, 'paper-bright on night'],
  [t['paper-dim'], t.night, 4.5, 'paper-dim on night'],
  [t['paper-faint'], t.night, 4.5, 'paper-faint on night'],
  [t['paper-ghost'], t.night, 4.5, 'paper-ghost on night (weak data)'],
]

let failed = 0
for (const name of Object.keys(THEMES)) {
  const t = mergedTokens(name)
  console.log(`\n=== theme: ${name} ===`)
  for (const [fg, bg, min, label] of PAIRS(t)) {
    const r = ratio(fg, bg)
    const ok = r >= min
    if (!ok) failed++
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}: ${r.toFixed(2)} (need ≥${min})  ${fg} on ${bg}`)
  }
}
process.exit(failed ? 1 : 0)
```

- [ ] **Step 4: 跑腳本，校準 japan 色值到全綠**

```bash
node scripts/check-theme-contrast.mjs
```

Expected: default 全 PASS（若 default 有 FAIL，代表那一對的規則寫錯了——對照
docs/design-system.md 修 PAIRS，不是改 default 色值）。japan 若有 FAIL，微調該 token 的明度
（往深或往淺一格格試）直到全綠。**把最終比值輸出留著，Task 8 要抄進 docs/design-system.md。**

---

### Task 2: render.mjs 接 theme（換皮 ＋ 判子郵戳 ＋ 記念 eyebrow）

**Files:**
- Modify: `pipeline/render.mjs`（import 區 ~line 5-7、`renderItinerary` 開頭 ~line 1212-1224、`head()` ~line 1263、eyebrow ~line 1237、postmark svg 的 `VISITED` ~line 1340）

**Interfaces:**
- Consumes: `THEMES`, `themeCss` from `./themes.mjs`（Task 1）。
- Produces: 渲染規則——`itinerary.theme` 欄位存在且合法才換皮；否則 default。

- [ ] **Step 1: import**

在 `import { writePwaAssets, pwaNames } from './pwa.mjs'` 下加：

```js
import { THEMES, themeCss } from './themes.mjs'
```

- [ ] **Step 2: `renderItinerary` 開頭解析 theme**

在 `const cover = itinerary.cover || {}` 之後加：

```js
  // theme 只讀欄位、不推斷（舊 JSON 一律 default——回歸鐵律）。
  const themeName = THEMES[itinerary.theme] ? itinerary.theme : 'default'
  const themeMotifs = THEMES[themeName].motifs || {}
  const themeOverrideCss = themeCss(themeName)
```

- [ ] **Step 3: `head()` 注入覆寫**

`head()`（~line 1263）裡的 `<style>${css}</style>` 改成：

```js
<style>${css}${themeOverrideCss}</style>
```

- [ ] **Step 4: eyebrow 接 motif**

`const eyebrow = cover.eyebrow || 'Ticket stack · UTC-first preview'` 改成：

```js
  const eyebrow = cover.eyebrow || themeMotifs.eyebrow || 'Ticket stack · UTC-first preview'
```

- [ ] **Step 5: 判子郵戳字**

postmark 的 client-side JS 模板（~line 1337-1340）裡
`'<text class="pm-head" x="60" y="48" text-anchor="middle">VISITED</text>'`
的 `VISITED` 改為插值（注意這段在模板字串內，插值要在**產生**這段 JS 的外層做）：

```js
'<text class="pm-head" x="60" y="48" text-anchor="middle">' + ${JSON.stringify(themeMotifs.stampText || 'VISITED')} + '</text>'
```

實作時看清楚該行外層是 template literal 還是字串串接，讓最終送到瀏覽器的 JS
產出 `済`（japan）或 `VISITED`（default）。localStorage 格式與指紋**不碰**。

- [ ] **Step 6: 驗證**

```bash
node --check pipeline/render.mjs
node pipeline/orchestrator.mjs --render-only --trip=switzerland
node pipeline/orchestrator.mjs --render-only --trip=japan-kyoto-osaka
find dist/trips/switzerland-lucerne-interlaken-lauterbrunnen-2026-470b dist/trips/japan-kyoto-osaka-2026-5c9f -type f | sort | xargs md5 > /tmp/after-task2.md5
diff /tmp/baseline-render.md5 /tmp/after-task2.md5 && echo REGRESSION-OK
```

Expected: `REGRESSION-OK`（default 逐 byte 不變）。

- [ ] **Step 7: japan 換皮 smoke**

```bash
cd "/Users/zack/Desktop/travel ticket/switzerland-itinerary-package"
node -e "
const fs = require('fs')
const p = 'data/trips/japan-kyoto-osaka-2026-5c9f.json'
const j = JSON.parse(fs.readFileSync(p, 'utf8'))
j.theme = 'japan'
fs.writeFileSync('/tmp/kyoto-japan-theme-test.json', JSON.stringify(j, null, 2))
fs.copyFileSync(p, '/tmp/kyoto-json-backup.json')
fs.writeFileSync(p, JSON.stringify(j, null, 2))
"
node pipeline/orchestrator.mjs --render-only --trip=japan-kyoto-osaka
grep -c "d3381c" dist/trips/japan-kyoto-osaka-2026-5c9f/index.html
grep -o "済" dist/trips/japan-kyoto-osaka-2026-5c9f/day-2026-09-10.html | head -1
# 還原（回歸基準不能污染）：
node -e "require('fs').copyFileSync('/tmp/kyoto-json-backup.json','data/trips/japan-kyoto-osaka-2026-5c9f.json')"
node pipeline/orchestrator.mjs --render-only --trip=japan-kyoto-osaka
find dist/trips/japan-kyoto-osaka-2026-5c9f -type f | sort | xargs md5 | diff <(grep japan-kyoto /tmp/baseline-render.md5) - && echo RESTORED-OK
```

Expected: grep 到 `d3381c` ≥1 次、`済` 有輸出、最後 `RESTORED-OK`。

---

### Task 3: 封面 poster 畫版（渲染端，manual 檔案流先通）

**Files:**
- Modify: `pipeline/render.mjs`（css 模板加 `.poster-panel` 區塊；`renderItinerary` 加 poster 偵測；`homeHtml`（~line 1400-1416）加畫版；`@media print` 區（~line 964-1000 附近）確認海報上紙）

**Interfaces:**
- Produces: 觸發規則——**`data/posters/<trip_id>.png` 檔案存在**即渲染畫版（欄位
  `cover.poster` 只是紀錄，不是開關；manual 流程/舊手冊丟檔案就能用）。
  輸出 dir 一律複製為 `poster.png`。

- [ ] **Step 1: poster 偵測 + 複製**

`renderItinerary` 開頭（theme 解析後）加：

```js
  // 記念票畫版：data/posters/<trip_id>.png 存在才渲染（檔案是觸發器，欄位只是紀錄）。
  const packageRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
  const posterSrc = path.join(packageRoot, 'data', 'posters', `${tripId}.png`)
  const hasPoster = fs.existsSync(posterSrc)
  if (hasPoster) {
    fs.mkdirSync(outDir, { recursive: true })
    fs.copyFileSync(posterSrc, path.join(outDir, 'poster.png'))
  }
```

（`fs`/`path` 已 import。`outDir` 若在函式後段才 mkdir，把複製移到既有 mkdir 之後——
以現有寫檔位置為準，不要重複 mkdir 邏輯。）

- [ ] **Step 2: 封面 HTML**

`homeHtml`（~line 1400）的 `.main` 區塊，`<div class="eyebrow">…</div>` 與 `<h1>` 之間插入：

```js
      ${hasPoster ? `<figure class="poster-panel"><img src="poster.png" alt="${esc(destinationTop)} 記念海報" width="1536" height="1024"><figcaption class="poster-cap" aria-hidden="true" translate="no">記念切符 · ${esc(tripId)}</figcaption></figure>` : ''}
```

並把 `<section class="ticket cover-ticket"` 改為
`<section class="ticket cover-ticket${hasPoster ? ' has-poster' : ''}"`。

- [ ] **Step 3: CSS（css 模板內、cover 相關區塊附近加）**

```css
/* 記念票畫版 — 海報是票面上半的印刷畫，機器層（條碼/microprint/route）不動 */
.poster-panel {
  margin: 14px 0 6px;
  border: 1px solid rgba(255,255,255,.18);
  background: var(--board);
}
.poster-panel img {
  display: block;
  width: 100%;
  height: auto;
  aspect-ratio: 3 / 2; /* 鎖比例防 CLS；非 3:2 的圖會被裁切置中 */
  object-fit: cover;
}
.poster-cap {
  font: 600 10px/1.6 var(--font-mono);
  letter-spacing: .12em;
  text-transform: uppercase;
  color: var(--paper-ghost);
  padding: 4px 8px;
  border-top: 1px solid rgba(255,255,255,.12);
}
/* 海報已是城市名 typography，大字 h1 讓位（壓縮不消失——序號/導航語意還在） */
.cover-ticket.has-poster h1 { font-size: clamp(28px, 4.2vw, 44px); }
```

規則：只用既有 token/既有 alpha 慣例（`rgba(255,255,255,*)` 是允許的透明度變體），
**禁止新 hex**。h1 現有字級 selector 找到後確認 clamp 蓋得過（必要時提高 specificity，
不用 `!important`）。

- [ ] **Step 4: print 確認**

`@media print` 區塊確認：`.poster-panel` 不在隱藏清單（要上紙）、加
`​.poster-panel { break-inside: avoid; }`。已知坑 #10：print 區的 RWD 斷點
`screen and` 限定不能動。

- [ ] **Step 5: 驗證（manual 檔案流 end-to-end）**

```bash
cd "/Users/zack/Desktop/travel ticket/switzerland-itinerary-package"
node --check pipeline/render.mjs
mkdir -p data/posters
TRIP_ID=$(node -e "console.log(JSON.parse(require('fs').readFileSync('data/trips/japan-kyoto-osaka-2026-5c9f.json','utf8')).trip_id)")
cp dist/icon-512.png "data/posters/${TRIP_ID}.png"   # 假海報 smoke（方形會被 3:2 裁切，正常）
node pipeline/orchestrator.mjs --render-only --trip=japan-kyoto-osaka
grep -c "poster-panel" dist/trips/japan-kyoto-osaka-2026-5c9f/index.html   # 期望 ≥1
ls -la dist/trips/japan-kyoto-osaka-2026-5c9f/poster.png                    # 期望存在
# 無海報 fallback + 回歸：
rm "data/posters/${TRIP_ID}.png"
node pipeline/orchestrator.mjs --render-only --trip=japan-kyoto-osaka
grep -c "poster-panel" dist/trips/japan-kyoto-osaka-2026-5c9f/index.html && echo SHOULD-BE-ZERO || echo FALLBACK-OK
find dist/trips/japan-kyoto-osaka-2026-5c9f -type f | sort | xargs md5 | diff <(grep japan-kyoto /tmp/baseline-render.md5) - && echo RESTORED-OK
```

Expected: 有海報時 `poster-panel` ≥1 且 `poster.png` 存在；刪掉後 `FALLBACK-OK`
＋ `RESTORED-OK`。

- [ ] **Step 6: 視覺確認（headless Chrome）**

先重放假海報（同 Step 5 的 cp）→ 重印 → 起 server → 截桌面版與 375px 手機版：

```bash
cd dist/trips/japan-kyoto-osaka-2026-5c9f && python3 -m http.server 4399 &
sleep 1
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --disable-gpu --no-sandbox --user-data-dir=/tmp/chrome-check --hide-scrollbars --screenshot=/tmp/poster-desktop.png --window-size=1400,2400 http://localhost:4399/index.html
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --disable-gpu --no-sandbox --user-data-dir=/tmp/chrome-check --hide-scrollbars --screenshot=/tmp/poster-mobile.png --window-size=375,1600 http://localhost:4399/index.html
kill %1
```

**打開兩張截圖看**：畫版有邊框與 caption、h1 縮小、375px 不撐爆 grid
（已知坑 #3/#4）。看完清掉假海報、重印還原（同 Step 5 尾段）。

---

### Task 4: posterPrompt 模板 ＋ runPosterAgent（三層 backend）

**Files:**
- Modify: `pipeline/agents.mjs`（檔尾 export 區加兩個函式；檔頭確認有 `node:child_process`、`node:fs`、`node:path` import，缺就加）

**Interfaces:**
- Consumes: `mergedTokens(themeName)` from `./themes.mjs`。
- Produces:
  - `posterPrompt({ city, landmarks, palette, slogan }) -> string`
  - `runPosterAgent({ city, landmarks, themeName, outPath }) -> Promise<{ backend, prompt } | { status:'skipped', notes, prompt }>`
    成功時圖已寫到 `outPath`；skipped 由 orchestrator 的 `supervise` 誠實記錄。

- [ ] **Step 1: 先探測 codex CLI 生圖能力（實彈，寫碼前）**

```bash
which codex && codex --version
codex exec --help 2>&1 | head -40
# 一次性探測（沙盒/旗標名以 --help 實際輸出為準微調）：
codex exec --skip-git-repo-check "Generate an image of a plain red circle centered on a white background. Save it as a PNG file at exactly this path: /tmp/codex-poster-probe.png. Do not ask questions." 
ls -la /tmp/codex-poster-probe.png && file /tmp/codex-poster-probe.png
```

Expected 兩種結果，都要記進實作：
- **成功**（PNG 生出來）→ 記下能跑通的确切指令與旗標，Step 3 的 `codex` backend 用它。
- **失敗**（無圖像能力/CLI 不在）→ `codex` backend 實作保留但探測式進場：
  runtime 先做同樣的小探測、失敗直接 throw 讓 orchestrator 降級。**不硬猜介面。**

- [ ] **Step 2: `posterPrompt`（Zack 原 prompt 參數化）**

```js
// 記念票海報 prompt — Zack 的 typographic travel poster prompt 參數化版：
// 城市名、真實地標（Local Discovery 查證過的）、palette（跟 theme 同色系）動態代入。
export function posterPrompt({ city, landmarks = [], palette, slogan = '' }) {
  const landmarkLine = landmarks.length
    ? `Feature these real landmarks and cultural elements of ${city} — accuracy matters, do not invent or substitute others: ${landmarks.join(', ')}.`
    : `Ensure every landmark, architectural style, sign, and cultural element is accurate for ${city} — not universal or incorrect landmarks.`
  return [
    'Create a clean, modern, typographic travel poster in which the name of the city itself becomes a composition.',
    `Highlight the city name ${city.toUpperCase()} in large, bold capital letters without serifs across the entire width of the illustration.`,
    "Integrate the city's most iconic landmarks, architecture, streets, transportation, cultural symbols, and local details into, around, and inside the letters. Let the landmarks interact naturally with the typography while maintaining legibility.",
    'Use an elegant flat vector illustration with clear geometric shapes, minimal details, clear contours, barely noticeable shadows, and excellent editorial aesthetics.',
    `Use a limited color palette built from exactly these tones so the poster feels timeless: deep night ${palette.night}, warm cream ${palette.paper}, vermilion red ${palette.rail}, muted green ${palette.green}.`,
    landmarkLine,
    slogan ? `Include a small elegant slogan under the city name in minimal print-shop type: "${slogan}".` : '',
    'Add small decorative elements only if specific to the city (street lights, trees, birds, trams, ferries).',
    'Maintain voluminous negative space with a clean background and a perfectly balanced composition.',
    'Landscape 3:2 aspect ratio, museum-quality flat vector, centered composition.',
  ].filter(Boolean).join(' ')
}
```

- [ ] **Step 3: `runPosterAgent` 三層 backend**

```js
// Poster Agent — 記念票畫版生圖。backend 自動選擇（仿 LLM backend 的降級哲學）：
// codex CLI → Gemini API → manual（不生圖，prompt 交給使用者）。
// POSTER_BACKEND=codex|gemini|manual|off 可強制。任何失敗都往下層降，最後誠實 skip。
import { mergedTokens } from './themes.mjs'

async function posterViaCodex(prompt, outPath) {
  // 指令形式以 Task 4 Step 1 的探測結果為準；探測不過就 throw 降級。
  const { execFileSync } = await import('node:child_process')
  execFileSync('codex', ['exec', '--skip-git-repo-check',
    `${prompt}\n\nSave the generated image as a PNG file at exactly this path: ${outPath}. Do not ask questions.`],
    { timeout: 240_000, stdio: 'pipe' })
  if (!fs.existsSync(outPath)) throw new Error('codex exec finished but produced no PNG')
}

async function posterViaGemini(prompt, outPath) {
  const key = process.env.GEMINI_API_KEY
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent?key=${key}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { imageConfig: { aspectRatio: '3:2' } },
      }),
    },
  )
  if (!res.ok) throw new Error(`Gemini image API ${res.status}: ${(await res.text()).slice(0, 200)}`)
  const json = await res.json()
  const part = json.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data)
  if (!part) throw new Error('Gemini response contained no inline image data')
  fs.writeFileSync(outPath, Buffer.from(part.inlineData.data, 'base64'))
}

export async function runPosterAgent({ city, landmarks, themeName, outPath }) {
  const palette = mergedTokens(themeName)
  const prompt = posterPrompt({ city, landmarks, palette })
  const forced = process.env.POSTER_BACKEND
  if (forced === 'off') return { status: 'skipped', notes: 'POSTER_BACKEND=off.', prompt }

  const hasCodex = (() => {
    try { const { execFileSync } = require('node:child_process'); execFileSync('which', ['codex']); return true }
    catch { return false }
  })()
  const order = forced ? [forced]
    : [hasCodex && 'codex', process.env.GEMINI_API_KEY && 'gemini', 'manual'].filter(Boolean)

  fs.mkdirSync(path.dirname(outPath), { recursive: true })
  const errors = []
  for (const backend of order) {
    if (backend === 'manual') {
      return { status: 'skipped', prompt,
        notes: `No image backend available (${errors.join('; ') || 'no codex CLI, no GEMINI_API_KEY'}). Poster prompt saved to cover.poster_prompt — generate manually and save to ${outPath}, then re-render.` }
    }
    try {
      if (backend === 'codex') await posterViaCodex(prompt, outPath)
      if (backend === 'gemini') await posterViaGemini(prompt, outPath)
      return { backend, prompt }
    } catch (error) {
      errors.push(`${backend}: ${error.message}`)
    }
  }
  return { status: 'skipped', notes: errors.join('; '), prompt }
}
```

注意：agents.mjs 是 ESM——`require` 不存在，`hasCodex` 檢查改用檔頭
`import { execFileSync } from 'node:child_process'` 統一處理（上面 `posterViaCodex`
的動態 import 也一併改掉，檔頭 import 一次）。`fs`/`path` 檔頭沒有就加
`import fs from 'node:fs'`、`import path from 'node:path'`。

- [ ] **Step 4: 驗證**

```bash
node --check pipeline/agents.mjs
# prompt 模板單元 smoke：
node -e "
import('./pipeline/agents.mjs').then(async (m) => {
  const p = m.posterPrompt({ city: 'Kyoto', landmarks: ['Fushimi Inari Taisha', 'Kinkaku-ji'], palette: (await import('./pipeline/themes.mjs')).mergedTokens('japan') })
  console.log(p)
  if (!p.includes('KYOTO') || !p.includes('#1f3a4d') || !p.includes('Fushimi Inari')) throw new Error('template missing pieces')
  console.log('PROMPT-OK')
})"
# manual 降級 smoke（不打任何 API）：
POSTER_BACKEND=manual node -e "
import('./pipeline/agents.mjs').then(async (m) => {
  const r = await m.runPosterAgent({ city: 'Kyoto', landmarks: [], themeName: 'japan', outPath: '/tmp/poster-test.png' })
  console.log(JSON.stringify(r.status)); if (r.status !== 'skipped') throw new Error('expected skipped')
  console.log('MANUAL-OK')
})"
```

Expected: `PROMPT-OK`、`MANUAL-OK`。有 `GEMINI_API_KEY` 或 codex 探測成功的話，
再各跑一次真生圖 smoke（`POSTER_BACKEND=gemini`/`codex`，outPath 指到 /tmp，
`file /tmp/poster-test.png` 應為 PNG）。模型名 404 的話：
`curl -s "https://generativelanguage.googleapis.com/v1beta/models?key=$GEMINI_API_KEY" | grep -o '"name":[^,]*image[^,]*'`
找現役 image 模型名替換。

---

### Task 5: orchestrator 接線（theme 欄位 ＋ Poster stage ＋ prune）

**Files:**
- Modify: `pipeline/orchestrator.mjs`（import ~line 24-30、TIMEOUTS ~line 122、
  assembleItinerary ~line 302、main 的 Stage 3 之後 ~line 430、prune ~line 55-74）

**Interfaces:**
- Consumes: `runPosterAgent`（Task 4）、`resolveTheme`（Task 1）。
- Produces: final JSON 新欄位——`theme`（字串）、`cover.poster`（成功才有，值固定
  `'poster.png'`）、`cover.poster_prompt`（一律寫入，manual 重生用）。

- [ ] **Step 1: imports**

agents import 清單加 `runPosterAgent`；新增
`import { resolveTheme } from './themes.mjs'`。

- [ ] **Step 2: TIMEOUTS 加 `'Poster Agent': 300_000`**

- [ ] **Step 3: Stage 3 之後、assemble 之前插 Poster stage**

在 `// Assemble + persist` 前加：

```js
  // Stage 3.5 — poster（記念票畫版）。city 取第一個 base，landmarks 取 Discovery 查證過的 POI。
  const themeName = resolveTheme({ destination_timezone: brief.destination_timezone, destination: brief.destination })
  const posterCity = composed.days?.[0]?.base
    || String(brief.destination || '').split(':').pop().split(/[&，,]/)[0].trim() || 'Trip'
  const posterLandmarks = (discovery.pois || []).slice(0, 6).map((p) => p.title).filter(Boolean)
  const posterOut = path.join(packageRoot, 'data', 'posters', `${tripId}.png`)
  let posterResult = null
  if (mock) {
    recordStatus('Poster Agent', 'skipped', 0, 'Mock mode: no image generation.')
    log('Poster Agent: skipped (mock)')
  } else {
    const posterRun = await supervise('Poster Agent', () => runPosterAgent({
      city: posterCity, landmarks: posterLandmarks, themeName, outPath: posterOut,
    }), { confidence: 0.7 })
    posterResult = posterRun.ok && !posterRun.result?.status ? posterRun.result : (posterRun.result ?? null)
  }
```

- [ ] **Step 4: assembleItinerary 收 theme/poster**

簽名改為
`function assembleItinerary({ tripId, brief, timezone, discovery, composed, contextResult, calendarResult, themeName, posterResult })`，
`itinerary` 物件 `cover:` 那行改為：

```js
    theme: themeName,
    cover: {
      ...composed.cover,
      ...(posterResult?.backend ? { poster: 'poster.png' } : {}),
      ...(posterResult?.prompt ? { poster_prompt: posterResult.prompt } : {}),
    },
```

呼叫端（`const itinerary = assembleItinerary({...})`）補傳
`themeName, posterResult`。mock 模式 `posterResult` 為 null → 欄位自然不出現。

- [ ] **Step 5: prune 同步清海報**

prune 迴圈（~line 58-73）裡，刪 `data/trips/<f>` 與 `dist/trips/` 的同時，
讀該 json 拿 `trip_id` 刪 `data/posters/<trip_id>.png`（讀失敗＝壞 json，
沿用「壞 json 不動」原則跳過）：

```js
    try {
      const tid = JSON.parse(fs.readFileSync(path.join(tripsDir, f), 'utf8')).trip_id
      if (tid) fs.rmSync(path.join(packageRoot, 'data', 'posters', `${tid}.png`), { force: true })
    } catch { /* 壞 json 不動（含它的海報） */ }
```

（放在既有刪除語句**之前**——json 刪掉就讀不到 trip_id 了。變數名
`tripsDir` 以現場實際命名為準。）

- [ ] **Step 6: 驗證（mock 全流程）**

```bash
node --check pipeline/orchestrator.mjs
npm run plan:mock
node -e "
const j = JSON.parse(require('fs').readFileSync('data/final_itinerary.json','utf8'))
console.log('theme:', j.theme)                      // 期望 japan（MOCK_BRIEF 是 Asia/Tokyo）
const ps = j.agent_statuses.find(s => s.agent === 'Poster Agent')
console.log('poster agent:', JSON.stringify(ps))    // 期望 status skipped（mock）
if (j.theme !== 'japan' || !ps || ps.status !== 'skipped') process.exit(1)
console.log('MOCK-OK')"
grep -c "d3381c" dist/index.html   # 期望 ≥1（mock 出的最新手冊套了 japan 皮）
```

Expected: `MOCK-OK`、`d3381c` ≥1。
**注意**：`plan:mock` 會產生一份新 mock 手冊進票夾（`data/trips/` 多一份）——
測完可用 `node pipeline/orchestrator.mjs --prune=3` 或手動刪該 json＋dist 目錄清掉，
但**不要**動瑞士與京都那兩份基準。

- [ ] **Step 7: 真跑一次（有 LLM backend 才做，約 6 分鐘）**

```bash
POSTER_BACKEND=manual npm run plan -- "十一月底帶爸媽去東京五天，淺草雷門和築地想去，步調放鬆"
node -e "
const j = JSON.parse(require('fs').readFileSync('data/final_itinerary.json','utf8'))
console.log('theme:', j.theme, '| poster_prompt head:', (j.cover.poster_prompt||'').slice(0,80))
if (j.theme !== 'japan' || !j.cover.poster_prompt) process.exit(1); console.log('REAL-OK')"
```

Expected: `REAL-OK`，`poster_prompt` 含 TOKYO 與真實地標。（codex/gemini 可用時
改跑對應 backend，確認 `data/posters/<trip_id>.png` 生出來、封面有畫版。）

---

### Task 6: PWA precache 收海報

**Files:**
- Modify: `pipeline/pwa.mjs`（`writePwaAssets` ~line 247、`serviceWorkerJs` ~line 174）
- Modify: `pipeline/render.mjs`（`writePwaAssets(...)` 呼叫點 ~line 1567）

**Interfaces:**
- Produces: `writePwaAssets(outDir, meta, pages, extraAssets = [])`——第四參數選填，
  空陣列時輸出**逐 byte 不變**（回歸鐵律）。

- [ ] **Step 1: pwa.mjs**

```js
export function writePwaAssets(outDir, { name, short, description }, pages, extraAssets = []) {
  // extraAssets 空時 hash 輸入與舊版完全相同 → 舊手冊 sw.js 逐 byte 不變（回歸鐵律）。
  const hashInput = extraAssets.length ? [name, pages, extraAssets] : [name, pages]
  const cacheId = crypto.createHash('sha1').update(JSON.stringify(hashInput)).digest('hex').slice(0, 12)
  fs.writeFileSync(path.join(outDir, 'manifest.webmanifest'), manifestJson({ name, short, description }))
  fs.writeFileSync(path.join(outDir, 'sw.js'), serviceWorkerJs([...pages, ...extraAssets], cacheId))
  ...
```

（`serviceWorkerJs` 本身不用改——它收到的清單多了 `poster.png` 就會進 CORE。
已知坑 #11 的 clone 時機**一個字都不碰**。）

- [ ] **Step 2: render.mjs 呼叫點**

```js
  writePwaAssets(outDir, { name: appName, short: appShort, description: itinerary.summary || appName }, pages, hasPoster ? ['poster.png'] : [])
```

- [ ] **Step 3: 驗證**

```bash
node --check pipeline/pwa.mjs pipeline/render.mjs 2>/dev/null || { node --check pipeline/pwa.mjs && node --check pipeline/render.mjs; }
# 回歸（無海報 → sw.js 不變）：
node pipeline/orchestrator.mjs --render-only --trip=switzerland
node pipeline/orchestrator.mjs --render-only --trip=japan-kyoto-osaka
find dist/trips/switzerland-lucerne-interlaken-lauterbrunnen-2026-470b dist/trips/japan-kyoto-osaka-2026-5c9f -type f | sort | xargs md5 | diff /tmp/baseline-render.md5 - && echo REGRESSION-OK
# 有海報 → CORE 收錄 + cacheId 變：
TRIP_ID=$(node -e "console.log(JSON.parse(require('fs').readFileSync('data/trips/japan-kyoto-osaka-2026-5c9f.json','utf8')).trip_id)")
cp dist/icon-512.png "data/posters/${TRIP_ID}.png"
node pipeline/orchestrator.mjs --render-only --trip=japan-kyoto-osaka
grep -o "poster.png" dist/trips/japan-kyoto-osaka-2026-5c9f/sw.js | head -1   # 期望有
rm "data/posters/${TRIP_ID}.png"; node pipeline/orchestrator.mjs --render-only --trip=japan-kyoto-osaka
```

Expected: `REGRESSION-OK`；有海報時 sw.js CORE 含 `poster.png`。
（「有註冊 ≠ 有快取」的 runtime 驗證放 Task 9 一起做。）

---

### Task 7: Studio 顯示 Poster agent ＋ manual prompt 出口

**Files:**
- Inspect（可能免改）: `pipeline/server.mjs`、`pipeline/studio.html`

- [ ] **Step 1: 確認 agent 進度列是動態的**

```bash
grep -n "agents\b\|agent_statuses\|Poster" pipeline/server.mjs pipeline/studio.html | head -20
```

studio 的 `#agents` 容器是 JS 動態填的：若 rows 來自 orchestrator 的
log/`agent_statuses`（大概率），Poster Agent 自動出現，**此檔免改**。
若發現硬編 agent 名單（array literal），在該 array 加 `'Poster Agent'`。

- [ ] **Step 2: manual prompt 出口確認**

manual 模式的 prompt 已在 `cover.poster_prompt`（JSON）＋ supervise 的 skipped
notes（帶落檔路徑說明）會進 studio logbox。跑一次
`POSTER_BACKEND=manual npm run plan:mock`……mock 會直接 skip，改用：檢查
Task 5 Step 7 真跑那份的 studio 顯示，或至少確認 logbox 有
`Poster Agent: skipped` 行。夠誠實即可，不加新 UI（YAGNI）。

- [ ] **Step 3: 驗證**

```bash
npm run studio &   # :4747
sleep 1
curl -s http://127.0.0.1:4747/ | grep -c "agents"   # 頁面活著
kill %1
```

Expected: ≥1。（server.mjs 若真的改了，記得重啟才驗得到——已知坑 #6。）

---

### Task 8: docs/design-system.md ＋ docs/history/handover-2026-07-05.md 登記（治理收尾）

**Files:**
- Modify: `docs/design-system.md`（新章節）
- Modify: `docs/history/handover-2026-07-05.md`（現況段補一行）

- [ ] **Step 1: docs/design-system.md 加「主題註冊表」章節**（放在「Tokens」章之後）

內容必須含（值抄 Task 1 校準後的定案值、比值抄 check-theme-contrast 實測輸出）：

```markdown
## 主題註冊表（2026-07-14 起）

Theme = token 的**覆寫集**（`pipeline/themes.mjs`），不是新設計系統。治理：
新 theme 每個色先過 `node scripts/check-theme-contrast.mjs`（docs/design-system.md 對比鐵律的
可執行版）才准登記；motif 開關逐個列出；render 端只讀 `itinerary.theme` 欄位、
不推斷（舊 JSON 一律 default）。

### japan（朱色/藍染/山吹/松葉）

| Token | 值 | 實測對比 |
|---|---|---|
| `--rail` | #d3381c | （非內文用途） |
| `--rail-deep` | <定案值> | <x.xx>:1 on paper / <x.xx>:1 on paper-bright |
| `--rail-press` | <定案值> | 白字 <x.xx>:1 |
| `--night` | #1f3a4d | gold <x.xx>:1、paper-dim <x.xx>:1（深底全項見腳本） |
| …（其餘覆寫 token 全列）… | | |

Motifs：`stampText: 済`（判子風郵戳，localStorage 格式不變）、
`eyebrow: 記念切符 · UTC-first preview`（Composer 給了自訂 eyebrow 優先）。

### poster（記念票畫版）— 元件語彙

封面票的「記念切符」規格：海報（AI 生成的城市 typographic poster，palette 代入
theme tokens）是票面上半的印刷畫，機器層（條碼/serial/microprint/route）不動。
觸發器＝`data/posters/<trip_id>.png` 存在；`cover.poster_prompt` 記錄圖的來源
（誠實可追溯）。無海報＝現狀封面，零改變。
```

- [ ] **Step 2: docs/history/handover-2026-07-05.md 現況段補一行**（「已完成」清單尾）：

```markdown
- **地區主題＋記念票海報**（2026-07-14）：themes.mjs 註冊表（japan＝朱/藍染/山吹）、
  判子郵戳「済」、Poster Agent 三層 backend（codex→gemini→manual），海報存
  data/posters/<trip_id>.png、--render-only 只重用不重生、--prune 同步清。
  詳見 docs/history/specs/2026-07-14-region-theming-poster-design.md。
```

- [ ] **Step 3: 驗證** — 重讀兩檔改動處，確認表格值不是佔位符（`<定案值>` 全部換成實值）。

---

### Task 9: 總驗收（全套跑一遍）

**Files:** 無新改動——只驗證。

- [ ] **Step 1: 語法全綠**

```bash
for f in pipeline/themes.mjs pipeline/render.mjs pipeline/agents.mjs pipeline/orchestrator.mjs pipeline/pwa.mjs; do node --check "$f" || echo "FAIL $f"; done
```

- [ ] **Step 2: 對比 gate**：`node scripts/check-theme-contrast.mjs` → exit 0。

- [ ] **Step 3: 回歸鐵律**：重印瑞士＋京都 → md5 對 `/tmp/baseline-render.md5` 全同。

- [ ] **Step 4: japan＋海報 end-to-end**（假海報 smoke 或真生圖擇一）＋
  headless 截圖桌面/375px 兩張**打開看**。

- [ ] **Step 5: PWA runtime 快取驗證**（「有註冊 ≠ 有快取」）：
  起 server → headless Chrome 開兩次（第二次讓 SW 接管）→ DevTools protocol 或
  頁內 eval `caches.keys()` dump，確認 poster.png 在 cache 內容裡。做不到 runtime
  dump 就至少：sw.js CORE 含 poster.png ＋ cacheId 與無海報版不同，並在交接註記
  runtime 驗證未做。

- [ ] **Step 6: print 檢查**：headless Chrome `--print-to-pdf` 出封面 PDF，
  確認海報上紙、A4 單頁（已知坑 #10）。

- [ ] **Step 7: hallmark 審計**跑一輪版面（`~/.agents/skills/hallmark`，docs/history/feature-specs-2026-07-03.md
  的編隊表）；本輪無新動效，`review-animations` 免跑。

- [ ] **Step 8: 測試殘留清理**：`data/posters/` 裡的假海報刪掉、mock 手冊
  prune 掉、`/tmp` 檔不用管。final state：瑞士＋京都兩份與基準 md5 一致。

---

## Self-Review 紀錄（計畫作者已檢）

- Spec 覆蓋：主題註冊表(T1)、render 換皮＋motif(T2)、poster 畫版＋manual 流(T3)、
  prompt 模板＋三層 backend(T4)、orchestrator theme/poster/prune(T5)、PWA(T6)、
  Studio(T7)、DESIGN/HANDOVER 治理(T8)、總驗收含 print/PWA/375px(T9)。
  Spec 的「明確不做」清單無對應 task——正確。
- 型別/名稱一致性：`resolveTheme`/`themeCss`/`mergedTokens`/`runPosterAgent`/
  `posterPrompt`/`writePwaAssets(…, extraAssets)` 各 task 引用一致；
  poster 觸發器統一為「檔案存在」，`cover.poster` 僅紀錄。
- 已知風險已編入：codex CLI 介面未知（T4 S1 先探測）、Gemini 模型名可能漂移
  （T4 S4 給了查模型清單指令）、sw.js hash 輸入向下相容（T6 S1）、
  iCloud dataless（Global Constraints）。
