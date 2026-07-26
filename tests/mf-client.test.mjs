import { test } from 'node:test'
import assert from 'node:assert/strict'
import { callMfAgent, extractAgentText, runMfJson } from '../pipeline/mf-client.mjs'

const ENV = { MF_API_URL: 'https://api.manyfold.ai/api', MF_API_TOKEN: 'self-token', MF_AGENT_ID: 'agt_self' }

function withFetch(handler, fn) {
  const original = globalThis.fetch
  globalThis.fetch = handler
  return fn().finally(() => { globalThis.fetch = original })
}

test('callMfAgent: mints a peer token then posts JSON-RPC message/send', () => withFetch(async (url, opts) => {
  if (String(url).includes('/a2a/peers/')) {
    assert.match(String(url), /\/agent-self\/a2a\/peers\/agt_peer\/token\?agentId=agt_self$/)
    assert.equal(opts.headers.authorization, 'Bearer self-token')
    return new Response(JSON.stringify({ token: 'peer-token', rpcUrl: 'https://rpc.example/agt_peer' }), { status: 200 })
  }
  assert.equal(url, 'https://rpc.example/agt_peer')
  assert.equal(opts.headers.authorization, 'Bearer peer-token')
  const body = JSON.parse(opts.body)
  assert.equal(body.method, 'message/send')
  assert.deepEqual(body.params.configuration, { blocking: false })
  assert.equal(body.params.message.parts[0].text, 'hello')
  return new Response(JSON.stringify({ result: { parts: [{ text: 'world' }] } }), { status: 200 })
}, async () => {
  const text = await callMfAgent(ENV, 'agt_peer', 'hello')
  assert.equal(text, 'world')
}))

test('callMfAgent: retries only when the caller opts in', () => withFetch((() => {
  let calls = 0
  return async (url) => {
    if (String(url).includes('/token')) return new Response(JSON.stringify({ token: 't', rpcUrl: 'https://rpc.example/x' }), { status: 200 })
    calls++
    if (calls === 1) return new Response('boom', { status: 502 })
    return new Response(JSON.stringify({ result: { parts: [{ text: 'ok' }] } }), { status: 200 })
  }
})(), async () => {
  const text = await callMfAgent(ENV, 'agt_retry', 'hello', { attempts: 2, retryDelayMs: 0 })
  assert.equal(text, 'ok')
}))

test('callMfAgent: 4xx fails fast, no retry', () => {
  let rpcCalls = 0
  return withFetch(async (url) => {
    if (String(url).includes('/token')) return new Response(JSON.stringify({ token: 't', rpcUrl: 'https://rpc.example/x' }), { status: 200 })
    rpcCalls++
    return new Response('bad request', { status: 400 })
  }, async () => {
    await assert.rejects(() => callMfAgent(ENV, 'agt_4xx', 'hello'), /400/)
    assert.equal(rpcCalls, 1)
  })
})

test('callMfAgent: task state failed → throws with extracted detail', () => withFetch(async (url) => {
  if (String(url).includes('/token')) return new Response(JSON.stringify({ token: 't', rpcUrl: 'https://rpc.example/x' }), { status: 200 })
  return new Response(JSON.stringify({ result: { status: { state: 'failed', message: { parts: [{ text: 'agent crashed' }] } } } }), { status: 200 })
}, async () => {
  await assert.rejects(() => callMfAgent(ENV, 'agt_failed', 'hello', { attempts: 1 }), /agent crashed/)
}))

