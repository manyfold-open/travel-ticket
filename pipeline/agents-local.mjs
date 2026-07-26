// Local-only backend surface: everything that spawns a subprocess or touches
// fs, kept out of the portable core (agents.mjs) so the Worker bundle never
// pulls in node:child_process/node:fs. Used by the local CLI orchestrator
// (pipeline/trip.mjs) and Studio, never by the deployed Worker.
//
// Adds a third LLM backend on top of agents.mjs's sdk/mf:
//   cli — headless `claude -p` (Claude Code login / subscription, no API key).
//         JSON is requested by prompt and validated by parsing.
// Also owns poster generation (codex CLI / Gemini API / manual), which is
// local-only — the deployed Worker's DAG intentionally has no poster step.
import { execFile, execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import { mergedTokens } from './themes.mjs'
import {
  createContext,
  BRIEF_SYSTEM, BRIEF_SCHEMA,
  DISCOVERY_SYSTEM, DISCOVERY_SCHEMA,
  COMPOSER_SYSTEM, COMPOSER_SCHEMA,
  runTripBriefAgent as runTripBriefAgentCore,
  runLocalDiscoveryAgent as runLocalDiscoveryAgentCore,
  runComposerAgent as runComposerAgentCore,
  runTravelContextAgent as runTravelContextAgentCore,
  runNotionAgent as runNotionAgentCore,
  runStructuredJson as runStructuredJsonCore,
  posterPrompt,
} from './agents.mjs'

export { runCalendarAgent } from './agents.mjs' // no LLM/backend dependency at all

const execFileAsync = promisify(execFile)

const spawnWithStdin = (cmd, args, input) => new Promise((resolve, reject) => {
  const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (d) => { stdout += d })
  child.stderr.on('data', (d) => { stderr += d })
  child.on('error', reject)
  child.on('close', (code) => {
    if (code === 0) resolve({ stdout, stderr })
    else reject(new Error(`${cmd} exited ${code}: ${stderr.slice(0, 500) || stdout.slice(0, 500)}`))
  })
  child.stdin.end(input)
})

const hasCommand = async (cmd) => {
  try {
    await execFileAsync('which', [cmd])
    return true
  } catch {
    return false
  }
}

// Full cli+sdk backend selection (today's original createContext behavior).
// The sdk path delegates to agents.mjs's createContext so there is one
// source of truth for constructing the Anthropic client.
export async function createLocalContext(preferred) {
  const hasApiCreds = Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN)
  const backend = preferred
    ?? (hasApiCreds ? 'sdk' : (await hasCommand('claude')) ? 'cli' : null)
  if (backend === 'sdk') return createContext('sdk')
  if (backend === 'cli') return { backend, client: null }
  throw new Error('No LLM backend available: set ANTHROPIC_API_KEY (or `ant auth login`), or install the `claude` CLI and log in.')
}

// --- claude CLI backend -----------------------------------------------------

const extractJson = (text) => {
  const stripped = text.replace(/^```(?:json)?\s*/m, '').replace(/```\s*$/m, '')
  const start = stripped.indexOf('{')
  const end = stripped.lastIndexOf('}')
  if (start === -1 || end <= start) throw new Error('no JSON object in CLI response')
  return JSON.parse(stripped.slice(start, end + 1))
}

async function runCliJson({ system, prompt, schema, webSearch = false }) {
  const args = ['-p', '--output-format', 'json', '--append-system-prompt', system]
  if (process.env.PIPELINE_CLAUDE_MODEL) args.push('--model', process.env.PIPELINE_CLAUDE_MODEL)
  if (webSearch) args.push('--allowedTools', 'WebSearch,WebFetch')
  const fullPrompt = [
    prompt,
    'Respond with ONLY a single JSON object that validates against this JSON Schema — no code fences, no commentary:',
    JSON.stringify(schema),
  ].join('\n\n')
  const { stdout } = await spawnWithStdin('claude', args, fullPrompt)
  const envelope = JSON.parse(stdout)
  if (envelope.is_error) throw new Error(`claude CLI error: ${String(envelope.result).slice(0, 300)}`)
  return extractJson(envelope.result)
}

// cli-aware structured-output call: dispatches to runCliJson for the cli
// backend, otherwise delegates to agents.mjs's sdk/mf implementation.
export async function runStructuredJson(ctx, req) {
  if (ctx?.backend === 'cli') return runCliJson(req)
  return runStructuredJsonCore(ctx, req)
}

// cli-aware wrappers for the three agents whose backend dispatch previously
// lived inline in agents.mjs. Non-cli backends delegate to the core.
export async function runTripBriefAgent(ctx, sentence, todayIso) {
  if (ctx.backend === 'cli') {
    const prompt = `Today is ${todayIso}. Trip request: ${sentence}`
    return runCliJson({ system: BRIEF_SYSTEM, prompt, schema: BRIEF_SCHEMA })
  }
  return runTripBriefAgentCore(ctx, sentence, todayIso)
}

export async function runLocalDiscoveryAgent(ctx, brief) {
  if (ctx.backend === 'cli') {
    const prompt = `Trip brief:\n${JSON.stringify(brief, null, 2)}`
    return runCliJson({ system: DISCOVERY_SYSTEM, prompt, schema: DISCOVERY_SCHEMA, webSearch: true })
  }
  return runLocalDiscoveryAgentCore(ctx, brief)
}

