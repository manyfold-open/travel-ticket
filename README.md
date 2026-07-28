# Trip Ticket Pipeline — 一句話變旅遊手冊

線上版：https://mf-travel-ticket.netmind-ai.workers.dev

## 這是什麼
一個 multi-agent pipeline：輸入一句話的旅遊需求，經過多個 agent 協作，
產出票券風格的互動行程網站，並由 GitHub Actions 部署到 Cloudflare Workers。

```
一句話 ─▶ Trip Brief Agent (LLM, structured output)
              ├─ Timezone Agent        (純程式，Intl 計算時差/DST)
              ├─ Local Discovery Agent (LLM + web search，官方來源)
              └─ Private Context       (目前停用，使用空 context)
          Itinerary Composer Agent (LLM) ─▶ final_itinerary.json ─▶ dist/ 網站
```

每個 agent 都在 orchestrator 的監督下執行（timeout、狀態、confidence 都會
記錄進最終產物的 `agent_statuses`）。Composer 失敗或逾時時，orchestrator
會用本地 fallback composer 硬湊出可渲染的行程（跟瑞士 demo 當初的行為一樣）。

## 怎麼跑

### Cloudflare 應用（推薦）

```bash
npm run dev   # → http://localhost:8788
```

開瀏覽器貼上一句話 → 建立並啟動 Workflow → 即時看每個 agent 的進度 → 完成後打開
`/trips/<id>/`。`/settings`、Durable Object、Queue 和 KV 都在同一個 Worker origin。

公開應用由 6 位數 access code 保護。第一次使用先進入 `/settings` 設定口令，
之後訪客從 `/access` 驗票進入；未驗證的頁面請求會跳轉到 access page，API 會
回傳 `ACCESS_REQUIRED`。

### 本地 Studio（開發工具）

```bash
npm run studio:local   # → http://localhost:4747
```

Studio 只執行本地 filesystem pipeline，輸出到 `data/` 和 `dist/`；它不是公開應用，
也不管理 Worker 配置。從 Studio 訪問 `/settings` 會跳轉到
`http://localhost:8788/settings`，因此需要另外啟動 `npm run dev`。

### 指令列

```bash
npm install

# 真實跑 — 不需要 API key：沒有 ANTHROPIC_API_KEY 時會自動改用
# headless `claude -p`（走你 Claude Code 的登入 / 訂閱額度）
npm run plan -- "十月中帶另一半從台北去京都四天，賞楓吃和食，步調放鬆"

# 測試 pipeline 管線（完全不打 LLM，用固定假資料）
npm run plan:mock

# 重新產生瑞士 demo（純資料，不打 LLM）
npm run demo

# 只重新渲染最新一份行程（改了 render.mjs 設計之後用）
node pipeline/orchestrator.mjs --render-only

# 只重印票夾裡指定那份（slug 前綴即可）
node pipeline/orchestrator.mjs --render-only --trip=kyoto
```

### 票夾（多份手冊共存）

- 每次產出：最新一份印在 `dist/` 根（本地預覽），同時收進
  `dist/trips/<slug-id>/`＋`data/trips/<slug-id>.json`。
- Studio 首頁右下 **Ticket Wallet** 列出歷史手冊（`/trips/<slug-id>/`）。
- 日票有 Relaxed/Full 深連結（`?mode=full`）、撕票翻頁（View Transitions＋
  手機左右滑）、行程蓋章（郵戳＋時刻，localStorage 僅本機）。

LLM backend 自動選擇（也可用 `--backend=sdk|cli` 強制指定）：
1. `sdk` — 有 `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` 時走 Anthropic API
   （`claude-opus-4-8` + 真正的 structured outputs）。
2. `cli` — 否則 fallback 到 headless `claude -p`（Claude Code 登入，訂閱額度計費；
   模型跟隨 Claude Code 預設，可用環境變數 `PIPELINE_CLAUDE_MODEL` 覆寫）。

實測（cli backend）：一句話 → 完整京都四天行程約 6 分鐘
（Brief ~18s、Discovery 含 web search ~150s、Composer ~170s）。

產出：
- `.trip_work/final_itinerary.json`、`data/final_itinerary.json` — 結構化行程
- `dist/index.html` + `dist/day-*.html` — 互動網站，瀏覽器直接開即可預覽

## 檔案結構

| 路徑 | 說明 |
|---|---|
| `docs/README.md` | 文件入口：目前有效的 product、design、Cloudflare 文件與歷史記錄索引 |
| `docs/design-system.md` | 設計語言（tokens、字體角色、元件語彙、無障礙底線）——改前端先讀這份 |
| `pipeline/server.mjs` + `pipeline/studio.html` | 入口網頁（Studio）：貼一句話出票、看 agent 進度、瀏覽產出手冊 |
| `pipeline/orchestrator.mjs` | 派工、timeout 監督、fallback、組裝 JSON、觸發渲染 |
| `pipeline/agents.mjs` | 穩定的 Agent 公開入口；只負責 re-export，既有 import 不需跟著內部拆分改動 |
| `pipeline/agents/` | Agent runtime、JSON schemas、行程 agents、Manyfold connector contract、poster prompt |
| `pipeline/mf-client.mjs` | Manyfold A2A client：mint peer token，呼叫 `message/send`，并以 `tasks/get` 等待非同步結果 |
| `pipeline/render.mjs` | 通用渲染器：任意 `final_itinerary` JSON → 票券風格網站（單一真實來源） |
| `worker/` | Cloudflare Worker 路由、自建 Durable Object + Queue workflow engine、KV storage 與 HTTP helper |
| `scripts/generate-itinerary-preview.mjs` | 瑞士 demo 的行程資料，渲染走 `pipeline/render.mjs` |
| `worker/entry.ts` + `wrangler.toml` | Cloudflare Worker 部署入口（靜態 app shell + Durable Object + Queue + KV） |