test('callMfAgent: polls an accepted task without submitting the prompt twice', () => withFetch((() => {
  const methods = []
  return async (url, opts) => {
    if (String(url).includes('/token')) {
      return new Response(JSON.stringify({
        token: 'task-token',
        rpcUrl: 'https://rpc.example/task',
        expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
      }), { status: 200 })
    }
    const body = JSON.parse(opts.body)
    methods.push(body.method)
    if (body.method === 'message/send') {
      return new Response(JSON.stringify({
        result: { id: 'task-1', status: { state: 'submitted' } },
      }), { status: 200 })
    }
    assert.equal(body.method, 'tasks/get')
    assert.equal(body.params.id, 'task-1')
    return new Response(JSON.stringify({
      result: {
        id: 'task-1',
        status: { state: 'completed' },
        artifacts: [{ parts: [{ text: 'completed asynchronously' }] }],
      },
    }), { status: 200 })
  }
})(), async () => {
  const states = []
  const text = await callMfAgent(ENV, 'agt_async', 'hello', {
    attempts: 1,
    timeoutMs: 5_000,
    pollIntervalMs: 0,
    onTaskState: state => states.push(state),
  })
  assert.equal(text, 'completed asynchronously')
  assert.deepEqual(states, ['submitted', 'completed'])
}))

test('callMfAgent: reports invalid credential JSON precisely', () => withFetch(
  async () => new Response('{"token":', { status: 200 }),
  async () => {
    await assert.rejects(
      () => callMfAgent(ENV, 'agt_bad_credential_json', 'hello', { attempts: 1 }),
      /credential response was not valid JSON/,
    )
  },
))

test('callMfAgent: reports invalid RPC JSON precisely', () => withFetch(async (url) => {
  if (String(url).includes('/token')) {
    return new Response(JSON.stringify({ token: 't', rpcUrl: 'https://rpc.example/bad-json' }), { status: 200 })
  }
  return new Response('{"result":', { status: 200 })
}, async () => {
  await assert.rejects(
    () => callMfAgent(ENV, 'agt_bad_rpc_json', 'hello', { attempts: 1 }),
    /returned invalid JSON/,
  )
}))

test('callMfAgent: isolates cached peer tokens by source agent identity', () => {
  const mintedFor = []
  return withFetch(async (url, opts) => {
    if (String(url).includes('/token')) {
      const source = new URL(String(url)).searchParams.get('agentId')
      mintedFor.push(source)
      return new Response(JSON.stringify({
        token: `token-${source}`,
        rpcUrl: `https://rpc.example/${source}`,
      }), { status: 200 })
    }
    return new Response(JSON.stringify({
      result: { parts: [{ text: opts.headers.authorization }] },
    }), { status: 200 })
  }, async () => {
    const first = await callMfAgent(ENV, 'agt_shared_peer', 'one', { attempts: 1 })
    const second = await callMfAgent({ ...ENV, MF_AGENT_ID: 'agt_other' }, 'agt_shared_peer', 'two', { attempts: 1 })
    assert.equal(first, 'Bearer token-agt_self')
    assert.equal(second, 'Bearer token-agt_other')
    assert.deepEqual(mintedFor, ['agt_self', 'agt_other'])
  })
})

test('extractAgentText: prefers result.parts, then artifacts, then status.message', () => {
  assert.equal(extractAgentText({ result: { parts: [{ text: 'a' }] } }), 'a')
  assert.equal(extractAgentText({ result: { artifacts: [{ parts: [{ text: 'b1' }] }, { parts: [{ text: 'b2' }] }] } }), 'b1\nb2')
  assert.equal(extractAgentText({ result: { status: { message: { parts: [{ text: 'c' }] } } } }), 'c')
  assert.equal(extractAgentText({}), '{}')
})

test('runMfJson: injects schema instructions into the prompt and parses the JSON reply', () => withFetch(async (url, opts) => {
  if (String(url).includes('/token')) return new Response(JSON.stringify({ token: 't', rpcUrl: 'https://rpc.example/x' }), { status: 200 })
  const body = JSON.parse(opts.body)
  const sentPrompt = body.params.message.parts[0].text
  assert.match(sentPrompt, /system prompt/)
  assert.match(sentPrompt, /JSON Schema/)
  return new Response(JSON.stringify({ result: { parts: [{ text: '```json\n{"ok":true}\n```' }] } }), { status: 200 })
}, async () => {
  const parsed = await runMfJson(ENV, 'agt_json', { system: 'system prompt', prompt: 'do the thing', schema: { type: 'object' } })
  assert.deepEqual(parsed, { ok: true })
}))

