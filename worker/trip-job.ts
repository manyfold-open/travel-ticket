import { DurableObject } from 'cloudflare:workers'
import type { Env, MfRole, SealedCredential, TripAgentBinding, TripAgentCredentials, TripJobParams } from './env.d.ts'

export type TripTaskName =
  | 'brief'
  | 'timezone'
  | 'discovery'
  | 'context'
  | 'composer'
  | 'theme'
  | 'render'

export interface TripQueueMessage {
  jobId: string
  taskId: TripTaskName
}

type TaskPhase = 'pending' | 'running' | 'done' | 'failed'

interface TaskRecord {
  id: TripTaskName
  phase: TaskPhase
  attempts: number
  maxAttempts: number
  availableAt: number
  queuedAt?: number
  leaseId?: string
  leaseUntil?: number
  output?: unknown
  error?: string
}

interface TripJobState {
  params: TripJobParams
  phase: 'draft' | 'queued' | 'running' | 'done' | 'error'
  tasks: Record<TripTaskName, TaskRecord>
  updatedAt: number
  completedAt?: number
  error?: string
  manifest?: { slug: string; status: string; page_count: number }
  agentBinding?: TripAgentBinding
  /**
   * Sealed per-role credentials, snapshotted when the trip starts.
   *
   * The whole DAG runs against one consistent set: a per-task KV read could
   * see a different record mid-run (KV is eventually consistent and edge
   * cached), and re-resolving after an operator reconnects would silently mix
   * credentials across a single trip. They stay sealed here — an open bearer
   * has no business sitting in Durable Object storage.
   */
  agentCredentials?: TripAgentCredentials
  /** The connection record's updatedAt when the snapshot was taken. */
  credentialRev?: string
  /** Set when an agent rejected its stored token and only the operator can fix it. */
  needsReconnect?: boolean
}

export interface TripTaskClaim {
  status: 'claimed' | 'done' | 'busy' | 'blocked' | 'missing'
  leaseId?: string
  retryAfterSeconds?: number
  params?: TripJobParams
  outputs?: Partial<Record<TripTaskName, unknown>>
  agentCredential?: SealedCredential
  /** Folded into the A2A messageId so a redelivered attempt cannot double-bill. */
  attempt?: number
}

interface TripTaskFailure {
  action: 'retry' | 'terminal' | 'stale'
  delaySeconds?: number
}

const STATE_KEY = 'job'
const ACTIVE_RECONCILE_MS = 60_000
const LEASE_MS = 10 * 60_000
const DRAFT_RETENTION_MS = 24 * 60 * 60_000
const RETENTION_MS = 7 * 24 * 60 * 60_000

const TASKS: TripTaskName[] = [
  'brief',
  'timezone',
  'discovery',
  'context',
  'composer',
  'theme',
  'render',
]

const DEPENDENCIES: Record<TripTaskName, TripTaskName[]> = {
  brief: [],
  timezone: ['brief'],
  discovery: ['brief', 'timezone'],
  context: ['brief', 'timezone'],
  composer: ['brief', 'timezone', 'discovery', 'context'],
  theme: ['brief', 'composer'],
  render: ['brief', 'timezone', 'discovery', 'context', 'composer', 'theme'],
}

const DISPLAY_NAMES: Partial<Record<TripTaskName, string>> = {
  brief: 'Trip Brief Agent',
  timezone: 'Timezone Agent',
  discovery: 'Local Discovery Agent',
  context: 'Travel Context Agent',
  composer: 'Itinerary Composer Agent',
  theme: 'Theme Designer Agent',
}

/**
 * Agent-backed tasks get fewer attempts than deterministic ones.
 *
 * Each retry of an agent task is a billed session and up to eight minutes of
 * user wait. With a resilient stream and bounded recovery underneath, a failure
 * that survived the whole call budget is rarely transient. timezone and render
 * are cheap, deterministic and bill nothing, so they keep three.
 */
const MAX_ATTEMPTS: Partial<Record<TripTaskName, number>> = {
  brief: 2,
  discovery: 2,
  context: 2,
  composer: 2,
  theme: 2,
}

function newTask(id: TripTaskName): TaskRecord {
  return { id, phase: 'pending', attempts: 0, maxAttempts: MAX_ATTEMPTS[id] ?? 3, availableAt: 0 }
}

function shortError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ').slice(0, 500)
}

