// Cloudflare entrypoint. HTTP stays in the portable MJS router; asynchronous
// orchestration is our own Durable Object + Queue state machine.
import httpHandler from './index.mjs'
import { handleTripTaskBatch } from './trip-task'
import { resolveRuntimeEnv } from './admin/settings.mjs'
import type { Env } from './env.d.ts'
import type { TripQueueMessage } from './trip-job'

export { TripJob } from './trip-job'

export default {
  fetch: httpHandler.fetch,
  async queue(batch: MessageBatch<TripQueueMessage>, env: Env): Promise<void> {
    return handleTripTaskBatch(batch, await resolveRuntimeEnv(env))
  },
}
