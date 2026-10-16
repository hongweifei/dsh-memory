/**
 * Integration test — generation.
 *
 * Drives the real `apply()` against the Harness doubles in
 * `test/support/integration-harness.mjs`. Split by topic from the single
 * integration suite; each suite is still one standalone process.
 *
 * Run: node test/integration-generation.test.mjs
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

console.log('dsh-memory integration tests — generation')

await test('a real generation pass files a daily journal entry through the tool', async () => {
  // The whole path, end to end: turn ends → background pass → the model calls `memory_write` with
  // `target: "daily"` → the entry lands in `journal/<today>.md`. The unit suite covers the writer; this
  // covers the fact that the PROMPT teaches the call and the TOOLKIT accepts it, which is where a port
  // of this shape actually breaks — a prompt that names a call the toolkit refuses is a silent no-op.
  const fs = makeFs({})
  const llm = makeScriptedLlm([
    {
      calls: [{
        id: 'c1',
        name: 'memory_write',
        arguments: JSON.stringify({
          target: 'daily',
          content: '- Set up pnpm for the project\n- Chose the project scope for the journal',
        }),
      }],
    },
    { text: 'recorded the day' },
  ])
  const { ctx, listeners, services } = makeCtx(fs, llm)
  let reported
  apply(
    ctx,
    loadConfig({
      mode: 'custom',
      userScope: false,
      projectScope: true,
      generation: {
        turnComplete: { minPromptChars: 1 },
        journal: { enabled: true, scope: 'project' },
        onResult: (result) => (reported = result),
      },
    }),
  )
  const session = makeSession(turnEvents('set up the project and note what we decided', 'done'), 'C:\\proj')
  const agent = makeAgent(session)
  listeners.get('agent/created')[0]({ agent })
  listeners.get('session/event')[0](session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  await services.get('memory').flushMemory()

  assert.equal(reported.status, 'saved', JSON.stringify(reported))
  const written = reported.writtenFiles.filter((file) => file.journal === true)
  assert.equal(written.length, 1, 'the journal entry is reported as such')
  assert.match(written[0].path, /^journal\/\d{4}-\d{2}-\d{2}\.md$/)

  const entry = [...fs.files.entries()].find(([key]) => key.includes('journal'))
  assert.ok(entry, 'the file exists on disk')
  assert.match(entry[1], /Set up pnpm for the project/)
  assert.match(entry[1], /^# \d{4}-\d{2}-\d{2}/, 'the day heading is written by the plugin')

  // And the pass that wrote it was TOLD to, by the prompt it was actually given. The memory agent
  // passes the instruction as the request's top-level `system`, not as a system message.
  assert.match(llm.calls[0].system, /Daily Memory Journal/, 'the prompt carried the journal section')
})

await test('a real generation pass does not journal while the switch is off', async () => {
  // The negative control for the test above: without the switch the prompt has no journal section, so
  // the same scripted tool call is not something the model would have been asked to make — and if it
  // made it anyway the toolkit would still file it, which is why the PROMPT is what is asserted here.
  const fs = makeFs({})
  const offLlm = makeScriptedLlm([{ text: 'nothing to record' }])
  const { ctx, listeners, services } = makeCtx(fs, offLlm)
  apply(
    ctx,
    loadConfig({
      mode: 'custom',
      userScope: false,
      projectScope: true,
      generation: { turnComplete: { minPromptChars: 1 }, onResult: () => {} },
    }),
  )
  const session = makeSession(turnEvents('a short prompt that still clears the gate', 'done'), 'C:\\proj')
  listeners.get('agent/created')[0]({ agent: makeAgent(session) })
  listeners.get('session/event')[0](session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  await services.get('memory').flushMemory()

  assert.doesNotMatch(offLlm.calls[0].system, /Daily Memory Journal/)
  assert.equal([...fs.files.keys()].some((key) => key.includes('journal')), false)
})

await test('generation writes a plan and reports status saved with writtenFiles', async () => {
  const fs = makeFs({})
  const plan = JSON.stringify({
    writes: [{ rootId: 'project', path: 'MEMORY.md', content: '# Project\n\nuse pnpm', mode: 'replace' }],
    reason: 'recorded the package manager',
  })
  const { ctx, listeners, services } = makeCtx(fs, makeLlm(plan))
  const results = []
  apply(
    ctx,
    loadConfig({
      mode: 'custom',
      userScope: false,
      projectScope: true,
      generation: { turnComplete: { minPromptChars: 1 }, onResult: (result) => results.push(result) },
    }),
  )
  const session = makeSession(turnEvents('please set up the project and document the build', 'done'), 'C:\\proj')
  const agent = makeAgent(session)
  listeners.get('agent/created')[0]({ agent })
  listeners.get('session/event')[0](session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  await services.get('memory').flushMemory()

  assert.equal(results.length, 1, 'generation.onResult must fire once')
  assert.equal(results[0].status, 'saved')
  assert.equal(results[0].turnIndex, 1)
  assert.equal(results[0].writtenFiles.length, 1)
  assert.equal(results[0].writtenFiles[0].rootId, 'project')
  assert.equal(results[0].writtenFiles[0].path, 'MEMORY.md')
  const written = [...fs.files.entries()].find(([key]) => key.endsWith('MEMORY.md'))
  assert.ok(written, 'the memory file must be written')
  assert.match(written[1], /use pnpm/)
})

await test('a plan with several writes lands whole — there is no per-pass write cap', async () => {
  // This used to be the "deferred" test: the plugin had its own `generation.maxWrites`, and a write
  // past it was reported as deferred rather than refused. Qoder has no such field, so the field is
  // gone and the only correct behaviour is that every write in the plan is attempted and lands —
  // with no `deferredFiles` anywhere in the result.
  const plan = (count) =>
    JSON.stringify({
      writes: Array.from({ length: count }, (_, index) => ({
        rootId: 'project',
        path: `note-${index}.md`,
        content: '# note',
      })),
      reason: 'several notes',
    })
  const run = async (count) => {
    const fs = makeFs({})
    const { ctx, listeners, services, commands } = makeCtx(fs, makeLlm(plan(count)))
    let reported
    apply(
      ctx,
      loadConfig({
        mode: 'custom',
        userScope: false,
        generation: { turnComplete: { minPromptChars: 1 }, onResult: (result) => (reported = result) },
      }),
    )
    const session = makeSession(turnEvents('a reasonably long prompt to pass the gate', 'ok'), 'C:\\proj')
    const agent = makeAgent(session)
    listeners.get('agent/created')[0]({ agent })
    listeners.get('session/event')[0](session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    await services.get('memory').flushMemory()
    return { reported, commands, agent }
  }

  const many = await run(6)
  assert.equal(many.reported.status, 'saved')
  assert.deepEqual(many.reported.failedFiles, [])
  assert.deepEqual(
    many.reported.writtenFiles.map((file) => file.path),
    ['note-0.md', 'note-1.md', 'note-2.md', 'note-3.md', 'note-4.md', 'note-5.md'],
  )
  assert.equal('deferredFiles' in many.reported, false, 'the field itself is gone, not empty')
  assert.match(many.reported.reason, /several notes/, "the model's own summary still wins the reason")

  // `/memory` has nothing to defer, and must not resurrect the old line.
  const report = await runCommand(many.commands, 'memory', { agent: many.agent })
  assert.doesNotMatch(report.text, /deferred:/)
})

await test('generation reports no_change when the model writes nothing', async () => {
  const fs = makeFs({})
  const { ctx, listeners, services } = makeCtx(fs, makeLlm('{"writes":[],"reason":"nothing durable"}'))
  let reported
  apply(
    ctx,
    loadConfig({
      mode: 'custom',
      userScope: false,
      generation: { turnComplete: { minPromptChars: 1 }, onResult: (result) => (reported = result) },
    }),
  )
  const session = makeSession(turnEvents('a reasonably long prompt to pass the gate', 'ok'), 'C:\\proj')
  const agent = makeAgent(session)
  listeners.get('agent/created')[0]({ agent })
  listeners.get('session/event')[0](session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  await services.get('memory').flushMemory()
  assert.equal(reported.status, 'no_change')
  assert.deepEqual(reported.writtenFiles, [])
})

await test('the built-in gate skips a short prompt', async () => {
  const fs = makeFs({})
  const { ctx, listeners, services } = makeCtx(fs, makeLlm('{"writes":[]}'))
  let reported
  apply(
    ctx,
    loadConfig({
      mode: 'custom',
      userScope: false,
      generation: { turnComplete: { minPromptChars: 500 }, onResult: (result) => (reported = result) },
    }),
  )
  const session = makeSession(turnEvents('short', 'ok'), 'C:\\proj')
  const agent = makeAgent(session)
  listeners.get('agent/created')[0]({ agent })
  listeners.get('session/event')[0](session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  await services.get('memory').flushMemory()
  assert.equal(reported.status, 'skipped')
  assert.match(reported.reason, /shorter than 500/)
})

await test('a custom shouldGenerate gate can veto a turn', async () => {
  const fs = makeFs({})
  const { ctx, listeners, services } = makeCtx(fs, makeLlm('{"writes":[]}'))
  let reported
  let gateSaw
  apply(
    ctx,
    loadConfig({
      mode: 'custom',
      userScope: false,
      generation: {
        turnComplete: {
          minPromptChars: 0,
          shouldGenerate: async (input) => {
            gateSaw = input
            return { run: false, reason: 'tenant budget exhausted' }
          },
        },
        onResult: (result) => (reported = result),
      },
    }),
  )
  const session = makeSession(turnEvents('a long enough prompt for the gate', 'ok'), 'C:\\proj')
  const agent = makeAgent(session)
  listeners.get('agent/created')[0]({ agent })
  listeners.get('session/event')[0](session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  await services.get('memory').flushMemory()

  assert.equal(reported.status, 'skipped')
  assert.equal(reported.reason, 'tenant budget exhausted')
  assert.equal(gateSaw.sessionId, 'session-1')
  assert.equal(gateSaw.cwd, 'C:\\proj')
  assert.equal(gateSaw.turnIndex, 1)
  assert.match(gateSaw.prompt, /long enough prompt/)
})

await test('a throwing gate with onGateError=skip reports skipped', async () => {
  const fs = makeFs({})
  const { ctx, listeners, services } = makeCtx(fs, makeLlm('{"writes":[]}'))
  let reported
  apply(
    ctx,
    loadConfig({
      mode: 'custom',
      userScope: false,
      generation: {
        turnComplete: {
          minPromptChars: 0,
          onGateError: 'skip',
          shouldGenerate: async () => {
            throw new Error('gate exploded')
          },
        },
        onResult: (result) => (reported = result),
      },
    }),
  )
  const session = makeSession(turnEvents('a long enough prompt for the gate', 'ok'), 'C:\\proj')
  const agent = makeAgent(session)
  listeners.get('agent/created')[0]({ agent })
  listeners.get('session/event')[0](session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  await services.get('memory').flushMemory()
  assert.equal(reported.status, 'skipped')
  assert.match(reported.reason, /gate exploded/)
})

await test('a throwing gate with onGateError=report_failed reports failed', async () => {
  const fs = makeFs({})
  const { ctx, listeners, services } = makeCtx(fs, makeLlm('{"writes":[]}'))
  let reported
  apply(
    ctx,
    loadConfig({
      mode: 'custom',
      userScope: false,
      generation: {
        turnComplete: {
          minPromptChars: 0,
          onGateError: 'report_failed',
          shouldGenerate: async () => {
            throw new Error('gate exploded')
          },
        },
        onResult: (result) => (reported = result),
      },
    }),
  )
  const session = makeSession(turnEvents('a long enough prompt for the gate', 'ok'), 'C:\\proj')
  const agent = makeAgent(session)
  listeners.get('agent/created')[0]({ agent })
  listeners.get('session/event')[0](session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  await services.get('memory').flushMemory()
  assert.equal(reported.status, 'failed')
  assert.match(reported.reason, /gate exploded/)
})

await test('a turn that did not complete is skipped without a model call', async () => {
  const fs = makeFs({})
  const llm = makeLlm('{"writes":[]}')
  const { ctx, listeners, services } = makeCtx(fs, llm)
  let reported
  apply(ctx, loadConfig({
      mode: 'custom', userScope: false, generation: { turnComplete: { minPromptChars: 0 }, onResult: (r) => (reported = r) } }))
  const session = makeSession([], 'C:\\proj')
  const agent = makeAgent(session)
  listeners.get('agent/created')[0]({ agent })
  listeners.get('session/event')[0](session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'aborted' } } })
  await services.get('memory').flushMemory()
  assert.equal(reported.status, 'skipped')
  assert.match(reported.reason, /aborted/)
  assert.equal(llm.calls.length, 0, 'no model call may happen for an aborted turn')
  // The skipped pass must still be visible through status(): it is the most
  // recent generation outcome, and the panel reports it.
  assert.equal(services.get('memory').status().lastGeneration.status, 'skipped')
})

await test('a read-only custom root rejects writes and reports partial', async () => {
  const fs = makeFs({ 'C:\\team\\INDEX.md': 'team knowledge' })
  const plan = JSON.stringify({
    writes: [{ rootId: 'team', path: 'NEW.md', content: 'should not be written' }],
    reason: 'tried to write a read-only root',
  })
  const { ctx, listeners, services } = makeCtx(fs, makeLlm(plan))
  let reported
  apply(
    ctx,
    loadConfig({
      mode: 'custom',
      userScope: false,
      projectScope: false,
      generation: {
        turnComplete: { minPromptChars: 1 },
        roots: [{ id: 'team', path: 'C:\\team', access: 'read', indexFile: 'INDEX.md' }],
        onResult: (result) => (reported = result),
      },
    }),
  )
  const session = makeSession(turnEvents('a long enough prompt for the gate', 'ok'), 'C:\\proj')
  const agent = makeAgent(session)
  listeners.get('agent/created')[0]({ agent })
  listeners.get('session/event')[0](session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  await services.get('memory').flushMemory()

  assert.equal(reported.status, 'failed', 'no file could be written')
  assert.equal(reported.failedFiles[0].error, 'root is read-only')
  assert.ok(![...fs.files.keys()].some((key) => key.endsWith('NEW.md')), 'a read-only root must not be written')
})

await test('an unknown root in the plan is reported as a failed file', async () => {
  const fs = makeFs({})
  const plan = JSON.stringify({ writes: [{ rootId: 'ghost', path: 'X.md', content: 'nope' }] })
  const { ctx, listeners, services } = makeCtx(fs, makeLlm(plan))
  let reported
  apply(
    ctx,
    loadConfig({
      mode: 'custom',
      userScope: false,
      generation: { turnComplete: { minPromptChars: 1 }, onResult: (result) => (reported = result) },
    }),
  )
  const session = makeSession(turnEvents('a long enough prompt for the gate', 'ok'), 'C:\\proj')
  const agent = makeAgent(session)
  listeners.get('agent/created')[0]({ agent })
  listeners.get('session/event')[0](session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  await services.get('memory').flushMemory()
  assert.equal(reported.status, 'failed')
  assert.equal(reported.failedFiles[0].error, 'unknown root')
})

await test('a path traversal in the plan is rejected before writing', async () => {
  const fs = makeFs({})
  const plan = JSON.stringify({ writes: [{ rootId: 'project', path: '../escape.md', content: 'nope' }] })
  const { ctx, listeners, services } = makeCtx(fs, makeLlm(plan))
  let reported
  apply(
    ctx,
    loadConfig({
      mode: 'custom',
      userScope: false,
      generation: { turnComplete: { minPromptChars: 1 }, onResult: (result) => (reported = result) },
    }),
  )
  const session = makeSession(turnEvents('a long enough prompt for the gate', 'ok'), 'C:\\proj')
  const agent = makeAgent(session)
  listeners.get('agent/created')[0]({ agent })
  listeners.get('session/event')[0](session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  await services.get('memory').flushMemory()
  assert.equal(reported.status, 'failed')
  assert.match(reported.failedFiles[0].error, /relative \.md path/)
  assert.ok(![...fs.files.keys()].some((key) => key.includes('escape')))
})

await test('a custom root uses its declared indexFile first', async () => {
  const fs = makeFs({ 'C:\\team\\INDEX.md': 'index body', 'C:\\team\\AAA.md': 'aaa body' })
  const { ctx, listeners } = makeCtx(fs, makeLlm('{}'))
  let reported
  apply(
    ctx,
    loadConfig({
      mode: 'custom',
      userScope: false,
      projectScope: false,
      generation: {
        turnComplete: { enabled: false },
        roots: [{ id: 'team', path: 'C:\\team', indexFile: 'INDEX.md' }],
      },
      consumption: { onResult: (result) => (reported = result) },
    }),
  )
  const session = makeSession([], 'C:\\proj')
  await runPreStep(listeners, makeAgent(session))
  assert.ok(reported, 'onResult must fire')
  const ids = reported.files.map((file) => file.id)
  assert.equal(ids[0], 'team:INDEX.md', 'the declared index file must come first')
})
console.log(`\n${passed} integration generation tests passed`)
