/**
 * The injection-budget contract, on any filesystem.
 *
 * The integration suites under `test/` are written against a Windows filesystem (`C:\proj`),
 * because that is the deployment this plugin was written for; they cannot run on a POSIX
 * filesystem, where `path.join` produces a different spelling for the same directory. The
 * budget contract is the part of this plugin most easily broken — a cap that stops applying,
 * a "no cap" that does not survive the configuration write-back, a marker string printed
 * where a token count belongs — so it gets a suite of its own that runs everywhere.
 *
 * It drives the REAL routes, the REAL command and the REAL renderer; only the filesystem
 * differs.
 *
 * Run: node test/budget.test.mjs
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The harness home is pinned BEFORE the plugin's modules are imported: the user scope
// resolves into it, and a leaked real home would let a test read somebody's own memory.
const home = await mkdtemp(join(tmpdir(), 'dsh-memory-budget-'))
process.env.DSH_HOME = home

const {
  apply,
  Config,
  CONSUMPTION_DEFAULT_TOKENS,
  CONSUMPTION_UNLIMITED,
} = await import('../lib/index.js')
const { renderMemoryContext, memoryIdentity } = await import('../lib/memory/render.js')
const { estimateMessage } = await import('../lib/core/tokens.js')
const { resolveMemoryConfig } = await import('../lib/config/config.js')
const { validateMemoryConfig } = await import('../lib/config/config-rules.js')
const harness = await import('./support/integration-harness.mjs')

let passed = 0
const test = async (label, fn) => {
  await fn()
  passed += 1
  console.log(`  ok  ${label}`)
}

/** Price a candidate render the way the plugin does. */
const measure = (messages) => messages.reduce((total, message) => total + estimateMessage(message), 0)

console.log('dsh-memory injection-budget tests')

await test('the default budget is 5000 tokens', async () => {
  // A deployment that says nothing about the budget still gets a bounded one, so memory cannot
  // grow until it crowds out the conversation.
  assert.equal(CONSUMPTION_DEFAULT_TOKENS, 5000)
  const validated = Config['~standard'].validate({ mode: 'custom' })
  assert.equal(validated.issues, undefined)
  assert.equal(resolveMemoryConfig(validated.value).consumption.maxTokens, 5000)
})

await test('"unlimited" survives the Loader configuration write-back', async () => {
  // The Loader rewrites an entry's configuration through `Config.simplify`, and schemastery's
  // `simplify` DROPS a key whose value is `null` inside an object. A `null` sentinel would
  // therefore vanish from the persisted profile, and the deployment would silently fall back to
  // the default cap — the exact failure a string marker does not have.
  const validated = Config['~standard'].validate({ mode: 'custom', consumption: { maxTokens: CONSUMPTION_UNLIMITED } })
  assert.equal(validated.issues, undefined)
  assert.equal(validated.value.consumption.maxTokens, 'unlimited')
  const simplified = Config.simplify(validated.value)
  assert.equal(simplified.consumption.maxTokens, 'unlimited', 'the write-back keeps it')
})

await test('the renderer treats "unlimited" as no cap', async () => {
  // A naive comparison would read the marker as a budget of NaN tokens and drop every file.
  const files = [{ id: 'user:MEMORY.md', text: 'x'.repeat(8000) }]
  const bounded = renderMemoryContext(files, 300, measure)
  assert.deepEqual(bounded.truncated, ['user:MEMORY.md'])
  const unbounded = renderMemoryContext(files, CONSUMPTION_UNLIMITED, measure)
  assert.deepEqual(unbounded.included, ['user:MEMORY.md'])
  assert.deepEqual(unbounded.truncated, [])
  assert.deepEqual(unbounded.omitted, [])
  assert.equal(unbounded.overflowed, undefined)
})

await test('the identity distinguishes a cap from no cap', async () => {
  // A changed budget changes the injection, so it must change the identity: otherwise a session
  // that already saw a capped block would keep it after the cap was removed.
  const roots = [{ id: 'user', path: '/u', access: 'read-write', indexFile: 'MEMORY.md' }]
  const base = { mode: 'custom', consumption: { maxTokens: 5000, overflow: 'truncate', files: undefined } }
  const bounded = memoryIdentity(base, roots)
  const unbounded = memoryIdentity({ ...base, consumption: { ...base.consumption, maxTokens: CONSUMPTION_UNLIMITED } }, roots)
  assert.notEqual(bounded, unbounded)
})

await test('a null cap is refused by the rules', async () => {
  // The schema cannot catch it: schemastery's resolver short-circuits a null value BEFORE the
  // union is tried, so `maxTokens: null` passes the schema and arrives at the rules as a value.
  // It has to be refused there — `null` is the shape the panel's wire protocol uses for "clear
  // this field", and the render layer would read it as a budget of zero tokens.
  const validated = Config['~standard'].validate({ mode: 'custom', consumption: { maxTokens: null } })
  assert.equal(validated.issues, undefined, 'the schema short-circuits a null')
  assert.throws(() => validateMemoryConfig(validated.value), /maxTokens/)
})

