# Travel Ticket 文档

这里仅保留当前实现的说明。根目录的 [README](../README.md) 面向第一次运行
项目的人；本目录面向开发、配置和运维。

## 从哪里开始

| 需求 | 文档 |
|---|---|
| 理解系统组件、请求路径和数据存储 | [系统架构](./architecture.md) |
| 理解 DAG、Manyfold A2A、重试和 fallback | [Agent 编排](./agent-orchestration.md) |
| 实作 Manyfold connector agent | [Manyfold Connector Contract](./manyfold-connector-contract.md) |
| 本地配置、Cloudflare 部署和故障排查 | [运行与部署](./operations.md) |
| 理解产品目标和体验原则 | [产品原则](./product.md) |
| 修改页面样式、主题或交互 | [设计系统](./design-system.md) |

## 当前生产基线

- Worker：`mf-travel-ticket`
- URL：`https://mf-travel-ticket.netmind-ai.workers.dev`
- Runtime：Cloudflare Worker + SQLite Durable Object + Queue + KV
- 编排：应用自建 workflow，不使用 Cloudflare Workflows
- Agent：Manyfold A2A role peers
- 配置入口：密码保护的 `/settings`
- 部署入口：`.github/workflows/deploy.yml`

## 文档边界

文档与实现冲突时，按以下顺序判断：

1. `worker/`、`pipeline/` 和自动化测试中的运行行为；
2. `wrangler.toml` 中的 Cloudflare 资源；
3. 本目录的当前文档；
4. [`history/`](./history/) 中的历史记录。

`history/` 仅记录当时的设计和迁移过程，其中可能包含旧 Worker 名称、旧目录、
Cloudflare Workflows 和本地部署命令。不要从历史文档复制生产操作。

## 文档维护规则

- 新的运行方式必须同步更新对应当前文档。
- 不在文档中保存 token、密码、OAuth credential 或账号专属资源 ID。
- 已被替代的方案移入 `history/`，不要与当前操作步骤混写。
- 当前文档使用相对路径，确保 GitHub 和本地浏览都能打开。
