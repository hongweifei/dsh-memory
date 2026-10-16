/**
 * Integration test — the runtime service.
 *
 * Drives the real `apply()` against the Harness doubles in
 * `test/support/integration-harness.mjs`. Split by topic from the single
 * integration suite; each suite is still one standalone process.
 *
 * Run: node test/integration-service.test.mjs
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

console.log('dsh-memory integration tests — the runtime service')

await test('initializationResult reads back the effective configuration', async () => {
  const fs = makeFs({})
  const { ctx, services } = makeCtx(fs, makeLlm('{}'))
  apply(
    ctx,
    loadConfig({
      mode: 'custom',
      userScope: false,
      projectScope: false,
      generation: {
        turnComplete: { enabled: false },
        roots: [{ id: 'team', path: 'C:\\team', access: 'read', indexFile: 'INDEX.md' }],
      },
      consumption: { maxTokens: 1234, overflow: 'fail_query', failureMode: 'fail_query' },
    }),
  )
  const init = await services.get('memory').initializationResult()
  assert.equal(init.enabled, true)
  assert.equal(init.requester, 'plugin')
  assert.equal(init.mode, 'custom')
  // `generation.enabled` (default true) gates the generation half;
  // `turnComplete.enabled: false` gates only the automatic per-turn trigger.
  // These are independent, exactly as in the Qoder SDK.
  assert.equal(init.generationEnabled, true)
  assert.equal(init.turnCompleteEnabled, false)
  assert.equal(init.consumptionEnabled, true)
  assert.equal(init.maxTokens, 1234)
  assert.equal(init.overflow, 'fail_query')
  assert.equal(init.failureMode, 'fail_query')
  assert.deepEqual(init.roots, [{ id: 'team', path: 'C:\\team', access: 'read' }])
})

await test('flushMemory awaits in-flight background generation', async () => {
  const fs = makeFs({})
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const plan = JSON.stringify({ writes: [{ rootId: 'project', path: 'MEMORY.md', content: 'x' }] })
  const { ctx, listeners, services } = makeCtx(fs, makeLlm(plan))
  apply(
    ctx,
    loadConfig({
      mode: 'custom',
      userScope: false,
      generation: {
        turnComplete: {
          minPromptChars: 0,
          shouldGenerate: async () => {
            await gate
            return { run: true }
          },
        },
      },
    }),
  )
  const session = makeSession(turnEvents('a long enough prompt for the gate', 'ok'), 'C:\\proj')
  const agent = makeAgent(session)
  listeners.get('agent/created')[0]({ agent })
  listeners.get('session/event')[0](session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  await new Promise((resolve) => setTimeout(resolve, 5))
  assert.equal(services.get('memory').status().pendingGenerations, 1, 'generation must be in flight')
  const flushing = services.get('memory').flushMemory()
  release()
  const flushed = await flushing
  assert.equal(flushed.flushed, 1)
  assert.equal(services.get('memory').status().pendingGenerations, 0)
})

await test('refreshMemory injects a fresh memory message', async () => {
  const fs = makeFs({ [USER_MEMORY]: 'refreshable knowledge' })
  const { ctx, services } = makeCtx(fs, makeLlm('{}'))
  apply(ctx, loadConfig({
      mode: 'custom', generation: { turnComplete: { enabled: false } } }))
  const session = makeSession([], 'C:\\proj')
  const agent = makeAgent(session)
  const result = await services.get('memory').refreshMemory(agent)
  assert.equal(result.injected, true)
  assert.equal(agent.injected.length, 1)
  assert.equal(agent.injected[0].source.kind, 'memory')
  assert.match(agent.injected[0].content[0].text, /refreshable knowledge/)
})

await test('previewMemory describes the next step without changing it', async () => {
  // The whole point of previewing through a plan instead of a stored result: a
  // panel action must not consume the change it is describing. If the preview
  // advanced the live baseline, the step AFTER it would find "unchanged" and
  // inject nothing — looking at the panel would silently disable injection.
  const fs = makeFs({ [USER_MEMORY]: 'previewable knowledge' })
  const { ctx, listeners, services } = makeCtx(fs, makeLlm('{}'))
  const injectedResults = []
  apply(
    ctx,
    loadConfig({
      mode: 'custom',
      userScope: true,
      generation: { turnComplete: { enabled: false } },
      consumption: { onResult: (result) => injectedResults.push(result) },
    }),
  )
  const service = services.get('memory')
  const session = makeSession([], 'C:\\proj')
  const agent = makeAgent(session)

  // A fresh session: the preview must say "snapshot", and must show the block.
  const first = await service.previewMemory(agent)
  assert.equal(first.available, true, `preview unavailable: ${first.reason}`)
  assert.equal(first.step.action, 'snapshot', 'a session with no baseline receives a snapshot')
  assert.match(first.snapshot.text, /previewable knowledge/)
  assert.ok(first.snapshot.tokens > 0)
  assert.ok(first.step.text, 'the snapshot is what this step would send, so it carries the text')
  // `step.tokens` is what the PANEL shows, and it used to be 0 for a snapshot: `planInjection` only set
  // `tokens` on the delta path (where the delta's cost differs from the block's), so the panel read
  // "0 of 2000 tokens used" while displaying a full block underneath. A snapshot costs the whole block.
  assert.equal(
    first.step.tokens,
    first.snapshot.tokens,
    'a snapshot costs the whole block, so the step and the snapshot report the same tokens',
  )

  // Nothing was recorded and nothing was injected by the preview itself.
  assert.equal(injectedResults.length, 0, 'a preview must never fire consumption.onResult')
  assert.equal(agent.injected.length, 0, 'a preview must never inject into the session')

  // The real step still injects the snapshot exactly as previewed.
  const decision = await runPreStep(listeners, agent)
  assert.equal(decision.messages.length, 1, 'the preview must not have consumed the snapshot')
  assert.equal(decision.messages[0].content[0].text, first.step.text, 'the step sends what the preview showed')
  assert.equal(injectedResults.length, 1, 'the real load reports once')

  // Now the session has a baseline: the next preview must say "silent" — and the
  // step after it must still be silent, i.e. the preview did not use it up.
  const second = await service.previewMemory(agent)
  assert.equal(second.step.action, 'silent', 'an unchanged session injects nothing')
  assert.equal(second.step.text, undefined, 'a silent step sends no text')
  const afterPreview = await runPreStep(listeners, agent)
  assert.equal(afterPreview.messages.length, 0, 'the preview consumed nothing')
  assert.equal(injectedResults.length, 1, 'a silent step reports nothing')

  // The preview is not merely inert — it tracks a real change. Editing memory
  // must make the NEXT preview a delta, and the next step must emit it.
  fs.touch(USER_MEMORY, 'changed knowledge')
  const third = await service.previewMemory(agent)
  assert.equal(third.step.action, 'delta', 'a changed file turns the next step into a delta')
  assert.deepEqual(third.step.changed, ['user:MEMORY.md'])
  assert.match(third.step.text, /changed knowledge/)
  const deltaDecision = await runPreStep(listeners, agent)
  assert.equal(deltaDecision.messages.length, 1, 'the delta the preview showed is really sent')
  assert.equal(deltaDecision.messages[0].content[0].text, third.step.text)
})

await test('previewMemory answers for the GLOBAL configuration when no session is in scope', async () => {
  // A settings page is a global surface: `settings.section` is root-scoped and receives no
  // `sessionId`, and no HTTP request carries an initiator boundary. So a preview with no session is
  // NOT an error — it is the normal case there, and it has an honest answer: what a session starting
  // now would receive. (This test previously asserted `available: false` with "no session is in
  // scope", which is exactly what made the panel's button fail every time in production.)
  const fs = makeFs({ [USER_MEMORY]: 'knowledge' })
  const { ctx, listeners, services } = makeCtx(fs, makeLlm('{}'))
  apply(ctx, loadConfig({
    mode: 'custom',
    userScope: true,
    generation: { turnComplete: { enabled: false } },
  }))
  const service = services.get('memory')
  // A session that HAS seen memory, so a sessionless preview is distinguishable from a live one.
  const agent = makeAgent(makeSession([], 'C:\\proj'))
  await runPreStep(listeners, agent)

  const global = await service.previewMemory(undefined)
  assert.equal(global.available, true, 'no session must still produce a preview')
  assert.equal(global.scope, 'global', 'and must say which question it answered')
  assert.equal(global.mode, 'auto', 'a session that was never pinned follows the configuration')
  assert.equal(global.session.id, undefined, 'there is no session id to report')
  assert.match(global.snapshot.text, /knowledge/, 'it still reads the real memory files')
  assert.ok(fs.reads.length > 0)

  // And a LIVE preview is labelled as such, so the panel can tell the two claims apart.
  const live = await service.previewMemory(agent)
  assert.equal(live.scope, 'session')
  assert.equal(live.session.id, agent.session.id)

  // Consumption disabled is its own reason, not an empty preview.
  const off = makeCtx(makeFs({}), makeLlm('{}'))
  apply(off.ctx, loadConfig({
    mode: 'custom',
    generation: { turnComplete: { enabled: false } },
    consumption: { enabled: false },
  }))
  const disabled = await off.services.get('memory').previewMemory(makeAgent(makeSession([], 'C:\\proj')))
  assert.equal(disabled.available, false)
  assert.match(disabled.reason, /consumption is disabled/)
})

await test('a generation onResult sees its own result through ctx.memory.status()', async () => {
  // Regression: the result was recorded in index.js AFTER the callback fired,
  // so a callback reading status() observed the PREVIOUS pass (or null).
  const fs = makeFs({})
  const plan = JSON.stringify({ writes: [{ rootId: 'project', path: 'MEMORY.md', content: 'new' }] })
  const { ctx, listeners, services } = makeCtx(fs, makeLlm(plan))
  let seen
  apply(
    ctx,
    loadConfig({
      mode: 'custom',
      userScope: false,
      generation: {
        turnComplete: { minPromptChars: 1 },
        onResult: (r) => {
          seen = { callback: r.status, statusSees: services.get('memory').status().lastGeneration?.status ?? null }
        },
      },
    }),
  )
  const session = makeSession(turnEvents('a long enough prompt for the gate', 'ok'), 'C:\\proj')
  const agent = makeAgent(session)
  listeners.get('agent/created')[0]({ agent })
  listeners.get('session/event')[0](session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  await services.get('memory').flushMemory()
  assert.equal(seen.callback, 'saved')
  assert.equal(seen.statusSees, seen.callback, 'the callback must observe the result it was handed, not the previous one')
})

await test('a consumption onResult sees its own result through ctx.memory.status()', async () => {
  const fs = makeFs({ [USER_MEMORY]: 'some knowledge' })
  const { ctx, listeners, services } = makeCtx(fs, makeLlm('{}'))
  let seen
  apply(
    ctx,
    loadConfig({
      mode: 'custom',
      generation: { turnComplete: { enabled: false } },
      consumption: {
        onResult: (r) => {
          seen = { callback: r.status, statusSees: services.get('memory').status().lastConsumption?.status ?? null }
        },
      },
    }),
  )
  const session = makeSession([], 'C:\\proj')
  await runPreStep(listeners, makeAgent(session))
  assert.equal(seen.callback, 'success')
  assert.equal(seen.statusSees, seen.callback, 'the callback must observe the result it was handed')
})

await test('a failed consumption pass is still reported to onResult and status()', async () => {
  // Regression: the fail_query throws happened BEFORE the result was recorded,
  // so a failed pass reported nothing and `status: "failed"` was unreachable.
  const fs = makeFs({})
  const { ctx, listeners, services } = makeCtx(fs, makeLlm('{}'))
  const reported = []
  apply(
    ctx,
    loadConfig({
      mode: 'custom',
      userScope: false,
      projectScope: false,
      generation: { turnComplete: { enabled: false } },
      consumption: {
        files: [{ id: 'req', path: 'C:\\nope.md', required: true }],
        failureMode: 'fail_query',
        onResult: (r) => reported.push(r),
      },
    }),
  )
  const session = makeSession([], 'C:\\proj')
  await runPreStep(listeners, makeAgent(session))

  assert.equal(reported.length, 1, 'the failed pass must fire onResult exactly once')
  assert.equal(reported[0].status, 'failed')
  assert.match(reported[0].error, /required memory file/)
  assert.equal(services.get('memory').status().lastConsumption.status, 'failed')
})

await test('an overflow=fail_query pass is reported as failed', async () => {
  const fs = makeFs({ [USER_MEMORY]: 'x'.repeat(20000) })
  const { ctx, listeners, services } = makeCtx(fs, makeLlm('{}'))
  const reported = []
  apply(
    ctx,
    loadConfig({
      mode: 'custom',
      generation: { turnComplete: { enabled: false } },
      consumption: { maxTokens: 10, overflow: 'fail_query', onResult: (r) => reported.push(r) },
    }),
  )
  const session = makeSession([], 'C:\\proj')
  await runPreStep(listeners, makeAgent(session))
  assert.equal(reported.length, 1)
  assert.equal(reported[0].status, 'failed')
  assert.match(reported[0].error, /maxTokens/)
  assert.equal(services.get('memory').status().lastConsumption.status, 'failed')
})

await test('consumption loads the index before the content files', async () => {
  const fs = makeFs({
    [USER_MEMORY]: '# Index\n\n- [Build](build.md) - how to build',
    [`${HOME}\\memory\\build.md`]: '---\nname: Build\ndescription: How to build\ntype: project\n---\n\npnpm build',
  })
  const { ctx, listeners, services } = makeCtx(fs, makeLlm('{}'))
  apply(ctx, loadConfig({ mode: 'custom', generation: { turnComplete: { enabled: false } } }))
  const session = makeSession([], 'C:\\proj')
  const agent = makeAgent(session)
  await runPreStep(listeners, agent)

  const result = services.get('memory').status().lastConsumption
  assert.equal(result.status, 'success')
  const ids = result.files.map((file) => file.id)
  assert.equal(ids[0], 'user:MEMORY.md', 'the index must be injected first')
  assert.ok(ids.includes('user:build.md'), 'content files must be injected too')
})

await test('the panel sees the index and content separately', async () => {
  const fs = makeFs({
    [USER_MEMORY]: '# Index',
    [`${HOME}\\memory\\conventions.md`]: '---\nname: Conventions\ndescription: House style\ntype: feedback\n---\n\nbody',
    [`${HOME}\\memory\\.hidden.md`]: 'never listed',
  })
  const { ctx, routes, services } = makeCtx(fs, makeLlm('{}'))
  apply(ctx, loadConfig({ mode: 'custom', generation: { turnComplete: { enabled: false } } }))
  const { json } = await callRoute(routes, '/api/memory/status')
  const userRoot = json.roots.find((root) => root.id === 'user')
  assert.deepEqual(userRoot.files, ['MEMORY.md', 'conventions.md'], 'dotfiles are not memory content')
  // The status payload carries the dream result for the panel.
  assert.equal(json.lastDream, null)
})
console.log(`\n${passed} integration service tests passed`)
