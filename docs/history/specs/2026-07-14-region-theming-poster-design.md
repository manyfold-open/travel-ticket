# SPEC — 地區主題換皮 ＋ 記念票城市海報（2026-07-14，Zack 拍板）

> Archived implementation specification. Current theme governance lives in
> `docs/design-system.md`; current code lives in `pipeline/themes.mjs`,
> `pipeline/render.mjs`, and `pipeline/agents/poster.mjs`.
>
> 給實作 agent 的開場順序：先讀 `docs/design-system.md`（設計唯一真實來源）→ 本檔 → `docs/history/handover-2026-07-05.md`
> 的「工作方式」與「已知坑」。本目錄**不是 git repo**，不要跑 git 指令。
> 改前端鐵律不變：新色先進 docs/design-system.md token 表再 var() 引用，禁裸 hex；改完
> `node --check` ＋ `--render-only` 雙 trip 重印 ＋ preview 驗證。

## 目標（一句話）

日本行程的手冊要「像一張日本的車票」：整套配色/細節換成日式主題（換皮），
且封面票升級為**記念切符**規格——票面印一張該城市的扁平向量海報（AI 生成），
票的機器層（條碼、microprint、路線欄）原封不動包著它。

兩個軸解耦：**主題（theme）不依賴海報，海報不依賴主題**。只有主題、只有海報、
兩者都有、兩者都無，四種組合都必須正確渲染。

---

## 軸一：主題註冊表（deterministic 換皮）

### 架構

- 新檔 `pipeline/themes.mjs`：export 一個 `THEMES` 註冊表＋ `resolveTheme(itinerary)`。
- 每個 theme = **token 覆寫物件**（只覆寫、不重造：未列出的 token 繼承 default）＋
  少量**文化細節開關**（motif flags）。
- `render.mjs` 的 css 模板把 `:root` 區塊改成：default tokens ＋ theme 覆寫序列化
  進去。**不是**另寫一套 CSS——選擇器/版面零改動，只換變數值。
- `studio.html` 不套 theme（開發工具維持現狀）。

### Theme 選擇邏輯（寫進 orchestrator，渲染端不再推斷）

1. `itinerary.theme` 欄位明確指定 → 直接用（手動覆寫口）。
2. 否則按 `destination_timezone` 映射：`Asia/Tokyo` → `japan`。
3. 否則 `destination` 字串含 `Japan`／`日本` → `japan`。
4. 都不中 → `default`。

orchestrator 在組裝 final JSON 時把**解析結果寫進 `itinerary.theme`**，
render 只讀這個欄位——`--render-only` 重印永遠確定性，不重推斷。
舊 JSON 沒有 `theme` 欄位 → render 一律當 `default`（**不推斷**，否則既有京都
手冊一重印就變皮，違反回歸鐵律）。想幫舊手冊換皮：手動在該份
`data/trips/<slug-id>.json` 加 `"theme": "japan"` 再 `--render-only --trip=<slug>`。

### japan 主題（第一版唯一新主題）

色彩方向（**候選值**，實作時必須先過對比驗證再定案、再登記進 docs/design-system.md）：

| Token | 候選值 | 靈感 |
|---|---|---|
| `--rail` | `#d3381c` | 朱色（判子朱肉、鳥居） |
| `--rail-deep` | `#8f2a14` 附近微調 | 深朱，紙上小字要 ≥4.5:1 |
| `--night` | `#1f3a4d` | 藍染／紺色（封面深色票面） |
| `--gold` | `#f8b500` | 山吹色（只上深底，鐵律不變） |
| `--green` | `#2f5d3a` 附近 | 松葉綠（sight 類） |
| `--blue` | `#165e83` | 藍（rest 類、連結） |
| `--board` | `#16211c` 附近 | 深色翻牌鐘底，往墨綠靠 |
| 紙色系（`--paper` 等） | 微調或不動 | 生成り色本來就接近現有米紙 |

衍生 tokens（`--rail-press`、`--board-hi/lo/edge`、`--lane-gradient`…）凡是從
上表派生的都要跟著出 japan 版本；純紙色系可繼承 default。

**對比驗證是硬 gate**：docs/design-system.md 的鐵律逐條重驗（紙上文字 ≥4.5:1、gold 禁上紙、
CTA 白字底 ≥4.5:1、`--rail-deep` on paper ≥4.5:1）。寫一個一次性 Node 腳本算
contrast ratio 全表跑過才准登記；驗證結果（實測比值）寫進 docs/design-system.md 的主題表格，
跟現有 `--rail-deep` 的寫法一樣。

### 文化細節（motif flags，劑量鐵律：安靜原則不變）

