import { test } from 'node:test'
import assert from 'node:assert/strict'
import { agentReply } from '../scripts/mock-manyfold-agent.mjs'

function briefPrompt(sentence) {
  return `You are the Trip Brief Agent. Trip request: ${sentence}`
}

function discoveryPrompt(brief) {
  return `You are the Local Discovery Agent. Trip brief:\n${JSON.stringify(brief, null, 2)}`
}

function composerPrompt(brief) {
  return `You are the Itinerary Composer Agent. Trip brief:\n${JSON.stringify(brief, null, 2)}`
}

test('local Manyfold mock carries New York through brief, discovery, and composer', () => {
  const brief = agentReply(briefPrompt('5 days in New York'))
  assert.equal(brief.destination, 'New York')
  assert.equal(brief.destination_timezone, 'America/New_York')
  assert.equal(brief.bases[0].name, 'New York')

  const discovery = agentReply(discoveryPrompt(brief))
  assert.equal(discovery.pois[0].base, 'New York')

  const composed = agentReply(composerPrompt(brief))
  assert.equal(composed.days[0].base, 'New York')
  assert.equal(composed.days[0].items[0].location, 'New York')
  assert.equal(composed.cover.title_top, 'New York')
})

test('local Manyfold mock keeps the existing Kyoto fixture profile', () => {
  const brief = agentReply(briefPrompt('5 days in Kyoto'))
  assert.equal(brief.destination, 'Japan: Kyoto & Osaka')
  assert.deepEqual(brief.bases, [{ name: 'Kyoto', nights: 2 }, { name: 'Osaka', nights: 1 }])

  const discovery = agentReply(discoveryPrompt(brief))
  assert.equal(discovery.pois[0].base, 'Kyoto')
  assert.deepEqual(discovery.transports[0], {
    from: 'Kyoto', to: 'Osaka', mode: 'rail', minutes: 30,
    notes: 'Fixture transfer.', source_label: 'Local mock',
  })

  const composed = agentReply(composerPrompt(brief))
  assert.equal(composed.days[0].base, 'Kyoto')
  assert.equal(composed.days[0].items[0].location, 'Kyoto')
})
