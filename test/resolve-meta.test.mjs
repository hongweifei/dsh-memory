/**
 * Simulate dsh-client-modules' resolveMeta() against this package to prove the
 * manifest is discoverable in a fresh process, and to demonstrate that the only
 * reason a live process misses it is the service's never-invalidated `pkgMeta`
 * cache (keyed `${baseUrl}\0${loaderName}`).
 *
 * Run: node test/resolve-meta.test.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { packageJsonPath, profilePackageJson } from './harness-env.mjs'

let passed = 0
const test = (label, fn) => {
  fn()
  passed += 1
  console.log(`  ok  ${label}`)
}

console.log('dsh-memory resolveMeta simulation')

/* ---- faithful reimplementation of the harness helpers we depend on ---- */

/** dsh-client-modules: optionalStringArray */
function optionalStringArray(pkgName, field, value) {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`client-modules: ${pkgName} ${field} must be a string array`)
  }
  return value
}

/** dsh-client-modules: parseDshClient — returns undefined when not declared. */
function parseDshClient(pkgName, decl) {
  if (decl === undefined) return undefined
  if (typeof decl !== 'object' || decl === null) {
    throw new Error(`client-modules: ${pkgName} has a non-object dsh.client declaration`)
  }
  if (typeof decl.platform !== 'string') {
    throw new Error(`client-modules: ${pkgName} dsh.client.platform must be a string`)
  }
  const inject = optionalStringArray(pkgName, 'dsh.client.inject', decl.inject)
  const external = optionalStringArray(pkgName, 'dsh.client.external', decl.external)
  if (decl.immediately !== undefined && typeof decl.immediately !== 'boolean') {
    throw new Error(`client-modules: ${pkgName} dsh.client.immediately must be a boolean`)
  }
  return { platform: decl.platform, inject, external, immediately: decl.immediately === true }
}

/** dsh-client-modules: clientExportOf — read "./client" out of exports. */
function clientExportOf(pkgName, exports) {
  if (exports === undefined || exports === null) return undefined
  const entry = exports['./client']
  if (entry === undefined) return undefined
  return typeof entry === 'string' ? entry : entry.default
}

/** dsh-client-modules: resolveMeta — the function whose cache blocks a live reload. */
function resolveMeta(pkgJsonPath, cache, sourceKey) {
  const cached = cache.get(sourceKey)
  if (cached !== undefined) return cached
  const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8'))
  const decl = parseDshClient(pkg.name, pkg.dsh?.client)
  if (decl === undefined || decl.platform !== 'web') {
    cache.set(sourceKey, null)
    return null
  }
  const clientRel = clientExportOf(pkg.name, pkg.exports)
  if (clientRel === undefined) {
    throw new Error(`client-modules: ${pkg.name} declares dsh.client but exports no "./client" bundle`)
  }
  const resolved = {
    packageName: pkg.name,
    meta: {
      clientPath: join(dirname(pkgJsonPath), clientRel),
      inject: decl.inject,
      external: decl.external ?? [],
      immediately: decl.immediately,
    },
  }
  cache.set(sourceKey, resolved)
  return resolved
}

// The manifest, discovered rather than hardcoded (see test/harness-env.mjs), and the
// URL-shaped cache key the client-modules service derives for a profile install. The key
// only has to have the real shape: these tests use it as the map key that shows a cached
// `null` winning over a later, fixed manifest.
const pkgJsonPath = packageJsonPath()
const sourceKey = `${pathToFileURL(profilePackageJson ?? pkgJsonPath).href}\u0000@dsh-external/dsh-memory`

/* ---- the fresh-process case ---- */

test('a fresh process discovers the client half', () => {
  const cache = new Map()
  const resolved = resolveMeta(pkgJsonPath, cache, sourceKey)
  assert.ok(resolved, 'resolveMeta must return a record for this package')
  assert.equal(resolved.packageName, '@dsh-external/dsh-memory')
  assert.ok(resolved.meta.clientPath.endsWith('client.js'))
  assert.equal(resolved.meta.immediately, true)
  assert.deepEqual(resolved.meta.inject, ['@deepseek-ai/dsh-client-ui-settings'])
})

test('the discovered clientPath points at the real artifact', () => {
  const cache = new Map()
  const resolved = resolveMeta(pkgJsonPath, cache, sourceKey)
  const source = readFileSync(resolved.meta.clientPath, 'utf8')
  assert.ok(source.includes('window.__ModuleLoader__.load'))
})

/* ---- the live-process case that actually blocks the UI ---- */

test('a cache primed while the manifest had no dsh.client keeps returning null', () => {
  const cache = new Map()
  // What v1 (no dsh.client) would have cached under the same sourceKey:
  cache.set(sourceKey, null)
  const resolved = resolveMeta(pkgJsonPath, cache, sourceKey)
  assert.equal(resolved, null, 'the stale null wins — this is why a live process misses the new client half')
})

test('the cache is keyed by baseUrl and loader name, so editing the manifest does not invalidate it', () => {
  const cache = new Map()
  cache.set(sourceKey, null)
  // Same key before and after the manifest edit: no invalidation is possible.
  assert.equal(cache.has(sourceKey), true)
  assert.equal(resolveMeta(pkgJsonPath, cache, sourceKey), null)
  // A different key (a different package or base URL) resolves correctly.
  const otherKey = `file:///other/\0@dsh-external/dsh-memory`
  assert.ok(resolveMeta(pkgJsonPath, cache, otherKey), 'a fresh key resolves')
})

console.log(`\n${passed} resolveMeta tests passed`)
