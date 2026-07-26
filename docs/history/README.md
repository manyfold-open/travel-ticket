# 历史文档

本目录是只读的决策记录，不是当前实现或操作手册。内容保留了当时的文件名、
本机路径、未完成任务和已经废弃的 Cloudflare Workflows 方案。

当前文档请从 [`docs/README.md`](../README.md) 开始。

## 时间线

| 日期 | 记录 | 说明 |
|---|---|---|
| 2026-07-03 | [`feature-specs-2026-07-03.md`](./feature-specs-2026-07-03.md) | 初始功能需求 |
| 2026-07-05 | [`handover-2026-07-05.md`](./handover-2026-07-05.md) | 本地 pipeline handover |
| 2026-07-14 | [`notes/`](./notes/) | Connector 与主题 brainstorm |
| 2026-07-14 | [`specs/`](./specs/) | 已接受的阶段性设计 |
| 2026-07-14 至 21 | [`plans/`](./plans/) | 详细实施计划 |
| 2026-07-21 | [`handover-cloud-2026-07-21.md`](./handover-cloud-2026-07-21.md) | 旧 Cloudflare 迁移 handover |
| 2026-07 | [`progress-2026-07.md`](./progress-2026-07.md) | 实施过程记录 |

## 已被替代的关键决策

- `TripPipelineWorkflow` / Cloudflare Workflows 已由 `TripJob` Durable Object +
  Queue 自建 workflow 替代。
- 旧 Worker 名称和 `zack-chen.workers.dev` 域名已由 `mf-travel-ticket` 替代。
- 本地 `wrangler deploy` 和 Studio 部署按钮已由 GitHub Actions-only 部署替代。
- 硬编码 KV namespace ID 已由 Wrangler account-local provisioning 替代。
- 分散的环境配置已集中到密码保护的 `/settings`。

历史文档中的 credential 描述只说明当时发生过什么。即使值看似完整，也不得复制、
验证或重新使用。
