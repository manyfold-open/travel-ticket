import { test } from 'node:test'
import assert from 'node:assert/strict'
import { callA2AAgent, foldStreamResults, extractAgentText, validateA2AUrl } from '../pipeline/mf-client.mjs'

// Connect hands the app an rpcUrl and a bearer; there is no mint step.
const CRED = { rpcUrl: 'https://rpc.example/x', token: 'connected-agent-token', label: 'Test agent' }

function withFetch(handler, fn) {
  const original = globalThis.fetch
  globalThis.fetch = handler
  return fn().finally(() => { globalThis.fetch = original })
}

/** Streams pre-built frames, so a frame can be split across chunk boundaries. */
function streamOf(chunks) {
  const encoder = new TextEncoder()
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
        controller.close()
      },
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  )
}

const frame = result => `data: ${JSON.stringify({ jsonrpc: '2.0', id: 'rpc', result })}\r\n\r\n`

function tokenThen(makeResponse) {
  return async (url) => {
    return makeResponse()
  }
}

/* ───────── frame parsing ───────── */

test('parses frames split across read boundaries', () => {
  const whole = frame({ kind: 'artifact-update', taskId: 't', artifact: { artifactId: 'a', parts: [{ text: 'split me' }] } })
    + frame({ kind: 'status-update', taskId: 't', status: { state: 'completed' }, final: true })
  const cut = Math.floor(whole.length / 3)
  return withFetch(
    tokenThen(() => streamOf([whole.slice(0, cut), whole.slice(cut, cut * 2), whole.slice(cut * 2)])),
    async () => {
      assert.equal(await callA2AAgent(CRED, 'hello'), 'split me')
    },
  )
})

test('accepts LF-only frame separators as well as CRLF', () => withFetch(
  tokenThen(() => streamOf([
    'data: ' + JSON.stringify({ jsonrpc: '2.0', result: { kind: 'artifact-update', taskId: 't', artifact: { artifactId: 'a', parts: [{ text: 'lf only' }] } } }) + '\n\n'
    + 'data: ' + JSON.stringify({ jsonrpc: '2.0', result: { kind: 'status-update', taskId: 't', status: { state: 'completed' } } }) + '\n\n',
  ])),
  async () => {
    assert.equal(await callA2AAgent(CRED, 'hello'), 'lf only')
  },
))

test('ignores the [DONE] sentinel and non-data lines', () => withFetch(
  tokenThen(() => streamOf([
    ': a comment\r\n\r\n',
    'event: ping\r\nid: 7\r\n\r\n',
    frame({ kind: 'artifact-update', taskId: 't', artifact: { artifactId: 'a', parts: [{ text: 'clean' }] } }),
    frame({ kind: 'status-update', taskId: 't', status: { state: 'completed' } }),
    'data: [DONE]\r\n\r\n',
  ])),
  async () => {
    assert.equal(await callA2AAgent(CRED, 'hello'), 'clean')
  },
))

test('a JSON-RPC error frame fails the call', () => withFetch(
  tokenThen(() => streamOf([
    `data: ${JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: 'internal error' } })}\r\n\r\n`,
  ])),
  async () => {
    await assert.rejects(
      () => callA2AAgent(CRED, 'hello', { attempts: 1 }),
      /internal error/,
    )
  },
))

test('a stream that ends with no events at all is retryable, not a phantom task', () => withFetch(
  tokenThen(() => streamOf([])),
  async () => {
    // Nothing was accepted, so no turn is being billed and a resend is safe.
    await assert.rejects(
      () => callA2AAgent(CRED, 'hello', { attempts: 1 }),
      /stream ended without A2A events/,
    )
  },
))

test('a stream that ends mid-task without a task id does not trigger recovery', () => {
  const methods = []
  return withFetch(async (url, opts) => {
    methods.push(JSON.parse(opts.body).method)
    // A status update carrying no task id: nothing to follow up on.
    return streamOf([frame({ kind: 'status-update', status: { state: 'working' } })])
  }, async () => {
    await assert.rejects(
      () => callA2AAgent(CRED, 'hello', { attempts: 1, timeoutMs: 5_000 }),
      /stream ended before the Task reached a terminal state/,
    )
    assert.deepEqual(methods, ['message/stream'], 'recovery must not run without a task id')
  })
})

/* ───────── accumulator ───────── */

