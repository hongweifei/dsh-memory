/**
 * Module-boundary tests.
 *
 * The plugin is one bundle with a Host half split into focused modules under
 * `lib/`, grouped into subsystem directories. These tests enforce the shape so it
 * cannot silently decay: a layer per module, a layered import graph with no cycles,
 * `index.js` as the only aggregator, no module reaching outside its layer, and a
 * size budget per file.
 *
 * Two of these checks exist because this suite itself has been wrong before:
 *
 *  - The graph is built by RESOLVING every relative specifier, not by matching a
 *    one-level `'./x.js'` pattern. While `lib/` was flat, the pattern-based version
 *    would have matched nothing after a reorg — acyclicity and layering would have
 *    passed on an EMPTY graph. `the graph parser really resolved every relative
 *    specifier` exists so that failure mode is loud.
 *  - `every module is assigned to a layer` is an explicit test: a module missing
 *    from {@link LAYERS} used to be compared against `undefined`, and every
 *    `undefined < n` comparison is false, so a stray module slipped through.
 *
 * Run: node test/architecture.test.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, posix } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const libDir = join(root, 'lib')

let passed = 0
const test = async (label, fn) => {
  await fn()
  passed += 1
  console.log(`  ok  ${label}`)
}

console.log('dsh-memory architecture tests')

/** Every `.js` under `lib/`, as a POSIX path relative to `lib/`, sorted. */
function walkLib(dir, rel = '', found = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const next = rel === '' ? entry.name : `${rel}/${entry.name}`
    if (entry.isDirectory()) walkLib(join(dir, entry.name), next, found)
    else if (entry.name.endsWith('.js')) found.push(next)
  }
  return found
}

/** Every module's source, keyed by its path relative to `lib/`. */
const modules = walkLib(libDir).sort()
const sources = new Map(modules.map((rel) => [rel, readFileSync(join(libDir, rel), 'utf8')]))