export async function runComposerAgent(ctx, args) {
  if (ctx.backend === 'cli') {
    const { sentence, brief, timezone, discovery, context, calendar } = args
    const prompt = [
      `Original request: ${sentence}`,
      `Trip brief:\n${JSON.stringify(brief, null, 2)}`,
      `Timezone analysis:\n${JSON.stringify(timezone, null, 2)}`,
      `Local discovery:\n${JSON.stringify(discovery, null, 2)}`,
      `Travel context (bookings): ${JSON.stringify(context)}`,
      `Calendar (fixed events): ${JSON.stringify(calendar)}`,
    ].join('\n\n')
    return runCliJson({ system: COMPOSER_SYSTEM, prompt, schema: COMPOSER_SCHEMA })
  }
  return runComposerAgentCore(ctx, args)
}

// runTravelContextAgent/runNotionAgent call an internal LLM only via their
// deps.llm override, so cli support is a matter of supplying that override.
const cliDeps = (ctx, deps) => (ctx?.backend === 'cli' ? { ...deps, llm: deps.llm ?? ((req) => runCliJson(req)) } : deps)

export async function runTravelContextAgent(ctx, brief, deps = {}) {
  return runTravelContextAgentCore(ctx, brief, cliDeps(ctx, deps))
}

export async function runNotionAgent(ctx, brief, deps = {}) {
  return runNotionAgentCore(ctx, brief, cliDeps(ctx, deps))
}

// ---------------------------------------------------------------------------
// Poster Agent — 記念票畫版生圖

// codex CLI backend — 海報生成主力（免 API key）。
// 2026-07-14 更正：codex-cli ≥0.144 已內建圖像生成工具，ChatGPT 帳號 + gpt-5.6-luna
// 實測可生出高品質 typographic travel poster（codex 先存到 ~/.codex/generated_images/
// 再自行複製到 outPath）。先前「codex 無生圖能力」的結論是被過時 CLI 誤導——當時獨立 CLI
// 是 0.142.5，gpt-5.6-luna 回 400（"requires a newer version of Codex"），升級到 0.144.x 即通。
// （ChatGPT.app 內建的 codex 一直是新版，所以 App 裡看得到生圖。）
// CLI 太舊、或帳號不支援任何可生圖模型時仍會 throw，orchestrator 會往下降級。
function posterViaCodex(prompt, outPath) {
  execFileSync('codex', ['exec', '--skip-git-repo-check',
    '--dangerously-bypass-approvals-and-sandbox', '-C', path.dirname(outPath),
    `${prompt}\n\nSave the generated image as a PNG file at exactly this path: ${outPath}. Do not ask questions.`],
    { timeout: 240_000, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' })
  // codex exec 就算 exit 0 也可能沒真的生圖（CLI 太舊/降級時），所以驗真 PNG magic bytes。
  if (!fs.existsSync(outPath)) throw new Error('codex exec finished but produced no PNG')
  const head = fs.readFileSync(outPath).subarray(0, 8)
  const isPng = head.equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  if (!isPng) throw new Error('codex exec wrote a file that is not a valid PNG')
}

async function posterViaGemini(prompt, outPath) {
  const key = process.env.GEMINI_API_KEY
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent?key=${key}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { imageConfig: { aspectRatio: '3:2' } },
      }),
    },
  )
  if (!res.ok) throw new Error(`Gemini image API ${res.status}: ${(await res.text()).slice(0, 200)}`)
  const json = await res.json()
  const part = json.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data)
  if (!part) throw new Error('Gemini response contained no inline image data')
  fs.writeFileSync(outPath, Buffer.from(part.inlineData.data, 'base64'))
}

// Poster Agent — 記念票畫版生圖。backend 自動選擇（仿 LLM backend 的降級哲學）：
// codex CLI → Gemini API → manual（不生圖，prompt 交給使用者）。
// POSTER_BACKEND=codex|gemini|manual|off 可強制。任何失敗都往下層降，最後誠實 skip。
export async function runPosterAgent({ city, landmarks, themeName, outPath }) {
  const palette = mergedTokens(themeName)
  const prompt = posterPrompt({ city, landmarks, palette })
  const forced = process.env.POSTER_BACKEND
  if (forced === 'off') return { status: 'skipped', notes: 'POSTER_BACKEND=off.', prompt }

  const hasCodex = (() => {
    try { execFileSync('which', ['codex'], { stdio: 'ignore' }); return true }
    catch { return false }
  })()
  const order = forced ? [forced]
    : [hasCodex && 'codex', process.env.GEMINI_API_KEY && 'gemini', 'manual'].filter(Boolean)

  // 只有真的會寫檔的層（codex/gemini）才建目錄；manual/off/skip 不留空的 data/posters/。
  const errors = []
  for (const backend of order) {
    if (backend === 'manual') {
      return { status: 'skipped', prompt,
        notes: `No image backend available (${errors.join('; ') || 'no codex CLI, no GEMINI_API_KEY'}). Poster prompt saved to cover.poster_prompt — generate manually and save to ${outPath}, then re-render.` }
    }
    try {
      if (backend !== 'codex' && backend !== 'gemini') {
        // 未知/設錯的 backend（例如 POSTER_BACKEND 打錯字）不得回報成功；
        // throw 進 errors，最後誠實 skip，避免產生指向不存在檔案的 cover.poster。
        throw new Error(`unknown backend ${backend}`)
      }
      fs.mkdirSync(path.dirname(outPath), { recursive: true })
      if (backend === 'codex') posterViaCodex(prompt, outPath)
      if (backend === 'gemini') await posterViaGemini(prompt, outPath)
      return { backend, prompt }
    } catch (error) {
      errors.push(`${backend}: ${error.message}`)
    }
  }
  return { status: 'skipped', notes: errors.join('; '), prompt }
}
