# Brainstorm 進行中 — Composio 連接器（Gmail / Calendar / Notion）

> Archived: this brainstorm was superseded by the finalized connector spec and
> the implementation in `pipeline/agents/connectors.mjs`.
>
> 狀態：**brainstorming 未完成**。下個 session 從「第 2 段設計」繼續，不要重問已定案的事。
> 流程：brainstorming → 逐段設計取得同意 → 寫 spec 到 docs/history/specs/ →
> 自我審查 → Zack review → writing-plans skill 產實作計畫。**還沒動任何實作程式碼。**

## 已定案的決策（Q1–Q4 + 方案）

- **Q1 使用者/授權邊界＝A**：純本機單人工具，只連 Zack 自己的 Google/Notion 帳號，
  憑證放本機 env（`COMPOSIO_API_KEY` 已在 `~/.zshrc`），部署的 Worker 完全不碰。
  另註：要寫 setup 文件讓別人能拿自己的 key 複製使用（單帳號程式，不是多使用者機制）。
- **Q2 Composio 現況**：走 **MCP server**（不是 REST SDK）。詳見 memory `composio-mcp-connector`。
  端點 `https://connect.composio.dev/mcp`，header `x-consumer-api-key`（不是 x-api-key）。
  **Gmail active、Calendar active（都 zack.chen@netmind.ai）；Notion 是 initiated 未完成 OAuth**。
- **Q3 讀寫範圍**：**三個連接器全部唯讀**。Gmail 讀訂位信；Calendar 只查衝突（不寫）；
  Notion 只讀。沒有任何寫入、沒有 approval 關卡（因為不動使用者資料）。
- **Q4 Notion 角色＝B（輸入）**：當資料來源讀 Zack 在 Notion 記的點/訂位/清單。
  「先做好這個管道就好」——連線沒完成前 agent 誠實 skip。
- **統一模型（Zack 的核心洞見）**：三個連接器是同形狀的「脈絡來源」，全餵給 Composer，
  **output 永遠只有那張票**（沒有 Notion 輸出）。哲學：**使用者給越多資訊 → 票做得越完整**。
- **方案＝1（零依賴 raw JSON-RPC over fetch）**：不裝 @modelcontextprotocol/sdk。
  萃取自由文字（信件/Notion）用現有 `@anthropic-ai/sdk` LLM backend。已用 curl 全程驗證可行。

## 已呈現並待確認的設計

### 第 1 段：架構與元件（Zack 尚未明確點頭，但方向已認可）

新增 `pipeline/composio.mjs`（零依賴，唯一碰 MCP 的地方）：
- `mcpClient()`：建 session（initialize → 抓 mcp-session-id → notifications/initialized），解 SSE
- `callTool(name,args)`：打 tools/call，回 result.content 的 JSON
- `hasConnection(slug)`：用 COMPOSIO_MANAGE_CONNECTIONS list 查 toolkit active 沒

改 `pipeline/agents.mjs` 三個 stub（都唯讀、都誠實降級）：
- `runTravelContextAgent(brief)` — Gmail：搜訂位確認信 → bookings[]
- `runCalendarAgent(brief)` — Calendar：列行程窗口事件 → conflicts[]
- `runNotionAgent(brief)` ★新★ — Notion：讀旅遊筆記/清單 → notes/pois[]

要點：邊界乾淨（只有 composio.mjs 懂協定）；讀 COMPOSIO_API_KEY 當開關，沒 key 全 skip（零回歸）；
每個 agent 獨立降級；Composer 現有 context/calendar 輸入即可吃，**不改 Composer 介面**。

## 下一步（新 session 從這裡繼續）

1. **第 2 段設計**：三個 agent 的資料流 —— 各自打哪個 Composio 工具（用 COMPOSIO_SEARCH_TOOLS /
   COMPOSIO_GET_TOOL_SCHEMAS 探實際 slug，如 GMAIL_FETCH_EMAILS / GOOGLECALENDAR_EVENTS_LIST /
   NOTION_*），回什麼形狀，LLM 萃取的 prompt 契約。
2. **第 3 段**：錯誤處理/誠實降級細節（timeout、SSE 解析失敗、toolkit 未連、LLM 萃取失敗）。
3. **第 4 段**：測試（mock MCP、契約測試、真連線 smoke）。
4. 逐段取得 Zack 同意 → 寫 spec `docs/history/specs/2026-07-14-composio-connectors-design.md`
   → 自我審查 → Zack review → **writing-plans skill**。

## MCP 呼叫備忘（已實測可用）

```bash
K="$COMPOSIO_API_KEY"; URL="https://connect.composio.dev/mcp"
# 1) initialize，從回應 header 抓 mcp-session-id
# 2) POST notifications/initialized（帶 mcp-session-id）
# 3) tools/call，回應是 SSE：event: message\ndata: {...}
# meta 工具：COMPOSIO_SEARCH_TOOLS / COMPOSIO_GET_TOOL_SCHEMAS /
#           COMPOSIO_MULTI_EXECUTE_TOOL / COMPOSIO_MANAGE_CONNECTIONS
```
Header 是 `x-consumer-api-key`，**不是** `x-api-key`（後者是舊 REST，回 401）。
Claude 的 Bash 是非互動 shell 讀不到 ~/.zshrc 的 env → 測試時 inline 帶 key 或讀檔。
