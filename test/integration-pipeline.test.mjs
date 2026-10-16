/**
 * Integration test — identity, discovery, imports and pacing.
 *
 * Drives the real `apply()` against the Harness doubles in
 * `test/support/integration-harness.mjs`. Split by topic from the single
 * integration suite; each suite is still one standalone process.
 *
 * Run: node test/integration-pipeline.test.mjs
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

console.log('dsh-memory integration tests — identity, discovery, imports and pacing')

await test('the project scope is keyed the way the harness keys a project', async () => {
  const fs = projectMemoryFixture()
  const { ctx, listeners } = makeCtx(fs, makeLlm('{}'))
  apply(ctx, trustConfig())
  const decision = await runPreStep(listeners, makeAgent(makeSession([], 'C:\\proj')))
  assert.match(decision.messages[0].content[0].text, /project knowledge/)
  // `--C-proj--` is the harness's own project-directory name for `C:\proj`.
  assert.equal(fs.files.has(PROJECT_MEMORY), true)
  assert.equal(fs.files.has('C:\\home\\.dsh\\projects\\C--proj\\memory\\MEMORY.md'), false)
})

await test('a projectRootMarker makes one repository share one memory scope', async () => {
  // With markers configured the identity walks up to the marker root, so a
  // session in a package sees the repository's memory.
  const fs = makeFs({
    [USER_MEMORY]: 'user knowledge',
    'C:\\home\\.dsh\\projects\\--C-repo--\\memory\\MEMORY.md': 'repo knowledge',
    'C:\\repo\\.git\\config': '[core]',
  })
  const { ctx, listeners } = makeCtx(fs, makeLlm('{}'))
  apply(ctx, trustConfig({ projectRootMarkers: ['.git'] }))
  const decision = await runPreStep(listeners, makeAgent(makeSession([], 'C:\\repo\\packages\\a')))
  assert.match(decision.messages[0].content[0].text, /repo knowledge/)

  // Without the marker the package is its own project, so it sees nothing.
  const bare = makeCtx(fs, makeLlm('{}'))
  apply(bare.ctx, trustConfig())
  const other = await runPreStep(bare.listeners, makeAgent(makeSession([], 'C:\\repo\\packages\\a')))
  assert.doesNotMatch(other.messages[0].content[0].text, /repo knowledge/)
})

await test('nothing carries a pre-DSH memory directory forward', async () => {
  // No migration, by decision: an old directory is simply not read. This pins
  // that memory written under Qoder's naming stays invisible.
  const fs = makeFs({
    [USER_MEMORY]: 'user knowledge',
    'C:\\home\\.dsh\\projects\\C--proj\\memory\\MEMORY.md': 'memory from the old naming',
  })
  const { ctx, listeners } = makeCtx(fs, makeLlm('{}'))
  apply(ctx, trustConfig())
  const decision = await runPreStep(listeners, makeAgent(makeSession([], 'C:\\proj')))
  const text = decision.messages[0].content[0].text
  assert.match(text, /user knowledge/)
  assert.doesNotMatch(text, /memory from the old naming/)
  assert.equal(fs.files.has(PROJECT_MEMORY), false, 'the new directory is not seeded either')
})

await test('consumption never picks up AGENTS.md: that layer is the harness own', async () => {
  // `dsh-agent-instructions` already loads AGENTS.md / CLAUDE.md into durable
  // context under `source.kind: 'agent-instructions'`. Loading them here too
  // would inject the same files twice, so consumption reads memory roots only.
  const fs = makeFs({
    [USER_MEMORY]: 'user knowledge',
    'C:\\proj\\AGENTS.md': 'workspace instructions from the harness layer',
    'C:\\home\\.dsh\\AGENTS.md': 'user-global instructions',
  })
  const { ctx, listeners } = makeCtx(fs, makeLlm('{}'))
  apply(ctx, trustConfig())
  const decision = await runPreStep(listeners, makeAgent(makeSession([], 'C:\\proj')))
  const text = decision.messages[0].content[0].text
  assert.match(text, /user knowledge/)
  assert.doesNotMatch(text, /workspace instructions from the harness layer/)
  assert.doesNotMatch(text, /user-global instructions/)
  assert.equal(decision.messages[0].source.kind, 'memory')
})

await test('an exclusion pattern drops project memory but never user memory', async () => {
  const fs = makeFs({
    [USER_MEMORY]: 'user knowledge',
    [`${PROJECT_DIR}\\MEMORY.md`]: 'project knowledge',
    [`${PROJECT_DIR}\\draft.draft.md`]: 'a draft note',
  })
  const { ctx, listeners, services } = makeCtx(fs, makeLlm('{}'))
  apply(
    ctx,
    trustConfig({
      // Qoder matches gitignore-flavoured globs against the absolute path.
      excludes: ['**/*.draft.md', '**/MEMORY.md'],
    }),
  )
  const decision = await runPreStep(listeners, makeAgent(makeSession([], 'C:\\proj')))
  const text = decision.messages[0].content[0].text
  // The user scope is this port's equivalent of Qoder's `global` layer, which
  // `pet()` never filters — so `**/MEMORY.md` removes the project index only.
  assert.match(text, /user knowledge/)
  assert.doesNotMatch(text, /project knowledge/)
  assert.doesNotMatch(text, /a draft note/)

  const result = services.get('memory').status().lastConsumption
  assert.deepEqual(
    result.excludedFiles.sort(),
    [`${PROJECT_DIR}\\MEMORY.md`, `${PROJECT_DIR}\\draft.draft.md`].sort(),
  )
  assert.equal(result.fileCount, 1, 'only the user index was actually read')
  assert.deepEqual(
    result.filePaths.filter((path) => path.endsWith('MEMORY.md')),
    ['C:\\home\\.dsh\\memory\\MEMORY.md'],
    'an excluded file is not even considered',
  )
})

