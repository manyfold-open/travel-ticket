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
| Manyfold | 透过 connect 交握授权的 agent 清单，以及四个角色的指派 |
| Private context | 当前停用 |

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

## 连接 Manyfold agents

全新部署没有任何 agent，trip 无法启动。

1. 开启 `/settings` 并以 `ADMIN_SETTINGS_PASSWORD` 登入；
2. 点 **Connect Manyfold agents**。Manyfold 授权页会开启，设定页会显示一组
   确认码；
3. **确认 Manyfold 显示的确认码与设定页一致。** 这是整个流程唯一的反钓鱼检查；
4. 勾选要分享的 agent，并选择授权天数。建议给宽裕的期限：系统没有 refresh，
   授权即将到期会直接挡下新的 trip；
5. 核准。设定页会在几秒内取得凭证并自动指派四个角色；
6. 检查角色指派。一个 agent 可以担任多个角色。

Agent bearer 以 AES-GCM 封存在 `TRIPS_KV`，永远不会送到浏览器。

旧的 `agt_*` 设定没有迁移路径：旧模型的 peer id 与 connect 的 agent id 属于
不同的 id 空间，沿用只会在执行期产生死因误导的失败。

### 重新连线

已到期、在 Manyfold 被撤销、或被 agent 拒绝的授权无法从这一侧更新。`/settings`
会把该 agent 标为未验证，`/api/config` 回报 `needs_reconnect`，新的 trip 会以
409 `manyfold_reconnect_required` 挡下，而不是让它花掉三个计费 session 后才在
第四个任务失败。重跑 connect 流程并核准同一个 agent 即可原地轮换 token。

### 金钥轮换

`MF_CONNECT_KEY` 封存 agent 凭证，刻意与 `ADMIN_SETTINGS_PASSWORD` 分开：轮换
admin 密码不该连带让所有 agent 授权失效。轮换 `MF_CONNECT_KEY` 则必须重新连线
所有 agent。

## Readiness

`/api/access/status.ready` 要求 6 位 access code 与
`ADMIN_SETTINGS_PASSWORD` 同时存在。`/api/config.ready` 只有满足以下条件才为
`true`：

- 四个启用中的角色都指派到一个已连线的 agent，且其授权在未来 45 分钟内不会
  到期（涵盖约 24 分钟的关键路径加上重试）。Private context 当前停用。

`/api/config` 未经认证，因此只回报数量与粗略原因，不会回传 agent 名称、主机
或任何 token 形状的内容。

Workflow 会直接启动，Private Context Agent 会诚实地标记为 skipped 并使用空 context。
当前不会读取私人账户资料，也不会启动 provider setup。

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

- 不把 token、密码、provider credential 写入 TOML、Markdown、Queue 或浏览器资源。
- 不在 `/api/config` 或 `/settings` API 回传 secret。
- access code 只保存在加密 Settings 或环境 secret 中，不写入静态资源。
- 所有业务页面、生成的 trip 文件和 API 都必须经过服务端 access guard。
- 当前版本不保存 trip-scoped External Client credential，也不执行 provider setup。
- Private Context 当前停用；provider credential、provider token、Composio account ID 和
  external subject 不进入 Travel Ticket。
- 保留每 IP Rate Limiting，限制昂贵的 trip 创建请求。
- 不新增 cron、Cloudflare Workflows 或本地生产部署入口。
