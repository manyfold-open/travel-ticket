import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const publicDirectory = join(root, 'worker', 'public')
const docsDirectory = join(root, 'docs')
const publicFiles = readdirSync(publicDirectory)
const htmlFiles = publicFiles.filter(file => file.endsWith('.html'))
const errors = []
let publicSource = ''

for (const file of htmlFiles) {
  const source = readFileSync(join(publicDirectory, file), 'utf8')
  publicSource += `\n${source}`
  const ids = [...source.matchAll(/\bid=["']([^"']+)["']/g)].map(match => match[1])
  const duplicateIds = [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))]
  if (duplicateIds.length) errors.push(`${file}: duplicate ids: ${duplicateIds.join(', ')}`)

  for (const match of source.matchAll(/\b(?:src|href)=["']([^"'#]+)["']/g)) {
    const reference = match[1]
    if (/^(?:[a-z]+:|\/\/)/i.test(reference)) continue
    const localPath = reference.replace(/^\/+/, '').split(/[?#]/, 1)[0]
    if (!localPath || !/\.[a-z0-9]+$/i.test(localPath)) continue
    if (!existsSync(join(publicDirectory, localPath))) {
      errors.push(`${file}: missing local asset ${reference}`)
    }
  }
}

const markdownFiles = [
  join(root, 'README.md'),
  ...readdirSync(docsDirectory)
    .filter(file => file.endsWith('.md'))
    .map(file => join(docsDirectory, file)),
  join(docsDirectory, 'history', 'README.md'),
]

for (const file of markdownFiles) {
  const source = readFileSync(file, 'utf8')
  for (const match of source.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
    const rawTarget = match[1].trim().replace(/^<|>$/g, '')
    if (!rawTarget || /^(?:[a-z]+:|#)/i.test(rawTarget)) continue
    const target = rawTarget.split('#', 1)[0]
    if (!target) continue
    if (!existsSync(resolve(dirname(file), decodeURIComponent(target)))) {
      errors.push(`${relative(root, file)}: missing Markdown target ${rawTarget}`)
    }
  }
}

const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
if (packageJson.scripts?.deploy) errors.push('package.json: local production deploy script is not allowed')
if (packageJson.scripts?.studio) errors.push('package.json: ambiguous studio script is not allowed; use studio:local')
if (!packageJson.scripts?.['studio:local']) errors.push('package.json: missing explicit studio:local script')
if (/\/(?:connect|progress)\.html\?trip=/.test(publicSource)) {
  errors.push('worker/public: browser flow must use resource-scoped /trips/:id routes')
}
if (/\/api\/trips\/[^"'` ]+\/status/.test(publicSource)) {
  errors.push('worker/public: browser flow must use canonical GET /api/trips/:id')
}
if (/\bvisitor_id\b/.test(publicSource)) {
  errors.push('worker/public: browser visitor identity must stay in the HttpOnly cookie')
}

const wrangler = readFileSync(join(root, 'wrangler.toml'), 'utf8')
if (/^\s*\[\[?workflows?\]?\]/m.test(wrangler)) errors.push('wrangler.toml: Cloudflare Workflows binding is not allowed')
if (/^\s*\[triggers\]/m.test(wrangler)) errors.push('wrangler.toml: scheduled triggers are not used')
if (!/^\s*run_worker_first\s*=\s*true\s*$/m.test(wrangler)) {
  errors.push('wrangler.toml: assets must run the Worker router first')
}
if (/^\s*id\s*=\s*["'][a-f0-9]{20,}["']/m.test(wrangler)) {
  errors.push('wrangler.toml: account-specific resource ID should be auto-provisioned')
}

if (errors.length) {
  for (const error of errors) console.error(`repository check: ${error}`)
  process.exitCode = 1
} else {
  console.log(
    `repository check: ${markdownFiles.length} current docs and ${htmlFiles.length} public pages are internally consistent`,
  )
}
