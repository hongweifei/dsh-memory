/**
 * Package-shape tests: one bundle, two halves.
 *
 * A DSH bundle is a single package whose manifest declares BOTH the Host half
 * (`dsh.bundle.patch` → a Loader row) and the Client half (`dsh.client` +
 * `exports["./client"]`). This is the shape the shipped `decoration` template
 * and `@dsh-external/dsh-chat-content-visibility-auto` use.
 *
 * The tests also reproduce `dsh-client-modules`' discovery so a fresh process
 * is proven to find the client half.
 *
 * Run: node test/discovery.test.mjs
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { packageJsonPath, profilePackageJson, resolveInstalled } from './harness-env.mjs'

let passed = 0
let skipped = 0
const test = (label, fn) => {
  fn()
  passed += 1
  console.log(`  ok  ${label}`)
}

/** Run a test only when its precondition holds; say so when it does not. */
const testIf = (condition, label, fn) => {
  if (condition) {
    test(label, fn)
    return
  }
  skipped += 1
  console.log(`  --  ${label} (skipped: this plugin is not installed in a profile here)`)
}

console.log('dsh-memory package-shape tests')

// Discovered, never hardcoded: through the profile when this runs inside a harness
// session, else straight from the checkout. See test/harness-env.mjs.
const pkgJsonPath = packageJsonPath()
const installed = resolveInstalled('@dsh-external/dsh-memory/package.json') !== undefined
const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8'))

test('the package resolves from the profile the way the Loader resolves it', () => {
  assert.ok(pkgJsonPath.endsWith('package.json'))
  assert.equal(pkg.name, '@dsh-external/dsh-memory')
})

test('ONE package carries both halves (host bundle + client)', () => {
  assert.ok(pkg.dsh, 'the manifest must have a dsh block')
  // Host half: a Loader patch that mounts the plugin.
  assert.ok(pkg.dsh.bundle, 'the manifest must declare dsh.bundle')
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml')
  // Client half: the web module table entry.
  assert.ok(pkg.dsh.client, 'the manifest must declare dsh.client')
  assert.equal(pkg.dsh.client.platform, 'web')
  assert.equal(pkg.dsh.client.immediately, true)
  assert.deepEqual(pkg.dsh.client.inject, ['@deepseek-ai/dsh-client-ui-settings'])
})

test('the manifest exports both halves', () => {
  assert.ok(pkg.exports, 'the manifest must declare exports')
  assert.equal(pkg.exports['.'], './lib/index.js', 'the Host half is the package root')
  assert.equal(pkg.exports['./client'], './lib/client.js', 'the Client half is ./client')
})