export class TripJob extends DurableObject<Env> {
  async initialize(params: TripJobParams): Promise<Record<string, unknown>> {
    const existing = this.readState()
    if (existing) return this.snapshot(existing)

    const now = Date.now()
    const tasks = Object.fromEntries(TASKS.map(id => [id, newTask(id)])) as Record<TripTaskName, TaskRecord>
    const state: TripJobState = {
      params,
      phase: 'draft',
      tasks,
      updatedAt: now,
    }
    this.writeState(state)
    await this.ctx.storage.setAlarm(now + DRAFT_RETENTION_MS)
    return this.snapshot(state)
  }

  async start(
    credentials?: TripAgentCredentials,
    credentialRev?: string,
  ): Promise<Record<string, unknown> | null> {
    const state = this.readState()
    if (!state) return null
    if (state.phase !== 'draft') return this.snapshot(state)

    if (credentials) {
      state.agentCredentials = credentials
      state.credentialRev = credentialRev
      state.needsReconnect = false
    }
    state.phase = 'queued'
    state.updatedAt = Date.now()
    this.writeState(state)
    await this.pump(state)
    return this.snapshot(state)
  }

  async getVisitorId(): Promise<string | null> {
    return this.readState()?.params.visitorId ?? null
  }

  async getAgentBinding(): Promise<TripAgentBinding | null> {
    return this.readState()?.agentBinding ?? null
  }

  async claim(taskId: TripTaskName): Promise<TripTaskClaim> {
    const state = this.readState()
    if (!state || !state.tasks[taskId]) return { status: 'missing' }
    if (state.phase === 'done' || state.phase === 'error') return { status: 'done' }
    if (state.phase === 'draft') return { status: 'blocked', retryAfterSeconds: 15 }

    const task = state.tasks[taskId]
    if (task.phase === 'done' || task.phase === 'failed') return { status: 'done' }

    const now = Date.now()
    if (task.phase === 'running' && (task.leaseUntil ?? 0) > now) {
      return {
        status: 'busy',
        retryAfterSeconds: Math.max(5, Math.ceil(((task.leaseUntil ?? now) - now) / 1000)),
      }
    }
    if (task.phase === 'running') {
      if (this.expireLease(state, task, now)) {
        this.writeState(state)
        await this.ctx.storage.setAlarm(now + RETENTION_MS)
        return { status: 'done' }
      }
    }
    if (task.availableAt > now) {
      return { status: 'busy', retryAfterSeconds: Math.max(1, Math.ceil((task.availableAt - now) / 1000)) }
    }
    if (!this.dependenciesDone(state, taskId)) return { status: 'blocked', retryAfterSeconds: 15 }

    const leaseId = crypto.randomUUID()
    task.phase = 'running'
    task.attempts += 1
    task.leaseId = leaseId
    task.leaseUntil = now + LEASE_MS
    task.error = undefined
    state.phase = 'running'
    state.updatedAt = now
    this.writeState(state)
    await this.scheduleAlarm(state)

    return {
      status: 'claimed',
      leaseId,
      params: state.params,
      outputs: this.outputs(state),
      attempt: task.attempts,
      ...(state.agentCredentials?.[taskId as MfRole]
        ? { agentCredential: state.agentCredentials[taskId as MfRole] }
        : {}),
    }
  }

  /**
   * Re-read the connection after an agent rejected its token.
   *
   * If the operator has reconnected since this trip started, the record's
   * updatedAt has moved and the caller gets a fresh credential to retry with
   * inside the same invocation. Otherwise the trip is marked as needing a
   * reconnect and told to stop: nothing in this system can re-issue that
   * credential, so further attempts only burn the lease.
   */
  async refreshAgentCredential(
    role: MfRole,
    credentials: TripAgentCredentials | null,
    credentialRev: string | null,
  ): Promise<SealedCredential | null> {
    const state = this.readState()
    if (!state) return null
    if (credentials && credentialRev && credentialRev !== state.credentialRev) {
      state.agentCredentials = credentials
      state.credentialRev = credentialRev
      state.needsReconnect = false
      state.updatedAt = Date.now()
      this.writeState(state)
      return credentials[role] ?? null
    }
    state.needsReconnect = true
    state.updatedAt = Date.now()
    this.writeState(state)
    return null
  }

