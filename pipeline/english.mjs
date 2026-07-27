const CJK_RE = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/u

function visit(value, path, matches) {
  if (path[0] === 'request' || path.at(-1) === 'url') return
  if (typeof value === 'string') {
    if (CJK_RE.test(value)) matches.push(path.join('.') || '<root>')
    return
  }
  if (!value || typeof value !== 'object') return
  for (const [key, child] of Object.entries(value)) visit(child, [...path, key], matches)
}

export function findCjkPaths(value) {
  const matches = []
  visit(value, [], matches)
  return matches
}

export function assertBritishEnglish(value) {
  const matches = findCjkPaths(value)
  if (matches.length) {
    throw new Error(`English-only output check failed at: ${matches.slice(0, 8).join(', ')}`)
  }
  return value
}