test('both half artifacts exist and are non-empty', () => {
  const host = readFileSync(join(dirname(pkgJsonPath), pkg.exports['.']), 'utf8')
  const client = readFileSync(join(dirname(pkgJsonPath), pkg.exports['./client']), 'utf8')
  assert.ok(host.includes('export function apply'), 'the host half must export apply()')
  assert.ok(client.length > 0, 'the client artifact must not be empty')
  assert.match(client, /window\.__ModuleLoader__\.load\(/)
})

test('the client artifact registers exactly the package id (module table key)', () => {
  const source = readFileSync(join(dirname(pkgJsonPath), pkg.exports['./client']), 'utf8')
  // Only the loader registration counts; the panel's own data also uses `id:`.
  const loaderCall = source.match(/window\.__ModuleLoader__\.load\(\{([\s\S]*?)\n\s*factory/)
  assert.ok(loaderCall, 'the loader registration must be present')
  const ids = [...loaderCall[1].matchAll(/id:\s*'([^']+)'/g)].map((match) => match[1])
  assert.deepEqual(ids, ['@dsh-external/dsh-memory'])
  assert.equal(ids[0], pkg.name, 'the registered id must equal the package name')
})

testIf(installed, 'the declared inject target is a real installed package', () => {
  // A missing inject target would leave the client half waiting forever.
  const target = pkg.dsh.client.inject[0]
  const resolved = resolveInstalled(`${target}/package.json`)
  assert.ok(resolved, `inject target ${target} must resolve`)
})

test('the bundle patch mounts exactly one row for the package', () => {
  const patch = readFileSync(join(dirname(pkgJsonPath), pkg.dsh.bundle.patch), 'utf8')
  assert.match(patch, /- insert:/)
  assert.match(patch, /name: '@dsh-external\/dsh-memory'/)
  assert.match(patch, /id: memory/)
})

testIf(installed && profilePackageJson !== undefined, 'the profile enables exactly this one bundle for the feature', () => {
  const profile = JSON.parse(readFileSync(profilePackageJson, 'utf8'))
  const bundles = profile.dsh?.profile?.bundles ?? []
  const memoryBundles = bundles.filter((name) => String(name).includes('dsh-memory'))
  assert.deepEqual(memoryBundles, ['@dsh-external/dsh-memory'], 'the feature must be ONE bundle, not several')
})

test('the plugin-manager display metadata agrees with the locale files', () => {
  // The card title/description can come from `meta` or from `locale/<lang>.json`.
  // Both are present, so they must not drift apart.
  assert.ok(pkg.meta, 'the manifest must declare meta')
  const dir = dirname(pkgJsonPath)
  for (const lang of ['en', 'zh']) {
    const locale = JSON.parse(readFileSync(join(dir, 'locale', `${lang}.json`), 'utf8'))
    assert.equal(typeof locale.title, 'string', `locale/${lang}.json needs a title`)
    assert.equal(typeof locale.description, 'string', `locale/${lang}.json needs a description`)
    assert.ok(locale.title.length > 0 && locale.description.length > 0)
  }
  const en = JSON.parse(readFileSync(join(dir, 'locale', 'en.json'), 'utf8'))
  assert.equal(pkg.meta.title, en.title, 'meta.title and locale/en.json title must agree')
  assert.equal(pkg.meta.description, en.description, 'meta.description and locale/en.json must agree')
  // A localized description must actually differ from English.
  const zh = JSON.parse(readFileSync(join(dir, 'locale', 'zh.json'), 'utf8'))
  assert.notEqual(zh.description, en.description, 'the Chinese description must be translated')
})

test('the manifest declares everything a release ships', () => {
  // Frozen by explicit instruction: the working version is 0.1.0 and it does not
  // move until the user asks for an upgrade. Continuous parity work accumulates
  // under CHANGELOG "Unreleased" and does NOT become a release on its own.
  // An upgrade is a deliberate act and touches four places together: this
  // assertion, package.json, CHANGELOG (a new release section) and README.
  assert.equal(pkg.version, '0.1.0', 'the version is frozen at 0.1.0 until the user asks to upgrade')
  assert.equal(pkg.private, true)
  assert.equal(pkg.icon, './icon.svg')
  assert.ok(pkg.exports['./package.json'], 'the manifest must export its own package.json')
  assert.ok(pkg.exports['./locale/*.json'], 'the manifest must export its locale files')
  for (const entry of ['README.md', 'CHANGELOG.md', 'docs', 'icon.svg', 'locale', 'lib', 'cordis.patch.yml']) {
    assert.ok(pkg.files.includes(entry), `files[] must ship ${entry}`)
    assert.ok(existsSync(join(dirname(pkgJsonPath), entry)), `files[] lists ${entry} but it does not exist`)
  }
  // TODO.md is the live working plan: kept local, not packaged and not committed
  // (the same intent `.gitignore` records). Shipping a file the repository does not
  // contain would be a build that cannot be reproduced from a clone.
  assert.ok(!pkg.files.includes('TODO.md'), 'TODO.md is a local working document, not a shipped one')
  assert.ok(existsSync(join(dirname(pkgJsonPath), 'TODO.md')), 'it still lives in the working tree')
})

console.log(`\n${passed} package-shape tests passed${skipped > 0 ? `, ${skipped} skipped` : ''}`)
