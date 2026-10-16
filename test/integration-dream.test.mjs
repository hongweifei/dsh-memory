/**
 * Integration test — consolidation (dream).
 *
 * Drives the real `apply()` against the Harness doubles in
 * `test/support/integration-harness.mjs`. Split by topic from the single
 * integration suite; each suite is still one standalone process.
 *
 * Run: node test/integration-dream.test.mjs
 */
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { apply, Config, LARGE_FILE_CHARS } from '../lib/index.js'
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

console.log('dsh-memory integration tests — consolidation (dream)')

await test('a due dream runs with origin dream and records its result', async () => {
  const fs = makeFs({ [USER_MEMORY]: '# Index\n\n- [A](a.md) - hook' })
  const plan = JSON.stringify({
    writes: [{ rootId: 'user', path: 'MEMORY.md', content: '# Index\n\n- [A](a.md) - merged hook' }],
    reason: 'merged duplicates',
  })
  const { ctx, listeners, services } = makeCtx(fs, makeLlm(plan))
  apply(
    ctx,
    loadConfig({
      mode: 'custom',
      projectScope: false,
      generation: { turnComplete: { minPromptChars: 1 }, dream: { enabled: true, minHours: 0 } },
    }),
  )
  const session = makeSession(turnEvents('a long enough prompt for the gate', 'ok'), 'C:\\proj')
  const agent = makeAgent(session)
  listeners.get('agent/created')[0]({ agent })
  listeners.get('session/event')[0](session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  await services.get('memory').flushMemory()

  const dream = services.get('memory').status().lastDream
  assert.ok(dream, 'the dream pass must have run')
  assert.equal(dream.origin, 'dream')
  assert.equal(dream.status, 'saved')
  assert.match(dream.reason, /merged duplicates/)
  // The run timestamp is persisted outside the memory roots.
  const saved = [...fs.files.keys()].find((key) => key.endsWith('dream-state.json'))
  assert.ok(saved, 'the scheduler must persist its last-run time')
  // And the cross-process lock records this claim, Qoder's `.consolidate-lock`.
  const lock = fs.files.get(`${HOME}\\.consolidate-lock`)
  assert.ok(lock, 'the scheduler must claim the consolidation lock')
  assert.equal(JSON.parse(lock).pid, process.pid)
})

await test('a stale consolidation lock is reclaimed, not just ignored', async () => {
  const fs = makeFs({
    [USER_MEMORY]: '# Index',
    [`${HOME}\\.consolidate-lock`]: JSON.stringify({ pid: 999999, startedAt: Date.now() }),
  })
  const { ctx, listeners, services } = makeCtx(fs, makeLlm('{"writes":[],"reason":"nothing durable"}'))
  apply(
    ctx,
    loadConfig({
      mode: 'custom',
      projectScope: false,
      generation: { turnComplete: { minPromptChars: 1 }, dream: { enabled: true, minHours: 0 } },
    }),
  )
  const session = makeSession(turnEvents('a long enough prompt for the gate', 'ok'), 'C:\\proj')
  const agent = makeAgent(session)
  listeners.get('agent/created')[0]({ agent })
  listeners.get('session/event')[0](session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  await services.get('memory').flushMemory()

  assert.ok(services.get('memory').status().lastDream, 'a dead-PID lock does not block the pass')
  // Qoder deletes it ("reclaimed lock from exited PID … before time gate") and then
  // replaces it with its own claim; either way the dead PID is gone.
  const lock = JSON.parse(fs.files.get(`${HOME}\\.consolidate-lock`))
  assert.equal(lock.pid, process.pid, 'the stale claim was replaced by this run')
})

await test('a consolidation lock held by a live process blocks the dream', async () => {
  const fs = makeFs({
    [USER_MEMORY]: '# Index',
    [`${HOME}\\.consolidate-lock`]: JSON.stringify({ pid: process.pid, startedAt: Date.now() }),
  })
  const { ctx, listeners, services } = makeCtx(fs, makeLlm('{"writes":[],"reason":"nothing durable"}'))
  apply(
    ctx,
    loadConfig({
      mode: 'custom',
      projectScope: false,
      generation: { turnComplete: { minPromptChars: 1 }, dream: { enabled: true, minHours: 0 } },
    }),
  )
  const session = makeSession(turnEvents('a long enough prompt for the gate', 'ok'), 'C:\\proj')
  const agent = makeAgent(session)
  listeners.get('agent/created')[0]({ agent })
  listeners.get('session/event')[0](session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  await services.get('memory').flushMemory()
  assert.equal(services.get('memory').status().lastDream, null, 'a live lock must block the pass')
})

await test('a dream inside its interval does not run again', async () => {
  const now = Date.now()
  const fs = makeFs({
    [USER_MEMORY]: '# Index',
    [`${HOME}\\dream-state.json`]: JSON.stringify({ [`${HOME}\\memory`]: now }),
  })
  const { ctx, listeners, services } = makeCtx(fs, makeLlm('{"writes":[]}'))
  apply(
    ctx,
    loadConfig({
      mode: 'custom',
      projectScope: false,
      generation: { turnComplete: { minPromptChars: 1 }, dream: { enabled: true, minHours: 24 } },
    }),
  )
  const session = makeSession(turnEvents('a long enough prompt for the gate', 'ok'), 'C:\\proj')
  const agent = makeAgent(session)
  listeners.get('agent/created')[0]({ agent })
  listeners.get('session/event')[0](session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  await services.get('memory').flushMemory()
  assert.equal(services.get('memory').status().lastDream, null, 'a fresh consolidation must block the next one')
})

await test('dream stays off unless it is enabled', async () => {
  const fs = makeFs({ [USER_MEMORY]: '# Index' })
  const { ctx, listeners, services } = makeCtx(fs, makeLlm('{"writes":[]}'))
  apply(ctx, loadConfig({ mode: 'custom', userScope: true, generation: { turnComplete: { minPromptChars: 1 } } }))
  const session = makeSession(turnEvents('a long enough prompt for the gate', 'ok'), 'C:\\proj')
  const agent = makeAgent(session)
  listeners.get('agent/created')[0]({ agent })
  listeners.get('session/event')[0](session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  await services.get('memory').flushMemory()
  assert.equal(services.get('memory').status().lastDream, null, 'dream is opt-in')
})

await test('model writes may target a typed content file, not only the index', async () => {
  const fs = makeFs({})
  const body = '---\nname: Build commands\ndescription: How to build\ntype: project\n---\n\nUse pnpm.'
  const plan = JSON.stringify({
    writes: [
      { rootId: 'user', path: 'MEMORY.md', content: '# Index\n\n- [Build](build.md) - commands' },
      { rootId: 'user', path: 'build.md', content: body },
    ],
    reason: 'recorded build commands',
  })
  const { ctx, listeners, services } = makeCtx(fs, makeLlm(plan))
  apply(
    ctx,
    loadConfig({
      mode: 'custom',
      projectScope: false,
      generation: { turnComplete: { minPromptChars: 1 } },
    }),
  )
  const session = makeSession(turnEvents('a long enough prompt for the gate', 'ok'), 'C:\\proj')
  const agent = makeAgent(session)
  listeners.get('agent/created')[0]({ agent })
  listeners.get('session/event')[0](session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  await services.get('memory').flushMemory()

  const result = services.get('memory').status().lastGeneration
  assert.equal(result.status, 'saved')
  assert.deepEqual(
    result.writtenFiles.map((file) => file.path).sort(),
    ['MEMORY.md', 'build.md'],
  )
  assert.equal(result.indexUpdated, true, 'the index changed')
  assert.equal(result.contentUpdated, true, 'a content file changed')
  assert.match(fs.files.get(`${HOME}\\memory\\build.md`), /type: project/)
})

await test('status reports the latest generation and consumption', async () => {
  const fs = makeFs({ [USER_MEMORY]: 'some knowledge' })
  const plan = JSON.stringify({ writes: [{ rootId: 'project', path: 'MEMORY.md', content: 'new' }] })
  const { ctx, listeners, services } = makeCtx(fs, makeLlm(plan))
  apply(
    ctx,
    loadConfig({
      mode: 'custom', generation: { turnComplete: { minPromptChars: 1 } } }),
  )
  const session = makeSession(turnEvents('a long enough prompt for the gate', 'ok'), 'C:\\proj')
  const agent = makeAgent(session)
  await runPreStep(listeners, agent)
  listeners.get('agent/created')[0]({ agent })
  listeners.get('session/event')[0](session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  await services.get('memory').flushMemory()
  const status = services.get('memory').status()
  assert.equal(status.enabled, true)
  assert.equal(status.lastGeneration.status, 'saved')
  assert.equal(status.lastConsumption.status, 'success')
})

await test('a disabled plugin still provides an answerable service', async () => {
  const fs = makeFs({})
  const { ctx, services } = makeCtx(fs, makeLlm('{}'))
  apply(ctx, loadConfig({ enabled: false }))
  const service = services.get('memory')
  assert.ok(service, 'the service must exist even when disabled')
  assert.equal(await service.initializationResult(), undefined)
  assert.deepEqual(await service.flushMemory(), { flushed: 0 })
  assert.equal(service.status().enabled, false)
})
console.log(`\n${passed} integration dream tests passed`)
