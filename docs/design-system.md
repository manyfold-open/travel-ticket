# Trip Ticket 設計系統

> Current design source of truth. Repository paths in this document are relative
> to the project root.

> 單一真實來源：所有頁面（產出手冊 `pipeline/render.mjs`、入口 `pipeline/studio.html`）
> 都必須從這份文件的 token 取值，不得另創顏色/字級/間距。

## 概念（已定案，Stage 0）

**火車票**。整個產品是一疊被撕下來的長途車票:封面是總票、每一天是一張日票。
所有設計決策回到同一個判準:**「真的車票會這樣印嗎？」**

- 票是「機器印在紙上」的：紙色底、油墨色字、撕孔、票根、條碼、序號。
- 資訊分兩層:**人寫的**（行程敘述，中文，Noto Sans TC）與**機器印的**
  （時刻、日期、序號、代碼——等寬字、大寫、字距拉開）。
- 誠實是設計的一部分：agent 狀態、warning 條款都印在票面上，不藏。

## Signature

**由 `trip_id` 派生的條碼**（票根底部）。條碼的線寬序列以 trip 序號雜湊生成——
每份手冊的條碼都不同、且真的編碼自己的身分。裝飾必須承載資訊，這是本專案
對「structure is information」的回答。全站的大膽額度花在這裡，其餘保持安靜。

## Tokens

### 色彩（`:root` CSS variables）

| Token | 值 | 用途 |
|---|---|---|
| `--ink` | `#171713` | 主文字/油墨 |
| `--muted` | `#69645a` | 次要文字（紙上，≥4.5:1） |
| `--paper` | `#fff8ea` | 票紙 |
| `--line` | `#d6c7aa` | 紙上邊線 |
| `--rail` | `#e3372d` | 主紅：撕孔、CTA、travel 類 |
| `--rail-deep` | `#9c322b` | 紙上的紅色小字（label/eyebrow；實測 6.84:1 on `--paper`、7.11:1 on `--paper-bright`，穩過 4.5 鐵律） |
| `--gold` | `#f3c95f` | 金：**只用在深色底上**（eyebrow、強調字） |
| `--blue` | `#176b87` | rest 類、來源連結 |
| `--green` | `#1f5d4a` | sight 類 |
| `--night` | `#292a25` | 封面深色票面 |
| `--board` | `#191916` | 翻牌鐘底 |

對比鐵律：`--gold` 禁止出現在 `--paper` 上（1.6:1）；紙上要紅色小字一律 `--rail-deep`
（含 `.stamp`、`.stub-title`；封面深色票面上的 stamp 改用 `--gold`）。
CTA 白字的底色用 `--rail-press`（白字對 `--rail` 只有 4.33:1，不及格）；
`--rail` 保留給撕孔、色條、大字（≥19px 粗體）等非內文用途。

### 衍生 tokens（2026-07-03 hallmark/impeccable 收斂後註冊）

紙、線、深底淡字的色階全部具名，禁止再出現裸 hex：

| Token | 值 | 用途 |
|---|---|---|
| `--rail-press` | `#c82018` | CTA 底色與按壓態（白字 5.7:1） |
| `--stamp` | `#9c322b` | 判子/postmark 郵戳單色（default＝`--rail-deep`；主題可獨立覆寫，如 japan 走朱紅） |
| `--paper-bright` | `#fffdf7` | 票面上的小卡底、深底上的主文字 |
| `--paper-dim` | `#eee5d5` | 深色票面上的內文 |
| `--paper-faint` | `#e2d8c6` | 深色票面上的次要 label/fineprint |
| `--paper-ghost` | `#bdb19d` | 深色票面上的弱化資料字（log、代碼） |
| `--ink-soft` | `#4d473d` | 票卡敘述文字 |
| `--line-strong` | `#b9aa90` | 撕邊虛線、票根分隔 |
| `--line-btn` | `#c8b99e` | 紙上按鈕/輸入框邊線 |
| `--line-coupon` | `#c7b89b` | 票卡內虛線 |
| `--desk` / `--desk-shade` | `#efe0c3` / `#ddd8c8` | 桌面背景漸層 |
| `--stack-1` / `--stack-2` / `--stack-edge` | `#f3e7cf` / `#eadcc2` / `#d1c0a0` | 票疊底層 |
| `--board-hi` / `--board-lo` / `--board-edge` | `#2d2c27` / `#11110f` / `#070706` | 翻牌鐘立體面 |
| `--lane-gradient` | 見 `:root` | timeboard 泳道底 |
| `--signal-ok` | `#7fbf6a` | studio agent completed 燈（僅深底） |

