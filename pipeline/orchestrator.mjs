#!/usr/bin/env node
// Orchestrator CLI: one-sentence trip request → multi-agent pipeline → ticket-style
// itinerary site. The pipeline itself lives in pipeline/trip.mjs (planTrip /
// renderTicket); this file is the CLI shell: arg parsing, --prune, --render-only,
// design choice, stdout JSON.
//
//   node pipeline/orchestrator.mjs "七月中帶另一半去瑞士五天，不租車不要太趕"
//   node pipeline/orchestrator.mjs --mock          # no API calls, canned data
//
// Flow:
//   Trip Brief Agent (LLM)
//     ├─ Timezone Agent (pure code)
//     ├─ Local Discovery Agent (LLM + web search)
//     └─ Context Agent (user Manyfold Connector → Composio)
//   Itinerary Composer Agent (LLM) — falls back to a local composer on
//   timeout/failure, mirroring how the demo artifact was produced.
//
// Outputs: .trip_work/final_itinerary.json, data/final_itinerary.json, dist/
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline/promises'
import { fileURLToPath } from 'node:url'
import { planTrip, renderTicket, parseDesignChoice, tripDirName, tripsDataDir, saveTripJson, customTokensFrom, customMotifsFrom } from './trip.mjs'
import { renderItinerary } from './render-local.mjs'

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// ---------------------------------------------------------------------------
// CLI

const args = process.argv.slice(2)
const flags = new Set(args.filter((a) => a.startsWith('--')))
const sentence = args.filter((a) => !a.startsWith('--')).join(' ').trim()
const mock = flags.has('--mock')
const skipRender = flags.has('--no-render')
const backendFlag = args.find((a) => a.startsWith('--backend='))?.split('=')[1]
const languageFlag = args.find((a) => a.startsWith('--language=') || a.startsWith('--lang='))?.split('=').slice(1).join('=')
const renderOnly = flags.has('--render-only')

// 票夾清理：--prune[=N] 保留最新 N 份（預設 10），較舊的 data/trips json 與
// dist/trips 目錄一起刪（wallet 以 data/trips 為準，兩邊要同步）。壞 json 不動。
const pruneFlag = args.find((a) => a === '--prune' || a.startsWith('--prune='))
if (pruneFlag) {
  const keep = Math.max(1, Number(pruneFlag.split('=')[1] ?? 10) || 10)
  const files = fs.existsSync(tripsDataDir) ? fs.readdirSync(tripsDataDir).filter((f) => f.endsWith('.json')) : []
  const byNewest = files
    .map((f) => {
      try { return { f, trip_id: JSON.parse(fs.readFileSync(path.join(tripsDataDir, f), 'utf8')).trip_id } }
      catch { return null } // 壞 json 不進排序、也不會被刪
    })
    .filter(Boolean)
    .sort((a, b) => String(b.trip_id).localeCompare(String(a.trip_id)))
  const drop = byNewest.slice(keep)
  for (const { f, trip_id } of drop) {
    // trip_id 已在 byNewest 解析過（壞 json 早被濾掉），直接用、不重讀。
    if (trip_id) fs.rmSync(path.join(packageRoot, 'data', 'posters', `${trip_id}.png`), { force: true })
    fs.rmSync(path.join(tripsDataDir, f))
    fs.rmSync(path.join(packageRoot, 'dist', 'trips', f.replace(/\.json$/, '')), { recursive: true, force: true })
    console.error(`[orchestrator] pruned ${f} (+ dist/trips/${f.replace(/\.json$/, '')})`)
  }
  console.log(JSON.stringify({ pruned: drop.length, kept: Math.min(keep, byNewest.length) }, null, 2))
  process.exit(0)
}

