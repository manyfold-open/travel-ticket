// docs/design-system.md 對比鐵律的單一真實來源。CI 腳本(scripts/check-theme-contrast.mjs)
// 與 runtime 守門(pipeline/customTheme.mjs)都 import 這裡,規則只此一份。
const lum = (hex) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

export const ratio = (a, b) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

// [前景, 背景, 最低比值, 說明] — 來源:docs/design-system.md「對比鐵律」與現役用法。
export const contrastPairs = (t) => [
  [t.ink, t.paper, 4.5, 'ink on paper'],
  [t.muted, t.paper, 4.5, 'muted on paper'],
  [t['ink-soft'], t.paper, 4.5, 'ink-soft on paper'],
  [t['rail-deep'], t.paper, 4.5, 'rail-deep on paper'],
  [t['rail-deep'], t['paper-bright'], 4.5, 'rail-deep on paper-bright'],
  [t.stamp, t.paper, 4.5, 'postmark on paper'],
  [t.stamp, t['paper-bright'], 4.5, 'postmark on paper-bright'],
  ['#ffffff', t['rail-press'], 4.5, 'CTA white on rail-press'],
  [t.gold, t.night, 4.5, 'gold on night (eyebrow)'],
  [t['paper-bright'], t.night, 4.5, 'paper-bright on night'],
  [t['paper-dim'], t.night, 4.5, 'paper-dim on night'],
  [t['paper-faint'], t.night, 4.5, 'paper-faint on night'],
  [t['paper-ghost'], t.night, 4.5, 'paper-ghost on night (weak data)'],
]

const HEX_RE = /^#[0-9a-f]{6}$/i

export function checkTokens(tokens) {
  const failures = []
  for (const [fg, bg, min, label] of contrastPairs(tokens)) {
    if (!HEX_RE.test(String(fg)) || !HEX_RE.test(String(bg))) {
      failures.push({ label, ratio: 0, need: min, fg, bg })
      continue
    }
    const r = ratio(fg, bg)
    if (r < min) failures.push({ label, ratio: Number(r.toFixed(2)), need: min, fg, bg })
  }
  return { pass: failures.length === 0, failures }
}

export function validateOverrides(overrides, allowedKeys) {
  const problems = []
  for (const [k, v] of Object.entries(overrides ?? {})) {
    if (!allowedKeys.includes(k)) problems.push(`key not allowed: ${k}`)
    else if (!HEX_RE.test(String(v))) problems.push(`bad hex for ${k}: ${String(v).slice(0, 40)}`)
  }
  return { ok: problems.length === 0, problems }
}