白／紙色的 alpha 疊層（`rgba(255,255,255,*)`、`rgba(255,248,234,*)`、`rgba(23,23,19,*)`）
視為 token 色的透明度變體，允許直接使用。timeboard 色塊一律帶
`inset 0 0 0 1px rgba(23,23,19,.28)` 勾邊（`--gold` 色塊在泳道上 1.5:1，沒勾邊等於隱形）。

### 字體（三個角色）

| 角色 | 字體 | 用法 |
|---|---|---|
| Display | `Archivo` 900 | 大標、按鈕、label；uppercase + letter-spacing .11em |
| Body | `Noto Sans TC` 400/500/700/900 | 中文內文、票券敘述 |
| Data | `IBM Plex Mono` 500/600/700 | **所有機器資料**:時刻、日期代碼、trip 序號、條碼序號、log |
| Hand | `LXGW WenKai TC`（OFL，CDN 子集按需載入） | **手寫批註層**（`.annot`）：站務員/同行者的鉛筆字 |

Hand 角色劑量鐵律（2026-07-03 定案）：**每張票至多一句**（`handwritten_note`，≤22 字），
只出現在票根 stamp 旁或封面票根；內容必須是該票既有 warnings/notes 的口語改寫，
**不得引入新事實**（誠實原則）。條款本體永遠是 Body——機器印的字不用手寫體。
沒有 note 的頁面不載入文楷 webfont。

判準：這個字是「行程的內容」還是「票務系統印的」？後者一律 Data 角色，
並開 `font-variant-numeric: tabular-nums`。
適用清單（2026-07-03 起強制）：`.kv b`、`.mini b`、`.station b`、`.stat b`、
`.pass b`、`.tick`、`.flip-time`、`.coupon-time`、`.serial`。
`--font-mono` 的 fallback 帶 `"Noto Sans TC"`，讓混排的中文字落回 Body 字體而非系統等寬。

### 動效

- 每頁**一段**進場 timeline（GSAP:票面 → 翻牌鐘 → 時間軸 → 票卡），不加散落 hover 特效。
- 一切動效包在 `prefers-reduced-motion` 檢查內（JS 已檢查;CSS 動畫要包 media query）。

## 主題註冊表（2026-07-14 起）

Theme = token 的**覆寫集**（`pipeline/themes.mjs`），不是新設計系統。治理：
新 theme 每個色先過 `node scripts/check-theme-contrast.mjs`（docs/design-system.md 對比鐵律的
可執行版）全綠才准登記；motif 開關逐個列出；render 端只讀 `itinerary.theme` 欄位、
不推斷（無 `theme` 欄位的舊 JSON 一律 default，回歸鐵律）。

### japan（JR 青綠票面／朱紅判子／山吹／草綠）

日本 JR 車票感：**票面油墨走青綠**（撕孔/色條/大字/travel、紙上小字），**判子（済郵戳）
獨立走朱紅** —— 用新的 `--stamp` token 跟票面 rail 系解耦（見下）。純 CSS，無圖像生成。
（2026-07-14 晚定案，取代先前的朱色/藍染版；理由：對齊「像一張日本 JR 車票」的原始需求。）

| Token | 值 | 實測對比 |
|---|---|---|
| `--rail` | `#0b7d6e` | JR 青綠：撕孔、色條、大字、travel 類（非內文用途） |
| `--rail-deep` | `#0a5648` | 8.15:1 on `--paper`、8.47:1 on `--paper-bright`（穩過 4.5） |
| `--rail-press` | `#0a5648` | CTA 白字 8.62:1 |
| `--stamp` | `#a62812` | 朱紅判子（済郵戳）：6.77:1 on `--paper`、7.04:1 on `--paper-bright` |
| `--night` | `#123a33` | 深青綠封面底：gold 6.91:1、paper-bright 12.30:1、paper-dim 10.01:1、paper-faint 8.86:1、paper-ghost 5.92:1 |
| `--gold` | `#f8b500` | 山吹：只上深底（on `--night` 6.91:1） |
| `--green` | `#3a6b2f` | 草綠：sight 類（跟 rail 青綠區隔） |
| `--blue` | `#165e83` | 藍：rest 類、來源連結 |
| `--board` | `#0f231f` | 翻牌鐘底（墨青綠，非內文用途） |
| `--board-hi` | `#1a3029` | 翻牌鐘立體亮面（非內文用途） |
| `--board-lo` | `#081310` | 翻牌鐘立體暗面（非內文用途） |
| `--board-edge` | `#040a08` | 翻牌鐘邊（非內文用途） |

