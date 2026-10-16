/**
 * Integration test — folder trust.
 *
 * Drives the real `apply()` against the Harness doubles in
 * `test/support/integration-harness.mjs`. Split by topic from the single
 * integration suite; each suite is still one standalone process.
 *
 * Run: node test/integration-trust.test.mjs
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

console.log('dsh-memory integration tests — folder trust')

await test('an off gate leaves the project scope exactly as it was', async () => {
  const fs = projectMemoryFixture()
  const { ctx, listeners, services } = makeCtx(fs, makeLlm('{}'))
  apply(ctx, trustConfig())

  const init = await services.get('memory').initializationResult()
  assert.deepEqual(init.roots.map((root) => root.id), ['user', 'project'])
  const decision = await runPreStep(listeners, makeAgent(makeSession([], 'C:\\proj')))
  assert.match(decision.messages[0].content[0].text, /project knowledge/)
})

await test('an enabled gate drops the project root in an untrusted folder', async () => {
  const fs = projectMemoryFixture()
  const { ctx, listeners, services } = makeCtx(fs, makeLlm('{}'))
  apply(ctx, trustConfig({ trust: { enabled: true } }))

  const init = await services.get('memory').initializationResult()
  assert.deepEqual(init.roots.map((root) => root.id), ['user'], 'only the user scope survives the gate')
  assert.deepEqual(init.trust, { enabled: true, folders: [] })

  const decision = await runPreStep(listeners, makeAgent(makeSession([], 'C:\\proj')))
  const text = decision.messages[0].content[0].text
  assert.match(text, /user knowledge/, 'user memory still loads')
  assert.doesNotMatch(text, /project knowledge/, 'project memory must not reach an untrusted session')
})

await test('an enabled gate keeps the project root when a declared folder covers it', async () => {
  const fs = projectMemoryFixture()
  const { ctx, listeners } = makeCtx(fs, makeLlm('{}'))
  apply(
    ctx,
    trustConfig({
      trust: { enabled: true, folders: ['C:\\proj'] },
    }),
  )
  // Asserted through a session pass, not `initializationResult()`: that method
  // has no agent and can only resolve the HOST's working directory, so a
  // fixture folder is not a valid probe for it.
  const decision = await runPreStep(listeners, makeAgent(makeSession([], 'C:\\proj')))
  assert.match(decision.messages[0].content[0].text, /project knowledge/)
})

await test('a remembered decision in the store also lifts the gate', async () => {
  const fs = projectMemoryFixture({ [TRUST_STORE]: JSON.stringify({ folders: ['C:\\proj'] }) })
  const { ctx, listeners } = makeCtx(fs, makeLlm('{}'))
  apply(ctx, trustConfig({ trust: { enabled: true } }))
  const decision = await runPreStep(listeners, makeAgent(makeSession([], 'C:\\proj')))
  assert.match(decision.messages[0].content[0].text, /project knowledge/)
})

await test('a damaged trust store is treated as nothing remembered', async () => {
  const fs = projectMemoryFixture({ [TRUST_STORE]: '{ not json' })
  const { ctx, listeners } = makeCtx(fs, makeLlm('{}'))
  apply(ctx, trustConfig({ trust: { enabled: true } }))
  const decision = await runPreStep(listeners, makeAgent(makeSession([], 'C:\\proj')))
  assert.doesNotMatch(decision.messages[0].content[0].text, /project knowledge/)
})

await test('/memory-trust allow remembers the folder across sessions', async () => {
  const fs = projectMemoryFixture()
  const { ctx, listeners, commands } = makeCtx(fs, makeLlm('{}'))
  apply(ctx, trustConfig({ trust: { enabled: true } }))
  const agent = makeAgent(makeSession([], 'C:\\proj'))

  const before = await runCommand(commands, 'memory-trust', { agent })
  assert.match(before.text, /trusted=false/)
  assert.match(before.text, /\/memory-trust allow/)

  const allowed = await runCommand(commands, 'memory-trust', { agent, rawInput: ' allow' })
  assert.match(allowed.text, /trusted=true/)
  const stored = JSON.parse(fs.files.get(TRUST_STORE))
  assert.deepEqual(stored.folders, ['C:\\proj'], 'the decision must be persisted outside every memory root')

  // A later pass — the "across sessions" half — now sees the project scope.
  const decision = await runPreStep(listeners, makeAgent(makeSession([], 'C:\\proj')))
  assert.match(decision.messages[0].content[0].text, /project knowledge/)

  const denied = await runCommand(commands, 'memory-trust', { agent, rawInput: ' deny' })
  assert.match(denied.text, /trusted=false/)
  assert.deepEqual(JSON.parse(fs.files.get(TRUST_STORE)).folders, [])
})

await test('/memory-trust rejects an unknown action and names the right one', async () => {
  const fs = projectMemoryFixture()
  const { ctx, commands } = makeCtx(fs, makeLlm('{}'))
  apply(ctx, trustConfig({ trust: { enabled: true } }))
  const agent = makeAgent(makeSession([], 'C:\\proj'))
  const result = await runCommand(commands, 'memory-trust', { agent, rawInput: ' maybe' })
  assert.equal(result.kind, 'error')
  assert.match(result.text, /unknown action "maybe"/)
  for (const name of ['memory', 'memory-trust', 'memory-refresh', 'memory-flush']) {
    assert.ok(commands.registered.has(name), `/${name} must be registered`)
  }
})

await test('/memory reports the trust decision and why a scope is missing', async () => {
  const fs = projectMemoryFixture()
  const { ctx, commands } = makeCtx(fs, makeLlm('{}'))
  apply(ctx, trustConfig({ trust: { enabled: true } }))
  const agent = makeAgent(makeSession([], 'C:\\proj'))
  const result = await runCommand(commands, 'memory', { agent })
  assert.match(result.text, /trust: enabled trusted=false folder=C:\\proj/)
  assert.match(result.text, /project scope is skipped here/)
  // The identity line names the directory the harness would group this session
  // under, its project key, and the workspace id when one exists.
  assert.match(result.text, /project: C:\\proj \(key --C-proj--, workspace none\)/)
  assert.doesNotMatch(result.text, /^- project /, 'the untrusted project root must not be listed')
})

await test('a disabled gate says so instead of claiming a decision', async () => {
  const fs = projectMemoryFixture()
  const { ctx, commands } = makeCtx(fs, makeLlm('{}'))
  apply(ctx, trustConfig())
  const result = await runCommand(commands, 'memory', {
    agent: makeAgent(makeSession([], 'C:\\proj')),
  })
  assert.match(result.text, /trust: disabled/)
})

await test('the gate also hides the project root from the generation pass', async () => {
  const fs = projectMemoryFixture()
  const plan = JSON.stringify({
    writes: [{ rootId: 'project', path: 'MEMORY.md', content: '# Project\n\nuse pnpm', mode: 'replace' }],
    reason: 'recorded the package manager',
  })
  const { ctx, listeners, services } = makeCtx(fs, makeLlm(plan))
  let reported
  apply(
    ctx,
    trustConfig({
      trust: { enabled: true },
      generation: {
        turnComplete: { minPromptChars: 1 },
        onResult: (result) => (reported = result),
      },
    }),
  )
  const session = makeSession(turnEvents('please set up the project and document the build', 'done'), 'C:\\proj')
  const agent = makeAgent(session)
  listeners.get('agent/created')[0]({ agent })
  listeners.get('session/event')[0](session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  await services.get('memory').flushMemory()

  assert.notEqual(reported.status, 'saved', 'an untrusted folder must not accept project writes')
  assert.deepEqual(reported.writtenFiles, [])
  assert.equal(fs.files.get(PROJECT_MEMORY), 'project knowledge', 'the untrusted project memory stays untouched')
  // The root is simply absent, so a planned project write is refused as an
  // unknown root rather than silently dropped.
  assert.equal(reported.failedFiles.length, 1)
  assert.equal(reported.failedFiles[0].error, 'unknown root')
  assert.equal(reported.failedFiles[0].rootId, 'project')
})

await test('the status route publishes the trust decision for the panel', async () => {
  const fs = projectMemoryFixture()
  const { ctx, routes } = makeCtx(fs, makeLlm('{}'))
  apply(ctx, trustConfig({ trust: { enabled: true } }))
  const { status, json } = await callRoute(routes, '/api/memory/status', {})
  assert.equal(status, 200)
  assert.equal(json.trust.enabled, true)
  assert.equal(json.trust.trusted, false)
  assert.deepEqual(
    json.roots.map((root) => root.id),
    ['user'],
  )
  assert.deepEqual(json.trust.declared, [])
  assert.deepEqual(json.trust.remembered, [])
  assert.equal(json.trustEnabled, true, 'the service snapshot still carries the declared switch')
  assert.deepEqual(json.trustedFolders, [], 'and the declared list')
})

await test('the memory tool deletes a file, and refuses one outside the root', async () => {
  const fs = projectMemoryFixture()
  const { ctx, tools } = makeCtx(fs, makeLlm('{}'))
  apply(ctx, trustConfig())
  const agent = makeAgent(makeSession([], 'C:\\proj'))

  const refused = await runTool(tools, agent, { scope: 'project', action: 'delete', path: '../escape.md' })
  assert.equal(refused.ok, false)
  assert.match(refused.message, /relative \.md path/)

  const absent = await runTool(tools, agent, { scope: 'project', action: 'delete', path: 'nope.md' })
  assert.equal(absent.ok, false)
  assert.match(absent.message, /does not exist/)

  // The project index really goes away, and the tool says what to do next.
  const indexAt = `${HOME}\\.dsh\\projects\\--C-proj--\\memory\\MEMORY.md`
  assert.equal(fs.files.has(PROJECT_MEMORY), true)
  const deleted = await runTool(tools, agent, { scope: 'project', action: 'delete', path: 'MEMORY.md' })
  assert.equal(deleted.ok, true)
  assert.match(deleted.message, /deleted project:MEMORY\.md/)
  assert.match(deleted.message, /rewrite the index without its entry/)
  assert.equal(fs.files.has(PROJECT_MEMORY), false, 'the file is really gone')
  assert.ok(![...fs.files.keys()].includes(indexAt), 'and it is gone at the resolved path too')
})

await test('/memory-delete removes a file, and refuses a bad spec', async () => {
  const fs = projectMemoryFixture({ [`${HOME}\\memory\\notes.md`]: 'a note worth retiring' })
  const { ctx, commands } = makeCtx(fs, makeLlm('{}'))
  apply(ctx, trustConfig())
  const agent = makeAgent(makeSession([], 'C:\\proj'))

  const bad = await runCommand(commands, 'memory-delete', { agent, rawInput: 'MEMORY.md' })
  assert.equal(bad.kind, 'error')
  assert.match(bad.text, /use <scope>:<path>/)

  const unknown = await runCommand(commands, 'memory-delete', { agent, rawInput: 'nope:MEMORY.md' })
  assert.equal(unknown.kind, 'error')
  assert.match(unknown.text, /unknown root/)

  const missing = await runCommand(commands, 'memory-delete', { agent, rawInput: 'user:nope.md' })
  assert.equal(missing.kind, 'error')
  assert.match(missing.text, /no such memory file/)

  const deleted = await runCommand(commands, 'memory-delete', { agent, rawInput: 'user:notes.md' })
  assert.equal(deleted.kind, 'success')
  assert.match(deleted.text, /deleted user:notes\.md/)
  assert.match(deleted.text, /rewrite the index without its entry/)
  assert.equal(fs.files.has(`${HOME}\\memory\\notes.md`), false)
})

await test('with no active session the panel reports the host fallback as a fallback', async () => {
  const fs = makeFs({ [USER_MEMORY]: 'knowledge' })
  const { ctx, routes } = makeCtx(fs, makeLlm('{}'))
  apply(ctx, loadConfig({ mode: 'custom', generation: { turnComplete: { enabled: false } } }))
  // No `agents` service in this double, which is the no-session case.
  const response = await callRoute(routes, '/api/memory/status', {})
  assert.equal(response.json.projectFolder.source, 'host')
  assert.equal(response.json.projectFolder.cwd, process.cwd())
})

await test('a scope is labelled with its workspace name, not its directory slug', async () => {
  // A project scope is ADDRESSED by slug, but a slug is not a name a person recognises:
  // `--D-code-demo--` came out of `D:\code\demo`, and only the workspace registry knows
  // that, because the slug cannot be decoded back into a path.
  const active = `${HOME}\\projects\\--D-code-demo--\\memory`
  const orphan = `${HOME}\\projects\\--D-code-orphan--\\memory`
  const fs = makeFs({ [USER_MEMORY]: '# User', [`${active}\\MEMORY.md`]: '# Demo', [`${orphan}\\MEMORY.md`]: '# Orphan' })
  const { ctx, routes, services, setInitiator } = makeCtx(fs, makeLlm('{}'))
  services.set('workspaceRegistry', {
    list: () => [
      { id: 'ws-1', path: 'D:\\code\\demo', title: 'Demo project' },
      // A record whose path is not a string is skipped, not guessed at.
      { id: 'ws-3', path: 42 },
    ],
  })
  apply(ctx, trustConfig())
  setInitiator(makeAgent(makeSession([], 'D:\\code\\demo')))

  const listed = await callRoute(routes, '/api/memory/status', {})
  const labels = Object.fromEntries(listed.json.roots.map((root) => [root.id, root.label]))
  // The user scope has no workspace, so it keeps its id; that is its name.
  assert.equal(labels.user, undefined, 'the user scope stays `user`')
  assert.equal(labels['--D-code-demo--'], 'Demo project', 'the workspace title is the row title')
  // A project nobody registered keeps the slug rather than inventing a name.
  assert.equal(labels['--D-code-orphan--'], undefined, 'an unknown project is not renamed')

  // Without a registry the panel still works: every row falls back to the slug.
  const bare = makeCtx(fs, makeLlm('{}'))
  apply(bare.ctx, trustConfig())
  bare.setInitiator(makeAgent(makeSession([], 'D:\\code\\demo')))
  const plain = await callRoute(bare.routes, '/api/memory/status', {})
  assert.deepEqual(plain.json.roots.map((root) => root.label), [undefined, undefined, undefined])
})

await test('memory writes declare the memory root as their sandbox workspace', async () => {
  // Memory lives under `$DSH_HOME`, outside every session workspace, so under
  // `workspace-write` an omitted per-call policy denies every write ("file access denied
  // under workspace-write mode"). The plugin declares the root it is writing to instead.
  const fs = makeFs({ [USER_MEMORY]: '# Index' })
  const { ctx, routes } = makeCtx(fs, makeLlm('{}'))
  apply(ctx, trustConfig())
  const written = await callRoute(routes, '/api/memory/file', {
    method: 'POST',
    body: { scope: 'user', path: 'notes.md', content: 'body' },
  })
  assert.equal(written.status, 200)
  const call = fs.writes.at(-1)
  assert.equal(call.key, `${HOME}\\memory\\notes.md`)
  assert.deepEqual(call.sandboxPolicy, { mode: 'workspace-write', workspaceRoot: `${HOME}\\memory` })

  // `writePolicy: 'session'` hands the decision back: the provider is given no policy at
  // all, so the session's own sandbox decides (and memory becomes read-only when it fences).
  const sessionFs = makeFs({ [USER_MEMORY]: '# Index' })
  const session = makeCtx(sessionFs, makeLlm('{}'))
  apply(
    session.ctx,
    loadConfig({ mode: 'custom', writePolicy: 'session', generation: { turnComplete: { enabled: false } } }),
  )
  const second = await callRoute(session.routes, '/api/memory/file', {
    method: 'POST',
    body: { scope: 'user', path: 'notes.md', content: 'body' },
  })
  assert.equal(second.status, 200)
  assert.equal(sessionFs.writes.at(-1).sandboxPolicy, undefined, 'no policy is declared')
})

await test('following the session consults that session instead of the deployment default', async () => {
  // Reported live: a memory write was refused under `workspace-write` — "cannot write
  // "<memory file>": file access denied under workspace-write mode" — while the session
  // itself ran with FULL access. The backend resolves `sandboxPolicy.resolve()` with no
  // session for a call that declares no policy, so it fences against the deployment default
  // and never consults the session. Under `writePolicy: 'session'` the plugin therefore has
  // to hand the session over, exactly as the harness's own tools do, or "follows the
  // session" is a lie in both directions.
  const fs = makeFs({ [USER_MEMORY]: '# Index' })
  const { ctx, routes, services, setInitiator } = makeCtx(fs, makeLlm('{}'))
  apply(ctx, loadConfig({ mode: 'custom', writePolicy: 'session', generation: { turnComplete: { enabled: false } } }))
  setInitiator(makeAgent(makeSession([], 'D:\\code\\demo')))
  const asked = []
  services.set('sandboxPolicy', {
    resolve: (request = {}) => {
      asked.push(request)
      return request.session === undefined
        ? { mode: 'workspace-write', workspaceRoot: process.cwd() }
        : {
            mode: 'danger-full-access',
            workspaceRoot: request.session.header.cwd,
            sessionId: request.session.id,
          }
    },
  })

  const written = await callRoute(routes, '/api/memory/file', {
    method: 'POST',
    body: { scope: 'user', path: 'notes.md', content: 'body' },
  })
  assert.equal(written.status, 200)
  assert.deepEqual(
    fs.writes.at(-1).sandboxPolicy,
    { mode: 'danger-full-access', workspaceRoot: 'D:\\code\\demo', sessionId: 'session-1' },
    "the session's own policy is declared, not the deployment default",
  )
  assert.equal(asked.length > 0 && asked.every((request) => request.session !== undefined), true, 'the session was asked for')

  // The panel's write-policy row reports that same resolved mode; before this it showed the
  // deployment default, which is how a full-access session looked like a fenced one.
  const full = await callRoute(routes, '/api/memory/status', {})
  assert.equal(full.json.writePolicy, 'session')
  assert.equal(full.json.sandboxMode, 'danger-full-access')
  assert.equal(full.json.sessionMode, 'danger-full-access')

  // A session that is genuinely fenced says so, which is what the row is for.
  services.set('sandboxPolicy', { resolve: () => ({ mode: 'read-only', workspaceRoot: 'D:\\code\\demo' }) })
  const fenced = await callRoute(routes, '/api/memory/status', {})
  assert.equal(fenced.json.sandboxMode, 'read-only')
  assert.equal(fenced.json.sessionMode, 'read-only')

  // With no session in scope (a timer-driven pass) the deployment default is all there is.
  services.set('sandboxPolicy', {
    resolve: (request = {}) =>
      request.session === undefined
        ? { mode: 'workspace-write', workspaceRoot: process.cwd() }
        : { mode: 'read-only', workspaceRoot: request.session.header.cwd },
  })
  setInitiator(undefined)
  const agentless = await callRoute(routes, '/api/memory/status', {})
  assert.equal(agentless.json.sandboxMode, 'workspace-write')
  assert.equal(agentless.json.memoryMode, undefined, 'no session answered, so none is reported')
})

await test('the default memory-root policy reports the mode its own writes declare', async () => {
  // `memory-root` declares the memory directory as the write's workspace, so the session's
  // mode is irrelevant to it — and the row must not pretend the session's fence is in play.
  const fs = makeFs({ [USER_MEMORY]: '# Index' })
  const { ctx, routes, services, setInitiator } = makeCtx(fs, makeLlm('{}'))
  apply(ctx, trustConfig())
  setInitiator(makeAgent(makeSession([], 'D:\\code\\demo')))
  services.set('sandboxPolicy', { resolve: () => ({ mode: 'read-only', workspaceRoot: 'D:\\code\\demo' }) })
  const status = await callRoute(routes, '/api/memory/status', {})
  assert.equal(status.json.writePolicy, 'memory-root')
  assert.equal(status.json.sandboxMode, 'workspace-write')
  assert.equal(status.json.sessionMode, 'read-only', 'the session is still reported honestly')
})

await test('`/memory` reports the policy, the declared mode and the session mode together', async () => {
  // One number cannot say both facts: under the default policy memory keeps writing while a
  // fenced session is in force, and the report has to be readable as that.
  const fs = makeFs({ [USER_MEMORY]: '# Index' })
  const agent = makeAgent(makeSession([], 'D:\\code\\demo'))
  const own = makeCtx(fs, makeLlm('{}'))
  apply(own.ctx, trustConfig())
  own.services.set('sandboxPolicy', { resolve: () => ({ mode: 'read-only', workspaceRoot: 'D:\\code\\demo' }) })
  const report = await runCommand(own.commands, 'memory', { agent })
  assert.match(report.text, /write policy: memory-root \(workspace-write\)/)
  assert.match(report.text, /writes use the memory root; the session's own policy is read-only/)

  // Following the session, memory IS read-only, and the line says so plus the way out.
  const following = makeCtx(fs, makeLlm('{}'))
  apply(
    following.ctx,
    loadConfig({ mode: 'custom', writePolicy: 'session', generation: { turnComplete: { enabled: false } } }),
  )
  following.services.set('sandboxPolicy', { resolve: () => ({ mode: 'read-only', workspaceRoot: 'D:\\code\\demo' }) })
  const readOnly = await runCommand(following.commands, 'memory', { agent })
  assert.match(readOnly.text, /write policy: session \(read-only\)/)
  assert.match(readOnly.text, /memory is READ-ONLY under this session's sandbox \(read-only\)/)
})

await test('a session-following policy stops the delete that would bypass the fence', async () => {
  // The provider's own removal is fenced; an unlink through `processPath` is not. Following
  // the session means refusing that bypass rather than reaching around a fence it asked for.
  const fs = makeFs({ [`${HOME}\\memory\\notes.md`]: 'note' })
  fs.sandboxMode = 'workspace-write'
  // The bypass only exists for a provider that cannot delete itself.
  delete fs.remove
  const { ctx, routes } = makeCtx(fs, makeLlm('{}'))
  apply(ctx, loadConfig({ mode: 'custom', writePolicy: 'session', generation: { turnComplete: { enabled: false } } }))
  const refused = await callRoute(routes, '/api/memory/file', {
    method: 'DELETE',
    query: '?scope=user&path=notes.md',
  })
  assert.equal(refused.status, 500)
  assert.match(refused.json.error, /sandbox policy \(workspace-write\) does not allow deleting/)
  assert.ok(fs.files.has(`${HOME}\\memory\\notes.md`), 'the file survives the refusal')

  // The default (`memory-root`) treats the memory root as the plugin's own storage, so the
  // fence check is passed and the unlink path is reached. `processPath` is stubbed to prove
  // the attempt without deleting anything real.
  const own = makeFs({ [`${HOME}\\memory\\notes.md`]: 'note' })
  own.sandboxMode = 'workspace-write'
  delete own.remove
  let reached = false
  own.processPath = () => {
    reached = true
    return undefined
  }
  const allowed = makeCtx(own, makeLlm('{}'))
  apply(allowed.ctx, trustConfig())
  const attempted = await callRoute(allowed.routes, '/api/memory/file', {
    method: 'DELETE',
    query: '?scope=user&path=notes.md',
  })
  assert.equal(attempted.status, 500)
  assert.match(attempted.json.error, /exposes no path to delete/, 'the fence did not stop it')
  assert.ok(reached, 'the default policy reaches the unlink step')
})

await test('the panel browses every project with memory, not just the active session', async () => {
  // Two projects on disk, one of them the current session's own.
  const active = `${HOME}\\projects\\--D-code-demo--\\memory`
  const other = `${HOME}\\projects\\--D-code-other--\\memory`
  const fs = makeFs({
    [USER_MEMORY]: 'user knowledge',
    [`${active}\\MEMORY.md`]: '# Demo index',
    [`${other}\\MEMORY.md`]: '# Other index',
    [`${other}\\notes.md`]: 'other notes',
  })
  const { ctx, routes, services, setInitiator } = makeCtx(fs, makeLlm('{}'))
  apply(ctx, trustConfig())
  setInitiator(makeAgent(makeSession([], 'D:\\code\\demo')))

  const listed = await callRoute(routes, '/api/memory/status', {})
  // The user scope, the session's project, and the project that is merely on disk.
  assert.deepEqual(listed.json.roots.map((root) => root.id), ['user', '--D-code-demo--', '--D-code-other--'])
  assert.equal(listed.json.roots[1].files.length, 1, 'each project lists its own files')
  assert.deepEqual(listed.json.roots[2].files, ['MEMORY.md', 'notes.md'], 'the index leads')
  // The listing metadata already carries each file's size, so the row can state it.
  assert.equal(listed.json.roots[2].size, '24 B', 'the scope row reports how much memory it holds')
  assert.equal(listed.json.roots[1].size, '12 B')
  assert.equal(listed.json.projectFolder.cwd, 'D:\\code\\demo')

  // Any listed project is addressable by its directory name: read, write, delete.
  const read = await callRoute(routes, '/api/memory/file', { query: '?scope=--D-code-other--&path=notes.md' })
  assert.equal(read.status, 200)
  assert.equal(read.json.text, 'other notes')
  const wrote = await callRoute(routes, '/api/memory/file', {
    method: 'POST',
    body: { scope: '--D-code-other--', path: 'notes.md', content: 'edited elsewhere' },
  })
  assert.equal(wrote.status, 200)
  assert.equal(fs.files.get(`${other}\\notes.md`), 'edited elsewhere')
  const deleted = await callRoute(routes, '/api/memory/file', {
    method: 'DELETE',
    query: '?scope=--D-code-other--&path=notes.md',
  })
  assert.equal(deleted.status, 200)
  assert.equal(fs.files.has(`${other}\\notes.md`), false)
})

await test('a project directory name cannot address anything but a project memory dir', async () => {
  const fs = makeFs({ [USER_MEMORY]: 'user knowledge' })
  const { ctx, routes } = makeCtx(fs, makeLlm('{}'))
  apply(ctx, trustConfig())
  for (const scope of ['--..--', '--/etc--', 'D-code-demo', '--x--/../..', 'user', 'nope']) {
    const response = await callRoute(routes, '/api/memory/file', {
      query: `?scope=${encodeURIComponent(scope)}&path=x.md`,
    })
    assert.equal(response.status, 404, `${scope} must not resolve`)
  }
})

await test('with the trust gate on, only the current project is offered', async () => {
  const active = `${HOME}\\projects\\--D-code-demo--\\memory`
  const other = `${HOME}\\projects\\--D-code-other--\\memory`
  const fs = makeFs({
    [USER_MEMORY]: 'user knowledge',
    [`${active}\\MEMORY.md`]: '# Demo',
    [`${other}\\MEMORY.md`]: '# Other',
  })
  const { ctx, routes, services, setInitiator } = makeCtx(fs, makeLlm('{}'))
  apply(ctx, loadConfig({ mode: 'custom', trust: { enabled: true }, generation: { turnComplete: { enabled: false } } }))
  setInitiator(makeAgent(makeSession([], 'D:\\code\\demo')))

  // Untrusted: the project scope is absent, so nothing project-shaped is offered.
  const closed = await callRoute(routes, '/api/memory/status', {})
  assert.deepEqual(closed.json.roots.map((root) => root.id), ['user'])

  await callRoute(routes, '/api/memory/trust', { method: 'POST', body: { action: 'allow' } })
  const open = await callRoute(routes, '/api/memory/status', {})
  // Trusted: the session's project appears. The other one still cannot be shown,
  // because a slug cannot be turned back into a folder to check trust for.
  assert.deepEqual(open.json.roots.map((root) => root.id), ['user', '--D-code-demo--'])
})

await test('the file route deletes a file, and refuses traversal', async () => {
  const fs = projectMemoryFixture({ [`${HOME}\\memory\\notes.md`]: 'a note' })
  const { ctx, routes } = makeCtx(fs, makeLlm('{}'))
  apply(ctx, trustConfig())

  const traversal = await callRoute(routes, '/api/memory/file', {
    method: 'DELETE',
    query: '?scope=user&path=../escape.md',
  })
  assert.equal(traversal.status, 400)
  assert.match(traversal.json.error, /relative \.md path/)

  const missing = await callRoute(routes, '/api/memory/file', { method: 'DELETE', query: '?scope=user&path=nope.md' })
  assert.equal(missing.status, 404)

  // The gated project scope is not available at all under this config.
  const gated = await callRoute(routes, '/api/memory/file', {
    method: 'DELETE',
    query: '?scope=project&path=MEMORY.md',
  })
  assert.equal(gated.status, 404)

  // A read-only root is addressable, and refuses before it looks at the file.
  const readOnlyFs = makeFs({ 'C:\\shared\\keep.md': 'do not touch' })
  const readOnlyCtx = makeCtx(readOnlyFs, makeLlm('{}'))
  apply(
    readOnlyCtx.ctx,
    loadConfig({
      mode: 'custom',
      generation: {
        roots: [{ id: 'shared', path: 'C:\\shared', access: 'read' }],
        turnComplete: { enabled: false },
      },
    }),
  )
  const refused = await callRoute(readOnlyCtx.routes, '/api/memory/file', {
    method: 'DELETE',
    query: '?scope=shared&path=keep.md',
  })
  assert.equal(refused.status, 403)
  assert.equal(readOnlyFs.files.get('C:\\shared\\keep.md'), 'do not touch')

  const deleted = await callRoute(routes, '/api/memory/file', { method: 'DELETE', query: '?scope=user&path=notes.md' })
  assert.equal(deleted.status, 200)
  assert.equal(deleted.json.deleted, true)
  assert.equal(fs.files.has(`${HOME}\\memory\\notes.md`), false, 'the file is really gone')
})
console.log(`\n${passed} integration trust tests passed`)