await test('a large memory file is reported, not silently dropped', async () => {
  const huge = `# Big\n\n${'x'.repeat(LARGE_FILE_CHARS + 1)}`
  const fs = makeFs({ [`${PROJECT_DIR}\\huge.md`]: huge, [USER_MEMORY]: 'user knowledge' })
  const { ctx, listeners, services, commands } = makeCtx(fs, makeLlm('{}'))
  apply(ctx, trustConfig({ consumption: { maxTokens: 1000000 } }))
  const decision = await runPreStep(listeners, makeAgent(makeSession([], 'C:\\proj')))

  const result = services.get('memory').status().lastConsumption
  assert.equal(result.largeFiles.length, 1, 'Qoder reports the file AND still loads it')
  assert.equal(result.largeFiles[0].path, `${PROJECT_DIR}\\huge.md`)
  assert.equal(result.largeFiles[0].characterCount, huge.length)
  assert.match(decision.messages[0].content[0].text, /user knowledge/)

  // Qoder's own UI wording, surfaced by `/memory`.
  const report = await runCommand(commands, 'memory', { agent: makeAgent(makeSession([], 'C:\\proj')) })
  assert.match(report.text, /memory change: files=2 large=1 failed=0 excluded=0 imports=0 blocked=0/)
  assert.match(report.text, /large: .*huge\.md \(\d+ chars > 40000\)/)
})

await test('a file that cannot be read is reported as a failed file', async () => {
  const broken = `${PROJECT_DIR}\\broken.md`
  const fs = makeFs({ [broken]: 'unreadable', [USER_MEMORY]: 'user knowledge' }, { failReads: [broken] })
  const { ctx, listeners, services } = makeCtx(fs, makeLlm('{}'))
  apply(ctx, trustConfig())
  await runPreStep(listeners, makeAgent(makeSession([], 'C:\\proj')))

  const status = services.get('memory').status()
  assert.deepEqual(status.memoryChange.failedFiles, [{ path: broken, error: `Error: EACCES ${broken}` }])
  assert.equal(status.lastConsumption.status, 'partial', 'a failed file with a loaded one is partial')
  assert.equal(status.memoryChange.fileCount, 1)
})

await test('status exposes the memory-changed facts, empty lists omitted', async () => {
  const fs = makeFs({ [USER_MEMORY]: 'user knowledge' })
  const { ctx, listeners, services } = makeCtx(fs, makeLlm('{}'))
  apply(ctx, trustConfig())
  const before = services.get('memory').status()
  assert.equal(before.memoryChange, null, 'nothing has loaded yet')

  await runPreStep(listeners, makeAgent(makeSession([], 'C:\\proj')))
  const after = services.get('memory').status()
  assert.deepEqual(after.memoryChange, { fileCount: 1 })
  // Qoder omits empty arrays from the event; so does the snapshot.
  assert.equal(after.memoryChange.largeFiles, undefined)
  assert.equal(after.memoryChange.failedFiles, undefined)
})

await test('an @import is expanded in place with Qoder markers', async () => {
  const fs = makeFs({
    [`${PROJECT_DIR}\\MEMORY.md`]: '# Index\n\n@sub/notes.md\n',
    [IMPORT('notes.md')]: 'the imported body',
    [USER_MEMORY]: 'user knowledge',
  })
  const { ctx, listeners, services } = makeCtx(fs, makeLlm('{}'))
  apply(ctx, trustConfig())
  const decision = await runPreStep(listeners, makeAgent(makeSession([], 'C:\\proj')))
  const text = decision.messages[0].content[0].text
  // The reference is replaced by the file's content, wrapped in the comments
  // Qoder writes: `<!-- Imported from: X -->` … `<!-- End of import from: X -->`.
  assert.match(text, /<!-- Imported from: sub\/notes\.md -->/)
  assert.match(text, /the imported body/)
  assert.match(text, /<!-- End of import from: sub\/notes\.md -->/)

  const result = services.get('memory').status().lastConsumption
  assert.deepEqual(result.resolvedImportPaths, [IMPORT('notes.md')])
  assert.deepEqual(result.blockedExternalImports, [])
  assert.deepEqual(result.failedImports, [])
})

await test('a cycle is cut with the already-processed marker', async () => {
  const fs = makeFs({
    [`${PROJECT_DIR}\\MEMORY.md`]: 'root\n\n@sub/a.md\n',
    [IMPORT('a.md')]: 'A body\n\n@b.md\n',
    [IMPORT('b.md')]: 'B body\n\n@a.md\n',
  })
  const { ctx, listeners } = makeCtx(fs, makeLlm('{}'))
  apply(ctx, trustConfig())
  const decision = await runPreStep(listeners, makeAgent(makeSession([], 'C:\\proj')))
  const text = decision.messages[0].content[0].text
  assert.match(text, /A body/)
  assert.match(text, /B body/)
  // b.md imports a.md, which is already on this chain.
  assert.match(text, /<!-- File already processed: a\.md -->/)
  assert.equal(text.match(/A body/g).length, 1, 'a cyclic file is expanded exactly once')
})

