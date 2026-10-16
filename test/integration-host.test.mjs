/**
 * Integration test — web routes and option rules.
 *
 * Drives the real `apply()` against the Harness doubles in
 * `test/support/integration-harness.mjs`. Split by topic from the single
 * integration suite; each suite is still one standalone process.
 *
 * Run: node test/integration-host.test.mjs
 */
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { apply, Config, LARGE_FILE_CHARS, resolveMemoryConfig } from '../lib/index.js'
import { resolveInstalled } from './support/harness-env.mjs'
import {
  HOME,
  USER_MEMORY,
  makeFs,
  makeLlm,
  makeScriptedLlm,
  makeSession,
  makeAgent,
  makeCommands,
  makeTools,
  runCommand,
  makeCtx,
  callRoute,
  loadConfig,
  runPreStep,
  turnEvents,
  PROJECT_MEMORY,
  TRUST_STORE,
  projectMemoryFixture,
  trustConfig,
  runTool,
  PROJECT_DIR,
  IMPORT,
  waitFor,
  endTurn,
  makeLog,
  SWITCH_STORE,
  switchFixture,
} from './support/integration-harness.mjs'

let passed = 0
const test = async (label, fn) => {
  await fn()
  passed += 1
  console.log(`  ok  ${label}`)
}

console.log('dsh-memory integration tests — web routes and option rules')

await test('the status route reports configuration, scopes, and files', async () => {
  const fs = makeFs({ [USER_MEMORY]: 'knowledge' })
  const { ctx, routes } = makeCtx(fs, makeLlm('{}'))
  apply(
    ctx,
    loadConfig({
      mode: 'custom',
      generation: { turnComplete: { enabled: false } },
    }),
  )
  const { status, json } = await callRoute(routes, '/api/memory/status')
  assert.equal(status, 200)
  assert.equal(json.enabled, true)
  assert.equal(json.mode, 'custom')
  // No cap is configured, and no cap is what the payload says: Qoder's own default is an absent
  // field (`maxTokens ?? Infinity`), so this port must not report a number nobody set.
  assert.equal(json.maxTokens, undefined)
  assert.ok(!('maxTokens' in JSON.parse(JSON.stringify(json))), 'an absent cap must not ride the wire')
  assert.equal(json.gate.kind, 'minPromptChars')
  assert.equal(json.gate.minPromptChars, 40)
  const user = json.roots.find((root) => root.id === 'user')
  assert.ok(user, 'the user scope must be reported')
  assert.deepEqual(user.files, ['MEMORY.md'])
  assert.equal(user.access, 'read-write')
})

await test('the status route reports a custom gate shape', async () => {
  const fs = makeFs({})
  const { ctx, routes } = makeCtx(fs, makeLlm('{}'))
  apply(
    ctx,
    loadConfig({
      mode: 'custom',
      userScope: false,
      generation: {
        turnComplete: { shouldGenerate: async () => ({ run: true }), timeoutMs: 2500, onGateError: 'report_failed' },
      },
    }),
  )
  const { json } = await callRoute(routes, '/api/memory/status')
  assert.equal(json.gate.kind, 'custom')
  assert.equal(json.gate.timeoutMs, 2500)
  assert.equal(json.gate.onGateError, 'report_failed')
})

await test('the file route reads one memory file', async () => {
  const fs = makeFs({ [USER_MEMORY]: 'remember this' })
  const { ctx, routes } = makeCtx(fs, makeLlm('{}'))
  apply(ctx, loadConfig({
      mode: 'custom', generation: { turnComplete: { enabled: false } } }))
  const { status, json } = await callRoute(routes, '/api/memory/file', {
    query: '?scope=user&path=MEMORY.md',
  })
  assert.equal(status, 200)
  assert.equal(json.text, 'remember this')
  assert.equal(json.bytes, 'remember this'.length)
})

