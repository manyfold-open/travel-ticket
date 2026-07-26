# 公開雲端部署設計 — 一句話出票上 Cloudflare Workers（2026-07-21 定案）

> Archived implementation specification. The Worker and Workflow have been
> implemented; use `docs/cloudflare.md` for current architecture and operations.

**更正（2026-07-21 同日晚）**：LLM backend 決策改為 **Option B / Manyfold Agent
API**，取代原本「LLM 全部接 Zack 自己的 `ANTHROPIC_API_KEY`」。原因：Zack
不想在公開 Worker 上放一把獨立 Anthropic key，LLM 運算改成呼叫 Zack 自己
Manyfold 帳號下的 agent（走 A2A 協定），算力/費用記在 Manyfold 帳號，不是
Anthropic 直接扣款。實作對照 `article-lens`（hn-lens/hn-lens-v2）的既有
模式：`pipeline/mf-client.mjs`（port 自 `src/crew/mf.ts`）＋
`agents.mjs` 新增 `mf` backend（`createMfContext(env)`），單一共用
Manyfold agent（`AGENT_PIPELINE`）處理 brief/discovery/composer 三站，
不像 hn-lens 拆 6 個 agent（成本考量，先簡單版，需要再拆）。
下面 §1/§5 的「只留 sdk backend」已不適用，改看此更正段落；其餘章節
（Workflow 步驟、motifs 安全渲染、防濫用）不受影響，照舊。

**更正 2（2026-07-21 再晚一點）**：儲存層決策改為 **KV-only**，取代原本
「R2（行程 JSON + 渲染站）+ KV（進度）」。原因：Cloudflare 啟用 R2 要求
綁信用卡，Zack 不想現在做這件事；已實測 KV 不需要信用卡（帳號下已有
hn-lens 的 KV namespace 可佐證）。改用兩個 KV namespace：`TRIPS_KV`（進度
狀態，`trip:<id>:status`）與 `TRIPS_SITES`（渲染好的網站檔案，key
`trips/<id>/<path>`，value 上限 25MiB 綽綽有餘）。下面 §1/§3 提到的 R2
一律改讀 KV；`worker/storage.mjs` 的介面簽名不變（`saveTripFiles`/
`saveTripJson`/`getTripFile`/`writeStatus`/`readStatus`），只是底層綁定
從 R2Bucket 換成 KVNamespace。免費額度（1,000 次寫入/天、100,000 次
讀取/天）對這個流量規模綽綽有餘。

**目標**：讓任何人在公開網址貼一句話出票，過程中被引導（但不強制）連結
Gmail / Google Calendar / Notion 讓行程更個人化。全功能對齊本機版
（含 AI 客製主題），不做閹割版。

**決策紀錄（Zack 已拍板，不要重問）**：
- 架構走「全 Cloudflare」（A 方案），不是外部 Node 主機、不是混合。
- LLM 與 Composio 費用全部接 Zack 自己的 key（訪客不用帶 key）。
- 完全公開，不做登入/邀請碼，但**要** Turnstile + per-IP rate limit 當保險。
- 連結帳號頁是**必經步驟**（貼完一句話後一定看到），但可明確跳過；
  文案要講清楚「連了會更 customised」。
- 取票 = 純網址即憑證（`/trips/<slug-id>/`），無登入、不收 email。
- 功能範圍 = **完整搬遷**（B 選項）：含 AI 客製主題、動態印章文字，
  且 motifs 這次要真的做出 escaped render path（見 §4）。
- 先用 Cloudflare 免費方案跑，撞到 10ms CPU 上限再升 Workers Paid（$5/月）。

## 1. 整體架構

一個 Cloudflare Worker（前端頁面 + API）＋ **Cloudflare Workflows**（長流程）
＋ **R2**（行程 JSON、渲染好的網站檔案）＋ **KV**（進度狀態）。

- 選 Workflows 而非手刻 Durable Object + alarm：整條 pipeline ~6 分鐘
  （Brief ~18s、Discovery 含 web search ~150s、Composer ~170s），每個 agent
  天然對應一個 step，重試/恢復/狀態查詢是產品內建，不用自己寫。
- LLM backend 部署版**只留 `sdk`**（Anthropic API，fetch-based，Workers 相容）。
  CLI fallback（spawn `claude -p`）是 Node-only，部署版拿掉；本機版照舊。
- 等待 LLM/Composio 回應的時間不計 CPU time，所以 Workers 計費的重點只有
  渲染那一步的真運算。