if (renderOnly) {
  // Re-render without re-running agents. 預設重印最新一份（dist 根 + 它的票夾目錄）；
  // --trip=<slug 或前綴> 只重印票夾裡指定那份。
  const tripFlag = args.find((a) => a.startsWith('--trip='))?.split('=')[1]
  if (tripFlag) {
    const tripFiles = fs.existsSync(tripsDataDir) ? fs.readdirSync(tripsDataDir) : []
    const match = tripFiles.includes(`${tripFlag}.json`)
      ? `${tripFlag}.json`
      : tripFiles.find((f) => f.startsWith(tripFlag) && f.endsWith('.json'))
    if (!match) {
      console.error(`[orchestrator] no trip matching "${tripFlag}" in data/trips/${tripFiles.length ? '' : ' (directory is missing or empty - run a trip first or use --render-only)'}`)
      process.exit(1)
    }
    const itinerary = JSON.parse(fs.readFileSync(path.join(tripsDataDir, match), 'utf8'))
    const dir = tripDirName(itinerary)
    const customTokens = customTokensFrom(itinerary)
    const customMotifs = customMotifsFrom(itinerary)
    if (itinerary.custom_theme?.tokens && !customTokens) console.error('[orchestrator] custom_theme.tokens failed validation — rendering without custom overrides')
    const manifest = await renderItinerary(itinerary, { outDir: path.join(packageRoot, 'dist', 'trips', dir), ...(customTokens ? { customTokens } : {}), ...(customMotifs ? { customMotifs } : {}) })
    console.log(JSON.stringify({ ...manifest, trip_dir: dir }, null, 2))
    process.exit(0)
  }
  const latestPath = path.join(packageRoot, 'data', 'final_itinerary.json')
  if (!fs.existsSync(latestPath)) {
    console.error('[orchestrator] data/final_itinerary.json is missing - run a trip first before rendering')
    process.exit(1)
  }
  const itinerary = JSON.parse(fs.readFileSync(latestPath, 'utf8'))
  saveTripJson(itinerary) // 自我遷移：舊資料第一次重印時進票夾
  const dir = tripDirName(itinerary)
  const customTokens = customTokensFrom(itinerary)
  const customMotifs = customMotifsFrom(itinerary)
  if (itinerary.custom_theme?.tokens && !customTokens) console.error('[orchestrator] custom_theme.tokens failed validation — rendering without custom overrides')
  const manifest = await renderItinerary(itinerary, { outDir: path.join(packageRoot, 'dist'), ...(customTokens ? { customTokens } : {}), ...(customMotifs ? { customMotifs } : {}) })
  await renderItinerary(itinerary, { outDir: path.join(packageRoot, 'dist', 'trips', dir), ...(customTokens ? { customTokens } : {}), ...(customMotifs ? { customMotifs } : {}) })
  console.log(JSON.stringify({ ...manifest, trip_dir: dir }, null, 2))
  process.exit(0)
}

if (!sentence && !mock) {
  console.error('Usage: node pipeline/orchestrator.mjs "describe your trip in one sentence" [--mock] [--no-render]')
  process.exit(1)
}

const log = (msg) => console.error(`[orchestrator] ${msg}`)

// ---------------------------------------------------------------------------
// Main

async function main() {
  const { plan, designOptions } = await planTrip(sentence, { mock, backend: backendFlag, language: languageFlag, log })

  // Flag PRESENCE (not truthiness) decides the branch: a bare `--design=` must
  // resolve via parseDesignChoice's fallback, never fall through to the menu.
  const designArg = args.find((a) => a.startsWith('--design='))
  const designFlag = designArg?.split('=').slice(1).join('=')
  let choice
  if (designArg !== undefined) {
    choice = parseDesignChoice(designFlag, designOptions)
  } else if (process.stdin.isTTY && !mock) {
    console.error('\nWhich ticket design would you like for this trip?')
    designOptions.presets.forEach((p, i) => console.error(`  ${i + 1}. ${p.label} —— ${p.why}`))
    console.error(`  ${designOptions.presets.length + 1}. ${designOptions.custom.label} —— ${designOptions.custom.hint}`)
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr })
    const ans = (await rl.question(`Choose 1-${designOptions.presets.length + 1} (default 1): `)).trim()
    const n = Number(ans)
    if (n === designOptions.presets.length + 1) {
      const style = (await rl.question('Describe the look in one sentence: ')).trim()
      choice = style ? { kind: 'custom', style } : parseDesignChoice(undefined, designOptions)
    } else {
      choice = { kind: 'preset', name: designOptions.presets[Math.min(Math.max(n || 1, 1), designOptions.presets.length) - 1].name }
    }
    rl.close()
  } else {
    choice = parseDesignChoice(undefined, designOptions)
  }

  const { manifest, tripDir } = await renderTicket(plan, choice, { skipRender, log })

  console.log(JSON.stringify({
    ...manifest,
    trip_dir: tripDir,
    json_path: 'data/final_itinerary.json',
    agent_statuses: plan.agentStatuses,
  }, null, 2))
}

main().catch((error) => {
  console.error('[orchestrator] fatal:', error)
  process.exit(1)
})