await test('the file route writes one memory file and round-trips it', async () => {
  const fs = makeFs({})
  const { ctx, routes } = makeCtx(fs, makeLlm('{}'))
  apply(ctx, loadConfig({
      mode: 'custom', generation: { turnComplete: { enabled: false } } }))
  const written = await callRoute(routes, '/api/memory/file', {
    method: 'POST',
    body: { scope: 'user', path: 'PANEL.md', content: '# from the panel\n' },
  })
  assert.equal(written.status, 200)
  assert.equal(written.json.ok, true)
  assert.equal(written.json.path, 'PANEL.md')
  const read = await callRoute(routes, '/api/memory/file', { query: '?scope=user&path=PANEL.md' })
  assert.equal(read.json.text, '# from the panel\n')
})

await test('the file route rejects traversal, non-md paths, and empty content', async () => {
  const fs = makeFs({})
  const { ctx, routes } = makeCtx(fs, makeLlm('{}'))
  apply(ctx, loadConfig({
      mode: 'custom', generation: { turnComplete: { enabled: false } } }))
  const traversal = await callRoute(routes, '/api/memory/file', {
    method: 'POST',
    body: { scope: 'user', path: '../escape.md', content: 'x' },
  })
  assert.equal(traversal.status, 400)
  const nonMd = await callRoute(routes, '/api/memory/file', {
    method: 'POST',
    body: { scope: 'user', path: 'NOTES.txt', content: 'x' },
  })
  assert.equal(nonMd.status, 400)
  const empty = await callRoute(routes, '/api/memory/file', {
    method: 'POST',
    body: { scope: 'user', path: 'OK.md', content: '   ' },
  })
  assert.equal(empty.status, 400)
  assert.ok(![...fs.files.keys()].some((key) => key.includes('escape') || key.includes('NOTES')))
})

await test('the file route reports a missing file as 404', async () => {
  const fs = makeFs({})
  const { ctx, routes } = makeCtx(fs, makeLlm('{}'))
  apply(ctx, loadConfig({
      mode: 'custom', generation: { turnComplete: { enabled: false } } }))
  const { status } = await callRoute(routes, '/api/memory/file', { query: '?scope=user&path=NOPE.md' })
  assert.equal(status, 404)
})

await test('the refresh and flush routes answer', async () => {
  const fs = makeFs({ [USER_MEMORY]: 'knowledge' })
  const { ctx, routes } = makeCtx(fs, makeLlm('{}'))
  apply(ctx, loadConfig({
      mode: 'custom', generation: { turnComplete: { enabled: false } } }))
  const refresh = await callRoute(routes, '/api/memory/refresh', { method: 'POST' })
  assert.equal(refresh.status, 200)
  const flush = await callRoute(routes, '/api/memory/flush', { method: 'POST' })
  assert.equal(flush.status, 200)
  assert.equal(flush.json.flushed, 0)
})

await test('every route declares methods and a buffered body', async () => {
  const fs = makeFs({})
  const { ctx, routes } = makeCtx(fs, makeLlm('{}'))
  apply(ctx, loadConfig({
      mode: 'custom', generation: { turnComplete: { enabled: false } } }))
  assert.deepEqual([...routes.keys()].sort(), [
    '/api/memory/budget',
    '/api/memory/file',
    '/api/memory/flush',
    '/api/memory/generation',
    '/api/memory/mode',
    '/api/memory/preview',
    '/api/memory/refresh',
    '/api/memory/scope',
    '/api/memory/status',
    '/api/memory/switch',
    '/api/memory/trust',
    '/api/memory/write-budget',
  ])
  for (const route of routes.values()) {
    assert.ok(route.methods.length > 0, 'a route must declare at least one method')
    assert.equal(new Set(route.methods).size, route.methods.length, 'methods must not repeat')
    assert.equal(route.requestBody, 'buffered')
  }
  assert.deepEqual(routes.get('/api/memory/status').methods, ['GET'])
  assert.deepEqual(routes.get('/api/memory/file').methods, ['GET', 'POST', 'DELETE'])
  assert.deepEqual(routes.get('/api/memory/trust').methods, ['POST'])
  // GET is what the composer reads (one session, its mode); POST is the settings list. They
  // are the same PATH because they are the same resource, so the client route set stays one
  // literal per resource.
  assert.deepEqual(routes.get('/api/memory/switch').methods, ['GET', 'POST'])
})

