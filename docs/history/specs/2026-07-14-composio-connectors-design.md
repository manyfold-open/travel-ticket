# Composio 連接器設計 — Gmail / Calendar / Notion 唯讀脈絡來源

> Archived implementation specification. The feature is implemented; current
> behavior lives in `pipeline/composio.mjs`, `pipeline/agents/connectors.mjs`,
> and their tests.
>
> 狀態：**設計定案，待實作**。本 spec 收束 2026-07-14 的 brainstorm。
> 下一步：Zack review → writing-plans skill 產實作計畫 → 實作。
> 尚未寫任何實作程式碼。

## 1. 目標與哲學

把 Zack 自己的 Gmail / Google Calendar / Notion 當成 trip-ticket pipeline 的**唯讀脈絡來源**，
餵給 Itinerary Composer，讓票做得更完整。核心哲學：**使用者給越多資訊 → 票做得越完整**。
三個連接器是同形狀的「脈絡輸入」，**輸出永遠只有那張票**（沒有任何寫回、沒有 Notion 輸出）。

## 2. 已定案的決策（brainstorm Q1–Q4 + 方案）

- **Q1 授權邊界＝A**：純本機單人工具，只連 Zack 自己的帳號。憑證放本機 env
  （`COMPOSIO_API_KEY` 在 `~/.zshrc`）。部署的 Cloudflare Worker 完全不碰 Composio。
  之後要寫 setup 文件讓別人拿自己的 key 複製使用（單帳號程式，非多使用者機制）。
- **Q2 走 MCP server**（不是 REST SDK）。詳見 memory `composio-mcp-connector`。
- **Q3 三個連接器全部唯讀**。沒有任何寫入、沒有 approval 關卡（因為不動使用者資料）。
- **Q4 Notion 角色＝輸入**：讀 Zack 在 Notion 記的點/訂位/清單。連線沒完成前誠實 skip。
- **方案＝零依賴 raw JSON-RPC over fetch**：不裝 `@modelcontextprotocol/sdk`。
  萃取自由文字（信件/Notion）用現有 `@anthropic-ai/sdk` LLM backend。

## 3. 已驗證的環境（2026-07-14 實測）

- **端點**：`https://connect.composio.dev/mcp`（MCP streamable-HTTP, JSON-RPC 2.0）
- **Auth header**：`x-consumer-api-key: <key>`（**不是** `x-api-key`／`Authorization: Bearer`，
  那些回 401）。
- **握手**：POST `initialize` → 從回應 header `Mcp-Session-Id` 抓 session id →
  POST `notifications/initialized`（帶 `mcp-session-id`）→ 之後 `tools/call`。
  回應是 SSE：`event: message\ndata: {...}`。
- **教訓（key rotation）**：`~/.zshrc` 舊 key（`ck_OWb…`）已被 dashboard regenerate 掉，
  導致 401；換成 dashboard 現行 key（`ck_6e2…`）後握手回 200。**dashboard 是唯一真實來源。**
- **連線現況（實測）**：
  - `gmail` → 帳號 `gmail_squire-cisco` **active** ✅
  - `googlecalendar` → 帳號 `googlecalendar_wearer-raper` **active** ✅
  - `notion` → 無 active 帳號（全 initializing/initiated）❌ → 上線前誠實 skip
- **meta 工具**：`COMPOSIO_SEARCH_TOOLS`（找 slug + 產 recommended plan）、
  `COMPOSIO_GET_TOOL_SCHEMAS`、`COMPOSIO_MULTI_EXECUTE_TOOL`（跑 toolkit 工具）、
  `COMPOSIO_MANAGE_CONNECTIONS`、`COMPOSIO_WAIT_FOR_CONNECTIONS`。
  Gmail/Calendar/Notion 的實際工具透過這些 meta 工具執行。

## 4. 架構與元件

新增 **`pipeline/composio.mjs`**（零依賴，唯一碰 MCP 協定的地方）：

- `mcpSession()`：建 session（initialize → 抓 `Mcp-Session-Id` → notifications/initialized），
  回一個可重用的 `{ callTool }`。
- `callTool(name, args, { timeoutMs = 20000 })`：POST `tools/call`，解 SSE，回 `result.content`
  的 JSON（已 unwrap toolkit 回應的 `{ data, error, successful }` 外殼）。