await test('an out-of-root import is refused until it is approved', async () => {
  const outside = { [`${PROJECT_DIR}\\MEMORY.md`]: 'index\n\n@C:/secrets/keys.md\n' }
  const blocked = makeCtx(makeFs(outside), makeLlm('{}'))
  apply(blocked.ctx, trustConfig())
  const refused = await runPreStep(blocked.listeners, makeAgent(makeSession([], 'C:\\proj')))
  // Qoder's own wording, and the facts land in the change report where its
  // `pendingExternalImports` would be.
  assert.match(refused.messages[0].content[0].text, /<!-- Import blocked: C:\/secrets\/keys\.md - outside project root -->/)
  const change = blocked.services.get('memory').status().memoryChange
  assert.deepEqual(change.pendingExternalImports, [
    { importPath: 'C:/secrets/keys.md', resolvedPath: 'C:\\secrets\\keys.md', sourceFile: `${PROJECT_DIR}\\MEMORY.md` },
  ])

  const allowed = makeCtx(makeFs({ ...outside, 'C:\\secrets\\keys.md': 'the secret' }), makeLlm('{}'))
  apply(allowed.ctx, trustConfig({ imports: { allowExternal: true } }))
  const expanded = await runPreStep(allowed.listeners, makeAgent(makeSession([], 'C:\\proj')))
  assert.match(expanded.messages[0].content[0].text, /the secret/)
})

await test('a second project can be approved instead of everything', async () => {
  const files = {
    [`${PROJECT_DIR}\\MEMORY.md`]: 'index\n\n@C:/secrets/keys.md\n',
    'C:\\secrets\\keys.md': 'the secret',
  }
  const approved = makeCtx(makeFs(files), makeLlm('{}'))
  apply(approved.ctx, trustConfig({ imports: { approvedProjects: ['C:\\proj'] } }))
  const decision = await runPreStep(approved.listeners, makeAgent(makeSession([], 'C:\\proj')))
  assert.match(decision.messages[0].content[0].text, /the secret/)

  // A different session directory is not covered by that approval.
  const other = makeCtx(makeFs(files), makeLlm('{}'))
  apply(other.ctx, trustConfig({ imports: { approvedProjects: ['C:\\elsewhere'] } }))
  const refused = await runPreStep(other.listeners, makeAgent(makeSession([], 'C:\\proj')))
  assert.match(refused.messages[0].content[0].text, /Import blocked/)
})

await test('an import that cannot be read is reported, and depth is capped', async () => {
  const fs = makeFs({
    [`${PROJECT_DIR}\\MEMORY.md`]: 'index\n\n@sub/missing.md\n',
  })
  const { ctx, listeners, services } = makeCtx(fs, makeLlm('{}'))
  apply(ctx, trustConfig())
  const decision = await runPreStep(listeners, makeAgent(makeSession([], 'C:\\proj')))
  assert.match(decision.messages[0].content[0].text, /<!-- Import failed: sub\/missing\.md - could not be read -->/)
  assert.deepEqual(services.get('memory').status().lastConsumption.failedImports, [
    {
      importPath: 'sub/missing.md',
      resolvedPath: IMPORT('missing.md'),
      sourceFile: `${PROJECT_DIR}\\MEMORY.md`,
      error: 'could not be read',
    },
  ])

  // A chain deeper than maxDepth stops expanding: the deepest reference stays
  // literal rather than being followed forever.
  const chain = { [`${PROJECT_DIR}\\MEMORY.md`]: 'root\n\n@sub/l1.md\n' }
  for (let level = 1; level <= 4; level += 1) {
    chain[IMPORT(`l${level}.md`)] = `level ${level}\n\n@l${level + 1}.md\n`
  }
  chain[IMPORT('l5.md')] = 'the deepest body'
  const deep = makeCtx(makeFs(chain), makeLlm('{}'))
  apply(deep.ctx, trustConfig({ imports: { maxDepth: 2 } }))
  const capped = await runPreStep(deep.listeners, makeAgent(makeSession([], 'C:\\proj')))
  const text = capped.messages[0].content[0].text
  assert.match(text, /level 1/)
  assert.doesNotMatch(text, /the deepest body/)
  assert.match(text, /@l3\.md/, 'the reference past the ceiling is left as written')
})

await test('a flat import renders whole-file blocks and repeats a file once', async () => {
  const fs = makeFs({
    [`${PROJECT_DIR}\\MEMORY.md`]: 'index\n\n@sub/a.md\n\n@sub/b.md\n',
    [IMPORT('a.md')]: 'A body',
    [IMPORT('b.md')]: 'B body\n\n@a.md\n',
  })
  const { ctx, listeners, services } = makeCtx(fs, makeLlm('{}'))
  apply(ctx, trustConfig({ imports: { format: 'flat' } }))
  await runPreStep(listeners, makeAgent(makeSession([], 'C:\\proj')))
  const result = services.get('memory').status().lastConsumption
  // `flat` lists every resolved file once, each in its own block; a.md is
  // reached twice (directly and from b.md) and still appears once.
  assert.deepEqual(result.resolvedImportPaths.slice().sort(), [IMPORT('a.md'), IMPORT('b.md')].sort())
  assert.equal(result.resolvedImportPaths.filter((path) => path.endsWith('a.md')).length, 1)
})

