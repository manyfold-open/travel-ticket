import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AGENT_BUDGET_MS, agentBudgetMs, agentCallBudgetMs, DEFAULT_AGENT_BUDGET_MS } from '../pipeline/agent-budgets.mjs'
import { createMfContext } from '../pipeline/agents.mjs'

const ENV = {
  MF_API_URL: 'https://api.manyfold.ai/api',
  MF_API_TOKEN: 'self-token',
  MF_AGENT_ID: 'agt_self',
  AGENT_BRIEF: 'agt_brief',
  AGENT_DISCOVERY: 'agt_discovery',
  AGENT_CONTEXT_EXTRACTOR: 'agt_context',
  AGENT_COMPOSER: 'agt_composer',
  AGENT_THEME_DESIGNER: 'agt_theme',
}

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

test('createMfContext carries the role budget the supervisor sizes against', () => {
  assert.equal(createMfContext(ENV, 'brief').timeoutMs, agentCallBudgetMs('Trip Brief Agent'))
  assert.equal(createMfContext(ENV, 'discovery').timeoutMs, agentCallBudgetMs('Local Discovery Agent'))
  assert.equal(createMfContext(ENV, 'composer').timeoutMs, agentCallBudgetMs('Itinerary Composer Agent'))
  assert.equal(createMfContext(ENV, 'theme').timeoutMs, agentCallBudgetMs('Theme Designer Agent'))
  // All private connectors run through the single context peer.
  assert.equal(createMfContext(ENV, 'context').timeoutMs, agentCallBudgetMs('Travel Context Agent'))
})