- `execToolkitTool(slug, args)`：透過 `COMPOSIO_MULTI_EXECUTE_TOOL` 跑實際 toolkit 工具
  （如 `GMAIL_FETCH_EMAILS`），回其 `data` 或丟出帶 reason 的錯誤。
- **不提供** `hasConnection()` 預檢 —— 見第 6 段（改「直接打、錯就 skip」）。

改 **`pipeline/agents.mjs`** 三個 agent：

- `runTravelContextAgent(brief)` — Gmail：搜訂位確認信 → `bookings[]`
- `runCalendarAgent(brief)` — Calendar：列行程窗口事件 → `events[]`
- `runNotionAgent(brief)` ★新★ — Notion：讀旅遊筆記/清單 → `notes[]`

**邊界原則**：只有 `composio.mjs` 懂 MCP 協定；agent 只懂自己的資料語意；Composer 只吃結果。
讀 `COMPOSIO_API_KEY` 當總開關 —— 沒 key，三個 agent 全 skip（零回歸，維持現況行為）。

## 5. 各 agent 的資料流、真 slug、與回傳形狀

**回傳形狀沿用現有契約**（不改 Composer 介面）。現有 stub 已回
`{ status, confidence, notes, bookings|events }`；新增欄位一律加在此形狀內。
`status` ∈ `ok` | `skipped` | `error`。

### 5.1 `runTravelContextAgent` — Gmail（兩段式）

真 slug（`COMPOSIO_SEARCH_TOOLS` 驗證存在）：

- `GMAIL_FETCH_EMAILS`（列信；metadata-first，`include_payload=false`，用 `page_token` 分頁；
  回 `messages[].{messageId, threadId, sender, subject, preview, messageTimestamp}`）
- `GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID`（`format=full` 只對 finalists 取全文）
- 選配：`GMAIL_LIST_LABELS`、`GMAIL_FETCH_MESSAGE_BY_THREAD_ID`

流程：

1. 用 brief 組 Gmail 查詢 `q`，例：
   `(booking OR reservation OR confirmation OR itinerary OR 訂位 OR 確認) newer_than:180d`
   + 目的地/日期關鍵字。`GMAIL_FETCH_EMAILS` 取 metadata。
2. 依 sender/subject/preview 篩出 top N（預設 N=10）likely confirmations。
3. 對這 N 封 `GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID`（`format=full`）取內文。
4. LLM 萃取（見 5.4）→ `bookings[]`。

回傳：`{ status, confidence, notes, bookings: [...] }`，
`bookings[i] = { type: 'flight'|'hotel'|'train'|'car'|'activity', vendor, confirmation_no,
start, end, location, pax }`。

### 5.2 `runCalendarAgent` — Calendar（純確定性，無 LLM）

真 slug：`GOOGLECALENDAR_EVENTS_LIST`（主）。選配 `GOOGLECALENDAR_GET_CURRENT_DATE_TIME`
（解相對日期）、`GOOGLECALENDAR_FIND_FREE_SLOTS`（未來若要主動找空檔）。

流程：以 brief 的行程窗口設 `timeMin`/`timeMax`，`GOOGLECALENDAR_EVENTS_LIST` 取事件，
直接映射，不需 LLM。只讀不寫。

回傳：`{ status, confidence, notes, events: [...] }`，
`events[i] = { title, start, end, all_day }`。

### 5.3 `runNotionAgent` — Notion（搜 → 讀 → 萃取）★新★

真 slug：`NOTION_SEARCH_NOTION_PAGE`（搜頁）→ `NOTION_GET_PAGE_MARKDOWN`（回 markdown，
LLM 好吃）。備用讀取：`NOTION_FETCH_ALL_BLOCK_CONTENTS` / `NOTION_RETRIEVE_PAGE`。

流程：用目的地關鍵字搜頁 → 取 top 頁 markdown → LLM 萃取（見 5.4）→ `notes[]`。
**現無 active 連線 → 直接 skip**（見第 6 段），實作先建好管道，連上後自動生效。

回傳：`{ status, confidence, notes: [...] }`，
`notes[i] = { title, note, location, url, category }`。