await test('an @import inside a code fence stays literal', async () => {
  const fs = makeFs({
    [`${PROJECT_DIR}\\MEMORY.md`]: 'index\n\n```\n@sub/notes.md\n```\n',
    [IMPORT('notes.md')]: 'the imported body',
  })
  const { ctx, listeners, services } = makeCtx(fs, makeLlm('{}'))
  apply(ctx, trustConfig())
  const decision = await runPreStep(listeners, makeAgent(makeSession([], 'C:\\proj')))
  const text = decision.messages[0].content[0].text
  assert.match(text, /@sub\/notes\.md/, 'the fenced reference is not expanded')
  assert.doesNotMatch(text, /the imported body/)
  assert.deepEqual(services.get('memory').status().lastConsumption.resolvedImportPaths, [])
})

await test('imports can be switched off entirely', async () => {
  const fs = makeFs({
    [`${PROJECT_DIR}\\MEMORY.md`]: 'index\n\n@sub/notes.md\n',
    [IMPORT('notes.md')]: 'the imported body',
  })
  const { ctx, listeners, services } = makeCtx(fs, makeLlm('{}'))
  apply(ctx, trustConfig({ imports: { enabled: false } }))
  const decision = await runPreStep(listeners, makeAgent(makeSession([], 'C:\\proj')))
  assert.doesNotMatch(decision.messages[0].content[0].text, /the imported body/)
  assert.deepEqual(services.get('memory').status().lastConsumption.resolvedImportPaths, [])
})

await test('a memory file changed mid-session is injected as a delta', async () => {
  const notePath = `${PROJECT_DIR}\\notes.md`
  const fs = makeFs({ [USER_MEMORY]: 'user knowledge', [notePath]: 'first version' })
  const { ctx, listeners, services } = makeCtx(fs, makeLlm('{}'))
  const results = []
  apply(
    ctx,
    trustConfig({ consumption: { maxTokens: 5000, onResult: (result) => results.push(result) } }),
  )
  const session = makeSession([], 'C:\\proj')
  const agent = makeAgent(session)

  const first = await runPreStep(listeners, agent)
  assert.equal(first.messages.length, 1)
  assert.equal(first.messages[0].source.form, 'snapshot')
  assert.match(first.messages[0].content[0].text, /first version/)
  assert.equal(results.length, 1, 'the first load reports')

  // The session then edits its own memory — exactly what the `memory` tool does.
  fs.touch(notePath, 'second version')
  const second = await runPreStep(listeners, agent)
  assert.equal(second.messages.length, 1, 'the change is injected without a refresh')
  const delta = second.messages[0]
  assert.equal(delta.source.form, 'notice', 'a delta must not declare itself a snapshot')
  assert.match(delta.content[0].text, /second version/)
  assert.doesNotMatch(delta.content[0].text, /user knowledge/, 'unchanged notes are not repeated')
  assert.doesNotMatch(delta.content[0].text, /recorded in earlier sessions/)
  assert.equal(results.length, 2, 'an actual injection reports')

  // Unchanged again: nothing is injected and nothing is reported.
  const third = await runPreStep(listeners, agent)
  assert.equal(third.messages.length, 0, 'an unchanged step injects nothing')
  assert.equal(results.length, 2, 'an unchanged probe must not fire onResult')
  assert.equal(services.get('memory').status().lastConsumption.blockHash.length, 8)
})

await test('a removed memory file is reported in the delta', async () => {
  const notePath = `${PROJECT_DIR}\\notes.md`
  const fs = makeFs({ [notePath]: 'a note' })
  const { ctx, listeners } = makeCtx(fs, makeLlm('{}'))
  apply(ctx, trustConfig())
  const session = makeSession([], 'C:\\proj')
  const agent = makeAgent(session)

  await runPreStep(listeners, agent)
  fs.files.delete(notePath)
  const delta = await runPreStep(listeners, agent)
  assert.equal(delta.messages.length, 1)
  assert.match(delta.messages[0].content[0].text, /Removed: project:notes\.md/)
})

await test('a resumed session reads the previous hashes off the durable message', async () => {
  const notePath = `${PROJECT_DIR}\\notes.md`
  const fs = makeFs({ [notePath]: 'first version' })
  const { ctx, listeners } = makeCtx(fs, makeLlm('{}'))
  apply(ctx, trustConfig())

  const firstSession = makeSession([], 'C:\\proj')
  const first = await runPreStep(listeners, makeAgent(firstSession))
  const durable = first.messages[0]

  // A new process: no live state, but the surface still holds the snapshot.
  fs.touch(notePath, 'second version')
  const resumed = makeSession([], 'C:\\proj')
  resumed.surface = { nodes: ['node-1'] }
  resumed.eventAt = () => ({ type: 'user/message', data: durable })
  const agent = makeAgent(resumed)
  const delta = await runPreStep(listeners, agent)

  assert.equal(delta.messages.length, 1)
  assert.equal(delta.messages[0].source.form, 'notice', 'a resume must continue with a delta, not reload everything')
  assert.match(delta.messages[0].content[0].text, /second version/)

  // A third process resumes on top of that delta and, with nothing changed,
  // stays quiet instead of reloading everything.
  const afterDelta = makeSession([], 'C:\\proj')
  afterDelta.surface = { nodes: ['node-2'] }
  afterDelta.eventAt = () => ({ type: 'user/message', data: delta.messages[0] })
  const quiet = await runPreStep(listeners, makeAgent(afterDelta))
  assert.equal(quiet.messages.length, 0)
})

