# HANDOVER — 雲端遷移（2026-07-21，給接手的新 agent）

> Historical pre-implementation handover. The migration described here has been
> implemented in `worker/` and `wrangler.itinerary.toml`; use
> `docs/cloudflare.md` for current operations.
>
> 你的任務：把這個本機 pipeline 遷移成公開的 Cloudflare Workers 服務。
> **設計已全部定案**，在 `docs/history/specs/2026-07-21-public-cloud-deploy-design.md`
> ——先讀它，所有架構決定（含 Zack 拍板的取捨）都在裡面，**不要重新問一輪**。
> 你的起點是為那份 spec 寫 implementation plan，然後動工。

## 這個專案是什麼

一句話 → multi-agent pipeline → 車票風互動旅遊手冊網站。
（例：`npm run plan -- "十月中帶另一半從台北去京都四天，賞楓吃和食，步調放鬆"`）

- Agent 鏈：Trip Brief（LLM structured output）→ Timezone（純程式）→
  Local Discovery（LLM + web search）∥ Gmail ∥ Calendar ∥ Notion（Composio，
  未連結誠實 skip）→ Composer（LLM，失敗有本地 fallback）→ 渲染。
- 現況全綠：`main` 24 commits、61/61 tests（`npm test`，跑的是
  `TRIP_NO_LLM=1 node --test 'tests/*.test.mjs'`）、working tree clean。
- 線上只有一份**純靜態** demo：https://switzerland-itinerary-2026.zack-chen.workers.dev
  （wrangler 把 dist/ 當 assets 吐出去，沒有後端——這就是這次要改變的事）。

## 先讀的檔案（順序）

1. `docs/history/specs/2026-07-21-public-cloud-deploy-design.md` — 這次的設計（唯一真實來源）
2. `README.md` — 現有 pipeline 怎麼跑、檔案結構、final_itinerary 欄位
3. `docs/design-system.md` — 前端設計語言（改前端必讀，禁裸 hex）
4. `docs/history/handover-2026-07-05.md`（2026-07-05 舊版）— **「已知坑（血淚）」11 條仍然有效**，
   headless 驗證、print、Service Worker、Workflow agent prompt 的坑都在那
5. `docs/history/progress-2026-07.md` — 上一輪（Composio/設計選擇/MCP server）的
   完整審計軌跡與 deferred minors

## 設計精華（細節看 spec，這裡只是地圖）

- 全 Cloudflare：Worker（頁面+API）+ **Workflows**（pipeline ~6 分鐘，每 agent
  一個 step）+ **KV-only**（`TRIPS_KV` 進度、`TRIPS_SITES` 行程 JSON+渲染站，
  見下方更正——R2 需要信用卡，Zack 不想加，改用免卡的 KV 扛兩者）。
- 使用者流程：貼一句話（+Turnstile）→ **必經的連結帳號頁**（Gmail/Calendar/
  Notion 卡片，可明確跳過，文案強調連了更 customised）→ 進度頁輪詢 →
  `/trips/<slug-id>/` 網址即憑證（無登入、不收 email）。
- **（2026-07-21 晚更正）LLM backend 部署版改走 `mf`**：呼叫 Zack 自己
  Manyfold 帳號下的 agent（A2A 協定，`pipeline/mf-client.mjs` + `agents.mjs`
  的 `createMfContext`），不是 `ANTHROPIC_API_KEY`；費用記在 Manyfold 帳號。
  單一共用 agent（`AGENT_PIPELINE`）跑 brief/discovery/composer 三站。
  `sdk`/`cli` 兩個 backend 保留給本機開發用，不受影響。
- **完整搬遷**：含 AI 客製主題。motifs（stampText/eyebrow）這次要真的做
  escaped render path（舊 deviation 關閉）——這是安全項，公開後任何人都能觸發。
- 共用策略：純邏輯模組（render/themes/contrast/customTheme/schema/timezone/
  composio）平台無關共用；平台 adapter 各自薄層（本機 orchestrator.mjs vs
  新 worker/ 目錄）。`agents.mjs` 要拆核心/backend。
- MCP server（stdio）不在範圍。

## Zack 要親手做的事（你做不了，卡住就開口要）

- [x] ~~`npx wrangler login` 或給 Cloudflare API token~~（2026-07-21：確認
      `CLOUDFLARE_API_TOKEN`/`CLOUDFLARE_ACCOUNT_ID` 已在環境變數可用，實測
      `wrangler kv namespace create` 成功建立 `TRIPS_KV`/`TRIPS_SITES` 兩個
      namespace 並寫進 `wrangler.itinerary.toml`——**不需要 R2 權限**，
      儲存層已改 KV-only，見上方更正）