await test('the trust route resolves the SESSION folder with no initiator — a write on the right target', async () => {
  // The third instance of the same root cause, and the one that WRITES. `activeFolder` resolved
  // through `currentInitiator()`, which is `undefined` for every browser request — so `projectFolder`
  // fell back to the host's own cwd (usually the harness home, NOT the user's project) and the trust
  // route's default folder was that same wrong path. Pressing "trust this folder" would then trust the
  // harness home instead of the project, which is a write on the wrong target, not a cosmetic slip.
  //
  // Here the only live session is C:\proj, so the route must act on THAT.
  const fs = makeFs({ [USER_MEMORY]: 'knowledge' })
  const made = makeCtx(fs, makeLlm('{}'))
  apply(made.ctx, loadConfig({
    mode: 'custom',
    trust: { enabled: true },
    generation: { turnComplete: { enabled: false } },
  }))
  const session = makeSession([], 'C:\\proj')
  made.addAgent(makeAgent(session))
  // No initiator: the production condition for a browser request.
  made.setInitiator(undefined)

  const before = await callRoute(made.routes, '/api/memory/status', {})
  assert.deepEqual(before.json.projectFolder, { cwd: 'C:\\proj', source: 'session' }, 'the session answered, not the host')

  // A trust request with no folder in the body acts on the session's folder.
  const allowed = await callRoute(made.routes, '/api/memory/trust', { method: 'POST', body: { action: 'allow' } })
  assert.equal(allowed.status, 200)
  assert.equal(allowed.json.folder, 'C:\\proj', 'trust must not land on the host cwd')
  const store = JSON.parse(fs.files.get(`${HOME}\\trusted-folders.json`))
  assert.deepEqual(store.folders, ['C:\\proj'])
})

await test('the trust route grants and revokes, and rejects a bad action', async () => {
  const fs = makeFs({ [USER_MEMORY]: 'knowledge' })
  const { ctx, routes, setInitiator } = makeCtx(fs, makeLlm('{}'))
  apply(
    ctx,
    loadConfig({
      mode: 'custom',
      trust: { enabled: true },
      generation: { turnComplete: { enabled: false } },
    }),
  )
  // The panel speaks about the SESSION's folder, not the host's: a route has no
  // agent, so it asks the harness for the current initiator.
  setInitiator(makeAgent(makeSession([], 'C:\\proj')))

  const before = await callRoute(routes, '/api/memory/status', {})
  assert.equal(before.json.trust.folder, 'C:\\proj', 'the panel is session-scoped')
  // ...and the payload says WHERE that folder came from: a global settings page has
  // no single obvious project, so an unexplained path reads as a bug.
  assert.deepEqual(before.json.projectFolder, { cwd: 'C:\\proj', source: 'session' })
  assert.equal(before.json.trust.trusted, false)
  assert.equal(before.json.roots.some((root) => root.id.startsWith('--')), false, 'the gate is closed')

  const bad = await callRoute(routes, '/api/memory/trust', { method: 'POST', body: { action: 'maybe' } })
  assert.equal(bad.status, 400)

  // No folder in the body: the route acts on the active session's folder.
  const allowed = await callRoute(routes, '/api/memory/trust', { method: 'POST', body: { action: 'allow' } })
  assert.equal(allowed.status, 200)
  assert.equal(allowed.json.trust.trusted, true)
  assert.equal(allowed.json.folder, 'C:\\proj')
  // The decision is persisted where a trust decision belongs, outside the roots.
  const store = JSON.parse(fs.files.get(`${HOME}\\trusted-folders.json`))
  assert.deepEqual(store.folders, ['C:\\proj'])

  const after = await callRoute(routes, '/api/memory/status', {})
  assert.equal(after.json.trust.trusted, true)
  assert.equal(
    after.json.roots.some((root) => root.id === '--C-proj--'),
    true,
    'the gate opened: the session project is browsable, addressed by its directory name',
  )

  const denied = await callRoute(routes, '/api/memory/trust', { method: 'POST', body: { action: 'deny' } })
  assert.equal(denied.json.trust.trusted, false)
  assert.deepEqual(JSON.parse(fs.files.get(`${HOME}\\trusted-folders.json`)).folders, [])
})