Pattern：`seigaiha`（青海波）——純 CSS 三層 `radial-gradient`，色用 `color-mix(in srgb,var(--rail) 8%,transparent)`
從青綠衍生、低調當 `.ticket` 底紋。只有定義 `pattern` 的主題輸出（default 空字串，byte-identical）。

Motifs：`stampText: 済`（判子風郵戳中央字，localStorage 格式與指紋不變）、
`eyebrow: 記念切符 · UTC-first preview`（Composer 給了自訂 eyebrow 時以自訂優先）。

### poster（記念票畫版）— 元件語彙

封面票的「記念切符」規格：海報（AI 生成的城市 typographic poster，palette 代入
theme tokens）是票面上半的印刷畫，機器層（條碼/serial/microprint/route）不動。
觸發器＝`data/posters/<trip_id>.png` 檔案存在（`cover.poster` 只是紀錄，不是開關）；
`cover.poster_prompt` 記錄圖的來源（誠實可追溯）。無海報＝現狀封面，零改變。

## 元件語彙

`ticket`（缺角票面＋左緣撕孔）/ `stub`（票根:虛線撕邊＋半圓缺口）/
`pass`（封面的日票卡）/ `coupon`(行程票卡:左色條=類型) / `flip-board`(翻牌鐘) /
`timeboard`(四時區泳道) / `stamp`(斜蓋章) / `barcode + serial`(票根底部) /
`microprint`(封面票面底邊的微縮安全印刷帶——重複印路線/日期/人數/序號，
裝飾必須承載資訊；票根比票面長時，條款以 `margin-top:auto` 錨底、留白落在內容區之間) /
`punch + postmark`(蓋章鈕＋圓形郵戳：`--stamp` 單色〔default＝`--rail-deep`；japan 走朱紅〕、雙圈、中央 VISITED＋蓋章時刻，
時間戳承載資訊；紀錄存 localStorage 僅本機，票根印誠實註記；落章 130ms 縮放、undo 用淡出不倒播)。

類型色:travel=`--rail`、sight=`--green`、meal=`--gold`、rest=`--blue`。

## 文案

- 介面 label 用英文大寫短詞（TRAVELLERS / BASE / WINDOW）——車票的國際慣例;
  內容敘述用繁體中文。
- 按鈕寫會發生的事:「出票」不是「送出」。錯誤訊息講清楚壞在哪、怎麼修，不道歉。
- 日票標題 ≤12 字（超過渲染器自動縮級，但那是保險不是授權）。
- 標題的**括號補充語不進 display 層**：渲染器會拆成 h1 下的 `.h1-note` 小字註記，
  讓每張日票的站名對維持一致字級（車票不會把括號印成站名大字）。
- 條款/提醒/後續動作一律印成**編號條列**（`.terms`，mono 兩位數編號 01/02/…），
  不用整段長文；單條以兩三行為目標，超過就該回 Composer 拆句。
- 封面摘要**不准印成一堵字牆**：渲染器自動拆段（換行 → 「提醒/注意/備註」轉折 →
  超過 ~140 字的段從中點最近句號再拆），CJK 內文 line-height ≥1.9、letter-spacing .012em。

## 無障礙底線（Stage 5 checklist）

- [x] 紙上文字對比 ≥4.5:1（gold 不上紙）
- [x] 全站 `:focus-visible` 可見（深色底金框、紙上紅框）
- [x] Relaxed/Full 切換帶 `aria-pressed`
- [x] `prefers-reduced-motion` 全動效尊重
- [x] `lang="zh-Hant"`、裝飾性元素 `aria-hidden`
- [x] 條款/警告每頁最多 5 條（其餘只留在 JSON）
