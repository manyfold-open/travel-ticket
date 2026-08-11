# Agent 编排

Travel Ticket 使用应用自建 DAG 管理长任务。Cloudflare 只提供 Durable Object、
Queue 和 alarm；不使用 Cloudflare Workflows。

## 执行图

```mermaid
flowchart TD
  Brief["brief · Trip Brief"] --> Timezone["timezone · deterministic"]
  Timezone --> Discovery["discovery · Manyfold"]
  Timezone --> Context["context · user Manyfold Connector"]
  Discovery --> Composer["composer · Manyfold"]
  Context --> Composer
  Composer --> Theme["theme · preset or Manyfold"]
  Theme --> Render["render · local renderer"]
```

实际依赖定义在 `worker/trip-job.ts`；前端不得自行推测执行拓扑。

## Role peers

| 角色 | role key | 任务 |
|---|---|---|
| Brief | `brief` | 将一句话转为结构化 trip brief |
| Discovery | `discovery` | 目的地资料与来源 |
| Private context | disabled | 当前使用空 context |
| Composer | `composer` | 合并资料生成 itinerary |
| Theme designer | `theme` | 生成自定义视觉 tokens |

Agent 不再写在设定档里，而是透过 Manyfold connect 交握授权：在 `/settings`
点 Connect，于 Manyfold 自家同意页勾选要分享的 agent，再把四个角色各自指派
给一个 agent。一个 agent 可以同时担任多个角色。四个角色全部指派完成之前，
`POST /api/trips/:id/start` 会回 409 `manyfold_reconnect_required`。

## Manyfold A2A 调用

凭证在 trip 开始时一次解析完成，并以封存状态快照进 Durable Object，整条 DAG
共用同一组。一次调用遵循固定顺序：

1. 向该角色的 `rpcUrl` 发送 JSON-RPC `message/stream`，`Accept` 为
   `text/event-stream`，并带 `redirect: 'manual'`。
2. 累积 SSE 的 status-update 与 artifact-update，折回成 `tasks/get` 的信封格式，
   让串流与复原两条路径共用同一批读取函式。
3. 只有在 Task 已被接受、串流却中断时，才用 `tasks/get` 复原，且采固定稀疏排程
   （最多七次，全部受 deadline 箝制）。
4. 到达终态后读取 artifacts、message 或 status message。
5. 超时会尝试 `tasks/cancel`。已被接受的 task 永远不会重送 prompt：那一轮已经
   在计费，重送只会再买一轮。

`messageId` 由 trip、task 与 attempt 推导，因此 queue 重投同一次 attempt 会被
去重，而真正的新 attempt 仍会取得新的一轮。

每个 agent-supplied 的 `rpcUrl` 都会先经过 `validateA2AUrl`：拒绝非 https、
拒绝 URL 内带凭证、拒绝私有与 link-local 位址（含 cloud metadata）。错误讯息
会截断并清理 bearer、JWT 与 token/key/secret query 字样。

401 或 403 代表授权被拒。connect 凭证只发一次，没有东西可以重新 mint，因此
系统只在同一次 invocation 内重读一次连线记录：若 operator 期间重新连线过就用
新凭证再试一次，否则该 trip 标记为 needs reconnect 并终止，不再消耗 attempt。

默认一次 A2A 调用最多两次 transport attempt，每次最多四分钟。HTTP 408、409、
425、429、5xx 和明确的临时网络错误可以重试；参数、认证、schema 和无效 JSON
错误最终会明确失败。

## Workflow 状态机

任务状态为 `pending → running → done`，失败时可能回到 `pending` 等待重试，
最终进入 `failed`。Job 状态为
`draft → queued → running → done | error`。创建 draft 不会发布 Queue；只有用户
调用幂等 `start()` 后进入 queued；当前不需要 Connector 页面。

- Queue 是 at-least-once delivery，不能作为状态真相来源。
- draft 最多保留 24 小时，避免未完成 Connector 步骤的任务永久占用状态。
- `claim()` 生成 lease ID；只有相同 lease ID 能 complete/fail。
- 任务 retry delay 从 30 秒指数增长，最高五分钟。
- lease 过期后重新进入 pending；第三次 lease 过期变为 terminal error。
- Queue 发布失败由 alarm 重新对账，不会丢失已经接受的 trip。
- 非 retryable 业务错误立即终止当前 workflow task。

## 失败和降级

| 步骤 | 失败行为 |
|---|---|
| Brief | 硬失败；没有 brief 不能继续 |
| Timezone | 使用 UTC 安全结果 |
| Discovery | 使用空 POI、交通和来源 |
| Private context | 当前停用，诚实标记 skipped 并使用空 context |
| Composer | 使用本地 composer 生成可渲染结果 |
| Custom theme | 回退到目的地 preset |
| Render / persistence | 硬失败并展示原因 |

Fallback 不应伪装为真实 Agent 成功。生成的 itinerary 会保存 `agent_statuses`，
进度 API 同时返回角色状态、任务 attempt 和可展示的错误。

## 进度与排错

`GET /api/trips/:id` 返回：

- `phase`、`trip_id`、`updated_at`；
- `agents`：面向用户的角色状态；
- `tasks`：内部任务状态、attempt、max attempts 和错误；
- `log`：最近的可读状态；
- `manifest` 或 terminal `error`。
- `links`：connect、start、progress 和 result 的 canonical URL。

`GET /api/trips/:id/status` 仅作为旧客户端兼容别名保留。

排错时先找失败 task，再判断是 credential mint、A2A Task、Manyfold Connector、
renderer 还是持久化错误。不要仅根据 Agent 显示名称推测失败来源。
