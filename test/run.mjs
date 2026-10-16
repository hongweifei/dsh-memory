/**
 * Test runner: find every `*.test.mjs` under `test/`, run each in its own process,
 * report a per-file verdict and a total.
 *
 * The suites are deliberately standalone processes (each prints its own `ok` lines
 * and exits non-zero on failure), so this runner adds only what they cannot do for
 * themselves: discovery, ordering, and one summary that fails when any file fails.
 * It never parses a suite's internals beyond the count it prints at the end.
 *
 * Run: node test/run.mjs            # everything under test/
 *      node test/run.mjs integration # only files whose path contains "integration"
 */
import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const testDir = dirname(fileURLToPath(import.meta.url))
const filter = process.argv.slice(2).join(' ').trim()

/** Every `*.test.mjs` under `test/`, at any depth, sorted for a stable order. */
function discover(dir) {
  const found = []
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) found.push(...discover(full))
    else if (entry.name.endsWith('.test.mjs')) found.push(full)
  }
  return found
}

/** The number of tests a suite reports, from the one summary line each of them prints. */
function reportedCount(output) {
  // Anchored to a line and kept on it: an unanchored pattern would start at any
  // number in the output and let the middle of the match cross newlines.
  const plain = output.match(/^(\d+)[ \t]+(?:[\w-]+[ \t]+)*tests?[ \t]+passed/m)
  if (plain !== null) return Number(plain[1])
  const nodetest = output.match(/^\s*\u2139\s+pass\s+(\d+)/m)
  return nodetest === null ? undefined : Number(nodetest[1])
}

const files = discover(testDir).filter((file) => filter.length === 0 || relative(testDir, file).includes(filter))
if (files.length === 0) {
  console.error(`no test file matched ${JSON.stringify(filter)}`)
  process.exit(1)
}

console.log(`dsh-memory test runner — ${files.length} suite(s)${filter.length > 0 ? ` matching ${JSON.stringify(filter)}` : ''}\n`)

let total = 0
let unknown = 0
const failed = []
for (const file of files) {
  const rel = relative(testDir, file).replaceAll('\\', '/')
  process.stdout.write(`\u25b6 ${rel} ... `)
  const result = spawnSync(process.execPath, [file], { cwd: join(testDir, '..'), encoding: 'utf8' })
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
  const count = reportedCount(output)
  if (result.status === 0) {
    total += count ?? 0
    if (count === undefined) unknown += 1
    console.log(`ok${count === undefined ? '' : ` (${count})`}\n`)
  } else {
    failed.push(rel)
    console.log(`FAILED (exit ${result.status})\n`)
    console.log(output.trimEnd())
    console.log()
  }
}

console.log(`\n${files.length - failed.length}/${files.length} suites passed, ${total} tests${unknown > 0 ? ` (+${unknown} suite(s) whose count was not parsed)` : ''}`)
if (failed.length > 0) {
  console.error(`failed: ${failed.join(', ')}`)
  process.exit(1)
}