第一版只做兩個，其餘想法登記在 spec 不做（YAGNI）：

1. **郵戳改判子風**：`punch + postmark` 元件在 japan 主題下，郵戳中央 `VISITED`
   改「**済**」單字＋圈內小字保留蓋章時刻（時間戳承載資訊原則不變）；顏色用
   theme 的 `--rail-deep`。既有 localStorage 格式/指紋**完全不動**（HANDOVER 定案：
   stamp fingerprint 不修）。
2. **封面 eyebrow 用語**：japan 主題下 cover eyebrow 預設文案帶「記念切符」字樣
   （Composer 給了自訂 eyebrow 就尊重 Composer）。

不做清單（明確排除）：直書 writing-mode 裝飾、和紙紋理底圖、額外日文裝飾字層——
與「其餘保持安靜」衝突，等真的需要再開 spec。

### docs/design-system.md 更新（治理）

新增「主題註冊表」章節：宣告 theme = token 覆寫的治理規則（新 theme 必須整套過
對比驗證、必須登記在 docs/design-system.md、motif flags 逐個列出）、japan 主題完整 token 表
（含實測對比值）、記念票元件語彙（見軸二）。

---

## 軸二：Poster Agent（記念票城市海報）

### 隱喻定位（寫進 docs/design-system.md 元件語彙）

`poster`（記念票畫版）：封面票升級「記念切符」規格——海報是票面上半的**印刷畫**，
不是貼上去的裝飾。票的機器層（條碼、serial、microprint、路線欄、agent 狀態）
原封不動。判準「真的車票會這樣印嗎」→ 會，日本鐵道的記念切符就是這樣。

### Pipeline 整合

- 新 agent：`runPosterAgent(brief, discovery, theme)` 加進 `pipeline/agents.mjs`，
  orchestrator 在 Composer 之後跑（要用到城市名＋Local Discovery 的地標清單）。
  timeout/status/confidence 進 `agent_statuses`，跟其他 agent 同規格（誠實原則：
  skipped/failed/timeout 都如實記）。
- **Backend 自動選擇**（仿現有 LLM backend 的 sdk→cli fallback 哲學），
  可用 `POSTER_BACKEND=codex|gemini|manual|off` 強制：
  1. `codex` — 系統 PATH 有 `codex` CLI → headless spawn 生圖
     （Zack 的 ChatGPT 額度）。**實作第一步是能力探測**：先小規模驗證 codex CLI
     headless 出圖的確切指令與輸出格式，探測失敗就降級到下一層，不硬猜。
     > 更正（2026-07-14 晚）：探測已解——codex CLI ≥0.144 內建圖像生成，`codex exec`
     > 叫它存 PNG 即可，實測 ~100s 生出高品質海報。codex 現為主力 backend（免 API key）。
  2. `gemini` — 有 `GEMINI_API_KEY` → 直接打 Gemini 圖像生成 API（nano banana 系模型）。
  3. `manual` — 都沒有：不生圖。把調好的完整 prompt 寫進
     `itinerary.cover.poster_prompt` ＋ Studio logbox 印出（可複製），使用者自己
     生完把圖存成 `data/posters/<trip_id>.png`，`--render-only` 重印即帶上。
- **產物與重用**：
  - 原圖存 `data/posters/<trip_id>.png`（單一真實來源，跟 trips json 同層治理）。
  - 渲染時複製進每個輸出 dir（dist 根＋`dist/trips/<slug>/`）為 `poster.png`
    ——每個 dir 自足（zip 下載原則不破）。
  - JSON 記 `cover.poster = "poster.png"`（相對路徑）＋ `cover.poster_prompt`
    （誠實：圖怎麼來的可追溯）。
  - **`--render-only` 只重用不重生**（省錢＋確定性）。重生的唯一途徑是重跑 pipeline
    或未來加 `--regen-poster` 旗標（第一版不做）。
  - `--prune` 要同步清 `data/posters/`（跟 trips json 同生命週期）。

### Prompt 模板（改造 Zack 的原 prompt）

新函式 `posterPrompt({ city, landmarks, palette, slogan })`，保留原 prompt 的骨架
（typographic travel poster、城市名大字、地標融進字母、flat vector、negative space、
準確地標要求），但三處參數化：

1. **City name**：`brief`／`destination` 的主城市，大寫（例：`KYOTO`）。
2. **Landmarks**：從 Local Discovery agent 的產出抽真實地標名清單餵進 prompt
   （原 prompt 要求「地標必須準確」——我們直接給查證過的清單，比讓生圖模型自由發揮可靠）。
   Discovery 被 skip 時退回只給城市名。
