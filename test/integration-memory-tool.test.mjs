/**
 * Integration test — the memory tool.
 *
 * Drives the real `apply()` against the Harness doubles in
 * `test/support/integration-harness.mjs`. Split by topic from the single
 * integration suite; each suite is still one standalone process.
 *
 * Run: node test/integration-memory-tool.test.mjs
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

console.log('dsh-memory integration tests — the memory tool')

await test('the memory tool offers list, read, search, write, edit and delete in one schema', async () => {
  const fs = projectMemoryFixture()
  const { ctx, tools } = makeCtx(fs, makeLlm('{}'))
  apply(ctx, trustConfig())
  const definition = tools.registered.get('memory')
  assert.ok(definition, 'the memory tool must be registered')
  assert.deepEqual(definition.parameters.properties.action.enum, ['list', 'read', 'search', 'write', 'edit', 'delete'])
  assert.ok(definition.parameters.properties.query, 'search needs a query property')
  // `edit` needs its own three fields, and they must be DECLARED: the harness validates arguments
  // against this schema, so an undeclared `old_string` would be rejected before the tool ever ran.
  assert.ok(definition.parameters.properties.old_string, 'edit needs old_string')
  assert.ok(definition.parameters.properties.new_string, 'edit needs new_string')
  assert.ok(definition.parameters.properties.replace_all, 'edit needs the replace_all opt-in')
})

await test('every value the memory tool returns satisfies its own declared output schema', async () => {
  // THE HARNESS VALIDATES THIS SCHEMA AGAINST EVERY RETURNED VALUE, and rejects an undeclared key
  // outright: `tool "memory" returned invalid output: "value.files[0].deleted" is not a declared
  // property (additionalProperties: false)`. That is exactly what a successful DELETE used to
  // produce — the file really was removed, but the model was told the call was invalid, so it had
  // no way to know what happened.
  //
  // Driving every action through the REAL validator is what makes this class of bug impossible:
  // a per-action assertion could not have caught it, because the schema is what was wrong.
  const toolsEntry = resolveInstalled('@deepseek-ai/dsh-tools')
  if (toolsEntry === undefined) {
    console.log('  --  (skipped: @deepseek-ai/dsh-tools is not installed here)')
    return
  }
  const { validateJsonSchemaValue } = await import(pathToFileURL(toolsEntry).href)

  const fs = projectMemoryFixture()
  const { ctx, tools } = makeCtx(fs, makeLlm('{}'))
  apply(ctx, trustConfig())
  const agent = makeAgent(makeSession([], 'C:\\proj'))
  const schema = tools.registered.get('memory').output.schema

  // One call per action, including the failure paths and the delete that started this.
  const calls = [
    { action: 'list' },
    { action: 'list', scope: 'user' },
    { action: 'read', path: 'MEMORY.md' },
    { action: 'read', path: 'missing.md' },
    { action: 'search', query: 'knowledge' },
    { action: 'write', path: 'new.md', content: '# new\n' },
    // `edit` on every path: applied, ambiguous, not found, missing file. The success case returns the
    // same shape as `write`, and the refusals must too — a refusal that returned an undeclared key
    // would be reported to the model as an invalid call rather than as the refusal it is.
    { action: 'edit', path: 'new.md', old_string: '# new', new_string: '# newer' },
    { action: 'edit', path: 'new.md', old_string: '#', new_string: '#', replace_all: true },
    { action: 'edit', path: 'new.md', old_string: 'absent', new_string: 'x' },
    { action: 'edit', path: 'gone.md', old_string: 'a', new_string: 'b' },
    { action: 'delete', path: 'MEMORY.md' },
    { action: 'delete', path: 'never-existed.md' },
    { action: 'list', path: '../escape.md' },
  ]
  for (const args of calls) {
    const value = await runTool(tools, agent, args)
    const violations = validateJsonSchemaValue(schema, value)
    assert.deepEqual(
      violations,
      [],
      `${JSON.stringify(args)} returned ${JSON.stringify(value)} — ${violations.join('; ')}`,
    )
  }

  // The delete really did return the field that used to be undeclared, so this test would fail
  // again if the declaration were removed.
  const removed = await runTool(tools, agent, { action: 'read', path: 'new.md' })
  assert.equal(removed.ok, true, 'the written file is readable')
  const deletion = await runTool(tools, agent, { action: 'delete', path: 'new.md' })
  assert.equal(deletion.ok, true)
  // `scope` defaults to project, and the write above used that default too.
  assert.deepEqual(deletion.files, [{ rootId: 'project', path: 'new.md', bytes: 0, deleted: true }])
  assert.deepEqual(validateJsonSchemaValue(schema, deletion), [])
})

await test('a missing path is refused as missing, not as malformed', async () => {
  // A refusal that misdirects is worse than a terse one. `path` is optional in the schema (only
  // `action` is required, since `list`/`search` need none), so omitting it on `read`/`write`/`edit`/
  // `delete` used to fall through to the FORMAT check and answer "path must be a relative .md path
  // inside the scope root" — blaming the spelling of a path that was never sent. Hit live while
  // editing a memory note, which cost several turns chasing a format problem that did not exist.
  const fs = makeFs({})
  const { ctx, tools } = makeCtx(fs, makeLlm('{}'))
  apply(ctx, loadConfig({ mode: 'custom', generation: { turnComplete: { enabled: false } } }))
  const agent = makeAgent(makeSession([], 'C:\\proj'))

  for (const action of ['read', 'write', 'edit', 'delete']) {
    const result = await runTool(tools, agent, action === 'write' ? { action, content: 'x' } : { action })
    assert.equal(result.ok, false, `${action} without a path must be refused`)
    assert.match(result.message, /path is required/, `${action}: must say the path is MISSING`)
    assert.doesNotMatch(result.message, /must be a relative/, `${action}: must not blame the format`)
  }

  // A path that IS present but malformed still gets the format message — the two cases stay distinct.
  const malformed = await runTool(tools, agent, { action: 'read', path: '../escape.md' })
  assert.equal(malformed.ok, false)
  assert.match(malformed.message, /must be a relative \.md path/, 'a real format problem keeps its own message')
})

await test('the memory tool edits one passage, leaving the rest of the file alone', async () => {
  // The reason `edit` exists: `write` replaces the whole file, so a model that means to change one
  // line must reproduce every other line perfectly. Memory files are prose, and a whole-file rewrite
  // silently drops whatever the model did not reproduce.
  const fs = makeFs({
    [`${HOME}\\projects\\--C-proj--\\memory\\NOTE.md`]: '---\nname: Note\n---\n\nold line\n\ntrailing text\n',
  })
  const { ctx, tools } = makeCtx(fs, makeLlm('{}'))
  apply(ctx, trustConfig())
  const agent = makeAgent(makeSession([], 'C:\\proj'))

  const edited = await runTool(tools, agent, {
    action: 'edit',
    path: 'NOTE.md',
    old_string: 'old line',
    new_string: 'new line',
  })
  assert.equal(edited.ok, true, edited.message)
  assert.match(edited.message, /edited project:NOTE\.md \(1 replacement/)
  const after = fs.files.get(`${HOME}\\projects\\--C-proj--\\memory\\NOTE.md`)
  assert.equal(after, '---\nname: Note\n---\n\nnew line\n\ntrailing text\n', 'only the passage changed')
  assert.deepEqual(edited.files, [{ rootId: 'project', path: 'NOTE.md', bytes: Buffer.byteLength(after, 'utf8') }])
})

await test('the memory tool refuses an ambiguous edit and an edit that matches nothing', async () => {
  const fs = makeFs({
    [`${HOME}\\projects\\--C-proj--\\memory\\NOTE.md`]: 'same\nmiddle\nsame\n',
  })
  const { ctx, tools } = makeCtx(fs, makeLlm('{}'))
  apply(ctx, trustConfig())
  const agent = makeAgent(makeSession([], 'C:\\proj'))
  const path = `${HOME}\\projects\\--C-proj--\\memory\\NOTE.md`
  const before = fs.files.get(path)

  const ambiguous = await runTool(tools, agent, { action: 'edit', path: 'NOTE.md', old_string: 'same', new_string: 'x' })
  assert.equal(ambiguous.ok, false)
  assert.match(ambiguous.message, /appears 2 times/)
  assert.equal(fs.files.get(path), before, 'a refused edit must not touch the file')

  const missing = await runTool(tools, agent, { action: 'edit', path: 'NOTE.md', old_string: 'absent', new_string: 'x' })
  assert.equal(missing.ok, false)
  assert.match(missing.message, /not found/)
  assert.equal(fs.files.get(path), before)

  // `replace_all` is the opt-in that makes the ambiguous case legal.
  const all = await runTool(tools, agent, { action: 'edit', path: 'NOTE.md', old_string: 'same', new_string: 'x', replace_all: true })
  assert.equal(all.ok, true)
  assert.match(all.message, /2 replacements/)
  assert.equal(fs.files.get(path), 'x\nmiddle\nx\n')

  // A file that does not exist is its own answer, not a create.
  const absentFile = await runTool(tools, agent, { action: 'edit', path: 'nope.md', old_string: 'a', new_string: 'b' })
  assert.equal(absentFile.ok, false)
  assert.match(absentFile.message, /does not exist/)
})

await test('an edit that lost a race is REFUSED, not applied over somebody else’s change', async () => {
  // THE property that makes `edit` better than `write` for a change to an existing file, and the one
  // no other test can see: `editGuarded` reads the body, computes the replacement, and writes with
  // `replaceIfVersion` against the version IT read. If the file changed in between — the user edited
  // it, another session wrote it, the background pass rewrote it — the write is refused.
  //
  // `write` has no such protection for this case: it stats immediately before writing, so a change
  // made after the model READ the file (but before it wrote) is silently overwritten.
  const path = `${HOME}\\projects\\--C-proj--\\memory\\NOTE.md`
  const fs = makeFs({ [path]: 'original body\n' })
  const { ctx, tools } = makeCtx(fs, makeLlm('{}'))
  apply(ctx, trustConfig())
  const agent = makeAgent(makeSession([], 'C:\\proj'))

  // Race the edit: the file changes between the tool's read and its write. The double's
  // `replaceIfVersion` compares versions, so this is a real interleaving, not a simulated flag.
  const realWriteText = fs.writeText
  fs.writeText = async (target, content, expected, signal, policy) => {
    fs.touch(path, 'somebody else wrote this\n')
    return realWriteText.call(fs, target, content, expected, signal, policy)
  }
  const raced = await runTool(tools, agent, { action: 'edit', path: 'NOTE.md', old_string: 'original body', new_string: 'mine' })
  fs.writeText = realWriteText

  assert.equal(raced.ok, false, 'the edit must not be applied over a change it never saw')
  assert.match(raced.message, /changed since it was read/)
  assert.equal(fs.files.get(path), 'somebody else wrote this\n', 'the other writer’s change survives')
})

await test('an edit may grow a file freely — there is no byte cap to hit', async () => {
  // `generation.maxWriteBytes` was this port's own per-file ceiling and is gone (Qoder has no such
  // field), so the same edit that used to be refused now simply applies. What remains is the
  // compare-and-swap: the edit is still computed against the version it read.
  const path = `${HOME}\\projects\\--C-proj--\\memory\\NOTE.md`
  const fs = makeFs({ [path]: 'small\n' })
  const { ctx, tools } = makeCtx(fs, makeLlm('{}'))
  apply(ctx, trustConfig())
  const agent = makeAgent(makeSession([], 'C:\\proj'))

  const grown = await runTool(tools, agent, { action: 'edit', path: 'NOTE.md', old_string: 'small', new_string: 'x'.repeat(2000) })
  assert.equal(grown.ok, true)
  assert.equal(fs.files.get(path), `${'x'.repeat(2000)}\n`, 'the whole edit landed')
})

await test('a muted session cannot edit, and the refusal says why', async () => {
  // `edit` is a mutation, so it follows the switch exactly as `write` and `delete` do. A read stays
  // available in a muted session; a change does not.
  const path = `${HOME}\\projects\\--C-proj--\\memory\\NOTE.md`
  const fs = makeFs({ [path]: 'body\n' })
  const { ctx, tools, services } = makeCtx(fs, makeLlm('{}'))
  apply(ctx, trustConfig())
  const agent = makeAgent(makeSession([], 'C:\\proj'))
  await services.get('memory').setMemorySwitch(agent.session, 'off')

  const refused = await runTool(tools, agent, { action: 'edit', path: 'NOTE.md', old_string: 'body', new_string: 'changed' })
  assert.equal(refused.ok, false)
  assert.match(refused.message, /switched off/)
  assert.equal(fs.files.get(path), 'body\n', 'a muted session must not leave a trace')
})

await test('the memory tool searches every scope, not just the selected one', async () => {
  const fs = projectMemoryFixture()
  const { ctx, tools } = makeCtx(fs, makeLlm('{}'))
  apply(ctx, trustConfig())
  const agent = makeAgent(makeSession([], 'C:\\proj'))

  // The user scope holds 'user knowledge' and the project scope 'project
  // knowledge'; a search for the shared word must reach both roots even though
  // `scope` defaults to project.
  const result = await runTool(tools, agent, { action: 'search', query: 'knowledge' })
  assert.equal(result.ok, true)
  assert.match(result.message, /user:MEMORY\.md:1 \[index\] user knowledge/)
  assert.match(result.message, /project:MEMORY\.md:1 \[index\] project knowledge/)
  assert.equal(result.files.length, 2)

  const miss = await runTool(tools, agent, { action: 'search', query: 'nothing-like-this' })
  assert.equal(miss.ok, true)
  assert.match(miss.message, /no memory matches/)
  assert.deepEqual(miss.files, [])
})

await test('the memory tool refuses a search without a query', async () => {
  const fs = projectMemoryFixture()
  const { ctx, tools } = makeCtx(fs, makeLlm('{}'))
  apply(ctx, trustConfig())
  const result = await runTool(tools, makeAgent(makeSession([], 'C:\\proj')), { action: 'search', query: '   ' })
  assert.equal(result.ok, false)
  assert.match(result.message, /query is required/)
})

await test('the memory tool cannot search an untrusted project scope', async () => {
  const fs = projectMemoryFixture()
  const { ctx, tools } = makeCtx(fs, makeLlm('{}'))
  apply(ctx, trustConfig({ trust: { enabled: true } }))
  const result = await runTool(tools, makeAgent(makeSession([], 'C:\\proj')), { action: 'search', query: 'knowledge' })
  assert.match(result.message, /user:MEMORY\.md/)
  assert.doesNotMatch(result.message, /project:MEMORY\.md/, 'a gated root must not be searchable')
})
console.log(`\n${passed} integration memory-tool tests passed`)