await test('the budget route writes a number and "unlimited" through configEditor', async () => {
  const fs = harness.makeFs({})
  const { ctx, routes, services } = harness.makeCtx(fs, harness.makeLlm('{}'))
  apply(ctx, harness.loadConfig({ mode: 'custom', generation: { turnComplete: { enabled: false } } }))
  let current = { enabled: true, mode: 'custom', consumption: { maxTokens: 2000, overflow: 'truncate' } }
  services.set('configEditor', {
    entries: () => [{ options: { id: 'memory', name: '@dsh-external/dsh-memory' } }],
    edit: async (entry, change) => { current = change(current, {}) },
  })

  // A form sends a STRING; the route coerces it and reports the coerced value.
  const number = await harness.callRoute(routes, '/api/memory/budget', { method: 'POST', body: { maxTokens: '1500' } })
  assert.equal(number.status, 200)
  assert.equal(number.json.maxTokens, 1500, 'the coerced number is reported, not the string sent')
  assert.equal(current.consumption.maxTokens, 1500)

  const unlimited = await harness.callRoute(routes, '/api/memory/budget', { method: 'POST', body: { maxTokens: CONSUMPTION_UNLIMITED } })
  assert.equal(unlimited.status, 200)
  assert.equal(unlimited.json.maxTokens, CONSUMPTION_UNLIMITED)
  assert.equal(current.consumption.maxTokens, CONSUMPTION_UNLIMITED)

  // The illegal forms stay illegal. `Number('')` is 0 and `Number(true)` is 1: neither may become
  // a silent configuration change.
  for (const bad of ['', '  ', 'abc', '1.5', '1e3', 0, true, {}, []]) {
    const refused = await harness.callRoute(routes, '/api/memory/budget', { method: 'POST', body: { maxTokens: bad } })
    assert.equal(refused.status, 400, `maxTokens=${JSON.stringify(bad)} must be refused`)
  }
})

await test('the /memory-budget command reports, sets, and restores the default', async () => {
  const fs = harness.makeFs({})
  const { ctx, commands, services } = harness.makeCtx(fs, harness.makeLlm('{}'))
  apply(ctx, harness.loadConfig({ mode: 'custom', generation: { turnComplete: { enabled: false } } }))
  let current = { mode: 'custom', consumption: { maxTokens: 2000, overflow: 'truncate' } }
  services.set('configEditor', {
    entries: () => [{ options: { id: 'memory', name: '@dsh-external/dsh-memory' } }],
    edit: async (entry, change) => { current = change(current, {}) },
  })

  // The command reports the EFFECTIVE cap — the resolved configuration, not the draft the
  // configEditor would persist. This deployment configured no cap, so the default applies.
  const status = await harness.runCommand(commands, 'memory-budget')
  assert.match(status.text, /injection cap: 5000 tokens \(the default is 5000\)/)

  const unlimited = await harness.runCommand(commands, 'memory-budget', { rawInput: 'unlimited' })
  assert.equal(unlimited.kind, 'success')
  assert.match(unlimited.text, /no limit/)
  assert.equal(current.consumption.maxTokens, CONSUMPTION_UNLIMITED)

  // "default" REMOVES the key, so the resolver applies the default again — the two ways of
  // saying "not a number" must not be confused with each other.
  const back = await harness.runCommand(commands, 'memory-budget', { rawInput: 'default' })
  assert.equal(back.kind, 'success')
  assert.ok(!('maxTokens' in current.consumption), '"default" removes the key')

  const bogus = await harness.runCommand(commands, 'memory-budget', { rawInput: 'lots' })
  assert.equal(bogus.kind, 'error')
  assert.match(bogus.text, /unlimited/)
  assert.match(bogus.text, /default/)
})

await test('the status payload publishes the default and the marker', async () => {
  // The panel cannot import a Host module, so the floor, the default and the marker all travel
  // on the payload — from the same constants the schema and the route use.
  const fs = harness.makeFs({})
  const { ctx, routes } = harness.makeCtx(fs, harness.makeLlm('{}'))
  apply(ctx, harness.loadConfig({ mode: 'custom', generation: { turnComplete: { enabled: false } } }))
  const { json } = await harness.callRoute(routes, '/api/memory/status')
  assert.equal(json.maxTokens, 5000)
  assert.equal(json.defaultTokens, 5000)
  assert.equal(json.minTokens, 1)
  assert.equal(json.unlimited, CONSUMPTION_UNLIMITED)
})

await rm(home, { recursive: true, force: true })
console.log(`\n${passed} injection-budget tests passed`)