## final_itinerary JSON 重點欄位
- `days[].items[]`：`start_utc`/`end_utc`（UTC-first）＋ `timezone`、`variant`（both/relaxed/full）、`sources`
- `agent_statuses`：每個 agent 的 status/confidence/notes（誠實記錄 skipped/failed/timeout）
- `cover`：封面文案（標題、eyebrow、route stops、stats）——Composer 產生，渲染器也能自行推導
- `actions_suggested`：後續動作（訂票確認、寫入 Calendar 等），全部 `requires_approval: true`

## Private Context

目前版本不使用 Gmail、Calendar、Notion 或 Composio context，也不要求使用者連接
Manyfold External Client。行程只根據使用者請求、目的地調研和已配置的 pipeline agents
生成；context stage 會明確記錄為 `skipped` 並使用空資料。

Private context 相關連線目前停用；Travel Ticket 不會直接保存 Composio credential。

## Use as an MCP server

`pipeline/mcp-server.mjs`（`npm run mcp`）是 stdio MCP server。它**不會呼叫
Anthropic、Claude CLI、web search 或任何 LLM**：連進來的 Claude Code、Claude Desktop、
Codex CLI、Manyfold 等 MCP client 自己理解使用者需求、查資料、組出 JSON，並以該
client 自己的模型 session / 訂閱承擔推理成本。

**Prerequisites**
- Node 22+
- 不需要 `ANTHROPIC_API_KEY`，也不需要登入 `claude` CLI。
- hosted pipeline 目前不讀取私有 Gmail/Calendar/Notion context；MCP client 若需要，
  可自行提供 optional context。

**MCP tools**
- `get_itinerary_schema`：回傳 `final_itinerary` JSON schema 與完整範例。
- `fetch_travel_context`：用明確提供的 IANA timezone 與日期計算時差、DST、body clock。
- `render_ticket`：將 client-composed JSON 渲染成票券網站；只接受 preset 或 client 提供、經 contrast gate 的 custom tokens。

**典型流程**
1. Client 先呼叫 `get_itinerary_schema`，再自行理解需求、搜尋當地資料。
2. Client 可自行提供 optional context，或直接使用空 context。
3. Client 組合 itinerary JSON 後呼叫 `render_ticket`，取得本機 `entry` 路徑。

**Client 設定範例**（把路徑換成你自己 clone 這個 repo 的絕對路徑）：
```json
{
  "mcpServers": {
    "trip-ticket": {
      "command": "node",
      "args": ["/absolute/path/to/travel-ticket/pipeline/mcp-server.mjs"],
      "env": {}
    }
  }
}
```
請把 `/absolute/path/to/travel-ticket` 換成這份 repo 的實際絕對路徑。

**注意事項**
- `render_ticket` 不產生 poster；MCP 模式保留圖片生成的誠實 skip，不會呼叫本機
  Codex CLI 或 Gemini API。
- 私有 connector context 不會經過這個 MCP server；Manyfold agent 應自行限制資料範圍
  和 provider permissions。

## 部署

完整的 bindings、secrets、驗證和部署流程見
[系統架構](./docs/architecture.md)、[Agent 編排](./docs/agent-orchestration.md)
與[運行及部署](./docs/operations.md)。

公開 Worker 的運行配置集中在密碼保護的 `/settings`。本機開發可建立不提交的
`.dev.vars`：

```dotenv
ADMIN_SETTINGS_PASSWORD=choose-a-long-random-password
```

執行 `npm run dev` 後進入 `http://localhost:8788/settings`，可配置 Manyfold role
agents、Manyfold token 和必要的 6 位 access code。Private context 目前停用，未要求
使用者配置 Connector/Composio。Travel Ticket 的 secret 會加密保存在
KV，頁面不會回顯。

生產部署只由 [`.github/workflows/deploy.yml`](./.github/workflows/deploy.yml)
執行：push 到 `main`，或在 GitHub Actions 手動觸發 workflow。Repository 的
`production` environment 需要配置 `CLOUDFLARE_API_TOKEN`、
`CLOUDFLARE_ACCOUNT_ID` 和 `ADMIN_SETTINGS_PASSWORD`。本地只執行
`npm run check` 和 `npm run check:worker`，沒有生產發布命令。

公開版的長任務不使用 Cloudflare Workflows。每個 trip 由 `TripJob` Durable
Object 保存 DAG、租約、重試與進度，Queue consumer 執行 Manyfold A2A context、
composer 和渲染任務；詳細恢復語義與 role peer 設定見上面的 Cloudflare 文件。

## 部署邊界

本機 orchestrator 和 Studio 不會發布程式碼或新站點。公開 Worker 內產生的每份
行程直接寫入 KV，完成後由 `/trips/<id>/` 提供，不需要為每份行程再次部署。
