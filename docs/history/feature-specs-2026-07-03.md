# 三個功能的輕量規格（2026-07-03）

> Historical design record. The listed features were subsequently implemented;
> current behavior is defined by the code and tests. The active design source is
> `docs/design-system.md`.
>
> 共同判準不變：「真的車票會這樣嗎？」＋ `docs/design-system.md` tokens ＋ 誠實原則。
> 定位：輕量旅遊規劃模板——沒有帳號、沒有資料庫，一個 trip 就是一份 JSON + 一疊靜態票。

---

## Spec 1 · 撕票翻頁（Day → Day 轉場）

**隱喻**：手冊是一疊票，翻到下一天＝把這張票撕下來，下一張本來就墊在下面。

**技術路線：MPA View Transitions API**（`@view-transition { navigation: auto }`）。
dist 是純靜態多頁站，這是唯一不用改架構的方案——CSS 為主、零路由框架：

- `.ticket` 掛 `view-transition-name: ticket`。
- **出場**（按 Next）：舊票向上撕起——`translateY(-4%) rotate(-5deg)`、
  透明度收掉，transform-origin 設在左緣撕孔帶（撕的支點）。
- **進場**：新票從 `scale(.985)` 沉底浮上（它本來就在票疊下面）。
- **方向感**：`pageswap` / `pagereveal` 事件寫入 view-transition types
  （`forward`／`back`），Previous 反向：舊票沉下去、上一張從左上蓋回來。
- **降級**：不支援的瀏覽器＝普通跳頁（progressive enhancement，零成本）。
  `prefers-reduced-motion` 用 media query 整段關掉。
- **互斥**：轉場跑過的頁面要跳過 GSAP 進場 timeline（`pagereveal` 有 fire
  就設 flag），避免票面動兩次。這是本 spec 唯一的坑。

**規模**：S（一段 CSS + ~20 行 JS，全在 render.mjs）。
**Phase 2 選配**：行動裝置左右滑手勢翻票。

---

## Spec 2 · 去過蓋章（check-in stamp）

**隱喻**：剪票／入場戳。stamp 已是既有元件語彙，這是它的互動化。

**UX**：
- 每張 coupon 時間欄下方一顆「蓋章」按鈕（`aria-pressed`）。點下→蓋上
  **圓形郵戳**（SVG：外圈站名/地點、中間 `VISITED` + 蓋章當下的日期時刻——
  時間戳承載資訊，符合 signature 原則）；再點＝取消（undo，不跳確認框）。
- 已蓋的 coupon：郵戳斜壓在票卡右側 + 左色條頂端打一個半圓「剪口」缺口。
  其餘不動——不要 desaturate 整張卡，安靜。
- 動效：章「蓋下去」＝scale 1.35→1 + 微 rotate，一次性 120ms ease-out；
  蓋章是物理動作，允許極輕的落章感（同 flip-board 的物理豁免）。
- 票根進度：`Stops 7` 旁邊加 `· 3 stamped`（mono 資料層）。
- 封面 day pass 角落印小章數（phase 2）。

**持久化**：`localStorage`，key = `trip_id + item 指紋`（date+start_utc+title
hash——items 目前沒有穩定 id，渲染時生成 `data-item-id`）。
**誠實條款**：票根 fineprint 註明「蓋章紀錄只存在這台裝置」。不做同步。

**a11y**：郵戳本體 `aria-hidden`，按鈕文字「蓋章／已蓋章」+ `aria-pressed`；
狀態變化不用 toast（silent success，票面上看得到章就夠了）。

**規模**：M（SVG 郵戳產生器 + ~60 行 JS + localStorage；全在 render.mjs）。

---

## Spec 3 · 一個 input → 完整旅遊車票（模板產品化）

Studio 已經做到「一句話→手冊」，這條 spec 是把它變成**輕量模板產品**的路線圖：

**P1 · 降低 input 門檻＋抬高 output 質感**（小）
- Studio 加 2–3 個 **preset 票根**（週末小旅、多城長途、一日遊）：點一下
  填入示範句，使用者改地名日期就能出票——模板感的最便宜實現。
- **@media print 印刷版**：一票一頁 A4、隱藏互動元件、條碼放大——
  螢幕版是車票、印出來是文件（kami 那條線的正確位置）。
- `og:image`／`meta` 讓分享連結有票面預覽。

**P2 · Ticket Wallet 票夾**（中，唯一的結構改動）
- dist 從「一次一份」改 `dist/trips/<slug>/` 多份共存；
  studio 首頁下方變成票夾：每份手冊一張縮小的票根（既有 lasttrip 元件推廣）。
- orchestrator 產出寫進對應 slug；`--render-only` 加 `--trip=<slug>`。

