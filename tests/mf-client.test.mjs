import { test } from 'node:test'
import assert from 'node:assert/strict'
import { callA2AAgent, extractAgentText, runA2AJson } from '../pipeline/mf-client.mjs'

// Connect hands the app an rpcUrl and a bearer; there is no mint step.
const CRED = { rpcUrl: 'https://rpc.example/x', token: 'connected-agent-token', label: 'Test agent' }

function withFetch(handler, fn) {
  const original = globalThis.fetch
  globalThis.fetch = handler
  return fn().finally(() => { globalThis.fetch = original })
}

/** Builds a text/event-stream response out of JSON-RPC results. */
function sse(results) {
  return new Response(
    results.map(result => `data: ${JSON.stringify({ jsonrpc: '2.0', id: 'rpc', result })}\r\n\r\n`).join(''),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  )
}

test('callA2AAgent: streams the turn over SSE using the connected credential', () => withFetch(async (url, opts) => {
  assert.equal(url, CRED.rpcUrl)
  assert.equal(opts.headers.authorization, `Bearer ${CRED.token}`)
  assert.equal(opts.headers.accept, 'text/event-stream')
  // A 3xx must never replay the bearer against an unvalidated host.
  assert.equal(opts.redirect, 'manual')
  const body = JSON.parse(opts.body)
  assert.equal(body.method, 'message/stream')
  assert.deepEqual(body.params.configuration, { acceptedOutputModes: ['text/plain'] })
  assert.equal(body.params.message.parts[0].text, 'hello')
  return sse([
    { kind: 'status-update', taskId: 't1', status: { state: 'working' } },
    { kind: 'artifact-update', taskId: 't1', artifact: { artifactId: 'a', parts: [{ text: 'world' }] } },
    { kind: 'status-update', taskId: 't1', status: { state: 'completed' }, final: true },
  ])
}, async () => {
  const text = await callA2AAgent(CRED, 'hello')
  assert.equal(text, 'world')
}))

test('callA2AAgent: artifact chunks with append concatenate in arrival order', () => withFetch(async (url) => {
  return sse([
    { kind: 'artifact-update', taskId: 't2', artifact: { artifactId: 'a', parts: [{ text: '{"ok":' }] }, append: false },
    { kind: 'artifact-update', taskId: 't2', artifact: { artifactId: 'a', parts: [{ text: 'true}' }] }, append: true },
    { kind: 'status-update', taskId: 't2', status: { state: 'completed' }, final: true },
  ])
}, async () => {
  assert.equal(await callA2AAgent(CRED, 'hello'), '{"ok":true}')
}))

test('callA2AAgent: reuses one messageId across attempts so a retry cannot double-bill', () => {
  const ids = []
  let calls = 0
  return withFetch(async (url, opts) => {
    ids.push(JSON.parse(opts.body).params.message.messageId)
    calls += 1
    if (calls === 1) return new Response('boom', { status: 502 })
    return sse([
      { kind: 'artifact-update', taskId: 't3', artifact: { artifactId: 'a', parts: [{ text: 'ok' }] } },
      { kind: 'status-update', taskId: 't3', status: { state: 'completed' }, final: true },
    ])
  }, async () => {
    assert.equal(await callA2AAgent(CRED, 'hello', { attempts: 2, retryDelayMs: 0 }), 'ok')
    assert.equal(ids.length, 2)
    assert.equal(ids[0], ids[1], 'a retry must reuse the idempotency key')
  })
})

