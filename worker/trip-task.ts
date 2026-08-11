import cityThemePrompt from '../pipeline/prompts/city-theme.txt'
import { createAgentContext } from '../pipeline/agents.mjs'
import { openCredential, resolveRoleCredentials } from './mf/store.mjs'
import { assembleItinerary } from '../pipeline/trip-core.mjs'
import {
  runBriefStep,
  runTimezoneStep,
  runDiscoveryStep,
  runContextStep,
  runComposerStep,
  runThemeStep,
  runRenderStep,
} from './pipeline-steps.mjs'
import type { Env } from './env.d.ts'
import type { MfRole } from './env.d.ts'
import type { TripQueueMessage, TripTaskClaim, TripTaskName } from './trip-job'

function output<T>(claim: TripTaskClaim, task: TripTaskName): T {
  const value = claim.outputs?.[task]
  if (value === undefined) throw new Error(`missing completed task output: ${task}`)
  return value as T
}

/**
 * Build the context for an agent-backed task from the credential the Durable
 * Object snapshotted when the trip started.
 *
 * messageId is derived from the trip, the task and the attempt: a queue
 * redelivery of the same attempt is deduplicated by the agent, while a genuine
 * new attempt still gets a fresh turn.
 */
async function agentContext(
  env: Env,
  taskId: TripTaskName,
  claim: TripTaskClaim,
  tripId: string,
): Promise<ReturnType<typeof createAgentContext>> {
  if (!claim.agentCredential) {
    throw new Error(`No Manyfold agent is assigned to the ${taskId} role. Connect one in /settings.`)
  }
  const credential = await openCredential(env, claim.agentCredential)
  return createAgentContext(credential, taskId as MfRole, {
    messageId: `tt-${tripId}-${taskId}-${claim.attempt ?? 0}`,
  })
}

async function executeTask(env: Env, taskId: TripTaskName, claim: TripTaskClaim): Promise<unknown> {
  const params = claim.params
  if (!params) throw new Error('trip job claim did not include params')

  if (taskId === 'brief') {
    return runBriefStep(await agentContext(env, 'brief', claim, params.tripId), params.sentence, params.todayIso, params.language)
  }

  const briefRes = output<{ brief: unknown }>(claim, 'brief')
  const brief = briefRes.brief

  if (taskId === 'timezone') return runTimezoneStep(brief)
  if (taskId === 'discovery') return runDiscoveryStep(await agentContext(env, 'discovery', claim, params.tripId), brief)
  if (taskId === 'context') {
    return runContextStep(null, brief, params.visitorId, params.tripId, params.agentBinding)
  }

  const timezoneRes = output<{ timezone: unknown }>(claim, 'timezone')
  const discoveryRes = output<{ discovery: unknown }>(claim, 'discovery')
  const contextRes = output<{ context: {
    bookings?: unknown[]
    calendar_events?: unknown[]
    travel_notes?: unknown[]
  } }>(claim, 'context')
  const context = contextRes.context ?? { bookings: [], calendar_events: [], travel_notes: [] }

  if (taskId === 'composer') {
    return runComposerStep(await agentContext(env, 'composer', claim, params.tripId), {
      sentence: params.sentence,
      brief,
      timezone: timezoneRes.timezone,
      discovery: discoveryRes.discovery,
      context: {
        bookings: context.bookings ?? [],
        travel_notes: context.travel_notes ?? [],
      },
      calendar: { events: context.calendar_events ?? [] },
      language: params.language,
    })
  }

  const composerRes = output<{ composed: unknown }>(claim, 'composer')
  if (taskId === 'theme') {
    return runThemeStep(await agentContext(env, 'theme', claim, params.tripId), {
      design: params.design,
      brief,
      promptTemplate: cityThemePrompt,
      language: params.language,
    })
  }

  if (taskId === 'render') {
    const themeRes = output<{
      themeName: string
      customTokens: unknown
      customMotifs: unknown
      themeUsed: { name: string; custom?: boolean; rationale?: string }
    }>(claim, 'theme')
    const statuses = [
      ...((briefRes as { statuses?: unknown[] }).statuses ?? []),
      ...((timezoneRes as { statuses?: unknown[] }).statuses ?? []),
      ...((discoveryRes as { statuses?: unknown[] }).statuses ?? []),
      ...((contextRes as { statuses?: unknown[] }).statuses ?? []),
      ...((composerRes as { statuses?: unknown[] }).statuses ?? []),
    ]
    const itinerary = assembleItinerary({
      tripId: params.tripId,
      sentence: params.sentence,
      brief,
      timezone: timezoneRes.timezone,
      discovery: discoveryRes.discovery,
      composed: composerRes.composed,
      contextResult: { bookings: context.bookings ?? [] },
      calendarResult: { events: context.calendar_events ?? [] },
      notionResult: { travel_notes: context.travel_notes ?? [] },
      themeName: themeRes.themeName,
      posterResult: null,
      agentStatuses: statuses,
      language: params.language,
    })
    if (themeRes.themeUsed.custom) {
      Object.assign(itinerary, { custom_theme: {
        name: themeRes.themeUsed.name,
        rationale: themeRes.themeUsed.rationale,
        tokens: themeRes.customTokens,
        motifs: themeRes.customMotifs ?? {},
      } })
    }
    const rendered = await runRenderStep(env, itinerary, {
      customTokens: themeRes.customTokens,
      customMotifs: themeRes.customMotifs,
    })
    return {
      ...rendered,
      slug: itinerary.slug,
      status: itinerary.status,
    }
  }

  throw new Error(`unknown trip task: ${taskId}`)
}