await test('a paced pass still sees every turn it skipped', async () => {
  const plan = JSON.stringify({
    writes: [{ rootId: 'user', path: 'MEMORY.md', content: '# Index\n\n- a', mode: 'replace' }],
    reason: 'recorded',
  })
  const fs = makeFs({ [USER_MEMORY]: '# Index' })
  const llm = makeLlm(plan)
  const { ctx, listeners, services } = makeCtx(fs, llm)
  const results = []
  apply(
    ctx,
    loadConfig({
      mode: 'custom',
      projectScope: false,
      generation: {
        turnComplete: { minPromptChars: 1 },
        incremental: { everyTurns: 3 },
        onResult: (result) => results.push(result),
      },
    }),
  )
  const session = makeSession([], 'C:\\proj')
  const agent = makeAgent(session)
  const log = makeLog(session)
  // Each turn is allowed to settle, which is what makes three turns three
  // interval ticks; turns that overlap coalesce instead (see the next test).
  const sessionEvents = listeners.get('session/event')
  for (const [turn, prompt] of [[1, 'first turn prompt'], [2, 'second turn prompt'], [3, 'third turn prompt']]) {
    log.turn(listeners, agent, turn, prompt)
    await services.get('memory').flushMemory()
    void sessionEvents
  }

  assert.deepEqual(
    results.map((result) => result.status),
    ['skipped', 'skipped', 'saved'],
    'two turns are paced out, the third runs the pass',
  )
  assert.match(results[0].reason, /turn interval gate \(1 of 3 turns\)/)
  assert.match(results[1].reason, /turn interval gate \(2 of 3 turns\)/)
  assert.equal(llm.calls.length, 1, 'only the due turn reaches the model')

  // Qoder slices the transcript from the last processed message (`MOl`); without
  // that cursor the two paced-out turns would be lost.
  const seen = llm.calls[0].messages.map((message) => JSON.stringify(message.content)).join('\n')
  for (const prompt of ['first turn prompt', 'second turn prompt', 'third turn prompt']) {
    assert.match(seen, new RegExp(prompt), `${prompt} must reach the model`)
  }
})

await test('generation pauses after three consecutive failures and stops calling the model', async () => {
  // Qoder's `hFl = 3`: a broken route must stop costing a model call every turn. This is
  // the exact shape reported as "最近一次生成总是 failed" — the pass failed on turn 1 and
  // kept failing identically, once per turn, forever.
  const fs = makeFs({ [USER_MEMORY]: '# Index' })
  const llm = makeLlm(() => {
    throw new Error('provider exploded')
  })
  const { ctx, listeners, services } = makeCtx(fs, llm)
  const results = []
  apply(
    ctx,
    loadConfig({
      mode: 'custom',
      projectScope: false,
      generation: {
        pauseAfterFailures: 3,
        turnComplete: { minPromptChars: 1 },
        onResult: (result) => results.push(result),
      },
    }),
  )
  const session = makeSession([], 'C:\\proj')
  const agent = makeAgent(session)
  const log = makeLog(session)
  for (let turn = 1; turn <= 4; turn += 1) {
    log.turn(listeners, agent, turn, `turn ${turn} prompt with enough text`)
    await services.get('memory').flushMemory()
  }

  assert.deepEqual(
    results.map((result) => result.status),
    ['failed', 'failed', 'failed', 'skipped'],
    'three failures arm the pause; the fourth turn attempts nothing',
  )
  assert.match(results[0].reason, /provider exploded/, 'the cause is recorded')
  assert.equal(llm.calls.length, 3, 'a paused session spends no model call')
  assert.match(results[3].reason, /paused after 3 consecutive failures: provider exploded/)

  // Both readers see it before a human intervenes.
  const status = services.get('memory').status()
  assert.equal(status.generationPause.failures, 3)
  assert.equal(status.generationPause.sessionId, 'session-1')

  // The original never resumes; this port adds one escape hatch, and it must work.
  await services.get('memory').resumeGeneration()
  assert.equal(services.get('memory').status().generationPause, null, 'the pause is cleared')
  log.turn(listeners, agent, 5, 'turn five prompt with enough text')
  await services.get('memory').flushMemory()
  assert.equal(llm.calls.length, 4, 'resuming lets the next turn reach the model again')
  assert.equal(results.at(-1).status, 'failed', 'the route is still broken, of course')
})

await test('a success clears the failure count before it can arm the pause', async () => {
  // Two failures are not a pattern: one completed pass must forget them, or an
  // occasional provider hiccup would pause a healthy session.
  const fs = makeFs({ [USER_MEMORY]: '# Index' })
  let fail = true
  const llm = makeLlm(() => {
    if (fail) throw new Error('transient')
    return JSON.stringify({ writes: [], reason: 'nothing durable' })
  })
  const { ctx, listeners, services } = makeCtx(fs, llm)
  const results = []
  apply(
    ctx,
    loadConfig({
      mode: 'custom',
      projectScope: false,
      generation: {
        pauseAfterFailures: 3,
        turnComplete: { minPromptChars: 1 },
        onResult: (result) => results.push(result),
      },
    }),
  )
  const session = makeSession([], 'C:\\proj')
  const agent = makeAgent(session)
  const log = makeLog(session)
  const runTurn = async (turn) => {
    log.turn(listeners, agent, turn, `turn ${turn} prompt with enough text`)
    await services.get('memory').flushMemory()
  }

  await runTurn(1)
  await runTurn(2)
  fail = false
  await runTurn(3)
  assert.equal(results.at(-1).status, 'no_change', 'the third pass completed')
  fail = true
  await runTurn(4)
  await runTurn(5)
  assert.equal(services.get('memory').status().generationPause, null, 'two more failures are not three in a row')

  await runTurn(6)
  assert.equal(results.at(-1).status, 'failed', 'the arming pass is the third failure itself')
  assert.equal(services.get('memory').status().generationPause.failures, 3)
  await runTurn(7)
  assert.equal(results.at(-1).status, 'skipped', 'from the NEXT turn nothing is attempted')
  assert.match(results.at(-1).reason, /paused after 3 consecutive failures/)
})