await test('native mode rejects generation/consumption overrides (SDK rule)', () => {
  const fs = makeFs({})
  const { ctx } = makeCtx(fs, makeLlm('{}'))
  // The real SDK: mode "native" only accepts the two onResult callbacks and
  // the scope switches. Any other override is a TypeError.
  assert.throws(
    () => apply(ctx, loadConfig({ mode: 'native', generation: { prompt: 'x' } })),
    /only accepts generation\.onResult and consumption\.onResult/,
  )
  assert.throws(
    () => apply(ctx, loadConfig({ mode: 'native', consumption: { maxTokens: 10 } })),
    /only accepts generation\.onResult and consumption\.onResult/,
  )
})

await test('native mode accepts only the result callbacks', () => {
  const fs = makeFs({})
  const { ctx } = makeCtx(fs, makeLlm('{}'))
  // This must NOT throw: onResult is the one allowed override in native mode.
  apply(ctx, loadConfig({ mode: 'native', generation: { onResult: () => {} }, consumption: { onResult: () => {} } }))
})

await test('generation.enabled:false with turnComplete.enabled:true is rejected', () => {
  const fs = makeFs({})
  const { ctx } = makeCtx(fs, makeLlm('{}'))
  assert.throws(
    () => apply(ctx, loadConfig({ mode: 'custom', generation: { enabled: false, turnComplete: { enabled: true } } })),
    /turnComplete cannot be enabled when generation\.enabled is false/,
  )
})

await test('turnComplete gates only the automatic trigger, not the half', () => {
  const fs = makeFs({})
  const { ctx, services } = makeCtx(fs, makeLlm('{}'))
  apply(ctx, loadConfig({ mode: 'custom', generation: { turnComplete: { enabled: false } } }))
  return services.get('memory').initializationResult().then((init) => {
    // Independent switches, exactly as the SDK reports them.
    assert.equal(init.generationEnabled, true)
    assert.equal(init.turnCompleteEnabled, false)
  })
})

await test('consumption.maxTokens must be a positive integer WHEN IT IS SET', () => {
  // The schema enforces this before apply() ever runs, mirroring the SDK's positive-integer
  // requirement. The SDK's rule is conditional: an ABSENT field is legal and means no limit.
  assert.throws(() => loadConfig({ mode: 'custom', consumption: { maxTokens: 1.5 } }), /maxTokens/)
  assert.throws(() => loadConfig({ mode: 'custom', consumption: { maxTokens: 0 } }), /maxTokens/)
  // Absent and explicit are both accepted — and an absent one resolves to "no cap".
  assert.doesNotThrow(() => loadConfig({ mode: 'custom' }))
  assert.equal(resolveMemoryConfig(Config({ mode: 'custom' })).consumption.maxTokens, undefined)
  assert.equal(resolveMemoryConfig(Config({ mode: 'custom', consumption: { maxTokens: 42 } })).consumption.maxTokens, 42)
})

await test('turnComplete.timeoutMs must be a positive finite number', () => {
  // Enforced by the schema (positive integer) before apply() runs.
  assert.throws(() => loadConfig({ mode: 'custom', generation: { turnComplete: { timeoutMs: -1 } } }), /timeoutMs/)
  assert.throws(() => loadConfig({ mode: 'custom', generation: { turnComplete: { timeoutMs: 0 } } }), /timeoutMs/)
  // A non-finite value is rejected by the cross-field rule in apply().
  const fs = makeFs({})
  const { ctx } = makeCtx(fs, makeLlm('{}'))
  assert.throws(
    () => apply(ctx, { mode: 'custom', generation: { turnComplete: { timeoutMs: Number.POSITIVE_INFINITY } } }),
    /timeoutMs must be a positive finite number/,
  )
})