/** A relative import or re-export, in each of the three forms and both quote styles. */
const SPECIFIER = /(?:from\s+|import\s*\(\s*|import\s+)(['"])((?:\.{1,2}\/)[^'"]*)\1/g

/** Local import edges: path -> Set<path>; unresolvable specifiers are collected. */
const unresolved = []
const graph = new Map()
let relativeSpecifiers = 0
for (const [rel, source] of sources) {
  const dir = posix.dirname(rel)
  const targets = new Set()
  for (const match of source.matchAll(SPECIFIER)) {
    relativeSpecifiers += 1
    const target = posix.normalize(posix.join(dir, match[2]))
    if (sources.has(target)) targets.add(target)
    else unresolved.push(`${rel} -> ${match[2]}`)
  }
  graph.set(rel, targets)
}

/** The layering this plugin intends, lowest first. */
const LAYERS = [
  ['core/constants.js'],
  // The rules, in their own leaf layer so BOTH the loader path and the write path can read them: the
  // write path has to be able to ask "would the plugin accept this?" before persisting, and a
  // configuration the plugin rejects does not fail to apply — it makes the plugin fail to activate.
  ['config/config-rules.js', 'config/scopes.js'],
  ['config/config.js', 'core/tokens.js', 'core/fs.js', 'core/paths.js', 'memory/memory-file.js', 'memory/memory-edit.js', 'memory/journal.js'],
  // The write path sits ABOVE the schema on purpose: to refuse a configuration before persisting it,
  // it must ask the same question `apply()` asks, which means the real schema and the real rules.
  // A hand-rolled approximation here is what missed the `native` default (see `judgeConfig`).
  ['config/config-write.js'],
  ['memory/render.js', 'memory/memory-pass.js', 'memory/memory-prompt.js', 'memory/memory-search.js', 'memory/imports.js', 'memory/excludes.js', 'session/trust.js', 'memory/jit.js', 'memory/transcript.js', 'memory/failure-pause.js', 'session/memory-switch.js', 'session/project-scopes.js', 'memory/commands-report.js'],
  ['pipeline/memory-agent.js', 'pipeline/consumption-plan.js'],
  ['pipeline/consumption.js', 'pipeline/generation.js', 'pipeline/dream.js'],
  ['host/service.js', 'host/tools.js', 'host/routes.js', 'host/commands.js', 'host/consumption-seam.js', 'host/config-route.js'],
  ['index.js'],
]
/** Modules that live at the root of `lib/` and are not part of the layered Host half. */
const ROOT_ARTIFACTS = ['client.js']
/** The subsystem directories this layout consists of, and nothing else. */
const SUBSYSTEMS = ['config', 'core', 'host', 'memory', 'pipeline', 'session']

const layerOf = new Map()
LAYERS.forEach((layer, index) => layer.forEach((name) => layerOf.set(name, index)))

await test('the specifier scanner sees every import form', () => {
  // The scanner is a regex, so it gets its own positive controls: a form it cannot
  // see is a module edge the graph never checks. A side-effect import
  // (`import './x.js'`) was invisible to the first version of this pattern, and the
  // graph stayed green because no module currently uses that form.
  const sample = [
    "import { a } from './one.js'",
    "await import('./two.js')",
    "import './three.js'",
    'export { b } from "./four.js"',
    "import { c } from 'react'",
  ].join('\n')
  const found = [...sample.matchAll(SPECIFIER)].map((match) => match[2])
  assert.deepEqual(found, ['./one.js', './two.js', './three.js', './four.js'])
})

await test('the Host half is split into focused modules', () => {
  const hostModules = modules.filter((rel) => rel !== 'client.js')
  assert.ok(hostModules.length >= 10, `expected a split Host half, found ${hostModules.length} modules`)
  assert.ok(sources.has('index.js'))
})

await test('every module is assigned to a layer, and no layer names a missing module', () => {
  // The check has to be explicit: a module absent from LAYERS compares as
  // `undefined < n`, which is false, so every layering assertion would skip it.
  const unassigned = modules.filter((rel) => !layerOf.has(rel) && !ROOT_ARTIFACTS.includes(rel))
  assert.deepEqual(unassigned, [], `assign these to a layer in LAYERS: ${unassigned.join(', ')}`)
  const stale = [...layerOf.keys()].filter((rel) => !sources.has(rel))
  assert.deepEqual(stale, [], `LAYERS names modules that do not exist: ${stale.join(', ')}`)
  assert.equal(layerOf.size + ROOT_ARTIFACTS.length, modules.length)
})

await test('the lib/ layout is exactly the declared subsystem directories', () => {
  const dirs = new Set(modules.filter((rel) => rel.includes('/')).map((rel) => rel.split('/')[0]))
  assert.deepEqual([...dirs].sort(), SUBSYSTEMS, 'a new subsystem needs its own entry here and in LAYERS')
  const rootFiles = modules.filter((rel) => !rel.includes('/')).sort()
  assert.deepEqual(rootFiles, ['client.js', 'index.js'], 'only the two entry artifacts live at the root of lib/')
})

await test('the graph parser really resolved every relative specifier', () => {
  // An empty graph passes acyclicity, layering and re-export ownership at once, so
  // the parser gets a sentinel of its own: a floor on the edges it must find, and a
  // hard failure on any specifier it could not resolve to a real module.
  assert.deepEqual(unresolved, [], `unresolved relative specifiers: ${unresolved.join(', ')}`)
  assert.ok(
    relativeSpecifiers >= 100,
    `the parser only saw ${relativeSpecifiers} relative specifiers; that is far below this module graph`,
  )
})

/**
 * Size budgets.
 *
 * Every Host module is held to {@link MAX_HOST_LOGIC_LINES}, and that limit has
 * teeth: this plugin has been split twice to honour it (`memory-search`/
 * `memory-migrate`, then the `imports` glue), because a Host module can always
 * become two modules.
 *
 * `client.js` cannot be split the same way. The browser module loader loads ONE
 * artifact per package, a client bundle cannot import a Host module, and its three
 * inline data blocks — the two locale dictionaries and the stylesheet copied from
 * the UI primitives — therefore have to live in that file. They are excluded from
 * the logic count as literal data.
 *
 * The client check is a DRIFT guard, not a compromise budget: it exists so the
 * panel cannot quietly double in size, not so that a panel feature has to be
 * dropped to fit under it. The owner's ruling is that this project should not
 * contort the UI for a self-imposed line count, so the ceiling is set above the
 * current shape rather than the shape being cut to the ceiling. It moved 830 → 870
 * when the injection cap gained an explicit "no limit" state (Qoder's own default),
 * which is a feature, not drift.
 */
const MAX_HOST_LOGIC_LINES = 500
const MAX_CLIENT_LOGIC_LINES = 870
const MAX_INLINE_DATA_LINES = 260

await test('no module is a god file', () => {
  for (const [rel, source] of sources) {
    if (rel === 'client.js') continue
    const lines = source.split('\n').length
    assert.ok(
      lines <= MAX_HOST_LOGIC_LINES,
      `${rel} is ${lines} lines; split it rather than growing past ${MAX_HOST_LOGIC_LINES}`,
    )
  }
})

await test('the client bundle holds its logic to its own budget', () => {
  const source = sources.get('client.js')
  const total = source.split('\n').length
  // Inline data, not logic: the two locale dictionaries and the stylesheet.
  const blocks = [
    ...source.matchAll(/^ {4}var (?:en|zh) = \{[\s\S]*?^ {4}\}$/gm),
    ...source.matchAll(/^ {4}var CSS = \[[\s\S]*?^ {4}\]\.join\('\\n'\)$/gm),
  ]
  const dataLines = blocks.reduce((sum, match) => sum + match[0].split('\n').length, 0)
  const logicLines = total - dataLines
  assert.equal(blocks.length, 3, 'the client bundle must carry the en and zh dictionaries and the stylesheet')
  assert.ok(
    logicLines <= MAX_CLIENT_LOGIC_LINES,
    `client.js has ${logicLines} lines of logic; show less rather than growing past ${MAX_CLIENT_LOGIC_LINES}`,
  )
  assert.ok(
    dataLines <= MAX_INLINE_DATA_LINES,
    `client.js carries ${dataLines} lines of inline locale data; move them to a chunk`,
  )
})

await test('index.js is wiring only', () => {
  const lines = sources.get('index.js').split('\n').length
  assert.ok(lines <= 300, `index.js is ${lines} lines; keep it as wiring (<=300)`)
})

await test('the local import graph is acyclic', () => {
  const visiting = new Set()
  const done = new Set()
  const visit = (name, trail) => {
    if (done.has(name)) return
    assert.ok(!visiting.has(name), `import cycle: ${[...trail, name].join(' -> ')}`)
    visiting.add(name)
    for (const target of graph.get(name) ?? []) visit(target, [...trail, name])
    visiting.delete(name)
    done.add(name)
  }
  for (const name of graph.keys()) visit(name, [])
})

await test('imports only point downward through the layers', () => {
  for (const [name, targets] of graph) {
    for (const target of targets) {
      assert.ok(
        layerOf.get(target) < layerOf.get(name),
        `${name} (layer ${layerOf.get(name)}) must not import ${target} (layer ${layerOf.get(target)})`,
      )
    }
  }
})

await test('index.js is the only module that imports the presentation layers', () => {
  const presentation = [
    'host/service.js', 'host/tools.js', 'host/routes.js', 'host/commands.js', 'host/consumption-seam.js',
  ]
  for (const [name, targets] of graph) {
    if (name === 'index.js') continue
    for (const target of targets) {
      assert.ok(!presentation.includes(target), `${name} must not import ${target}; only index.js wires those`)
    }
  }
})

await test('only index.js re-exports the public surface', () => {
  for (const [rel, source] of sources) {
    if (rel === 'index.js' || rel === 'client.js') continue
    assert.ok(
      !/^export \{[^}]*\} from '\.\.?\//m.test(source),
      `${rel} must not re-export another module's symbols; index.js owns the public surface`,
    )
  }
})

await test('the client half is self-contained (no lib imports)', () => {
  // The client bundle is evaluated by the browser module loader; it may only
  // require React and call the Host's /api routes.
  const client = sources.get('client.js')
  assert.ok(!/from '\.{1,2}\//.test(client), 'client.js must not import Host modules')
  assert.ok(!/require\(['"]\.{1,2}\//.test(client), 'client.js must not require Host modules')
  assert.ok(client.includes('@dsh-external/dsh-memory'), 'the client half registers under the package id')
})

await test('the client route literals match the Host route table', async () => {
  // The browser bundle cannot import ROUTE_PATHS, so a rename on either side
  // would otherwise fail only at runtime in the browser. This links them.
  const { ROUTE_PATHS } = await import('../lib/host/routes.js')
  const client = sources.get('client.js')
  // Capture the WHOLE path token — including upper case and digits, and
  // stopping at any query string. A narrower class would silently truncate
  // `/api/memory/flushAll` to `/api/memory/flush` and miss a rename.
  const clientPaths = new Set([...client.matchAll(/['"](\/api\/memory\/[A-Za-z0-9_-]+)/g)].map((m) => m[1]))
  const serverPaths = new Set(Object.values(ROUTE_PATHS))
  assert.ok(clientPaths.size > 0, 'the client must call at least one /api/memory route')
  assert.deepEqual(
    [...clientPaths].sort(),
    [...serverPaths].sort(),
    'the client and the Host must agree on the exact /api/memory route set',
  )
  for (const path of clientPaths) {
    assert.equal(path, path.toLowerCase(), `${path} must be lowercase`)
  }
})

await test('each module documents its purpose', () => {
  for (const [rel, source] of sources) {
    assert.match(source, /\/\*\*[\s\S]*?@module /, `${rel} needs a module doc comment with @module`)
  }
})

await test('the public surface is exactly what index.js exports', () => {
  const index = sources.get('index.js')
  const exported = new Set()
  for (const match of index.matchAll(/^export (?:async )?function (\w+)|^export const (\w+)/gm)) {
    exported.add(match[1] ?? match[2])
  }
  // Re-exported names come from both `export { A, B }` and `export { ... } from`.
  for (const match of index.matchAll(/^export \{([\s\S]*?)\}/gm)) {
    for (const raw of match[1].split(',')) {
      const name = raw.trim().split(/\s+as\s+/).pop()
      if (name && name.length > 0) exported.add(name)
    }
  }
  for (const required of ['apply', 'Config', 'name']) {
    assert.ok(exported.has(required), `index.js must export ${required}`)
  }
  // The SDK-facing surface the tests and callers rely on.
  for (const required of ['validateMemoryConfig', 'resolveMemoryConfig', 'validateRoots']) {
    assert.ok(exported.has(required), `index.js must re-export ${required}`)
  }
})

await test('no shipped file carries CP936 damage', () => {
  // Editing a text file with `Get-Content`/`Set-Content` on this machine re-encodes it
  // through CP936: em dashes and CJK come back as garbage, and a BOM appears. It has
  // corrupted this repository twice (five source files, then a test file), so the damage
  // gets a test of its own. The markers are built from code points so this file does not
  // contain the very characters it looks for.
  const root2 = join(here, '..')
  const markers = [0x950b, 0x9225, 0x93b8, 0x93c2, 0x9286, 0x951f, 0x95ff, 0x9428].map((code) =>
    String.fromCharCode(code),
  )
  const skip = new Set(['node_modules', '.git'])
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (skip.has(entry.name)) continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full)
        continue
      }
      if (!/\.(js|mjs|json|md|yml|svg)$/.test(entry.name)) continue
      const text = readFileSync(full, 'utf8')
      const where = full.slice(root2.length + 1)
      const hit = markers.find((marker) => text.includes(marker))
      assert.equal(hit, undefined, `${where} carries CP936 damage`)
      assert.notEqual(text.charCodeAt(0), 0xfeff, `${where} starts with a BOM`)
    }
  }
  walk(root2)
})

await test('nothing shipped names an absolute path from one machine', () => {
  // Examples, fixtures and recipes must be something a reader can run anywhere: a
  // concrete home directory (`C:\Users\<name>` or `/home/<name>`) is the marker that one
  // slipped in, and it is exactly the kind of thing that gets pasted back in by accident.
  // Placeholders are fine — `C:\Users\<you>`, `$DSH_HOME`, `~/`, and short fixture names
  // such as `/home/u` or `/home/.dsh` (a single letter or a dot-leading segment is a
  // stand-in, not a person). The search covers the whole checkout except ignored files.
  const here2 = join(here, '..')
  const skip = new Set(['node_modules', '.git'])
  const homePath = /(?:[A-Za-z]:[\\/]{1,2}Users[\\/]{1,2}|\/home\/)([A-Za-z0-9._-]+)/g
  const placeholder = /(?:[\\/])(?:[A-Za-z]|\.[A-Za-z0-9._-]+)$/
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (skip.has(entry.name)) continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full)
        continue
      }
      if (!/\.(js|mjs|json|md|yml|svg|txt)$/.test(entry.name)) continue
      if (entry.name === '_qoder-memory-strings.txt') continue
      const offending = [...readFileSync(full, 'utf8').matchAll(homePath)]
        .map((match) => match[0])
        .filter((hit) => !placeholder.test(hit))
      assert.deepEqual(
        offending,
        [],
        `${full.slice(here2.length + 1)} names a machine-specific home directory: ${offending.join(', ')}`,
      )
    }
  }
  walk(here2)
})

console.log(`\n${passed} architecture tests passed`)
