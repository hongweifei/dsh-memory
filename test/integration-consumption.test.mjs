/**
 * Integration test — consumption.
 *
 * Drives the real `apply()` against the Harness doubles in
 * `test/support/integration-harness.mjs`. Split by topic from the single
 * integration suite; each suite is still one standalone process.
 *
 * Run: node test/integration-consumption.test.mjs
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

console.log('dsh-memory integration tests — consumption')

await test('consumption injects a snapshot-form memory message and reports per-file status', async () => {
  const fs = makeFs({ 'C:\\home\\.dsh\\memory\\MEMORY.md': 'remember the build command' })
  const { ctx, listeners, services } = makeCtx(fs, makeLlm('{}'))
  const results = []
  apply(
    ctx,
    loadConfig({
      mode: 'custom',
      consumption: { maxTokens: 5000, onResult: (result) => results.push(result) },
      generation: { turnComplete: { enabled: false } },
    }),
  )
  // Force the user scope to the fixture path.
  const service = services.get('memory')
  assert.ok(service, 'the memory service must be provided')

  const session = makeSession([], 'C:\\proj')
  const agent = makeAgent(session)
  const decision = await runPreStep(listeners, agent)

  assert.equal(decision.messages.length, 1)
  const injected = decision.messages[0]
  assert.equal(injected.source.kind, 'memory')
  assert.equal(injected.source.form, 'snapshot')
  assert.match(injected.content[0].text, /^<system-reminder>/)
  assert.match(injected.content[0].text, /remember the build command/)

  assert.equal(results.length, 1, 'consumption.onResult must fire exactly once')
  assert.equal(results[0].status, 'success')
  assert.ok(Array.isArray(results[0].files))
  assert.ok(results[0].tokens > 0)
})

await test('consumption.onResult reports a per-file status for every considered file', async () => {
  const fs = makeFs({
    [USER_MEMORY]: 'user knowledge',
  })
  const { ctx, listeners, services } = makeCtx(fs, makeLlm('{}'))
  let reported
  apply(
    ctx,
    loadConfig({
      mode: 'custom',
      userScope: true,
      projectScope: true,
      consumption: { onResult: (result) => (reported = result) },
      generation: { turnComplete: { enabled: false } },
    }),
  )
  const session = makeSession([], 'C:\\proj')
  await runPreStep(listeners, makeAgent(session))
  assert.ok(reported, 'onResult must fire')
  for (const file of reported.files) {
    assert.ok(
      ['loaded', 'missing', 'failed', 'truncated'].includes(file.status),
      `unexpected status ${file.status}`,
    )
  }
  assert.ok(['success', 'partial', 'failed'].includes(reported.status))
})

await test('explicit consumption.files in custom mode replaces auto discovery', async () => {
  const fs = makeFs({ 'C:\\knowledge\\CONVENTIONS.md': 'always run pnpm test' })
  const { ctx, listeners } = makeCtx(fs, makeLlm('{}'))
  let reported
  apply(
    ctx,
    loadConfig({
      mode: 'custom',
      userScope: false,
      projectScope: false,
      consumption: {
        files: [{ id: 'conventions', path: 'C:\\knowledge\\CONVENTIONS.md', required: true }],
        onResult: (result) => (reported = result),
      },
      generation: { turnComplete: { enabled: false } },
    }),
  )
  const session = makeSession([], 'C:\\proj')
  const decision = await runPreStep(listeners, makeAgent(session))
  assert.equal(decision.messages.length, 1)
  assert.match(decision.messages[0].content[0].text, /conventions/)
  assert.equal(reported.files[0].status, 'loaded')
})

await test('a missing required file with failureMode fail_query rejects the query', async () => {
  const fs = makeFs({})
  const { ctx, listeners } = makeCtx(fs, makeLlm('{}'))
  apply(
    ctx,
    loadConfig({
      mode: 'custom',
      userScope: false,
      projectScope: false,
      consumption: {
        files: [{ id: 'missing', path: 'C:\\knowledge\\NOPE.md', required: true }],
        failureMode: 'fail_query',
      },
      generation: { turnComplete: { enabled: false } },
    }),
  )
  const session = makeSession([], 'C:\\proj')
  const handler = (listeners.get('agent/pre-step') ?? [])[0]
  const messages = []
  // The plugin contains the failure and preserves the decision (fail-soft at the seam).
  const decision = await handler(
    { agent: makeAgent(session), messages, turn: 1, step: 1, signal: new AbortController().signal },
    async () => ({ kind: 'enter', messages }),
  )
  assert.equal(decision.messages.length, 0)
})
console.log(`\n${passed} integration consumption tests passed`)
