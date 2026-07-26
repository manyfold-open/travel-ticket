import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  saveTripFiles,
  saveTripJson,
  getTripFile,
} from '../../worker/storage.mjs'

// Minimal in-memory stand-in for a Cloudflare KVNamespace — just enough of
// put/get's contract (string|ArrayBuffer|ArrayBufferView values, 'text'|
// 'json'|'arrayBuffer' get types) to TDD the adapter without real bindings.
class MockKV {
  constructor() { this.store = new Map() }
  async put(key, value) { this.store.set(key, value) }
  async get(key, type) {
    const value = this.store.get(key)
    if (value === undefined) return null
    if (type === 'json') return JSON.parse(value)
    if (type === 'arrayBuffer') {
      if (value instanceof ArrayBuffer) return value
      if (ArrayBuffer.isView(value)) return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength)
      return new TextEncoder().encode(String(value)).buffer
    }
    return value
  }
}

const makeEnv = () => ({ TRIPS_SITES: new MockKV() })

test('saveTripFiles + getTripFile: round-trips content under trips/<id>/<path>', async () => {
  const env = makeEnv()
  await saveTripFiles(env, 'abc123', new Map([
    ['index.html', '<html>hi</html>'],
    ['day-1.html', '<html>day 1</html>'],
  ]))
  const res = await getTripFile(env, 'abc123', 'index.html')
  assert.ok(res instanceof Response)
  assert.equal(res.status, 200)
  assert.equal(await res.text(), '<html>hi</html>')
  assert.match(res.headers.get('content-type'), /text\/html/)

  const day1 = await getTripFile(env, 'abc123', 'day-1.html')
  assert.equal(await day1.text(), '<html>day 1</html>')
})

test('getTripFile: unknown trip id or path returns null', async () => {
  const env = makeEnv()
  await saveTripFiles(env, 'abc123', new Map([['index.html', 'x']]))
  assert.equal(await getTripFile(env, 'no-such-trip', 'index.html'), null)
  assert.equal(await getTripFile(env, 'abc123', 'nope.html'), null)
})

test('getTripFile: content-type inferred from extension (css/js/webmanifest/json/png)', async () => {
  const env = makeEnv()
  await saveTripFiles(env, 't1', new Map([
    ['style.css', 'body{}'],
    ['app.js', 'console.log(1)'],
    ['manifest.webmanifest', '{}'],
    ['icon.png', Buffer.from([137, 80, 78, 71])],
  ]))
  assert.match((await getTripFile(env, 't1', 'style.css')).headers.get('content-type'), /text\/css/)
  assert.match((await getTripFile(env, 't1', 'app.js')).headers.get('content-type'), /javascript/)
  assert.match((await getTripFile(env, 't1', 'manifest.webmanifest')).headers.get('content-type'), /manifest\+json/)
  assert.match((await getTripFile(env, 't1', 'icon.png')).headers.get('content-type'), /image\/png/)
})

test('saveTripJson + getTripFile: itinerary.json round-trips as JSON content', async () => {
  const env = makeEnv()
  await saveTripJson(env, 'abc123', { destination: 'Kyoto', days: [1, 2, 3] })
  const res = await getTripFile(env, 'abc123', 'itinerary.json')
  assert.match(res.headers.get('content-type'), /application\/json/)
  assert.deepEqual(await res.json(), { destination: 'Kyoto', days: [1, 2, 3] })
})