  async complete(taskId: TripTaskName, leaseId: string, output: unknown): Promise<'ok' | 'stale'> {
    const state = this.readState()
    if (!state) return 'stale'
    const task = state.tasks[taskId]
    if (!task || task.phase !== 'running' || task.leaseId !== leaseId) return 'stale'

    const now = Date.now()
    task.phase = 'done'
    task.output = output
    task.leaseId = undefined
    task.leaseUntil = undefined
    state.updatedAt = now

    if (taskId === 'render') {
      const rendered = output as { slug?: string; status?: string; pageCount?: number }
      state.phase = 'done'
      state.completedAt = now
      state.manifest = {
        slug: rendered.slug ?? '',
        status: rendered.status ?? 'complete',
        page_count: rendered.pageCount ?? 0,
      }
    }

    this.writeState(state)
    if (state.phase === 'done') {
      await this.ctx.storage.setAlarm(now + RETENTION_MS)
    } else {
      await this.pump(state)
    }
    return 'ok'
  }

  async fail(
    taskId: TripTaskName,
    leaseId: string,
    error: unknown,
    retryable: boolean,
  ): Promise<TripTaskFailure> {
    const state = this.readState()
    if (!state) return { action: 'stale' }
    const task = state.tasks[taskId]
    if (!task || task.phase !== 'running' || task.leaseId !== leaseId) return { action: 'stale' }

    const now = Date.now()
    const message = shortError(error)
    task.error = message
    task.leaseId = undefined
    task.leaseUntil = undefined

    if (retryable && task.attempts < task.maxAttempts) {
      const delaySeconds = Math.min(30 * (2 ** Math.max(0, task.attempts - 1)), 300)
      task.phase = 'pending'
      task.availableAt = now + delaySeconds * 1000
      task.queuedAt = undefined
      state.updatedAt = now
      this.writeState(state)
      await this.scheduleAlarm(state)
      return { action: 'retry', delaySeconds }
    }

    task.phase = 'failed'
    state.phase = 'error'
    state.error = `${taskId}: ${message}`
    state.completedAt = now
    state.updatedAt = now
    this.writeState(state)
    await this.ctx.storage.setAlarm(now + RETENTION_MS)
    return { action: 'terminal' }
  }

  async getStatus(): Promise<Record<string, unknown> | null> {
    const state = this.readState()
    return state ? this.snapshot(state) : null
  }

  async alarm(): Promise<void> {
    const state = this.readState()
    if (!state) return

    const now = Date.now()
    if (state.phase === 'draft') {
      if (now >= state.updatedAt + DRAFT_RETENTION_MS) {
        await this.ctx.storage.deleteAlarm()
        await this.ctx.storage.deleteAll()
      } else {
        await this.ctx.storage.setAlarm(state.updatedAt + DRAFT_RETENTION_MS)
      }
      return
    }

    if ((state.phase === 'done' || state.phase === 'error') && state.completedAt && now >= state.completedAt + RETENTION_MS) {
      await this.ctx.storage.deleteAlarm()
      await this.ctx.storage.deleteAll()
      return
    }

    if (state.phase === 'queued' || state.phase === 'running') {
      let terminalLeaseExpiry = false
      for (const task of Object.values(state.tasks)) {
        if (task.phase === 'running' && (task.leaseUntil ?? 0) <= now) {
          if (this.expireLease(state, task, now)) {
            terminalLeaseExpiry = true
            break
          }
        }
      }
      state.updatedAt = now
      this.writeState(state)
      if (terminalLeaseExpiry) {
        await this.ctx.storage.setAlarm(now + RETENTION_MS)
        return
      }
      await this.pump(state)
      return
    }

    await this.scheduleAlarm(state)
  }

  private readState(): TripJobState | undefined {
    return this.ctx.storage.kv.get<TripJobState>(STATE_KEY)
  }

  private writeState(state: TripJobState): void {
    this.ctx.storage.kv.put(STATE_KEY, state)
  }

  private dependenciesDone(state: TripJobState, taskId: TripTaskName): boolean {
    return DEPENDENCIES[taskId].every(id => state.tasks[id].phase === 'done')
  }

  private outputs(state: TripJobState): Partial<Record<TripTaskName, unknown>> {
    return Object.fromEntries(
      Object.values(state.tasks)
        .filter(task => task.phase === 'done')
        .map(task => [task.id, task.output]),
    )
  }