test('callA2AAgent: a non-SSE JSON reply is still a usable answer', () => withFetch(async (url) => {
  // Some deployments, and the local mock, answer a stream request with a plain
  // JSON-RPC task envelope. That is an answer, not a protocol failure.
  return new Response(JSON.stringify({ result: { parts: [{ text: 'plain json' }] } }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}, async () => {
  assert.equal(await callA2AAgent(CRED, 'hello'), 'plain json')
}))

test('callA2AAgent: posts directly to the supplied RPC URL with its bearer token', () => withFetch(async (url, opts) => {
  assert.equal(url, 'https://external.example/rpc')
  assert.equal(opts.headers.authorization, 'Bearer external-token')
  assert.equal(JSON.parse(opts.body).method, 'message/stream')
  return new Response(JSON.stringify({ result: { parts: [{ text: 'ready' }] } }), { status: 200 })
}, async () => {
  assert.equal(await callA2AAgent({ rpcUrl: 'https://external.example/rpc', token: 'external-token' }, 'ping'), 'ready')
}))

test('callA2AAgent: retries only when the caller opts in', () => withFetch((() => {
  let calls = 0
  return async (url) => {
    calls++
    if (calls === 1) return new Response('boom', { status: 502 })
    return new Response(JSON.stringify({ result: { parts: [{ text: 'ok' }] } }), { status: 200 })
  }
})(), async () => {
  const text = await callA2AAgent(CRED, 'hello', { attempts: 2, retryDelayMs: 0 })
  assert.equal(text, 'ok')
}))

test('callA2AAgent: 4xx fails fast, no retry', () => {
  let rpcCalls = 0
  return withFetch(async (url) => {
    rpcCalls++
    return new Response('bad request', { status: 400 })
  }, async () => {
    await assert.rejects(() => callA2AAgent(CRED, 'hello'), /400/)
    assert.equal(rpcCalls, 1)
  })
})

test('callA2AAgent: task state failed → throws with extracted detail', () => withFetch(async (url) => {
  return new Response(JSON.stringify({ result: { status: { state: 'failed', message: { parts: [{ text: 'agent crashed' }] } } } }), { status: 200 })
}, async () => {
  await assert.rejects(() => callA2AAgent(CRED, 'hello', { attempts: 1 }), /agent crashed/)
}))

const recoveryMethods = []
test('callA2AAgent: recovers an accepted task after a broken stream, never resending', () => withFetch((() => {
  const methods = recoveryMethods
  return async (url, opts) => {
    const body = JSON.parse(opts.body)
    methods.push(body.method)
    if (body.method === 'message/stream') {
      // The stream opens and reports the Task accepted, then ends without ever
      // reaching a terminal state.
      return sse([{ kind: 'status-update', taskId: 'task-1', status: { state: 'submitted' } }])
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
  const text = await callA2AAgent(CRED, 'hello', {
    attempts: 1,
    timeoutMs: 5_000,
    onTaskState: state => states.push(state),
  })
  assert.equal(text, 'completed asynchronously')
  // One send, then follow the Task that send accepted. Never a second send.
  assert.deepEqual(recoveryMethods, ['message/stream', 'tasks/get'])
  assert.deepEqual(states, ['submitted', 'stream-recovering', 'completed'])
}))

test('callA2AAgent: reports invalid RPC JSON precisely', () => withFetch(async (url) => {
  return new Response('{"result":', { status: 200 })
}, async () => {
  await assert.rejects(
    () => callA2AAgent(CRED, 'hello', { attempts: 1 }),
    /returned invalid JSON/,
  )
}))

test('callA2AAgent: sends only the credential it was handed', () => {
  // The peer-token cache is gone, and with it the risk of one role picking up
  // another's token. Each call carries exactly the bearer it was given; the
  // per-role isolation property now lives in worker/mf/store.mjs.
  const seen = []
  return withFetch(async (url, opts) => {
    seen.push({ url: String(url), authorization: opts.headers.authorization })
    return new Response(JSON.stringify({ result: { parts: [{ text: 'ok' }] } }), { status: 200 })
  }, async () => {
    await callA2AAgent(CRED, 'one', { attempts: 1 })
    await callA2AAgent({ rpcUrl: 'https://rpc.example/other', token: 'other-token' }, 'two', { attempts: 1 })
    assert.deepEqual(seen, [
      { url: CRED.rpcUrl, authorization: `Bearer ${CRED.token}` },
      { url: 'https://rpc.example/other', authorization: 'Bearer other-token' },
    ])
  })
})

test('extractAgentText: prefers result.parts, then artifacts, then status.message', () => {
  assert.equal(extractAgentText({ result: { parts: [{ text: 'a' }] } }), 'a')
  assert.equal(extractAgentText({ result: { artifacts: [{ parts: [{ text: 'b1' }] }, { parts: [{ text: 'b2' }] }] } }), 'b1\nb2')
  assert.equal(extractAgentText({ result: { status: { message: { parts: [{ text: 'c' }] } } } }), 'c')
  assert.equal(extractAgentText({}), '{}')
})

test('runA2AJson: injects schema instructions into the prompt and parses the JSON reply', () => withFetch(async (url, opts) => {
  const body = JSON.parse(opts.body)
  const sentPrompt = body.params.message.parts[0].text
  assert.match(sentPrompt, /system prompt/)
  assert.match(sentPrompt, /JSON Schema/)
  return new Response(JSON.stringify({ result: { parts: [{ text: '```json\n{"ok":true}\n```' }] } }), { status: 200 })
}, async () => {
  const parsed = await runA2AJson(CRED, { system: 'system prompt', prompt: 'do the thing', schema: { type: 'object' } })
  assert.deepEqual(parsed, { ok: true })
}))

test('runA2AJson: throws when reply has no JSON object', () => withFetch(async (url) => {
  return new Response(JSON.stringify({ result: { parts: [{ text: 'no json here' }] } }), { status: 200 })
}, async () => {
  await assert.rejects(() => runA2AJson(CRED, { system: 's', prompt: 'p', schema: {} }), /no JSON object/)
}))

test('callA2AAgent: timeoutMs is the budget for the whole call, not per attempt', () => {
  let rpcCalls = 0
  return withFetch(async (url) => {
    rpcCalls++
    return new Response('overloaded', { status: 503 })
  }, async () => {
    // A retryable failure that leaves no room for a second attempt must surface
    // instead of spending another agent session past the caller's deadline.
    await assert.rejects(
      () => callA2AAgent(CRED, 'hello', { attempts: 3, timeoutMs: 5_000, retryDelayMs: 0 }),
      /503/,
    )
    assert.equal(rpcCalls, 1)
  })
})

test('callA2AAgent: a timeout reports what the recovery loop actually saw', () => {
  let polls = 0
  return withFetch(async (url, opts) => {
    if (JSON.parse(opts.body).method === 'message/stream') {
      return sse([{ kind: 'status-update', taskId: 'aat_1', status: { state: 'working' } }])
    }
    polls += 1
    return new Response('upstream hiccup', { status: 503 })
  }, async () => {
    // A recovery loop that never once read the task's state must say so: a slow
    // agent and a blind client produce the same bare timeout otherwise.
    await assert.rejects(
      () => callA2AAgent(CRED, 'hello', { attempts: 1, timeoutMs: 5_000 }),
      (error) => {
        assert.match(error.message, /did not complete within its wait budget/)
        assert.match(error.message, /waited \d+s over \d+ recovery request\(s\)/)
        assert.match(error.message, /Last \d+ recovery request\(s\) failed: .*503/)
        return true
      },
    )
    assert.ok(polls > 0, 'expected the loop to have attempted recovery')
  })
})

test('callA2AAgent: recovery is bounded and never outlives the deadline', () => {
  let recoveries = 0
  return withFetch(async (url, opts) => {
    if (JSON.parse(opts.body).method === 'message/stream') {
      return sse([{ kind: 'status-update', taskId: 'aat_1', status: { state: 'working' } }])
    }
    recoveries += 1
    return new Response(JSON.stringify({ result: { id: 'aat_1', status: { state: 'working' } } }), { status: 200 })
  }, async () => {
    const startedAt = Date.now()
    // The old design polled once a second for the whole budget: ~34 requests
    // over 280s, and 460 over a composer budget. Recovery is now a fixed sparse
    // schedule, and every delay is clamped to the deadline.
    await assert.rejects(
      () => callA2AAgent(CRED, 'hello', { attempts: 1, timeoutMs: 8_000 }),
      /did not complete within its wait budget/,
    )
    assert.ok(recoveries <= 16, `expected at most 16 recovery requests, saw ${recoveries}`)
    assert.ok(Date.now() - startedAt < 12_000, 'recovery ran past the call deadline')
  })
})