function isRetryable(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase()
  if (/\b(400|401|403|404|validation|invalid json|schema|refused)\b/.test(message)) return false
  return true
}

/**
 * Did the agent reject its stored authorization?
 *
 * Under the peer-mint model this meant "re-mint and carry on". A connect
 * credential is issued once, so there is nothing to refresh: either the
 * operator has reconnected since this trip started, or the trip is over.
 */
function isCredentialRejection(error: unknown): boolean {
  const rejected = (error as { refreshCredential?: boolean })?.refreshCredential === true
  const message = error instanceof Error ? error.message : String(error)
  return rejected || /\b(401|403)\b/.test(message)
}

export async function handleTripTaskBatch(
  batch: MessageBatch<TripQueueMessage>,
  env: Env,
): Promise<void> {
  for (const message of batch.messages) {
    const { jobId, taskId } = message.body ?? {}
    if (!jobId || !taskId) {
      message.ack()
      continue
    }

    const stub = env.TRIP_JOBS.get(env.TRIP_JOBS.idFromName(jobId))
    let claim: TripTaskClaim
    try {
      claim = await stub.claim(taskId)
    } catch {
      message.retry({ delaySeconds: 15 })
      continue
    }

    if (claim.status === 'done' || claim.status === 'missing') {
      message.ack()
      continue
    }
    if (claim.status === 'busy' || claim.status === 'blocked') {
      message.retry({ delaySeconds: Math.min(claim.retryAfterSeconds ?? 15, 600) })
      continue
    }
    if (!claim.leaseId) {
      message.retry({ delaySeconds: 15 })
      continue
    }

    try {
      let result: unknown
      try {
        result = await executeTask(env, taskId, claim)
      } catch (error) {
        if (!isCredentialRejection(error) || !claim.agentCredential) throw error
        // One re-read, in this same invocation, without spending an attempt: if
        // the operator reconnected while this trip was running, the fresh
        // credential is worth trying. Otherwise the trip is marked as needing a
        // reconnect and the failure stands.
        const refreshed = await resolveRoleCredentials(env).catch(() => null)
        const next = await stub.refreshAgentCredential(
          taskId as MfRole,
          refreshed?.credentials ?? null,
          refreshed?.credentialRev ?? null,
        )
        if (!next) throw error
        result = await executeTask(env, taskId, { ...claim, agentCredential: next })
      }
      await stub.complete(taskId, claim.leaseId, result)
      message.ack()
    } catch (error) {
      try {
        // A rejected credential is terminal: no number of retries can re-issue
        // it, and each one costs a lease.
        const retryable = isRetryable(error) && !isCredentialRejection(error)
        const decision = await stub.fail(taskId, claim.leaseId, error, retryable)
        if (decision.action === 'retry') {
          message.retry({ delaySeconds: decision.delaySeconds ?? 30 })
        } else {
          message.ack()
        }
      } catch {
        message.retry({ delaySeconds: 30 })
      }
    }
  }
}
