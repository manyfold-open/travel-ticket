// docs/design-system.md 對比鐵律的可執行版。規則本體在 pipeline/contrast.mjs(單一真實來源)。
// 用法:node scripts/check-theme-contrast.mjs (任何一對不及格 → exit 1)
import { THEMES, mergedTokens } from '../pipeline/themes.mjs'
import { contrastPairs, ratio } from '../pipeline/contrast.mjs'

let failed = 0
for (const name of Object.keys(THEMES)) {
  const t = mergedTokens(name)
  console.log(`\n=== theme: ${name} ===`)
  for (const [fg, bg, min, label] of contrastPairs(t)) {
    const r = ratio(fg, bg)
    const ok = r >= min
    if (!ok) failed++
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}: ${r.toFixed(2)} (need ≥${min})  ${fg} on ${bg}`)
  }
}
process.exit(failed ? 1 : 0)