**P3 · 一鍵分享**（小）
- 「出票完成」旁加「部署」：`wrangler deploy` 已經存在，包成 server 端一鍵
  （仍照 `deployment_status: awaiting_approval` 誠實流程，按了才部署）。
- 或 zip 下載整份 dist（純靜態，收件人直接開）。

**不做**：帳號、資料庫、協作編輯。trip = JSON 檔，這是這個產品的「輕」。

---

## Skills 編隊（2026-07-03 補：四組 skills 怎麼交叉用）

原則：**skill 是顧問不是 owner，docs/design-system.md 永遠是最終裁判**。每個階段一個主責 skill，
避免三套 anti-slop 框架同時搶方向盤（指令互相打架時輸出反而變差）。

| 階段 | 主責 | 用法 |
|---|---|---|
| 動效 spec（寫進本檔/docs/design-system.md 前） | emil `animation-vocabulary` | 它是「模糊描述→正名」的反查詞彙表：先給撕票/蓋章找到正確術語（見下方動效正名），spec 用對名詞才寫碼 |
| 動效實作 | gsap 官方 skills（按需載入單科） | Spec 1 翻頁：**不用 GSAP**（View Transitions 純 CSS），只在跟既有 intro timeline 互斥時查 `gsap-timeline`；Spec 2 蓋章：`gsap-core`；效能疑慮查 `gsap-performance`。八科全裝但一次只開用得到的 |
| 動效品味決策 | emil `emil-design-eng` | easing/duration 的取捨（Vercel/Linear 實務派），跟 docs/design-system.md「每頁一段 timeline」原則對齊 |
| 審計循環（Stage 4） | hallmark audit（版面）＋ emil `review-animations`（動效） | 兩把尺並列：hallmark 抓 slop 版面、review-animations 抓 slop 動效；impeccable 負責把兩者的 findings 修掉。注意 review-animations 標了 `disable-model-invocation`——**要手動點名**（審計清單記著喊它），它預設從嚴、「approval is earned」 |
| 上線前（Stage 5） | web-design-guidelines | 不變 |

**taste-skill（55k stars 那個）：建議不裝。** 它跟 hallmark + impeccable 職能高度重疊
（第三套反 slop 框架＝指令打架），唯一值得偷的是三個刻度盤的**語言**——本專案定錨為：
`DESIGN_VARIANCE 3`（票的結構是定案，不實驗）、`MOTION_INTENSITY 4`（一頁一段 timeline
＋物理豁免）、`VISUAL_DENSITY 7`（車票本來就是高密度印刷品）。這三個值當 brief 措辭用，
寫在這裡就夠，不需要引進整套框架。

已安裝（2026-07-03，專案層 `.agents/skills/`，共 11 個 + `skills-lock.json`）：
emil 三件套 + gsap 八科。taste-skill 依建議未裝。

### 動效正名（animation-vocabulary 試刀，Spec 1/2 從此用這些詞）

- **Spec 1 撕票** ＝ **Page transition**（實作為 **View transition**）+
  **Direction-aware transition**（Next/Previous 反向）。出場票是 **3D tilt** +
  **Translate**，**transform-origin** 錨在左緣撕孔帶（**origin-aware**——從撕的支點動）；
  進場票是 **Scale in**（.985→1，不是 Pop in——票疊下面那張本來就在，不該彈）。
  Easing：**ease-out**（**asymmetric** 曲線），出場略快於進場。
- **Spec 2 蓋章** ＝ **Press feedback**（按下那一拍）接郵戳的 **Scale in**
  （1.35→1、單次、~120ms ease-out）。**不是 Pop in / Bounce**——章落在紙上就停，
  高 damping、零 oscillation；undo 是 **Fade out**，不倒播蓋章（撕不回去的東西不倒播）。

## 建議順序

1. **Spec 1 撕票翻頁**——最便宜、每次翻頁都感受得到，先做。
2. **Spec 2 蓋章**——旅途中真的會用的互動，做完產品從「看」變「用」。
3. **Spec 3 P1**（preset + print CSS）→ 用一陣子再決定要不要 P2 票夾。

## 拍板結果（2026-07-03，Zack）

- **郵戳配色**：`--rail-deep` 深紅單色，全站同一顆章。進 docs/design-system.md 元件語彙。
- **票夾（P2）**：**這輪就做**——dist 改 `trips/<slug>/` 多份共存、studio 首頁
  ticket wallet、orchestrator/`--render-only` 加 `--trip` 旗標。
- **swipe 手勢**：**跟 Spec 1 一起做**——Spec 1 升級為 M+：View Transitions 之外
  加行動裝置左右滑翻票（拖曳中斷可放回，Observer 或原生 touch，注意跟垂直捲動搶手勢）。

執行順序：Spec 1（含 swipe）→ Spec 2 蓋章 → P2 票夾 → P1 preset+print（P3 之後再說）。