await test('an operator gate bypasses the turn interval', async () => {
  const plan = JSON.stringify({ writes: [], reason: 'nothing durable' })
  const fs = makeFs({ [USER_MEMORY]: '# Index' })
  const llm = makeLlm(plan)
  const { ctx, listeners, services } = makeCtx(fs, llm)
  const results = []
  apply(
    ctx,
    loadConfig({
      mode: 'custom',
      projectScope: false,
      generation: {
        // Qoder sets `skipExtractionIntervalGate` when the caller supplied a
        // callback; here the equivalent is an operator-supplied gate.
        turnComplete: { shouldGenerate: async () => ({ run: true }), minPromptChars: 1 },
        incremental: { everyTurns: 5 },
        onResult: (result) => results.push(result),
      },
    }),
  )
  const session = makeSession([], 'C:\\proj')
  const agent = makeAgent(session)
  const log = makeLog(session)
  log.turn(listeners, agent, 1, 'first prompt here')
  await services.get('memory').flushMemory()
  assert.equal(results.at(-1).status, 'no_change', 'the operator decision wins over the interval')
  assert.equal(llm.calls.length, 1)
})

await test('turns completing during a pass coalesce into one follow-up', async () => {
  const plan = JSON.stringify({ writes: [], reason: 'nothing durable' })
  const fs = makeFs({ [USER_MEMORY]: '# Index' })
  let release
  const held = new Promise((resolve) => {
    release = resolve
  })
  const llm = makeLlm(plan, { before: (nth) => (nth === 0 ? held : undefined) })
  const { ctx, listeners, services } = makeCtx(fs, llm)
  apply(
    ctx,
    loadConfig({ mode: 'custom', projectScope: false, generation: { turnComplete: { minPromptChars: 1 } } }),
  )
  const session = makeSession([], 'C:\\proj')
  const agent = makeAgent(session)
  const log = makeLog(session)

  log.turn(listeners, agent, 1, 'a prompt for the first turn')
  await waitFor(() => llm.calls.length === 1, 'the first pass to reach the model')
  // Two more turns complete while that pass is still open.
  log.turn(listeners, agent, 2, 'a prompt for the second turn')
  log.turn(listeners, agent, 3, 'a prompt for the third turn')
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(llm.calls.length, 1, 'a pass in flight is never raced')

  release()
  await services.get('memory').flushMemory()
  assert.equal(llm.calls.length, 2, 'both turns coalesced into ONE follow-up pass')
  // The follow-up carries what the coalesced turns said, not just the last one.
  const seen = llm.calls[1].messages.map((message) => JSON.stringify(message.content)).join('\n')
  assert.match(seen, /a prompt for the third turn/)
})

await test('an unchanged step stats but does not re-read the memory files', async () => {
  const fs = makeFs({ [USER_MEMORY]: 'user knowledge' })
  const { ctx, listeners } = makeCtx(fs, makeLlm('{}'))
  apply(ctx, trustConfig())
  const session = makeSession([], 'C:\\proj')
  const agent = makeAgent(session)

  await runPreStep(listeners, agent)
  assert.deepEqual(fs.reads, [USER_MEMORY], 'the first load reads the index')

  await runPreStep(listeners, agent)
  assert.deepEqual(fs.reads, [USER_MEMORY], 'an unchanged step reads nothing more')

  // A real edit changes the provider version, so exactly that file is re-read.
  fs.touch(USER_MEMORY, 'user knowledge v2')
  const delta = await runPreStep(listeners, agent)
  assert.deepEqual(fs.reads, [USER_MEMORY, USER_MEMORY], 'only the changed file is re-read')
  assert.equal(delta.messages.length, 1, 'and the change still arrives as a delta')
  assert.match(delta.messages[0].content[0].text, /user knowledge v2/)

  // Cached again: the version is stable once more.
  await runPreStep(listeners, agent)
  assert.equal(fs.reads.length, 2)
})

