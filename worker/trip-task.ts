import cityThemePrompt from '../pipeline/prompts/city-theme.txt'
import { createDirectA2AContext, createMfContext } from '../pipeline/agents.mjs'
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
import type { TripQueueMessage, TripTaskClaim, TripTaskName } from './trip-job'

function output<T>(claim: TripTaskClaim, task: TripTaskName): T {
  const value = claim.outputs?.[task]
  if (value === undefined) throw new Error(`missing completed task output: ${task}`)
  return value as T
}

async function executeTask(env: Env, taskId: TripTaskName, claim: TripTaskClaim): Promise<unknown> {
  const params = claim.params
  if (!params) throw new Error('trip job claim did not include params')

  if (taskId === 'brief') {
    return runBriefStep(createMfContext(env, 'brief'), params.sentence, params.todayIso, params.language)
  }

  const briefRes = output<{ brief: unknown }>(claim, 'brief')
  const brief = briefRes.brief

  if (taskId === 'timezone') return runTimezoneStep(brief)
  if (taskId === 'discovery') return runDiscoveryStep(createMfContext(env, 'discovery'), brief)
  if (taskId === 'context') {
    // Private context must come only from the user's supplied External Client.
    // Skipping the connection must never fall back to the deployment's role peer.
    const context = claim.agentCredential
      ? createDirectA2AContext(claim.agentCredential, 'context')
      : null
    return runContextStep(context, brief, params.visitorId, params.tripId, params.agentBinding)
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
    return runComposerStep(createMfContext(env, 'composer'), {
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
    return runThemeStep(createMfContext(env, 'theme'), {
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
      const result = await executeTask(env, taskId, claim)
      await stub.complete(taskId, claim.leaseId, result)
      message.ack()
    } catch (error) {
      try {
        const decision = await stub.fail(taskId, claim.leaseId, error, isRetryable(error))
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