test('folds artifacts in arrival order, appending only when asked', () => {
  const folded = foldStreamResults([
    { kind: 'status-update', taskId: 't1', status: { state: 'working' } },
    { kind: 'artifact-update', taskId: 't1', artifact: { artifactId: 'a', parts: [{ text: 'Hello' }] } },
    { kind: 'artifact-update', taskId: 't1', append: true, artifact: { artifactId: 'a', parts: [{ text: ', world' }] } },
    { kind: 'artifact-update', taskId: 't1', artifact: { artifactId: 'b', parts: [{ text: 'second' }] } },
    { kind: 'status-update', taskId: 't1', status: { state: 'completed' }, final: true },
  ])
  assert.equal(extractAgentText(folded), 'Hello, world\nsecond')
  assert.equal(folded.result.id, 't1')
  assert.equal(folded.result.status.state, 'completed')
})

test('a repeated artifact id without append replaces rather than concatenating', () => {
  const folded = foldStreamResults([
    { kind: 'artifact-update', taskId: 't', artifact: { artifactId: 'a', parts: [{ text: 'draft' }] } },
    { kind: 'artifact-update', taskId: 't', artifact: { artifactId: 'a', parts: [{ text: 'final' }] } },
  ])
  assert.equal(extractAgentText(folded), 'final')
})

test('normalizes protobuf-style task states', () => {
  const folded = foldStreamResults([{ kind: 'status-update', taskId: 't', status: { state: 'TASK_STATE_COMPLETED' } }])
  assert.equal(folded.result.status.state, 'completed')
})

/* ───────── SSRF guard ───────── */

test('rejects every host that could exfiltrate a bearer token in production', () => {
  const rejected = [
    'http://api.manyfold.ai/rpc',
    'https://user:pass@api.manyfold.ai/rpc',
    'https://localhost/rpc',
    'https://127.0.0.1/rpc',
    'https://0.0.0.0/rpc',
    'https://10.0.0.8/rpc',
    'https://192.168.1.5/rpc',
    'https://172.16.0.1/rpc',
    'https://169.254.169.254/latest/meta-data',
    'https://agent.local/rpc',
    'https://[::1]/rpc',
    'https://[fd00::1]/rpc',
    'not a url',
  ]
  for (const url of rejected) {
    assert.throws(() => validateA2AUrl(url, { production: true }), undefined, `expected ${url} to be rejected`)
  }
})

test('allows a loopback agent outside production and strips the fragment', () => {
  assert.equal(validateA2AUrl('http://127.0.0.1:8789/a2a', { production: false }), 'http://127.0.0.1:8789/a2a')
  assert.equal(
    validateA2AUrl('https://api.manyfold.ai/api/a2a/agents/x/rpc#frag', { production: true }),
    'https://api.manyfold.ai/api/a2a/agents/x/rpc',
  )
})

test('a failed task that was accepted is not retried, however many attempts remain', () => {
  const sends = []
  return withFetch(async (url, opts) => {
    const method = JSON.parse(opts.body).method
    if (method === 'message/stream') sends.push(method)
    // The agent ran the turn and it failed. That turn is billed; sending the
    // same prompt again would simply buy a second one.
    return streamOf([frame({
      kind: 'status-update',
      taskId: 'burned',
      status: { state: 'failed', message: { parts: [{ text: 'runtime exited 1' }] } },
      final: true,
    })])
  }, async () => {
    await assert.rejects(
      () => callA2AAgent(CRED, 'hello', { attempts: 3, retryDelayMs: 0 }),
      /runtime exited 1/,
    )
    assert.equal(sends.length, 1, 'an accepted task must never be re-sent')
  })
})

test('a failure before acceptance still retries', () => {
  let sends = 0
  return withFetch(async (url) => {
    sends += 1
    if (sends === 1) return new Response('upstream busy', { status: 503 })
    return streamOf([
      frame({ kind: 'artifact-update', taskId: 'ok', artifact: { artifactId: 'a', parts: [{ text: 'recovered' }] } }),
      frame({ kind: 'status-update', taskId: 'ok', status: { state: 'completed' } }),
    ])
  }, async () => {
    // Nothing was accepted on the first try, so no turn was billed.
    assert.equal(await callA2AAgent(CRED, 'hello', { attempts: 2, retryDelayMs: 0 }), 'recovered')
    assert.equal(sends, 2)
  })
})