test('runMfJson: throws when reply has no JSON object', () => withFetch(async (url) => {
  if (String(url).includes('/token')) return new Response(JSON.stringify({ token: 't', rpcUrl: 'https://rpc.example/x' }), { status: 200 })
  return new Response(JSON.stringify({ result: { parts: [{ text: 'no json here' }] } }), { status: 200 })
}, async () => {
  await assert.rejects(() => runMfJson(ENV, 'agt_no_json', { system: 's', prompt: 'p', schema: {} }), /no JSON object/)
}))

test('callMfAgent: timeoutMs is the budget for the whole call, not per attempt', () => {
  let rpcCalls = 0
  return withFetch(async (url) => {
    if (String(url).includes('/token')) return new Response(JSON.stringify({ token: 't', rpcUrl: 'https://rpc.example/x' }), { status: 200 })
    rpcCalls++
    return new Response('overloaded', { status: 503 })
  }, async () => {
    // A retryable failure that leaves no room for a second attempt must surface
    // instead of spending another agent session past the caller's deadline.
    await assert.rejects(
      () => callMfAgent(ENV, 'agt_budget', 'hello', { attempts: 3, timeoutMs: 5_000, retryDelayMs: 0 }),
      /503/,
    )
    assert.equal(rpcCalls, 1)
  })
})

test('callMfAgent: a timeout reports what the poll loop actually saw', () => {
  let polls = 0
  return withFetch(async (url, opts) => {
    if (String(url).includes('/token')) return new Response(JSON.stringify({ token: 't', rpcUrl: 'https://rpc.example/x' }), { status: 200 })
    if (JSON.parse(opts.body).method === 'message/send') {
      return new Response(JSON.stringify({ result: { id: 'aat_1', status: { state: 'working' } } }), { status: 200 })
    }
    polls += 1
    return new Response('upstream hiccup', { status: 503 })
  }, async () => {
    // A poll loop that never once read the task's state must say so: a slow
    // agent and a blind client produce the same bare timeout otherwise.
    await assert.rejects(
      () => callMfAgent(ENV, 'agt_blind', 'hello', { attempts: 1, timeoutMs: 5_000, pollIntervalMs: 0 }),
      (error) => {
        assert.match(error.message, /did not complete within its wait budget/)
        assert.match(error.message, /waited \d+s over \d+ poll\(s\)/)
        assert.match(error.message, /Last \d+ poll\(s\) failed: .*503/)
        return true
      },
    )
    assert.ok(polls > 0, 'expected the loop to have attempted polls')
  })
})

test('callMfAgent: poll interval backs off instead of spending a subrequest a second', () => {
  const pollAt = []
  const startedAt = Date.now()
  return withFetch(async (url, opts) => {
    if (String(url).includes('/token')) return new Response(JSON.stringify({ token: 't', rpcUrl: 'https://rpc.example/x' }), { status: 200 })
    if (JSON.parse(opts.body).method === 'message/send') {
      return new Response(JSON.stringify({ result: { id: 'aat_1', status: { state: 'working' } } }), { status: 200 })
    }
    pollAt.push(Date.now() - startedAt)
    if (pollAt.length < 8) return new Response(JSON.stringify({ result: { status: { state: 'working' } } }), { status: 200 })
    return new Response(JSON.stringify({ result: { status: { state: 'completed' }, parts: [{ text: 'done' }] } }), { status: 200 })
  }, async () => {
    assert.equal(await callMfAgent(ENV, 'agt_backoff', 'hello', { attempts: 1, pollIntervalMs: 20 }), 'done')
    assert.equal(pollAt.length, 8)
    // First polls stay eager so a short turn is still picked up quickly; later
    // gaps grow, which is what keeps a multi-minute wait off the subrequest cap.
    const gaps = pollAt.slice(1).map((at, i) => at - pollAt[i])
    assert.ok(gaps.at(-1) > gaps[0] * 3, `expected backoff, got gaps ${gaps.join(',')}`)
  })
})
