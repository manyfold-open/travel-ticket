import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const noNodeImports = (relPath) => {
  const src = fs.readFileSync(path.join(here, '..', relPath), 'utf8')
  const staticImports = [...src.matchAll(/^import\s.*?from\s+['"]([^'"]+)['"]/gm)].map((m) => m[1])
  return staticImports.filter((spec) => spec.startsWith('node:'))
}
const noBufferUsage = (relPath) => {
  const src = fs.readFileSync(path.join(here, '..', relPath), 'utf8')
  return [...src.matchAll(/\bBuffer\b/g)].length
}

test('render.mjs (the portable core) has no node: builtin imports', () => {
  const nodeBuiltins = noNodeImports('pipeline/render.mjs')
  assert.deepEqual(nodeBuiltins, [], `render.mjs must stay Worker-safe — found node: imports: ${nodeBuiltins.join(', ')}`)
})

test('pwa.mjs (the portable core) has no node: builtin imports', () => {
  const nodeBuiltins = noNodeImports('pipeline/pwa.mjs')
  assert.deepEqual(nodeBuiltins, [], `pwa.mjs must stay Worker-safe — found node: imports: ${nodeBuiltins.join(', ')}`)
})

test('pwa.mjs does not use the Node-only Buffer global', () => {
  assert.equal(noBufferUsage('pipeline/pwa.mjs'), 0, 'pwa.mjs must use Uint8Array/DataView instead of Buffer to stay Worker-safe')
})

test('customTheme.mjs (the portable core) has no node: builtin imports', () => {
  const nodeBuiltins = noNodeImports('pipeline/customTheme.mjs')
  assert.deepEqual(nodeBuiltins, [], `customTheme.mjs must stay Worker-safe — found node: imports: ${nodeBuiltins.join(', ')}`)
})

test('trip-core.mjs (the portable core) has no node: builtin imports', () => {
  const nodeBuiltins = noNodeImports('pipeline/trip-core.mjs')
  assert.deepEqual(nodeBuiltins, [], `trip-core.mjs must stay Worker-safe — found node: imports: ${nodeBuiltins.join(', ')}`)
})

test('worker/pipeline-steps.mjs has no node: builtin imports', () => {
  const nodeBuiltins = noNodeImports('worker/pipeline-steps.mjs')
  assert.deepEqual(nodeBuiltins, [], `worker/pipeline-steps.mjs must stay Worker-safe — found node: imports: ${nodeBuiltins.join(', ')}`)
})

test('worker/routes/create-trip.mjs has no node: builtin imports', () => {
  const nodeBuiltins = noNodeImports('worker/routes/create-trip.mjs')
  assert.deepEqual(nodeBuiltins, [], `worker/routes/create-trip.mjs must stay Worker-safe — found node: imports: ${nodeBuiltins.join(', ')}`)
})

test('worker/routes/status.mjs has no node: builtin imports', () => {
  const nodeBuiltins = noNodeImports('worker/routes/status.mjs')
  assert.deepEqual(nodeBuiltins, [], `worker/routes/status.mjs must stay Worker-safe — found node: imports: ${nodeBuiltins.join(', ')}`)
})

test('worker/routes/connect.mjs has no node: builtin imports', () => {
  const nodeBuiltins = noNodeImports('worker/routes/connect.mjs')
  assert.deepEqual(nodeBuiltins, [], `worker/routes/connect.mjs must stay Worker-safe — found node: imports: ${nodeBuiltins.join(', ')}`)
})

test('worker trip routing helpers have no node: builtin imports', () => {
  for (const path of ['worker/trip-links.mjs', 'worker/trip-session.mjs', 'worker/visitor-session.mjs']) {
    assert.deepEqual(noNodeImports(path), [], `${path} must stay Worker-safe`)
  }
})

test('worker/index.mjs has no node: builtin imports', () => {
  const nodeBuiltins = noNodeImports('worker/index.mjs')
  assert.deepEqual(nodeBuiltins, [], `worker/index.mjs must stay Worker-safe — found node: imports: ${nodeBuiltins.join(', ')}`)
})

test('worker/routes/config.mjs has no node: builtin imports', () => {
  const nodeBuiltins = noNodeImports('worker/routes/config.mjs')
  assert.deepEqual(nodeBuiltins, [], `worker/routes/config.mjs must stay Worker-safe — found node: imports: ${nodeBuiltins.join(', ')}`)
})