3. **Palette**：原 prompt 寫死的 dark blue/warm cream/muted red/soft gray-blue
   **替換成當前 theme 的 hex**（japan：`--night` 藍染、`--paper` 米紙、`--rail` 朱、
   `--green` 松葉），海報跟票面天生同色系。
4. Slogan 選配：cover eyebrow 或城市別名，一行小字。

比例規格：**橫式 3:2**（配合封面票面），目標寬 ≥1600px。輸出一律轉存 PNG。

### 封面版面（render.mjs）

- `cover.poster` 存在且檔案在 → 封面票的深色票面上半渲染海報畫版（`.poster-panel`）：
  海報圖＋細邊框＋角落一行 mono 小字（`記念切符 · <trip_id>`——裝飾承載資訊）。
  原本的超大 `JAPAN ITINERARY` h1 **壓縮為海報下方的次級標題行**（海報本身已是
  城市名 typography，不能兩個大字打架）；eyebrow、票夾 route 欄、stats、
  microprint、條碼全部不動。
- `cover.poster` 不存在 → **現狀封面一個像素都不變**（fallback 即現狀，零風險）。
- 手機直式：海報 full-width 置頂，比例用 `aspect-ratio` 鎖住防 CLS。
- `@media print`：海報照印（它是票面的一部分），確認 A4 單頁放得下
  （HANDOVER 已知坑 #10 的 `screen and` 斷點限定不能退）。
- 圖片標 `alt`（「<城市> 記念海報」）；裝飾邊框 `aria-hidden`。

### PWA / SW（pipeline/pwa.mjs）

- `poster.png` 加進 precache 清單；`cacheId` 的 hash 輸入加入 poster 檔名
  （換海報要 bump cache）。已知坑 #11 的 clone 時機鐵律不碰。
- 驗收必須 dump `caches` 內容確認 poster 真的進了快取（「有註冊 ≠ 有快取」教訓）。

### Studio（pipeline/server.mjs + studio.html）

- agent 進度列多一行 Poster（沿用既有 phase 播報機制）。
- manual backend 時 logbox 印 prompt 全文＋落檔路徑說明。
- 不改 server 的安全邊界（127.0.0.1 bind、originOk、body 上限全部不動）。

---

## 測試 / 驗收清單（實作 agent 照跑）

1. `node --check`：themes.mjs、render.mjs、agents.mjs、orchestrator.mjs、pwa.mjs。
2. 對比驗證腳本：japan 主題全 token 過 docs/design-system.md 鐵律，實測值登記進 docs/design-system.md。
3. `npm run plan:mock` ＋強制 `theme=japan`、`POSTER_BACKEND=off` → 日式換皮渲染
   正確、無海報時封面 fallback 正確。
4. manual 海報流程：手放一張 3:2 PNG → `--render-only` → 封面出現海報畫版、
   `dist/trips/<slug>/poster.png` 存在、print 預覽單頁。
5. codex backend 能力探測＋（成功的話）一次真生圖 smoke；失敗降級鏈誠實記錄
   進 `agent_statuses`。
6. 回歸：`--render-only` 重印**既有兩份手冊**（瑞士＋京都）→ 逐像素不變
   （無 theme 欄位的舊 JSON 一律 default，不推斷）。
7. PWA：dump caches 確認 poster 進快取；SW cacheId 有隨海報 bump。
8. hallmark 審計跑一輪（版面）；本 spec 無新動效，`review-animations` 免跑
   （判子郵戳只是 SVG 內容替換，落章動效沿用）。
9. 手機 375px 檢查：poster panel 不撐爆 grid（已知坑 #3/#4：nowrap 與
   `minmax(0,1fr)` 鐵律）。

## 明確不做（YAGNI）

- 日本以外的新主題（表可擴充，但第一版只有 japan + default）。
- `--regen-poster` 旗標、海報多語系、海報進日票內頁。
- 直書/和紙紋理等額外和風裝飾。
- Composer LLM 自選配色（違反治理，永久排除）。
- 帳號/資料庫/雲端海報庫（產品「輕」的底線）。

## 風險與開放問題

- **codex CLI headless 生圖的介面不確定**：故列為實作第一步的探測項，探測不過
  就走 gemini/manual，不阻塞主線。
- **生圖模型對「地標準確」的遵從度**：已用 Discovery 真實地標清單餵 prompt 降險；
  仍不保證版畫內容百分百正確——記念票畫版是藝術印刷不是資訊層，可接受。
- **海報色彩與 palette 指令的偏離**：生圖模型不一定嚴格用 hex；驗收標準是
  「肉眼同色系」，不是像素級比對。