await test('a session grant expands what the configuration blocks', async () => {
  const fs = makeFs({
    [`${PROJECT_DIR}\\MEMORY.md`]: 'index\n\n@C:/secrets/keys.md\n',
    'C:\\secrets\\keys.md': 'the secret',
  })
  const { ctx, listeners, commands } = makeCtx(fs, makeLlm('{}'))
  apply(ctx, trustConfig())
  const agent = makeAgent(makeSession([], 'C:\\proj'))

  const first = await runPreStep(listeners, agent)
  assert.match(first.messages[0].content[0].text, /Import blocked: C:\/secrets\/keys\.md/)

  // Qoder's `sessionExternalImportApproved`: the grant covers ONE session, and
  // its `refreshExternalImports()` re-resolves what was pending — here the
  // reload does it.
  const allowed = await runCommand(commands, 'memory-imports', { agent, rawInput: ' allow' })
  assert.match(allowed.text, /session external imports: approved/)
  assert.match(allowed.text, /1 import\(s\) resolved, 0 still blocked/)
  assert.ok(agent.injected.length > 0, 'the grant reloads so the import actually lands')
  assert.match(agent.injected.at(-1).content[0].text, /the secret/)

  // A different session is untouched by that grant.
  const other = makeAgent(makeSession([], 'C:\\proj'))
  const second = await runPreStep(listeners, other)
  assert.match(second.messages[0].content[0].text, /Import blocked/, 'the grant is per session')

  // And it can be revoked.
  const denied = await runCommand(commands, 'memory-imports', { agent, rawInput: ' deny' })
  assert.match(denied.text, /session external imports: not approved/)
  const status = await runCommand(commands, 'memory-imports', { agent })
  assert.match(status.text, /not approved/)
  const bogus = await runCommand(commands, 'memory-imports', { agent, rawInput: ' maybe' })
  assert.equal(bogus.kind, 'error')
})

