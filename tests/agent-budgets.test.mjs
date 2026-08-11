import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AGENT_BUDGET_MS, agentBudgetMs, agentCallBudgetMs, DEFAULT_AGENT_BUDGET_MS } from '../pipeline/agent-budgets.mjs'
import { createAgentContext, mfCallOptions } from '../pipeline/agents.mjs'

const CREDENTIAL = { rpcUrl: 'https://rpc.example/x', token: 'connected-agent-token', label: 'Test agent' }
const ctxFor = role => createAgentContext(CREDENTIAL, role)

// The bug this file guards: the A2A client waited 240s for the brief while
// makeSupervisor abandoned it at 120s. Promise.race cannot cancel the call it
// loses to, so a Manyfold session that answered at ~138s was reported as
// "Trip Brief Agent failed" — three times, once per queue attempt.
test('every agent call budget stays strictly under its supervisor backstop', () => {
  for (const agent of Object.keys(AGENT_BUDGET_MS)) {
    assert.ok(
      agentCallBudgetMs(agent) < agentBudgetMs(agent),
      `${agent}: call budget ${agentCallBudgetMs(agent)} must be under supervisor ${agentBudgetMs(agent)}`,
    )
  }
  assert.ok(agentCallBudgetMs('Unlisted Agent') < DEFAULT_AGENT_BUDGET_MS)
})

// A trivial brief measured ~138s end to end against the real peer, so anything
// close to that is a false-failure generator, not a safety margin.
test('agent budgets leave room for real Manyfold session latency', () => {
  assert.ok(agentCallBudgetMs('Trip Brief Agent') >= 240_000)
  for (const agent of Object.keys(AGENT_BUDGET_MS)) {
    assert.ok(agentCallBudgetMs(agent) >= 180_000, `${agent} budget is too tight for an agent session`)
  }
})

// worker/trip-job.ts leases a task for 10 minutes; a budget past that would let
// the lease expire mid-flight and be re-dispatched while still running.
test('agent budgets stay inside the TripJob lease window', () => {
  for (const agent of Object.keys(AGENT_BUDGET_MS)) {
    assert.ok(agentBudgetMs(agent) < 10 * 60_000, `${agent} budget exceeds the TripJob lease`)
  }
})

test('createAgentContext carries the role budget the supervisor sizes against', () => {
  assert.equal(ctxFor('brief').timeoutMs, agentCallBudgetMs('Trip Brief Agent'))
  assert.equal(ctxFor('discovery').timeoutMs, agentCallBudgetMs('Local Discovery Agent'))
  assert.equal(ctxFor('composer').timeoutMs, agentCallBudgetMs('Itinerary Composer Agent'))
  assert.equal(ctxFor('theme').timeoutMs, agentCallBudgetMs('Theme Designer Agent'))
})

test('createAgentContext refuses a role with no usable credential', () => {
  assert.throws(() => createAgentContext(null, 'brief'), /no usable credential/)
  assert.throws(() => createAgentContext({ rpcUrl: 'https://x/rpc' }, 'brief'), /no usable credential/)
})

test('a context spends one role budget in total, however many calls it makes', () => {
  const ctx = ctxFor('composer')
  const first = mfCallOptions(ctx)
  // The language policy in agents/trip.mjs runs a second full call after the
  // first has already spent its budget. Before deadlineAt existed, that second
  // call got a fresh timeoutMs and the composer could run to 2x its allowance:
  // 2 x 460s against a 600s TripJob lease, so the lease expired mid-flight and
  // the task was re-dispatched while the first session was still billing.
  const pretendSpent = first.timeoutMs - 30_000
  const laterCtx = { ...ctx, deadlineAt: ctx.deadlineAt - pretendSpent }
  const second = mfCallOptions(laterCtx)
  assert.ok(
    second.timeoutMs < first.timeoutMs,
    `a later call must get the remaining budget, got ${second.timeoutMs} vs ${first.timeoutMs}`,
  )
  assert.ok(second.deadlineAt <= first.deadlineAt, 'the deadline must not move outwards')
})

test('every role budget still fits inside the TripJob lease', () => {
  // The lease is what re-dispatches a task; a role allowed to outlive it can
  // have two billed sessions running at once.
  const LEASE_MS = 10 * 60_000
  for (const role of ['brief', 'discovery', 'composer', 'theme']) {
    const ctx = ctxFor(role)
    assert.ok(
      ctx.deadlineAt - Date.now() < LEASE_MS,
      `${role} budget ${ctx.deadlineAt - Date.now()}ms must stay under the ${LEASE_MS}ms lease`,
    )
  }
})