**併入 Composer**：orchestrator 把 Notion 的 `notes[]` 併進傳給 Composer 的 `context` 物件
（如 `context.notes`），**不新增 Composer 參數**。Composer prompt 可加「一行」把 notes 納入
考量（additive，非必要；honest-skip 基線不需要它）。

### 5.4 LLM 萃取契約（Gmail 與 Notion 共用原則）

- 後端：現有 `@anthropic-ai/sdk`，最新 Claude 模型。
- 輸入：信件內文 / Notion markdown。輸出：**嚴格 JSON**，schema 如 5.1 / 5.3。
- **鐵律：只萃取來源裡真有的欄位；缺的留空字串/略去；完全沒有相關資料 → 回空陣列。
  嚴禁臆造（vendor、confirmation number、日期都不可猜）。**
- 回非法 JSON → 重試 1 次；再失敗 → 回空陣列（見第 6 段第 4 層）。

## 6. 錯誤處理 / 誠實降級

**設計決策：拿掉 `hasConnection()` 預檢，改「直接打工具、錯了就 skip」。**
理由（brainstorm 探測時實測）：`COMPOSIO_MANAGE_CONNECTIONS` 帶 `toolkits` 呼叫會**副作用式
生出新的 pending 連線**，污染帳號清單。改為直接執行資料工具、把「無 active 連線 / auth 失敗」
的錯誤視為 skip 訊號 —— 少一輪呼叫、零副作用、天然誠實降級。`composio.mjs` 因此完全不碰
`MANAGE_CONNECTIONS`。

分層降級（任何一層只影響該 agent；pipeline 續跑，Composer 照出票）：

1. **沒 `COMPOSIO_API_KEY`** → 三個 agent 全 `status:'skipped'`（零回歸，維持現況）。
2. **握手 / SSE 解析失敗 / timeout**（每呼叫上限 20s）→ 該 agent `status:'skipped'`，notes 記原因。
3. **工具回 error**（無連線 / 權限 / rate limit）→ 該 agent `status:'skipped'`，notes 帶 reason。
4. **LLM 萃取失敗或回非法 JSON**（Gmail/Notion）→ 重試 1 次，再失敗 →
   `status:'ok'` 但空陣列（不讓壞資料進 Composer）。
5. **回空結果**（信箱沒訂位信 / 日曆沒事件）→ 正常，`status:'ok'` + 空陣列，非錯誤。

## 7. 測試

1. **契約測試（不連網，主力）**：錄真實 MCP SSE 回應成 fixtures（金鑰塗掉），餵給
   `composio.mjs` 的 SSE/JSON 解析器與各 agent 的映射/萃取，斷言輸出形狀。
2. **降級測試**：注入「無 key / timeout / tool error / 壞 JSON」→ 斷言對應 agent
   `skipped` 或空陣列、pipeline 不崩。
3. **LLM 萃取契約測試**：幾封範例信固定斷言「缺欄位不臆造、無訂位回空」。
4. **真連線 smoke（手動、選擇性、不進 CI）**：`npm run composio:smoke` 實打 Gmail+Calendar
   （現都 active），印回筆數。需真金鑰，故不進 CI。

## 8. 不在本 spec 範圍（另開 spec / session）

- **不同城市不同 ticket 設計**（theme 選單 + 自訂）— 另一個 session 進行中。
- **打包成 MCP 讓別人用** — 之後另開 session；前置鋪路「orchestrator 抽成可呼叫函式
  `generateTicket(sentence, opts)`」可與本連接器實作順手一起做。
- **Notion 連線的 OAuth 完成流程** — 屬 setup 文件，非本 spec；本 spec 只保證管道就緒。

## 9. 待確認 / 開放項

- Gmail 查詢 `q` 的關鍵字組合與 top-N 門檻，實作時用真信箱調校。
- `GOOGLECALENDAR_EVENTS_LIST` 與 Notion 工具的**確切參數**：實作第一步用
  `COMPOSIO_GET_TOOL_SCHEMAS` 拉正式 schema 再定案（避免寫死已知會漂移的欄位名）。
- Composer 是否加那「一行」consume Notion notes — 預設加，若影響回歸再議。
