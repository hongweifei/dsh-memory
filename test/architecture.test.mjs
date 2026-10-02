/**
 * Module-boundary tests.
 *
 * The plugin is one bundle with a Host half split into focused modules. These
 * tests enforce the shape so it cannot silently decay back into one large file:
 * a layered import graph with no cycles, `index.js` as the only aggregator, and
 * no module reaching outside its layer.
 *
 * Run: node test/architecture.test.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const libDir = join(here, '..', 'lib')

let passed = 0
const test = (label, fn) => {
  fn()
  passed += 1
  console.log(`  ok  ${label}`)
}

console.log('dsh-memory architecture tests')

/** Every module's source, keyed by file name. */
const sources = new Map()
for (const name of readdirSync(libDir).filter((name) => name.endsWith('.js'))) {
  sources.set(name, readFileSync(join(libDir, name), 'utf8'))
}

/** Local import edges: `{ from: Set<to> }`. */
const graph = new Map()
for (const [name, source] of sources) {
  const targets = new Set()
  for (const match of source.matchAll(/from '\.\/([a-z-]+)\.js'/g)) targets.add(`${match[1]}.js`)
  graph.set(name, targets)
}

/** The layering this plugin intends, lowest first. */
const LAYERS = [
  ['constants.js'],
  ['config.js', 'tokens.js', 'fs.js', 'paths.js', 'memory-file.js'],
  ['render.js', 'memory-pass.js', 'memory-prompt.js', 'memory-search.js', 'imports.js', 'excludes.js', 'trust.js', 'jit.js', 'transcript.js', 'failure-pause.js'],
  ['memory-agent.js', 'consumption-plan.js'],
  ['consumption.js', 'generation.js', 'dream.js'],
  ['service.js', 'tools.js', 'routes.js', 'commands.js'],
  ['index.js'],
]
const layerOf = new Map()
LAYERS.forEach((layer, index) => layer.forEach((name) => layerOf.set(name, index)))

test('the Host half is split into focused modules', () => {
  const hostModules = [...sources.keys()].filter((name) => name !== 'client.js')
  assert.ok(hostModules.length >= 10, `expected a split Host half, found ${hostModules.length} modules`)
  assert.ok(sources.has('index.js'))
})

/**
 * Size budgets.
 *
 * Every Host module is held to {@link MAX_HOST_LOGIC_LINES}, and that limit has
 * teeth: this plugin has been split twice to honour it (`memory-search`/
 * `memory-migrate`, then the `imports` glue), because a Host module can always
 * become two modules.
 *
 * `client.js` cannot. The browser module loader loads ONE artifact per package,
 * a client bundle cannot import a Host module, and its three inline data blocks —
 * the two locale dictionaries and the stylesheet copied from the UI primitives —
 * therefore have to live in that file. They are excluded from the logic count as
 * literal data. What remains is the panel's own render tree, and its cost is
 * inherent: every labelled row is a line, and extracting a component
 * (`ScopeCard`, `act`) improves the STRUCTURE without reducing the line count.
 * So its limit is higher by decision, not by drift — and it is still a limit: a
 * future panel feature that needs more room should make the panel show less (a
 * collapsed section) rather than earn another bump.
 */
const MAX_HOST_LOGIC_LINES = 500
const MAX_CLIENT_LOGIC_LINES = 560
const MAX_INLINE_DATA_LINES = 220

test('no module is a god file', () => {
  for (const [name, source] of sources) {
    if (name === 'client.js') continue
    const lines = source.split('\n').length
    assert.ok(
      lines <= MAX_HOST_LOGIC_LINES,
      `${name} is ${lines} lines; split it rather than growing past ${MAX_HOST_LOGIC_LINES}`,
    )
  }
})

test('the client bundle holds its logic to its own budget', () => {
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

test('index.js is wiring only', () => {
  const lines = sources.get('index.js').split('\n').length
  assert.ok(lines <= 300, `index.js is ${lines} lines; keep it as wiring (<=300)`)
})

test('the local import graph is acyclic', () => {
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

test('imports only point downward through the layers', () => {
  for (const [name, targets] of graph) {
    for (const target of targets) {
      assert.ok(
        layerOf.get(target) < layerOf.get(name),
        `${name} (layer ${layerOf.get(name)}) must not import ${target} (layer ${layerOf.get(target)})`,
      )
    }
  }
})

test('index.js is the only module that imports the presentation layers', () => {
  const presentation = ['service.js', 'tools.js', 'routes.js', 'commands.js']
  for (const [name, targets] of graph) {
    if (name === 'index.js') continue
    for (const target of targets) {
      assert.ok(!presentation.includes(target), `${name} must not import ${target}; only index.js wires those`)
    }
  }
})

test('only index.js re-exports the public surface', () => {
  for (const [name, source] of sources) {
    if (name === 'index.js' || name === 'client.js') continue
    assert.ok(
      !/^export \{[^}]*\} from '\.\//m.test(source),
      `${name} must not re-export another module's symbols; index.js owns the public surface`,
    )
  }
})

test('the client half is self-contained (no lib imports)', () => {
  // The client bundle is evaluated by the browser module loader; it may only
  // require React and call the Host's /api routes.
  const client = sources.get('client.js')
  assert.ok(!/from '\.\//.test(client), 'client.js must not import Host modules')
  assert.ok(!/require\(['"]\.\//.test(client), 'client.js must not require Host modules')
  assert.ok(client.includes('@dsh-external/dsh-memory'), 'the client half registers under the package id')
})

test('the client route literals match the Host route table', async () => {
  // The browser bundle cannot import ROUTE_PATHS, so a rename on either side
  // would otherwise fail only at runtime in the browser. This links them.
  const { ROUTE_PATHS } = await import('../lib/routes.js')
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

test('each module documents its purpose', () => {
  for (const [name, source] of sources) {
    assert.match(source, /\/\*\*[\s\S]*?@module /, `${name} needs a module doc comment with @module`)
  }
})

test('the public surface is exactly what index.js exports', () => {
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

test('no shipped file carries CP936 damage', () => {
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

test('nothing shipped names an absolute path from one machine', () => {
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
