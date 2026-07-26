import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { Script } from 'node:vm'

const publicDirectory = resolve('worker/public')
const files = readdirSync(publicDirectory)
const errors = []
let scripts = 0

for (const file of files.filter(name => name.endsWith('.js'))) {
  scripts += 1
  try {
    new Script(readFileSync(join(publicDirectory, file), 'utf8'), { filename: file })
  } catch (error) {
    errors.push(`${file}: ${error.message}`)
  }
}

for (const file of files.filter(name => name.endsWith('.html'))) {
  const source = readFileSync(join(publicDirectory, file), 'utf8')
  let index = 0
  for (const match of source.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    if (/\bsrc\s*=/i.test(match[1]) || !match[2].trim()) continue
    index += 1
    scripts += 1
    try {
      new Script(match[2], { filename: `${file}#script-${index}` })
    } catch (error) {
      errors.push(`${file} inline script ${index}: ${error.message}`)
    }
  }
}

if (errors.length) {
  for (const error of errors) console.error(`browser check: ${error}`)
  process.exitCode = 1
} else {
  console.log(`browser check: ${scripts} scripts parsed successfully`)
}