- [x] ~~核准 consent URL~~（2026-07-21 已核准 `agents:edit`/`agents:read`/`a2a:edit`/`a2a:read`）
- [x] ~~建立 `AGENT_PIPELINE` agent~~（2026-07-21 已建立：
      `agt_agpyj7n5wr4r3h3euvlbrqehpy`，已填進 `wrangler.itinerary.toml`）
- [ ] **（新，卡住點）在新 agent 的 A2A 分頁手動授權**：`mf a2a status` 仍顯示
      `no peer agents granted`；試打 token mint 端點回
      `"no active A2A grant for this peer"`。`mf help a2a --agent` 明說這一步
      要「to the target agent's A2A tab」手動授權——**這是 dashboard 操作，
      agent 端 CLI/consent URL 都做不到**。麻煩你：開 Manyfold dashboard →
      找 `travel-ticket-pipeline`（`agt_agpyj7n5wr4r3h3euvlbrqehpy`）這個 agent
      → A2A 分頁 → 把它授權給這個 agent（`agt_agpyjshs4b7obacdsev6x4m7wm`）
      當呼叫方。做完跟我說一聲，我會重跑 `mf a2a status` 確認。
- [ ] **`MF_API_TOKEN` → 設成 Worker secret**：
      `wrangler secret put MF_API_TOKEN --config wrangler.itinerary.toml`
      （這個 agent 自己身份的 token，只有你自己能設定貼上，agent 不會也不能
      印出/經手這個值）
- [ ] Composio：`COMPOSIO_API_KEY` + 三個 auth config ID
      （`COMPOSIO_GMAIL_AUTH_CONFIG_ID` / `COMPOSIO_CALENDAR_AUTH_CONFIG_ID` /
      `COMPOSIO_NOTION_AUTH_CONFIG_ID`）→ Worker secrets。
      **key 以 Composio dashboard 為準**（曾經 mid-session 旋轉過一次）
- [ ] Turnstile site key + secret（Cloudflare dashboard 建立）
- [ ] Cloudflare rate limiting rule（dashboard 設，或 Terraform/wrangler 能設就代勞）
- [ ] 若渲染撞免費方案 10ms CPU 上限 → 升 Workers Paid（$5/月，Zack 已同意）

## Process notes（會咬人的細節）

- Composio 用官方 `@composio/core` direct execution，每次呼叫帶訪客穩定
  `userId`（`[A-Za-z0-9_-]{8,128}`）；OAuth 用 `connectedAccounts.link()`
  （retired 的 initiate() 不能用）。per-visitor 隔離已實測。
- MULTI_EXECUTE 真實回應形狀是 `results[].response.{successful,data}`
  （sanitized fixture：`tests/fixtures/multi-execute-gmail.json`）。
- Notion OAuth 從未真的連過——agent 誠實 skip；其 live 回應形狀
  （`results[].id/.title`、`markdown`）未經實彈驗證。
- `node --test` 給裸目錄參數在 **cwd 含空格**時會壞（本專案路徑
  `travel ticket` 就含空格）——一律用 glob 形式（npm test 已經是）。
- `data/final_itinerary.json` git-tracked 但每次測試會重寫（tree 永遠 dirty）
  ——untrack 與否 Zack 未定案，先不要動。
- 互動式 TTY 選單分支沒有自動化測試（需要 pty harness），手動驗。
- 實測時間（cli backend）：Brief ~18s、Discovery ~150s、Composer ~170s，
  全程 ~6 分鐘——這就是單 request 撐不住、要用 Workflows 的原因。
- 舊 `docs/history/handover-2026-07-05.md` 的 11 條血淚坑照樣適用（尤其 headless 驗證與 SW cache）。

## 驗收基準

- 陌生人開公開網址 → 貼一句話 → 看到連結帳號頁（可跳過）→ 進度頁 →
  拿到 `/trips/<slug>/` 連結，重開瀏覽器仍可回訪。
- 連了 Gmail/Calendar 的行程，`agent_statuses` 顯示對應 agent `ok` 且
  行程內容反映個人資料；跳過的顯示 `skipped`。
- motifs 注入 payload（`<script>`、屬性逃逸、SVG event handler）輸出為純文字。
- `npm test` 全綠照舊；Worker 端測試（miniflare）全綠。
- Turnstile 缺 token 的 `POST /api/trips` 被拒；同 IP 超額被 429。