## 2. 使用者流程

1. **首頁**：貼一句話 + Turnstile → `POST /api/trips` 建 trip session
   （產生 `trip_id`；`visitor_id` 由前端產生存 localStorage，格式沿用
   composio.mjs 的 `[A-Za-z0-9_-]{8,128}` 驗證）。
2. **連結帳號頁（必經）**：Gmail / Google Calendar / Notion 三張卡片，
   各自寫明連結的好處。按卡片 → 後端呼叫 Composio
   `connectedAccounts.link()` 拿 `authorization_url` → 新分頁 OAuth →
   回來輪詢 `connector_status` 顯示已連結。底部「開始出票」＋
   明確的「跳過，直接出票」。
3. **進度頁**：觸發 Workflow，輪詢 `GET /api/trips/:id/status`，
   逐 agent 顯示狀態（沿用 Studio 的 agent 進度概念）。
4. **完成**：導向 `/trips/<slug-id>/`，網址即憑證，可回訪可分享。

## 3. Workflow 步驟

`brief`（LLM structured output）→ `timezone`（純程式）→
`discovery`（LLM + Anthropic web search tool）∥ `gmail` ∥ `calendar` ∥
`notion`（Composio；未連結誠實 skip）→ `composer`（LLM；失敗走現有本地
fallback composer）→ `custom_theme`（訪客選了才跑：生成 + 對比度 gate，
失敗 fallback preset，沿用 never-throws）→ `render`（render.mjs 產 HTML
寫進 R2）→ `manifest`（標記 done）。

每步結束把狀態寫 KV（`trip:<id>:status`）。`agent_statuses` 誠實記錄照舊。

## 4. Motifs 安全渲染（關掉舊 deviation）

現況：客製主題 `stampText`/`eyebrow` 生成但**不**渲染（LLM 輸出原樣插
SVG/HTML 是注入面，render.mjs ~1386）。公開部署後任何人都能觸發，正面解：

- 新增 escape 層：LLM 生成的 motif 文字經 HTML entity escape + 長度上限 +
  字元 allowlist（字母數字、常用標點、CJK）才進模板。
- SVG 內一律以 `<text>` 節點文字內容呈現，絕不拼接屬性或標籤。
- 注入測試組：`<script>`、屬性逃逸、SVG event handler 等 payload 進去
  必須輸出為純文字。
- 修好後本機版同步受益，spec §4.4 的 deviation 正式關閉。

## 5. 程式碼共用（不 fork 兩份）

- 平台無關、共用：`render.mjs`、`themes.mjs`、`contrast.mjs`、
  `customTheme.mjs`、`itinerary-schema.mjs`、`timezone.mjs`、`composio.mjs`
  （本來就不碰或改成不碰 fs/child_process）。
- 平台 adapter 各自薄薄一層：本機 = 現有 `orchestrator.mjs`
  （fs + CLI backend）；雲端 = 新 `worker/` 目錄（R2 + Workflows +
  只有 sdk backend）。
- `agents.mjs` 要拆：LLM 呼叫核心（共用）vs backend 選擇（平台各自）。
- MCP server（stdio）**不在範圍**，維持本機功能。

## 6. 防濫用與錯誤處理

- Turnstile server-side siteverify 在 `POST /api/trips` 強制。
- Cloudflare rate limiting rule：同 IP 每小時建 trip 上限（先 5 次），
  超過 429 + 友善訊息。
- Workflow 步驟重試耗盡 → 狀態 `error`，進度頁指名哪個 agent 掛了，
  可重試（計入 rate limit）。
- Composio OAuth 失敗/拒絕 → 卡片顯示未連結，不擋出票。
- 訪客隔離沿用 per-visitor_id 設計（已驗證不能跨訪客讀帳號）。

## 測試策略

- 核心邏輯：`npm test`（`TRIP_NO_LLM=1 node --test 'tests/*.test.mjs'`）照跑。
- Worker：`wrangler dev` + miniflare 測 API 路由與 Workflow steps
  （mock LLM/Composio）。
- Motifs escape：專門的注入測試組。

## 費用摘要

- Cloudflare：先免費方案；渲染步驟若撞 10ms CPU 上限 → Workers Paid $5/月。
  Turnstile/R2/KV/Workflows 免費額度都夠這個流量。零出站流量費。
- Anthropic：每次出票 3 個大 LLM 呼叫（Brief / Discovery+web search /
  Composer）＋可選 custom theme，全記 Zack 的 key，隨用量線性成長。
