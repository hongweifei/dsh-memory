/**
 * Dump every decoded qodercli string that looks like memory prompt text.
 *
 * The memory prompt is assembled at runtime from many obfuscated fragments, so
 * recovering it means decoding all of them and reading the pieces in order.
 * Output goes to a file because the text is long.
 *
 * Run: node test/dump-qodercli-strings.mjs [minLength]
 *      QODERCLI_BUNDLE=<path to qodercli.js> node test/dump-qodercli-strings.mjs
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const KEY = 'h74YFijkSnty'
const minLength = Number(process.argv[2] ?? 120)

// Same discovery as inspect-qodercli.mjs: an explicit path, else the global npm root.
function findBundle() {
  if (process.env.QODERCLI_BUNDLE) return process.env.QODERCLI_BUNDLE
  const roots = [
    process.env.APPDATA === undefined ? undefined : join(process.env.APPDATA, 'npm', 'node_modules'),
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
if (BUNDLE === undefined || !existsSync(BUNDLE)) {
  console.log('qodercli not found (set QODERCLI_BUNDLE to point at bundle/qodercli.js)')
  process.exit(0)
}
const source = readFileSync(BUNDLE, 'utf8')

const decode = (encoded, key = KEY) => {
  const buffer = Buffer.from(encoded, 'base64')
  for (let i = 0; i < buffer.length; i += 1) buffer[i] ^= key.charCodeAt(i % key.length)
  return buffer.toString('utf8')
}

const seen = new Set()
const hits = []
for (const match of source.matchAll(/_?\$d\("([A-Za-z0-9+/=]{8,})"(?:,\s*"([^"]*)"\))?/g)) {
  let text
  try {
    text = decode(match[1], match[2] ?? KEY)
  } catch {
    continue
  }
  if (!/^[\x20-\x7e\u4e00-\u9fff\n\r\t]*$/.test(text)) continue
  if (text.length < minLength || seen.has(text)) continue
  seen.add(text)
  // Prompt-shaped: prose about memory, not a keyword list or telemetry label.
  if (!/memory|MEMORY\.md|when_to_|\btype:|consolidat/i.test(text)) continue
  // Skip the giant language keyword dumps.
  if (text.length > 20000) continue
  hits.push(text)
}

hits.sort((a, b) => b.length - a.length)
const out = hits.map((text, index) => `\n${'='.repeat(78)}\n[${index + 1}] ${text.length} chars\n${'='.repeat(78)}\n${text}`).join('\n')
// Written next to this script's docs, not to an absolute path from one machine.
const path = join(dirname(fileURLToPath(import.meta.url)), '..', 'docs', '_qoder-memory-strings.txt')
writeFileSync(path, out)
console.log(`${hits.length} candidate strings, ${out.length} chars -> ${path}`)
for (const [index, text] of hits.entries()) {
  console.log(`  [${index + 1}] ${text.length} chars: ${text.split('\n')[0].slice(0, 90)}`)
}
