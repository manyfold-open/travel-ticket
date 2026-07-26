# 运行与部署

生产 Worker 为 `mf-travel-ticket`：

`https://mf-travel-ticket.netmind-ai.workers.dev`

生产发布只允许通过 `.github/workflows/deploy.yml`。本地没有 deploy script。

## 本地开发

```bash
npm install
cp .dev.vars.example .dev.vars
npm run dev
```

打开：

- 应用：`http://localhost:8788`
- 配置：`http://localhost:8788/settings`

`.dev.vars` 只保存 bootstrap 密码且不会提交：

```dotenv
ADMIN_SETTINGS_PASSWORD=replace-with-a-long-random-password
```

第一次进入 `/settings` 后配置应用 credential。本地 `/api/config` 返回
`ready:false` 是正常的，直到 Manyfold 和 Turnstile 必填项完整。

## `/settings` 配置

| 分类 | 配置 |
|---|---|
| Manyfold | API URL、source agent、API token、五个 role peers |
| Composio | project key、Gmail/Calendar/Notion auth config IDs |
| Turnstile | site key、secret key |

只有 `ADMIN_SETTINGS_PASSWORD` 必须先作为环境 secret 存在。页面保存的配置使用
AES-GCM 加密后写入 `TRIPS_KV`；secret 字段只返回 configured/source 状态，不回显
内容。

登录 session 有效八小时，cookie 为 `HttpOnly`、`SameSite=Strict`，HTTPS 下同时为
`Secure`。写请求拒绝 cross-site origin。

修改 bootstrap 密码会改变配置加密密钥。轮换前先确保关键配置仍有 Worker secret
fallback；轮换后重新登录并保存设置。

## Cloudflare 资源

`wrangler.toml` 声明：

- Static Assets：`ASSETS`
- Durable Object：`TRIP_JOBS` / `TripJob`
- Queue：`mf-travel-ticket-tasks`
- KV：`TRIPS_KV`、`TRIPS_SITES`
- Rate Limit：每个 IP 每分钟最多五次 trip 创建
- Manyfold API URL、source agent 和 role peer 默认值

Static Assets 使用 `run_worker_first = true`，因为 canonical 页面重定向、动态 trip
页面和 API 必须先经过 Worker router。

仓库不保存账号专属 KV ID。Wrangler 在目标账号首次部署时配置 account-local KV。
Queue 由 deployment workflow 幂等创建。

生产 Cloudflare token 需要目标账号的 Workers Scripts、Durable Objects、KV 和
Queues 权限。

## GitHub 环境

GitHub `production` environment 必须配置：

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`
- `ADMIN_SETTINGS_PASSWORD`

Manyfold、Composio 和 Turnstile credential 通过 `/settings` 管理，不作为 GitHub
deployment secrets。

push 到 `main` 或手动执行 `workflow_dispatch` 后，workflow 会：

1. 使用 Node.js 24 执行 `npm ci`；
2. 运行完整检查和 Wrangler dry-run；
3. 确保 Queue 已存在；
4. 部署 Worker；
5. 通过 stdin 写入 bootstrap admin secret；
6. 执行生产 smoke test。

## 发布前检查

```bash
npm run check
npm run check:worker
```

`npm run check` 包含 TypeScript、自动化测试、主题对比、当前文档链接、浏览器脚本
语法和 Shell 语法。`check:worker` 只做 Wrangler bundle dry-run，不修改 Cloudflare。

Smoke test 验证：

- 首页是 Travel Ticket 应用而非 Cloudflare 错误页；
- `/settings` 可访问；
- `/api/config` 为 `ready:true`；
- 未知 trip 返回 404。

部署后的资源传播可能短暂延迟，脚本会对页面语义做有限重试。readiness 未通过时
workflow 应失败，不发布“看似在线但不能出票”的版本。

## Readiness

`/api/config.ready` 只有同时满足以下条件才为 `true`：

- Manyfold URL、source agent、token 和五个 role peers 全部存在；
- Turnstile site key 和 secret key 同时存在。

Composio 是可选项，不影响总体 readiness；未配置时 connector 功能显示不可用或
skipped。

## 常见问题

### 首页显示服务尚未配置

检查 `/api/config` 中 `services.manyfold` 和 `services.turnstile`。进入
`/settings` 补齐相应字段，保存后重新读取。

### Agent 一直 working

先检查 `/api/trips/:id` 的 `phase`、`tasks`、attempt 和 error。若 phase 仍为
`draft`，说明用户尚未在 Connector 页面开始 Workflow。A2A 接受后的 Task
会轮询最多四分钟；整个 workflow task 最多三次 attempt。超过十分钟的单次调用还
可能触发 lease 过期，应拆分 Agent 工作而不是无限增大超时。

### 修改管理密码后配置消失

旧 ciphertext 无法用新密码解密。环境 fallback 仍可使用；用新密码登录后重新保存。

### Queue 任务重复

Queue 的重复投递是预期行为。`TripJob.claim()` 会通过 lease 去重。若出现重复外部
调用，检查是否绕过了 claim/complete 协议。

### 旧 trip 返回 404

Durable Object terminal state 保留七天。状态过期后会返回 404；生成文件是否仍可
访问取决于 `TRIPS_SITES` 中的产物是否保留。

## 安全边界

- 不把 token、密码、OAuth credential 写入 TOML、Markdown、Queue 或浏览器资源。
- 不在 `/api/config` 或 `/settings` API 回传 secret。
- connector account 必须按 `visitorId` 隔离，不允许回退到 owner 默认账号。
- 保留 Rate Limiting 和 Turnstile 两层昂贵请求保护。
- 不新增 cron、Cloudflare Workflows 或本地生产部署入口。