await test('an invalid root list is rejected before any work starts', () => {
  const fs = makeFs({})
  const { ctx } = makeCtx(fs, makeLlm('{}'))
  assert.throws(
    () => apply(ctx, loadConfig({ mode: 'custom', generation: { roots: [{ id: 'a', path: '/a' }, { id: 'a', path: '/b' }] } })),
    /duplicate id "a"/,
  )
  assert.throws(
    () => apply(ctx, loadConfig({ mode: 'custom', generation: { roots: [{ id: 'a', path: '/a', indexFile: '../x.md' }] } })),
    /indexFile must stay within its root/,
  )
})

await test('generation results carry attemptId, origin, and change flags', async () => {
  const fs = makeFs({})
  const plan = JSON.stringify({ writes: [{ rootId: 'project', path: 'MEMORY.md', content: 'note' }] })
  const { ctx, listeners, services } = makeCtx(fs, makeLlm(plan))
  let reported
  apply(
    ctx,
    loadConfig({
      mode: 'custom',
      userScope: false,
      generation: { turnComplete: { minPromptChars: 1 }, onResult: (r) => (reported = r) },
    }),
  )
  const session = makeSession(turnEvents('a long enough prompt for the gate', 'ok'), 'C:\\proj')
  const agent = makeAgent(session)
  listeners.get('agent/created')[0]({ agent })
  listeners.get('session/event')[0](session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  await services.get('memory').flushMemory()

  assert.equal(reported.status, 'saved')
  assert.equal(typeof reported.attemptId, 'string')
  assert.equal(reported.origin, 'turn_complete')
  // MEMORY.md is the project root's declared index file.
  assert.equal(reported.indexUpdated, true)
  assert.equal(reported.contentUpdated, false)
})

await test('an async onResult rejection does not fail the pass', async () => {
  const fs = makeFs({})
  const plan = JSON.stringify({ writes: [{ rootId: 'project', path: 'MEMORY.md', content: 'note' }] })
  const { ctx, listeners, services } = makeCtx(fs, makeLlm(plan))
  apply(
    ctx,
    loadConfig({
      mode: 'custom',
      userScope: false,
      generation: {
        turnComplete: { minPromptChars: 1 },
        onResult: async () => {
          throw new Error('consumer exploded')
        },
      },
    }),
  )
  const session = makeSession(turnEvents('a long enough prompt for the gate', 'ok'), 'C:\\proj')
  const agent = makeAgent(session)
  listeners.get('agent/created')[0]({ agent })
  listeners.get('session/event')[0](session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  // The rejection is contained: the write still lands and flush still settles.
  const flushed = await services.get('memory').flushMemory()
  assert.equal(flushed.flushed, 1)
  assert.ok([...fs.files.keys()].some((key) => key.endsWith('MEMORY.md')))
})

await test('consumption result files carry the SDK shape', async () => {
  const fs = makeFs({ [USER_MEMORY]: 'knowledge' })
  const { ctx, listeners } = makeCtx(fs, makeLlm('{}'))
  let reported
  apply(
    ctx,
    loadConfig({ mode: 'custom', generation: { turnComplete: { enabled: false } }, consumption: { onResult: (r) => (reported = r) } }),
  )
  const session = makeSession([], 'C:\\proj')
  await runPreStep(listeners, makeAgent(session))
  assert.ok(reported)
  for (const file of reported.files) {
    assert.deepEqual(Object.keys(file).sort().filter((key) => key !== 'error'), ['id', 'path', 'status'])
    assert.ok(['loaded', 'missing', 'failed', 'truncated'].includes(file.status))
  }
  assert.ok(['success', 'partial', 'failed'].includes(reported.status))
})
console.log(`\n${passed} integration host tests passed`)