  private expireLease(state: TripJobState, task: TaskRecord, now: number): boolean {
    task.leaseId = undefined
    task.leaseUntil = undefined
    task.queuedAt = undefined
    if (task.attempts >= task.maxAttempts) {
      const message = `lease expired after ${task.attempts} attempts`
      task.phase = 'failed'
      task.error = message
      state.phase = 'error'
      state.error = `${task.id}: ${message}`
      state.completedAt = now
      state.updatedAt = now
      return true
    }
    task.phase = 'pending'
    task.availableAt = now
    return false
  }

  private async pump(state: TripJobState): Promise<void> {
    const now = Date.now()
    const ready = TASKS
      .map(id => state.tasks[id])
      .filter(task =>
        task.phase === 'pending'
        && task.availableAt <= now
        && this.dependenciesDone(state, task.id)
        && (!task.queuedAt || task.queuedAt <= now - ACTIVE_RECONCILE_MS),
      )

    if (ready.length) {
      for (const task of ready) task.queuedAt = now
      state.updatedAt = now
      this.writeState(state)
      // Arm reconciliation before the external send. If the Queue call fails
      // or the object is evicted after publishing but before returning, the
      // alarm safely republishes; claim() deduplicates the delivery.
      await this.scheduleAlarm(state)
      try {
        await this.env.TRIP_TASK_QUEUE.sendBatch(
          ready.map(task => ({
            body: { jobId: state.params.tripId, taskId: task.id } satisfies TripQueueMessage,
          })),
        )
      } catch (error) {
        console.error('trip task publish failed; reconciliation will retry', shortError(error))
      }
      return
    }
    await this.scheduleAlarm(state)
  }

  private async scheduleAlarm(state: TripJobState): Promise<void> {
    if (state.phase === 'draft') {
      await this.ctx.storage.setAlarm(state.updatedAt + DRAFT_RETENTION_MS)
      return
    }
    if (state.phase === 'done' || state.phase === 'error') {
      if (state.completedAt) await this.ctx.storage.setAlarm(state.completedAt + RETENTION_MS)
      return
    }
    const now = Date.now()
    const candidates = Object.values(state.tasks)
      .filter(task => task.phase !== 'done' && task.phase !== 'failed')
      .flatMap(task => [
        task.phase === 'running' ? task.leaseUntil : undefined,
        task.phase === 'pending' ? task.availableAt : undefined,
        task.phase === 'pending' && task.queuedAt ? task.queuedAt + ACTIVE_RECONCILE_MS : undefined,
      ])
      .filter((value): value is number => typeof value === 'number' && value > now)
    const next = candidates.length ? Math.min(...candidates) : now + ACTIVE_RECONCILE_MS
    await this.ctx.storage.setAlarm(Math.min(next, now + ACTIVE_RECONCILE_MS))
  }

  private snapshot(state: TripJobState): Record<string, unknown> {
    const agents: Record<string, string> = {}
    const log: string[] = []
    const tasks: Record<string, Record<string, unknown>> = {}

    for (const id of TASKS) {
      const task = state.tasks[id]
      const display = DISPLAY_NAMES[id]
      if (display) {
        agents[display] = task.phase === 'done'
          ? 'completed'
          : task.phase
      }

      const statuses = (task.output as { statuses?: Array<{ agent?: string; status?: string; notes?: string }> } | undefined)?.statuses
      for (const status of statuses ?? []) {
        if (!status.agent) continue
        agents[status.agent] = status.status ?? 'completed'
        log.push(`${status.agent}: ${status.notes ?? status.status ?? 'completed'}`)
      }
      if (task.error) log.push(`${id}: ${task.error}`)
      tasks[id] = {
        status: task.phase,
        attempt: task.attempts,
        max_attempts: task.maxAttempts,
        ...(task.error ? { error: task.error } : {}),
      }
    }

    return {
      phase: state.phase,
      trip_id: state.params.tripId,
      language: state.params.language ?? 'en-GB',
      agents,
      tasks,
      log,
      manifest: state.manifest
        ? { slug: state.manifest.slug, status: state.manifest.status }
        : null,
      error: state.error ?? null,
      ...(state.agentBinding ? { agent_binding: {
        status: state.agentBinding.status,
        ...(state.agentBinding.mode ? { mode: state.agentBinding.mode } : {}),
        ...(state.agentBinding.agentName ? { agent_name: state.agentBinding.agentName } : {}),
        ...(state.agentBinding.connectedAt ? { connected_at: state.agentBinding.connectedAt } : {}),
      } } : {}),
      ...(state.manifest ? { page_count: state.manifest.page_count } : {}),
      updated_at: new Date(state.updatedAt).toISOString(),
    }
  }
}