await test('an oversized index is written anyway, with the warning reported', async () => {
  const plan = JSON.stringify({
    writes: [
      {
        rootId: 'user',
        path: 'MEMORY.md',
        content: `# Index\n\n- [a](a.md) - ${'x'.repeat(260)}\n`,
        mode: 'replace',
      },
    ],
    reason: 'rebuilt the index',
  })
  const fs = makeFs({ [USER_MEMORY]: '# Index' })
  const { ctx, listeners, services, commands } = makeCtx(fs, makeLlm(plan))
  apply(
    ctx,
    loadConfig({
      mode: 'custom',
      projectScope: false,
      generation: { turnComplete: { minPromptChars: 1 } },
    }),
  )
  const session = makeSession(turnEvents('a long enough prompt to pass the gate', 'done'), 'C:\\proj')
  const agent = makeAgent(session)
  listeners.get('agent/created')[0]({ agent })
  listeners.get('session/event')[0](session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  await services.get('memory').flushMemory()

  // Advisory, not a refusal: the write lands, and the result carries the advice.
  const written = services.get('memory').status().lastGeneration.writtenFiles
  assert.equal(written.length, 1)
  assert.equal(written[0].path, 'MEMORY.md')
  assert.equal(written[0].warnings[0].kind, 'long_lines')
  assert.match(written[0].warnings[0].message, /over about 200 characters/)
  assert.equal(fs.files.get(USER_MEMORY).includes('x'.repeat(260)), true, 'the content is on disk')

  const report = await runCommand(commands, 'memory', { agent })
  assert.match(report.text, /index warning: user:MEMORY\.md — 1 index line\(s\) over about 200 characters/)
})

await test('a file with `paths` loads only once the session touches a match', async () => {
  const jitFile = `${HOME}\\memory\\typescript.md`
  const fs = makeFs({
    [USER_MEMORY]: '# Index\n\n- [TypeScript](typescript.md) - repo conventions',
    [jitFile]: '---\ntype: project\npaths: ["**/*.ts"]\n---\n\nOnly load me when TypeScript is in play.',
  })
  const { ctx, listeners, services, commands, routes } = makeCtx(fs, makeLlm('{}'))
  apply(ctx, trustConfig())

  // A session that has touched nothing matching: the index loads, that file does not.
  const coldAgent = makeAgent(makeSession([], 'C:\\proj'))
  const cold = await runPreStep(listeners, coldAgent)
  assert.ok(
    !JSON.stringify(cold.messages).includes('Only load me when TypeScript is in play.'),
    'a glob-triggered file must not load before a match',
  )
  // A refresh publishes, which is where the per-file status is observable.
  await runCommand(commands, 'memory-refresh', { agent: coldAgent })
  const coldFiles = services.get('memory').status().lastConsumption.files
  assert.equal(coldFiles.find((file) => file.path === jitFile)?.status, 'jit_skipped')
  // The panel's own payload says why, rather than leaving the file invisible.
  assert.equal(services.get('memory').status().memoryChange.jitSkipped.length, 1)
  assert.match(services.get('memory').status().memoryChange.jitSkipped[0].reason, /no touched path matches/)
  const status = await callRoute(routes, '/api/memory/status', {})
  assert.equal(status.json.memoryChange.jitSkipped[0].path, jitFile)

  // A session working in TypeScript: the same file is now part of the context.
  const warmSession = makeSession([], 'C:\\proj')
  warmSession.deriveMessages = () => [{ role: 'user', content: 'look at C:\\proj\\src\\deep\\a.ts please' }]
  const warm = await runPreStep(listeners, makeAgent(warmSession))
  assert.equal(warm.messages.length, 1)
  assert.match(warm.messages[0].content[0].text, /Only load me when TypeScript is in play\./)
})

await test('a manual file never loads on its own', async () => {
  const manual = `${HOME}\\memory\\manual.md`
  const fs = makeFs({
    [USER_MEMORY]: '# Index\n\n- [Manual](manual.md) - read on request only',
    [manual]: '---\ntype: reference\ntrigger: false\n---\n\nManual-only knowledge.',
  })
  const { ctx, listeners, services, commands } = makeCtx(fs, makeLlm('{}'))
  apply(ctx, trustConfig())
  const session = makeSession([], 'C:\\proj')
  // Even a session that mentions the file by path does not pull it in.
  session.deriveMessages = () => [{ role: 'user', content: 'look at C:\\proj\\manual.md' }]
  const agent = makeAgent(session)
  const step = await runPreStep(listeners, agent)
  assert.ok(!JSON.stringify(step.messages).includes('Manual-only knowledge'), 'a manual file must not load')
  // It is still a known file, so the index pointer is not a dead end.
  await runCommand(commands, 'memory-refresh', { agent })
  assert.equal(
    services.get('memory').status().lastConsumption.files.find((file) => file.path === manual)?.status,
    'jit_skipped',
  )
})

await test('a nested directory inside a memory root is not memory content', async () => {
  // Qoder has a `<projectMemoryDir>/skills` accessor; this pins that such a
  // subdirectory could never leak into the context through the flat file set.
  const fs = makeFs({
    [USER_MEMORY]: '# Index\n\n- top level only',
    [`${HOME}\\memory\\skills\\generated.md`]: 'nested skill text that must not be injected',
    [`${HOME}\\memory\\notes\\deep.md`]: 'nested note text that must not be injected',
  })
  const { ctx, listeners, routes } = makeCtx(fs, makeLlm('{}'))
  apply(ctx, trustConfig())
  const step = await runPreStep(listeners, makeAgent(makeSession([], 'C:\\proj')))
  const text = JSON.stringify(step.messages)
  assert.match(text, /top level only/)
  assert.ok(!text.includes('nested skill text'), 'a subdirectory is not part of the root set')
  assert.ok(!text.includes('nested note text'))
  // And the panel lists the same flat set, so a nested folder is not offered either.
  const status = await callRoute(routes, '/api/memory/status', {})
  assert.deepEqual(status.json.roots[0].files, ['MEMORY.md'])
})

await test('in-turn generation is off unless it is switched on', async () => {
  const plan = JSON.stringify({
    writes: [{ rootId: 'user', path: 'MEMORY.md', content: '# Index\n\n- mid', mode: 'replace' }],
    reason: 'recorded',
  })
  const fs = makeFs({ [USER_MEMORY]: '# Index' })
  const llm = makeLlm(plan)
  const { ctx, listeners } = makeCtx(fs, llm)
  apply(ctx, loadConfig({ mode: 'custom', projectScope: false, generation: { turnComplete: { minPromptChars: 1 } } }))
  const session = makeSession([], 'C:\\proj')
  const agent = makeAgent(session)
  const log = makeLog(session)
  // An open turn: user message and a tool round, but no turn/end yet.
  log.log.push(
    { type: 'turn/start', seq: 0, data: { turn: 1 } },
    { type: 'user/message', seq: 1, data: { content: [{ type: 'text', text: 'a long task, step one' }] } },
    { type: 'assistant/message', seq: 2, data: { message: { content: [{ type: 'text', text: 'ran the first tool' }] } } },
  )
  await runPreStep(listeners, agent)
  assert.equal(llm.calls.length, 0, 'the default must not spend a model call inside a turn')
})

await test('in-turn generation records mid-turn work, and the cursor keeps it incremental', async () => {
  const plan = JSON.stringify({
    writes: [{ rootId: 'user', path: 'MEMORY.md', content: '# Index\n\n- mid', mode: 'replace' }],
    reason: 'recorded mid-turn',
  })
  const fs = makeFs({ [USER_MEMORY]: '# Index' })
  const llm = makeLlm(plan)
  const { ctx, listeners, services } = makeCtx(fs, llm)
  apply(
    ctx,
    loadConfig({
      mode: 'custom',
      projectScope: false,
      generation: { turnComplete: { minPromptChars: 1 }, incremental: { midTurn: true } },
    }),
  )
  const session = makeSession([], 'C:\\proj')
  const agent = makeAgent(session)
  const log = makeLog(session)
  log.log.push(
    { type: 'turn/start', seq: 0, data: { turn: 1 } },
    { type: 'user/message', seq: 1, data: { content: [{ type: 'text', text: 'a long task, step one' }] } },
    { type: 'assistant/message', seq: 2, data: { message: { content: [{ type: 'text', text: 'ran the first tool' }] } } },
  )

  await runPreStep(listeners, agent)
  await services.get('memory').flushMemory()
  assert.equal(llm.calls.length, 1, 'an open turn with new messages generates')
  const first = services.get('memory').status().lastGeneration
  assert.equal(first.status, 'saved')
  assert.equal(first.turn, 1, 'it names the turn it ran inside')
  assert.equal(first.midTurn, true, 'and says it was an in-turn pass')
  assert.match(first.reason, /recorded mid-turn/)
  assert.match(JSON.stringify(llm.calls[0].messages), /a long task, step one/)

  // A step with nothing new stays quiet: that is what keeps this affordable.
  await runPreStep(listeners, agent)
  await services.get('memory').flushMemory()
  assert.equal(llm.calls.length, 1, 'a step with no new messages is free')

  // The next tool round is new content again, and the pass sees only that round.
  log.log.push({
    type: 'assistant/message',
    seq: 3,
    data: { message: { content: [{ type: 'text', text: 'ran the second tool' }] } },
  })
  await runPreStep(listeners, agent)
  await services.get('memory').flushMemory()
  assert.equal(llm.calls.length, 2)
  const second = JSON.stringify(llm.calls[1].messages)
  assert.match(second, /ran the second tool/)
  assert.ok(!second.includes('a long task, step one'), 'the cursor must not resend what was already recorded')
})
console.log(`\n${passed} integration pipeline tests passed`)
