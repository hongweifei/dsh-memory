/**
 * Reproduce Qoder's native memory layout from the installed qodercli.
 *
 * The npm SDK only validates options; the real paths, file format and prompts
 * live in the CLI bundle, whose user-facing strings are obfuscated as
 * base64 XOR'd with a repeating key. This script decodes what it needs and
 * prints the facts recorded in `docs/qoder-memory-model.md`.
 *
 * Run: node test/inspect-qodercli.mjs [--strings <filter>]
 *      QODERCLI_BUNDLE=<path to qodercli.js> node test/inspect-qodercli.mjs
 *
 * Prints nothing and explains itself when qodercli is not installed, so it is
 * safe to run anywhere.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Where the installed CLI keeps its bundle: an explicit override, else the global npm
 * root's `@qoder-ai/qodercli` (the client and the app both ship one).
 */
function findBundle() {
  if (process.env.QODERCLI_BUNDLE) return process.env.QODERCLI_BUNDLE
  const roots = [
    process.env.APPDATA === undefined ? undefined : join(process.env.APPDATA, 'npm', 'node_modules'),
    process.env.LOCALAPPDATA === undefined ? undefined : join(process.env.LOCALAPPDATA, 'Programs', 'Qoder CN', 'resources', 'app'),
    '/usr/local/lib/node_modules',
    '/usr/lib/node_modules',
  ].filter((root) => root !== undefined)
  for (const root of roots) {
    const candidate = join(root, '@qoder-ai', 'qodercli', 'bundle', 'qodercli.js')
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

const BUNDLE = findBundle()
const KEY = 'h74YFijkSnty'

if (BUNDLE === undefined || !existsSync(BUNDLE)) {
  console.log('qodercli not found (set QODERCLI_BUNDLE to point at bundle/qodercli.js)')
  console.log('This script documents how the Qoder memory model was read out; it is not a test.')
  process.exit(0)
}

const source = readFileSync(BUNDLE, 'utf8')

/** The bundle's own decoder: base64, XOR'd with a repeating key. */
const decode = (encoded, key = KEY) => {
  const buffer = Buffer.from(encoded, 'base64')
  for (let index = 0; index < buffer.length; index += 1) buffer[index] ^= key.charCodeAt(index % key.length)
  return buffer.toString('utf8')
}

/** Print a window of minified source around a pattern. */
function show(label, pattern, before = 180, after = 420) {
  const match = new RegExp(pattern).exec(source)
  console.log(`\n── ${label} ${'─'.repeat(Math.max(0, 60 - label.length))}`)
  if (!match) return console.log('   (not found)')
  console.log('   ' + source.slice(Math.max(0, match.index - before), match.index + after).replace(/\n/g, ' '))
}

/** Print every match of a regex with a window of minified source around it. */
function showAll(label, pattern, before = 200, after = 500, limit = 5) {
  console.log(`\n── ${label} ${'─'.repeat(Math.max(0, 60 - label.length))}`)
  const re = new RegExp(pattern, 'g')
  let count = 0
  for (const match of source.matchAll(re)) {
    count += 1
    if (count > limit) break
    console.log(`   [${count}] ` + source.slice(Math.max(0, match.index - before), match.index + after).replace(/\n/g, ' '))
  }
  if (count === 0) console.log('   (not found)')
}

const findAt = process.argv.indexOf('--find')
if (findAt >= 0) {
  showAll('find', process.argv[findAt + 1], 200, 500, 8)
  process.exit(0)
}

const wanted = process.argv.indexOf('--strings')
if (wanted >= 0) {
  // Decode every obfuscated literal, optionally filtered, for prompt reading.
  const filter = (process.argv[wanted + 1] ?? '').toLowerCase()
  // `--full` prints whole literals: a prompt section is useless truncated.
  const full = process.argv.includes('--full')
  const seen = new Set()
  for (const match of source.matchAll(/_?\$d\("([A-Za-z0-9+/=]{8,})"(?:,\s*"([^"]*)"\))?/g)) {
    let text
    try {
      text = decode(match[1], match[2] ?? KEY)
    } catch {
      continue
    }
    if (!/^[\x20-\x7e\u4e00-\u9fff\n\r\t]*$/.test(text) || seen.has(text)) continue
    seen.add(text)
    if (filter.length > 0 && !text.toLowerCase().includes(filter)) continue
    console.log(`  ${full ? text : text.replace(/\n/g, '\\n').slice(0, 300)}`)
  }
  process.exit(0)
}

console.log('Qoder native memory layout, read from the installed qodercli\n')

show('index file name + the four memory kinds', 'new Set\\(\\["user","feedback","project","reference"\\]\\)', 420, 420)
show('the two scope directories', 'function k0\\(', 0, 360)
show('user scope dir', 'function Q7A\\(', 0, 120)
show('project scope dir', 'getProjectMemoryTempDir\\(\\)\\{', 0, 260)
show('project identifier', 'function DB\\(', 0, 300)
show('content-file listing filter', 'endsWith\\("\\.md"\\)&&A!==_y', 200, 200)
show('front-matter parsing', 'BFc.has\\(o\\)\\?o:"project"', 420, 160)
show('the dream (AutoDream) scheduler', 'class\\{constructor\\(A,e=\\{\\}\\)\\{this.config=A', 0, 260)

console.log('\nRun with --strings <filter> to dump decoded prompt text (e.g. --strings "type:")')
console.log('Findings: docs/qoder-memory-model.md')
