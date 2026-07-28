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

- 门禁：`http://localhost:8788/access`
- 应用：`http://localhost:8788`（验证 access code 后）
- 配置：`http://localhost:8788/settings`

`.dev.vars` 只保存 bootstrap 密码且不会提交：

```dotenv
ADMIN_SETTINGS_PASSWORD=replace-with-a-long-random-password
```

第一次进入 `/settings` 后先配置 6 位 access code 和应用 credential。口令未配置
时应用保持关闭，业务 API 返回 `ACCESS_NOT_CONFIGURED`；不会自动公开。

## `/settings` 配置

| 分类 | 配置 |
|---|---|
| Access | 必填的 6 位应用访问口令 |
| Manyfold | API URL、source agent、API token，以及 Brief、Discovery、Composer、Theme role peers |
| Private context | 当前停用；不要求用户连接 External Client 或配置 Composio |

只有 `ADMIN_SETTINGS_PASSWORD` 必须先作为环境 secret 存在。页面保存的配置使用
AES-GCM 加密后写入 `TRIPS_KV`；secret 字段只返回 configured/source 状态，不回显
内容。

登录 session 有效八小时，cookie 为 `HttpOnly`、`SameSite=Strict`，HTTPS 下同时为
`Secure`。写请求拒绝 cross-site origin。

访客 access session 有效七天，同样使用 `HttpOnly`、`SameSite=Strict` cookie。
cookie 签名使用 `ADMIN_SETTINGS_PASSWORD`，并包含当前 access code 的版本摘要；
更换口令会立即让旧 cookie 失效。每个 IP 在十分钟内连续五次输入错误后会被临时
锁定，计数只保存摘要 key，不保存输入的口令。

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

Manyfold credential 通过 `/settings` 管理，不作为 GitHub deployment secrets。
Composio credential 不进入 Travel Ticket；它们只配置在用户自己的 Manyfold。

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

Smoke test 默认验证：

- 未登录主页跳转到 `/access`；
- access status、登录页面和匿名 API 拒绝行为正常；
- `/settings` 可访问。

提供口令时会额外验证登录后的首页、`/api/config` 和未知 trip 404：

```bash
TRAVEL_TICKET_ACCESS_PASSCODE=123456 npm run smoke -- \
  https://mf-travel-ticket.netmind-ai.workers.dev
```

部署后的资源传播可能短暂延迟，脚本会对页面语义做有限重试。运行配置可在部署后
通过 `/settings` 补齐。

## Readiness

`/api/access/status.ready` 要求 6 位 access code 与
`ADMIN_SETTINGS_PASSWORD` 同时存在。`/api/config.ready` 只有满足以下条件才为
`true`：

- Manyfold URL、source agent、token 和四个启用中的 role peers 全部存在。Private
  context 当前停用，不需要 External Client URL/token。

Workflow 会直接启动，Private Context Agent 会诚实地标记为 skipped 并使用空 context。
未来 OAuth + Manyfold-owned provider setup 完成后，再重新启用这条流程。

## 常见问题

### 首页显示服务尚未配置

检查 `/api/config` 中 `services.manyfold`。进入 `/settings` 补齐相应字段，
保存后重新读取。

### Access 页面显示口令未配置

进入 `/settings`，使用管理密码登录后填写正好 6 位数字并保存。Settings 与
access gate 相互独立，所以即使访客门禁未配置，管理员仍能进入 Settings 完成
bootstrap。

### Agent 一直 working

先检查 `/api/trips/:id` 的 `phase`、`tasks`、attempt 和 error。若 phase 仍为
`draft`，说明 start request 尚未成功送出。Private Context 会直接标记 skipped；其余
A2A task 依角色预算轮询，整个 workflow task 最多三次 attempt。超过十分钟的单次调用
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
- access code 只保存在加密 Settings 或环境 secret 中，不写入静态资源。
- 所有业务页面、生成的 trip 文件和 API 都必须经过服务端 access guard。
- 当前版本不保存 trip-scoped External Client credential，也不执行 provider OAuth。
- 未来 Private Context 重新启用后，provider credential、OAuth token、Composio account
  ID 和 external subject 都必须留在用户自己的 Manyfold host agent 内。
- 保留每 IP Rate Limiting，限制昂贵的 trip 创建请求。
- 不新增 cron、Cloudflare Workflows 或本地生产部署入口。
