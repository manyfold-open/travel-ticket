// Single source of truth for how long each agent is allowed to take.
//
// Two layers used to disagree, and that disagreement was a real bug: the A2A
// client waited up to 240s for the Trip Brief Agent while makeSupervisor's
// Promise.race abandoned it at 120s. A race cannot cancel work already in
// flight — it only stops waiting — so a Manyfold session that finished at 138s
// produced a perfectly good brief that nothing was left listening for, and the
// pipeline reported "Trip Brief Agent failed" for an agent that had succeeded
// (billed, retried, and repeated three times by the queue).
//
// The rule now: the A2A client owns the real deadline (agentCallBudgetMs), so a
// slow turn is aborted at the source and its remote task canceled. supervise()
// keeps a slightly larger budget purely as a backstop for a client that never
// returns at all. Every budget must stay under worker/trip-job.ts's LEASE_MS.
//
// Values are wall-clock reality for Manyfold agent sessions, not aspirations: a
// trivial brief measured ~140s end to end, so anything near 60s is a guaranteed
// false failure.

export const DEFAULT_AGENT_BUDGET_MS = 240_000

export const AGENT_BUDGET_MS = {
  'Trip Brief Agent': 300_000,
  'Local Discovery Agent': 420_000,
  'Travel Context Agent': 240_000,
  'Calendar Agent': 240_000,
  'Notion Agent': 240_000,
  'Theme Designer Agent': 240_000,
  'Itinerary Composer Agent': 480_000,
  'Poster Agent': 300_000,
}

// Headroom between the client's own deadline and the supervisor's backstop, so
// a timeout surfaces as the client's specific error ("task … did not complete
// within its wait budget") instead of the supervisor's opaque 'timeout'.
const SUPERVISOR_MARGIN_MS = 20_000

export function agentBudgetMs(agent) {
  return AGENT_BUDGET_MS[agent] ?? DEFAULT_AGENT_BUDGET_MS
}

export function agentCallBudgetMs(agent) {
  return Math.max(30_000, agentBudgetMs(agent) - SUPERVISOR_MARGIN_MS)
}
