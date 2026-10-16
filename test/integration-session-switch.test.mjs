/**
 * Integration test — the per-session switch.
 *
 * Drives the real `apply()` against the Harness doubles in
 * `test/support/integration-harness.mjs`. Split by topic from the single
 * integration suite; each suite is still one standalone process.
 *
 * Run: node test/integration-session-switch.test.mjs
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

console.log('dsh-memory integration tests — the per-session switch')

await test('switching a session off stops BOTH halves: no injection, and no recording', async () => {
  const { fs, listeners, services, agent, llm } = switchFixture()
  const service = services.get('memory')

  // ON by default: a step injects, and a completed turn is recorded.
  const first = await runPreStep(listeners, agent)
  assert.equal(first.messages.length, 1, 'memory is injected while the switch is on')
  const log = makeLog(agent.session)
  log.turn(listeners, agent, 1, 'a long enough prompt to pass the gate')
  await service.flushMemory()
  assert.equal(llm.calls.length, 1, 'a completed turn is recorded while the switch is on')
  // The recorded pass really changed the file, so the muted step below would otherwise
  // have something to say — which is what makes "nothing was injected" meaningful.
  const recorded = fs.files.get(USER_MEMORY)
  assert.match(recorded, /Recorded/)

  // OFF: the very next step injects nothing, and the next turn records nothing.
  const switched = await service.setMemorySwitch(agent.session, 'off')
  assert.equal(switched.mode, 'off')
  assert.equal(switched.changed, true)
  const second = await runPreStep(listeners, agent)
  assert.equal(second.messages.length, 0, 'a muted session gets nothing injected, even after a change')
  log.turn(listeners, agent, 2, 'another long enough prompt to pass the gate')
  await service.flushMemory()
  assert.equal(llm.calls.length, 1, 'a muted session records nothing either')

  // The file is untouched by the muted turn, and the store names the session.
  assert.equal(fs.files.get(USER_MEMORY), recorded, 'the muted turn wrote nothing')
  assert.deepEqual(JSON.parse(fs.files.get(SWITCH_STORE)).sessions, { 'session-1': 'off' })
})

await test('a muted session drops memory already queued in its inbox', async () => {
  // The half-step case that matters: a message injected before the switch was flipped
  // is a lie sitting in the reader's own queue, so it must be removed, not left there.
  const { listeners, services, agent } = switchFixture()
  const service = services.get('memory')
  await runPreStep(listeners, agent)
  const queued = { id: 'queued-memory', source: { kind: 'memory', identity: 'x' } }
  agent.inbox.nextStep.push(queued)
  await service.setMemorySwitch(agent.session, 'off')
  const decision = await runPreStep(listeners, agent)
  assert.deepEqual(agent.removed, ['queued-memory'], 'the stale injection must be removed')
  assert.equal(decision.messages.length, 0)
})

await test('every storable mode reaches the DISK and comes back — a real round trip', async () => {
  // The store has two halves (serialize on write, parse on read) and a test that seeds the FILE only
  // exercises the second one. Here the write half runs for real: set the mode, read what actually
  // landed on disk, then boot a FRESH plugin against that exact content. A state the serializer
  // filters out — which is how a hand-written pair list breaks a newly added mode — would be written,
  // silently dropped, and leave the session following the configuration after a restart.
  for (const mode of ['all', 'user', 'project', 'off']) {
    const first = switchFixture()
    const service = first.services.get('memory')
    await service.setMemorySwitch(first.agent.session, mode)
    // Read the bytes the plugin actually wrote, not a fixture shaped like them.
    const onDisk = first.fs.files.get(SWITCH_STORE)
    assert.equal(typeof onDisk, 'string', `${mode} must be written to the store`)
    assert.equal(JSON.parse(onDisk).sessions['session-1'], mode, `${mode} must survive serialization`)

    // Boot again against exactly that content: this is the restart case.
    const restarted = switchFixture({ files: { [SWITCH_STORE]: onDisk } })
    assert.equal(
      (await callRoute(restarted.routes, '/api/memory/status')).json.memoryMode,
      mode,
      `${mode} must survive a restart through the store's own bytes`,
    )
  }
})

await test('turning the switch back on injects again, and is persisted', async () => {
  const { fs, listeners, services, agent } = switchFixture({
    files: { [SWITCH_STORE]: JSON.stringify({ sessions: ['session-1'] }) },
  })
  const service = services.get('memory')

  // The store was read before the first step, so a resumed mute is honoured at once.
  const muted = await runPreStep(listeners, agent)
  assert.equal(muted.messages.length, 0, 'a mute remembered on disk is honoured on the first step')

  const back = await service.setMemorySwitch(agent.session, 'auto')
  assert.equal(back.mode, 'auto')
  assert.equal(back.changed, true)
  const injected = await runPreStep(listeners, agent)
  assert.equal(injected.messages.length, 1, 'turning it back on injects again')
  // `auto` is stored as ABSENCE, so the store stops naming it entirely — which is what lets a
  // later configuration change reach this session instead of being pinned by a stale entry.
  assert.deepEqual(JSON.parse(fs.files.get(SWITCH_STORE)).sessions, {}, 'the store no longer names it')
})

await test('setting the switch twice is a no-op that does not rewrite the store', async () => {
  const { fs, services, agent } = switchFixture()
  const service = services.get('memory')
  await service.setMemorySwitch(agent.session, 'off')
  const writes = fs.writes.length
  const again = await service.setMemorySwitch(agent.session, 'off')
  assert.equal(again.changed, false, 'an unchanged switch reports that nothing changed')
  assert.equal(fs.writes.length, writes, 'and does not write the store again')
})

await test('a damaged switch store reads as no override, not as everything muted', async () => {
  // The store only ever records a DEVIATION, so a lost or damaged one must fail open: the
  // failure mode is "the override was forgotten", never "memory went quiet everywhere".
  const { routes, listeners, services, agent } = switchFixture({
    files: { [SWITCH_STORE]: '{ this is not json' },
  })
  const injected = await runPreStep(listeners, agent)
  assert.equal(injected.messages.length, 1, 'a damaged store must not mute anything')
  assert.equal((await callRoute(routes, '/api/memory/status')).json.memoryMode, 'auto')
})

await test('the switch is per session: a muted session does not mute another', async () => {
  const { listeners, services, agent, ctx } = switchFixture()
  const service = services.get('memory')
  await service.setMemorySwitch(agent.session, 'off')

  const other = makeAgent({ ...makeSession([], 'C:\\other'), id: 'session-2' })
  const injected = await runPreStep(listeners, other)
  assert.equal(injected.messages.length, 1, 'another session still gets its memory')
})

await test('a deliberate refresh and the memory tool respect the switch, and say why', async () => {
  const { services, commands, tools, agent, fs } = switchFixture()
  const service = services.get('memory')
  await service.setMemorySwitch(agent.session, 'off')

  // `/memory-refresh`: not silently ignored — the caller is told how to lift the mute.
  const refreshed = await runCommand(commands, 'memory-refresh', { agent })
  assert.equal(refreshed.kind, 'success')
  assert.match(refreshed.text, /memory is switched off/i)
  assert.match(refreshed.text, /composer/)

  // The model-facing write tool is refused with the same reason.
  const tool = tools.registered.get('memory')
  const written = await tool.execute({ action: 'write', scope: 'user', path: 'NEW.md', content: '# new' }, {
    agent,
    signal: new AbortController().signal,
  })
  assert.equal(written.ok, false)
  assert.match(written.message, /switched off/)
  assert.equal(fs.files.has(`${HOME}\\memory\\NEW.md`), false, 'a muted session must write nothing')
  // Reading stays available: asking memory a question does not let it affect the session.
  const read = await tool.execute({ action: 'list', scope: 'user' }, { agent, signal: new AbortController().signal })
  assert.equal(read.ok, true, 'a muted session may still READ memory')
})

await test('`project` mode loads project memory and withholds user-scope memory', async () => {
  // The point of the feature: a session that does not want OTHER projects' knowledge, while
  // still working normally against its own repository's memory.
  const { fs, listeners, services, agent } = switchFixture({
    files: {
      [USER_MEMORY]: 'cross-project knowledge nobody wants here',
      [PROJECT_MEMORY]: 'this repository conventions',
    },
  })
  const service = services.get('memory')

  const all = await runPreStep(listeners, agent)
  assert.match(all.messages[0].content[0].text, /cross-project knowledge/)
  assert.match(all.messages[0].content[0].text, /repository conventions/)

  await service.setMemorySwitch(agent.session, 'project')
  const scoped = await runPreStep(listeners, agent)
  assert.equal(scoped.messages.length, 1, 'the project scope still injects')
  assert.match(scoped.messages[0].content[0].text, /repository conventions/, 'project memory is still loaded')
  assert.doesNotMatch(scoped.messages[0].content[0].text, /cross-project knowledge/, 'user memory is withheld')
})

await test('`project` mode also withholds the user scope from the WRITE side', async () => {
  // Both halves, as with `off`: a scope that is not loaded must not be silently written to
  // either, or a "quiet" session would keep contributing to the knowledge it opted out of.
  const { fs, services, tools, agent } = switchFixture()
  const service = services.get('memory')
  await service.setMemorySwitch(agent.session, 'project')
  const tool = tools.registered.get('memory')

  const written = await tool.execute(
    { action: 'write', scope: 'user', path: 'NEW.md', content: '# new' },
    { agent, signal: new AbortController().signal },
  )
  assert.equal(written.ok, false, 'a project-scoped session may not write cross-project memory')
  assert.match(written.message, /not enabled/)
  assert.equal(fs.files.has(`${HOME}\\memory\\NEW.md`), false)

  // And its own project scope still works: this is a narrowing, not a mute.
  const own = await tool.execute(
    { action: 'write', scope: 'project', path: 'OWN.md', content: '# own' },
    { agent, signal: new AbortController().signal },
  )
  assert.equal(own.ok, true, 'the project scope must stay writable')
})

await test('`project` mode is not a mute: generation still records', async () => {
  const { listeners, services, agent, llm } = switchFixture()
  const service = services.get('memory')
  await service.setMemorySwitch(agent.session, 'project')
  const log = makeLog(agent.session)
  log.turn(listeners, agent, 1, 'a long enough prompt to pass the gate')
  await service.flushMemory()
  assert.equal(llm.calls.length, 1, 'a project-scoped session still records its own work')
})

await test('`/status` reports a muted session WITHOUT an initiator — the production condition', async () => {
  // The same root cause as the preview defect, in the row next to it. `/status` resolved its session
  // through `currentInitiator()`, which is `undefined` for EVERY browser request, so `memoryMode` was
  // always `undefined` — and the panel renders that as "follows the global configuration". In other
  // words the panel told a session the user had explicitly MUTED that it was following the
  // configuration: a lie of exactly the kind this plugin refuses elsewhere.
  //
  // Also pins that the fix is confined to READS: a write still names its session.
  const { routes, session, setInitiator } = switchFixture({
    files: { [SWITCH_STORE]: JSON.stringify({ version: 2, sessions: { 'session-1': 'off' } }) },
  })
  setInitiator(undefined)
  const status = await callRoute(routes, '/api/memory/status')
  assert.equal(status.json.memoryMode, 'off', 'a muted session must not be reported as following the config')
  assert.equal(status.json.memorySwitch.available, true)
  void session

  // And the WRITE path is unchanged: no session named is still refused, so a route can never switch
  // whichever session happens to be live. 409 (conflict), not 400 — the request is well-formed and the
  // route simply cannot identify the target; that is the documented contract of this route.
  const wrote = await callRoute(routes, '/api/memory/switch', { method: 'POST', body: { mode: 'project' } })
  assert.equal(wrote.status, 409, 'a write must still name its session')
  assert.match(wrote.json.error, /session is required/)

  // And a named-but-dead session is refused too, rather than falling back to the live one.
  const dead = await callRoute(routes, '/api/memory/switch', { method: 'POST', body: { session: 'session-gone', mode: 'project' } })
  assert.equal(dead.status, 409)
  assert.match(dead.json.error, /no live session/)
})

await test('`/status` refuses to guess between several live sessions', async () => {
  // One candidate is not a guess; two is. With no initiator and two open sessions the honest report
  // is "no session in scope" (undefined), not a coin flip that would show one session's mode as if it
  // were the other's.
  const { routes, addAgent, setInitiator } = switchFixture({
    files: { [SWITCH_STORE]: JSON.stringify({ version: 2, sessions: { 'session-1': 'off' } }) },
  })
  setInitiator(undefined)
  addAgent(makeAgent(makeSession([], 'C:\\other')))
  const status = await callRoute(routes, '/api/memory/status')
  assert.equal(status.json.memoryMode, undefined, 'two candidates means no session in scope')
})

await test('the mode survives a restart, and a v1 store still mutes', async () => {
  // Resume is the case the store exists for: the mode is keyed by session id, so it comes
  // back with the session. The v1 array shape is the compatibility case.
  const current = switchFixture({
    files: { [SWITCH_STORE]: JSON.stringify({ version: 2, sessions: { 'session-1': 'project' } }) },
  })
  assert.equal((await callRoute(current.routes, '/api/memory/status')).json.memoryMode, 'project')

  const legacy = switchFixture({ files: { [SWITCH_STORE]: JSON.stringify({ sessions: ['session-1'] }) } })
  assert.equal((await callRoute(legacy.routes, '/api/memory/status')).json.memoryMode, 'off')

  // The new scope states persist too. This is the case a hand-written "project or off" filter in
  // the store used to break: the mode was written, then dropped on the way back in, so the session
  // silently reverted to following the configuration after a restart.
  for (const mode of ['all', 'user']) {
    const stored = switchFixture({
      files: { [SWITCH_STORE]: JSON.stringify({ version: 2, sessions: { 'session-1': mode } }) },
    })
    assert.equal((await callRoute(stored.routes, '/api/memory/status')).json.memoryMode, mode, `${mode} must survive a restart`)
  }
})

await test('`user` mode narrows the OPPOSITE scope from `project`', async () => {
  // The two scoped modes must not be interchangeable. `user` keeps cross-project knowledge and drops
  // this project's; `project` does the reverse. A copy-paste in the flag mapping would give a
  // "user only" session its project's notes, and every test of `project` alone would still pass.
  const fixture = switchFixture({ files: { [USER_MEMORY]: 'cross-project knowledge', [PROJECT_MEMORY]: 'repository conventions' } })
  const service = fixture.services.get('memory')
  await service.setMemorySwitch(fixture.agent.session, 'user')

  const preview = await callRoute(fixture.routes, '/api/memory/preview')
  assert.equal(preview.status, 200)
  assert.match(preview.json.snapshot.text, /cross-project knowledge/, 'the user scope must be loaded')
  assert.doesNotMatch(preview.json.snapshot.text, /repository conventions/, 'the project scope must be withheld')
  // The identity the preview reports is the narrowed one, so the panel is describing the same
  // session the next step will run.
  assert.equal(preview.json.mode, 'user')
})

await test('`all` mode WIDENS a globally project-only session back to both scopes', async () => {
  // This is why `all` exists as its own state: `auto` follows the configuration, so a session in a
  // globally project-only setup had no way to opt back IN to the shared user notes. `all` does that.
  const fixture = switchFixture({
    config: { userScope: false, projectScope: true },
    files: { [USER_MEMORY]: 'cross-project knowledge', [PROJECT_MEMORY]: 'repository conventions' },
  })
  const service = fixture.services.get('memory')

  // Under `auto` the global layer withholds the user scope...
  const auto = await callRoute(fixture.routes, '/api/memory/preview')
  assert.doesNotMatch(auto.json.snapshot.text, /cross-project knowledge/, 'auto follows the global layer')

  // ...and `all` puts it back, for this session only.
  await service.setMemorySwitch(fixture.agent.session, 'all')
  const widened = await callRoute(fixture.routes, '/api/memory/preview')
  assert.equal(widened.status, 200)
  assert.match(widened.json.snapshot.text, /cross-project knowledge/, 'all must widen the session back to the user scope')
  assert.match(widened.json.snapshot.text, /repository conventions/)
  assert.equal(widened.json.mode, 'all')

  // The global configuration itself was not touched: this is a per-session decision.
  const status = await callRoute(fixture.routes, '/api/memory/status')
  assert.equal(status.json.globalScopes, 'project', 'the global layer must be unchanged')
})

await test('`all` is not a way around `off`: a muted session stays muted', async () => {
  // The states are alternatives, so the gate must read the SESSION's state rather than any scope
  // flag. If `all` merely set two booleans without consulting the mute, a muted session could be
  // un-muted by a scope change.
  const fixture = switchFixture({ files: { [USER_MEMORY]: 'cross-project knowledge' } })
  const service = fixture.services.get('memory')
  await service.setMemorySwitch(fixture.agent.session, 'off')
  const muted = await runPreStep(fixture.listeners, fixture.agent)
  assert.equal(muted.messages.length, 0, 'off injects nothing')

  await service.setMemorySwitch(fixture.agent.session, 'all')
  const widened = await runPreStep(fixture.listeners, fixture.agent)
  assert.equal(widened.messages.length, 1, 'and a scope change is a real un-mute, so it injects again')
})

await test('/memory-switch reports and changes the mode, and /memory states it', async () => {
  const { commands, agent } = switchFixture()
  const status = await runCommand(commands, 'memory-switch', { agent })
  assert.match(status.text, /session memory: auto/)
  assert.match(status.text, /session-1/)

  const off = await runCommand(commands, 'memory-switch', { agent, rawInput: 'off' })
  assert.match(off.text, /session memory: off/)
  assert.match(off.text, /nothing is injected into this session, and nothing from it is recorded/)

  // `/memory` states the session's mode BEFORE its results, so a narrowed session is explained
  // rather than looking like memory that has lost half its content.
  const report = await runCommand(commands, 'memory', { agent })
  assert.match(report.text, /session memory: off/)

  const project = await runCommand(commands, 'memory-switch', { agent, rawInput: 'project' })
  assert.match(project.text, /session memory: project/)
  assert.match(project.text, /cross-project \(user-scope\) knowledge is neither loaded nor recorded/)
  // Leaving `off` does not re-inject by itself, and the command says so.
  assert.match(project.text, /\/memory-refresh forces it now/)

  const auto = await runCommand(commands, 'memory-switch', { agent, rawInput: 'auto' })
  assert.match(auto.text, /session memory: auto/)

  const bad = await runCommand(commands, 'memory-switch', { agent, rawInput: 'maybe' })
  assert.equal(bad.kind, 'error')
  assert.match(bad.text, /unknown action "maybe"/)
})

await test('/memory-switch is registered, and reported by the panel command list', async () => {
  const { commands } = switchFixture()
  assert.ok(commands.registered.has('memory-switch'), '/memory-switch must be registered')
  assert.match(commands.registered.get('memory-switch').description, /THIS session/)
})

await test('/memory-scope reports the global layer, and refuses to guess when it cannot write', async () => {
  // The GLOBAL level, which is what a session's `auto` follows. A headless composition has no
  // `configEditor`, so the command must say the value and explain that it is set in config — never
  // silently pretend the change was applied.
  const { commands } = switchFixture()
  const status = await runCommand(commands, 'memory-scope')
  assert.equal(status.kind, 'success')
  assert.match(status.text, /global memory scopes: all/)
  assert.match(status.text, /every configured scope is loaded and recorded/)
  assert.match(status.text, /userScope \/ projectScope/, 'and names the config fields, since it cannot write')

  const denied = await runCommand(commands, 'memory-scope', { rawInput: 'project' })
  assert.equal(denied.kind, 'error', 'without configEditor the change is refused, not faked')
  assert.match(denied.text, /no configEditor/)

  const bad = await runCommand(commands, 'memory-scope', { rawInput: 'everything' })
  assert.equal(bad.kind, 'error')
  assert.match(bad.text, /unknown action "everything"/)
})

await test('/memory-scope writes the global scopes through configEditor', async () => {
  // A plugin's ONE sanctioned way to change its own configuration: `edit` validates, persists and
  // reconciles through the normal Loader path, so ordinary lifecycle rules still apply.
  const { commands, ctx, services } = switchFixture()
  const edits = []
  services.set('configEditor', {
    entries: () => [{ options: { id: 'memory', name: '@dsh-external/dsh-memory' } }],
    edit: async (entry, change) => {
      edits.push({ entry, next: change({ userScope: true, projectScope: true, mode: 'native' }) })
    },
  })

  // With the editor present the command offers itself, and the status row says it is writable.
  const status = await runCommand(commands, 'memory-scope')
  assert.match(status.text, /\/memory-scope all \| user \| project/)

  const scoped = await runCommand(commands, 'memory-scope', { rawInput: 'project' })
  assert.equal(scoped.kind, 'success')
  assert.match(scoped.text, /global memory scopes: project/)
  assert.equal(edits.length, 1)
  assert.equal(edits[0].entry.options.name, '@dsh-external/dsh-memory', 'the entry is found by specifier')
  // `project` means: keep the project scope, drop the user scope. Nothing else is touched.
  assert.deepEqual(edits[0].next, { userScope: false, projectScope: true, mode: 'native' })

  const user = await runCommand(commands, 'memory-scope', { rawInput: 'user' })
  assert.deepEqual(edits[1].next, { userScope: true, projectScope: false, mode: 'native' })
  const all = await runCommand(commands, 'memory-scope', { rawInput: 'all' })
  assert.deepEqual(edits[2].next, { userScope: true, projectScope: true, mode: 'native' })
  assert.match(all.text, /global memory scopes: all/)
})

await test('/memory-scope reports all four global states, not just two', async () => {
  // A real defect this pins: reporting only "both" vs "project" turned `userScope: true,
  // projectScope: false` into "all" — the exact opposite of the truth — and folded "neither" into
  // "project". A user reading the composer's `auto` has no other way to see this layer.
  for (const [flags, want] of [
    [{ userScope: true, projectScope: true }, 'all'],
    [{ userScope: false, projectScope: true }, 'project'],
    [{ userScope: true, projectScope: false }, 'user'],
    [{ userScope: false, projectScope: false }, 'none'],
  ]) {
    const { routes } = switchFixture({ config: flags })
    const response = await callRoute(routes, '/api/memory/status')
    assert.equal(response.json.globalScopes, want, `${JSON.stringify(flags)} must report "${want}"`)
  }
})

await test('the switch route sets a NAMED session and refuses an unknown one', async () => {
  const { routes, session, setInitiator, agent } = switchFixture()

  // No session named AND no initiator: this is the real browser case (no HTTP path
  // establishes an initiator boundary), so the route must say so rather than guess.
  setInitiator(undefined)
  const unnamed = await callRoute(routes, '/api/memory/switch', { method: 'POST', body: { mode: 'off' } })
  assert.equal(unnamed.status, 409)
  assert.match(unnamed.json.error, /session is required/)

  // A named session that does not exist is refused, not silently redirected to another.
  const unknown = await callRoute(routes, '/api/memory/switch', {
    method: 'POST',
    body: { session: 'session-nope', mode: 'off' },
  })
  assert.equal(unknown.status, 409)
  assert.match(unknown.json.error, /no live session has that id/)

  // A live session is switched, and the reply carries the global layer the session's `auto` would
  // follow — so the composer can re-render its title without a second round-trip.
  const off = await callRoute(routes, '/api/memory/switch', {
    method: 'POST',
    body: { session: session.id, mode: 'off' },
  })
  assert.equal(off.status, 200)
  assert.equal(off.json.mode, 'off')
  assert.equal(off.json.changed, true)
  assert.equal(off.json.global, 'all', 'both global scopes are on in this fixture')
  // Sessions are NOT enumerated in any reply: the panel no longer lists them — the composer acts
  // on its own session id.
  assert.equal(off.json.sessions, undefined)

  const project = await callRoute(routes, '/api/memory/switch', {
    method: 'POST',
    body: { session: session.id, mode: 'project' },
  })
  assert.equal(project.json.mode, 'project')

  // With an initiator in scope (a programmatic caller rather than the panel) an unnamed
  // request means THAT session — the same seam preview and refresh resolve through.
  setInitiator(agent)
  const implied = await callRoute(routes, '/api/memory/switch', { method: 'POST', body: { mode: 'off' } })
  assert.equal(implied.status, 200)
  assert.equal(implied.json.session, 'session-1')

  // A body without a known mode is a client error, not a default — the refusal names every legal
  // mode, read from the one list, so adding a state cannot leave this message behind.
  const missing = await callRoute(routes, '/api/memory/switch', { method: 'POST', body: { session: session.id } })
  assert.equal(missing.status, 400)
  assert.match(missing.json.error, /mode must be one of auto, all, user, project, off/)
  const twoState = await callRoute(routes, '/api/memory/switch', {
    method: 'POST',
    body: { session: session.id, off: true },
  })
  assert.equal(twoState.status, 400, 'the old { off } payload must not be silently accepted')
})

await test('the switch route READS one session, for the composer', async () => {
  // The composer lives in the conversation, not in settings, and it knows its own session id.
  // GET is what it polls: one session, its mode, and the vocabulary a button needs.
  const { routes, session, setInitiator } = switchFixture()
  setInitiator(undefined)

  const found = await callRoute(routes, '/api/memory/switch', { query: `?session=${session.id}` })
  assert.equal(found.status, 200)
  assert.equal(found.json.session, 'session-1')
  assert.equal(found.json.mode, 'auto')
  assert.deepEqual(found.json.modes, ['auto', 'all', 'user', 'project', 'off'])
  assert.equal(found.json.cwd, 'C:\\proj')

  // A named session that does not exist is refused, exactly as on the write side, so the
  // composer can show an error instead of rendering another session's state.
  const unknown = await callRoute(routes, '/api/memory/switch', { query: '?session=session-nope' })
  assert.equal(unknown.status, 409)
  // And with no session at all there is nothing to report: a route has no initiator.
  const missing = await callRoute(routes, '/api/memory/switch')
  assert.equal(missing.status, 409)

  // The composer's write is the same route and the same named session.
  const set = await callRoute(routes, '/api/memory/switch', {
    method: 'POST',
    body: { session: session.id, mode: 'project' },
  })
  assert.equal(set.status, 200)
  const after = await callRoute(routes, '/api/memory/switch', { query: `?session=${session.id}` })
  assert.equal(after.json.mode, 'project')
})

await test('the status route publishes the session mode and the global layer', async () => {
  const { routes, session, agent } = switchFixture()
  const before = await callRoute(routes, '/api/memory/status')
  assert.equal(before.json.memoryMode, 'auto')
  assert.equal(before.json.globalScopes, 'all')
  assert.equal(before.json.memorySwitch.available, true)

  await callRoute(routes, '/api/memory/switch', { method: 'POST', body: { session: session.id, mode: 'project' } })
  const after = await callRoute(routes, '/api/memory/status')
  assert.equal(after.json.memoryMode, 'project', 'the panel sees the session decision it must explain')
  assert.equal(agent.session.id, session.id)
})

await test('the preview route answers a REAL preview, not a 500', async () => {
  // This is the test whose absence hid a real defect: the route passed a SESSION into
  // `previewMemory(agent)`, which then read `target.session` (undefined) and threw
  // inside the route's catch — so the panel's preview was a 500 whenever a session was
  // in scope. The panel fixture served a canned payload, so nothing caught it.
  const { routes, fs } = switchFixture()
  const response = await callRoute(routes, '/api/memory/preview')
  assert.equal(response.status, 200, `the preview route must not fail: ${JSON.stringify(response.json)}`)
  assert.equal(response.json.available, true)
  assert.equal(response.json.mode, 'auto')
  assert.match(response.json.snapshot.text, /user knowledge/)
  assert.ok(response.json.snapshot.tokens > 0)
  assert.ok(fs.reads.length > 0, 'an unmuted preview really reads the memory files')
})

await test('the preview route works with NO initiator — the production condition', async () => {
  // THE regression test for the reported defect. Every preview test before this one ran through
  // `switchFixture`, which calls `setInitiator(agent)` — supplying exactly what a real browser
  // request never has. `withInitiator`'s only production caller is the agent loop's driver, so
  // `currentInitiator()` is `undefined` for every HTTP request, and the old code turned that into
  // "no session is in scope" EVERY time the user pressed the button.
  //
  // So: no initiator, one live session (the user is chatting in one and opens Settings).
  const { routes, fs, agent, setInitiator } = switchFixture()
  setInitiator(undefined)
  const response = await callRoute(routes, '/api/memory/preview')
  assert.equal(response.status, 200, `must not fail: ${JSON.stringify(response.json)}`)
  assert.equal(response.json.available, true, 'the button must produce a preview, not an error')
  assert.equal(response.json.scope, 'session', 'the ONE live session is not a guess')
  assert.equal(response.json.session.id, agent.session.id)
  assert.match(response.json.snapshot.text, /user knowledge/)
  assert.ok(fs.reads.length > 0)
})

await test('with no initiator AND no live session, the preview answers for the global configuration', async () => {
  // A settings page with nothing open. Still an honest answer — what a session starting now gets —
  // rather than an error about a session that does not exist. Built directly rather than through
  // `switchFixture`, which always registers one agent.
  const fs = makeFs({ [USER_MEMORY]: 'user knowledge' })
  const made = makeCtx(fs, makeLlm('{}'))
  apply(made.ctx, loadConfig({ mode: 'custom', userScope: true, projectScope: true, generation: { turnComplete: { minPromptChars: 1 } } }))
  made.setInitiator(undefined)
  assert.equal(made.ctx.get('agents').list().length, 0, 'the fixture must have no live session')

  const response = await callRoute(made.routes, '/api/memory/preview')
  assert.equal(response.status, 200)
  assert.equal(response.json.available, true)
  assert.equal(response.json.scope, 'global')
  assert.match(response.json.snapshot.text, /user knowledge/, 'the global configuration still reads memory')
  assert.ok(fs.reads.length > 0)
})

await test('with SEVERAL live sessions and no initiator, the route refuses to guess', async () => {
  // The reason this matters: enumerating live sessions and picking one is how a preview describes
  // somebody else's session. With more than one candidate the route cannot know which, and the
  // global answer is the only honest one. (`list()` returns a COPY, so the extra agent has to go in
  // through `addAgent` — a `push` on the returned array mutates nothing.)
  const { routes, ctx, agent, addAgent, setInitiator } = switchFixture()
  setInitiator(undefined)
  addAgent(makeAgent(makeSession([], 'C:\\other')))
  assert.equal(ctx.get('agents').list().length, 2)
  const response = await callRoute(routes, '/api/memory/preview')
  assert.equal(response.status, 200)
  assert.equal(response.json.scope, 'global', 'two candidates means no guessing')
  assert.notEqual(response.json.session.id, agent.session.id)
})

await test('a lone SUBAGENT is not mistaken for the session the user is looking at', async () => {
  // `list()` includes subagents. If the fallback used it, a session with one subagent and no other
  // live agent would look like "the only candidate", and the preview would describe the CHILD's step
  // — a preview for a session nobody is looking at. `roots()` excludes subagents, so the correct
  // answer here is the global one, not the subagent.
  const { routes, addSubagent, setInitiator } = switchFixture({ noInitialAgent: true })
  setInitiator(undefined)
  addSubagent(makeAgent(makeSession([], 'C:\\proj-sub')))
  const response = await callRoute(routes, '/api/memory/preview')
  assert.equal(response.status, 200)
  assert.equal(response.json.scope, 'global', 'a subagent alone is not the open session')
})

await test('?session names the session to preview, and an unknown one is refused', async () => {
  // The honest form for a caller that knows its session. A NAMED but dead session is a 409, not a
  // silent fallback: previewing a different session than the one asked for would be the very bug
  // the resolution order exists to avoid.
  const { routes, agent, setInitiator } = switchFixture()
  setInitiator(undefined)
  const named = await callRoute(routes, '/api/memory/preview', { query: `?session=${agent.session.id}` })
  assert.equal(named.status, 200)
  assert.equal(named.json.session.id, agent.session.id)
  assert.equal(named.json.scope, 'session')

  const missing = await callRoute(routes, '/api/memory/preview', { query: '?session=session-does-not-exist' })
  assert.equal(missing.status, 409, 'a named session that is not live must not fall back')
  assert.match(missing.json.error, /no live session/)
})

await test('a preview of a muted session says the switch is why, without running the pass', async () => {
  const { routes, session, fs } = switchFixture()
  await callRoute(routes, '/api/memory/switch', { method: 'POST', body: { session: session.id, mode: 'off' } })
  const reads = fs.reads.length
  const { status, json } = await callRoute(routes, '/api/memory/preview')
  assert.equal(status, 200)
  assert.equal(json.available, true)
  assert.equal(json.switchedOff, true)
  assert.equal(json.step.action, 'silent')
  assert.match(json.step.reason, /switched off/)
  assert.equal(fs.reads.length, reads, 'muted previews must not read memory files')
})

await test('a preview of a project-scoped session shows only project memory', async () => {
  // The preview must describe the step that will really run: a project-scoped session would
  // be lied to by a preview built from the global roots.
  const { routes, session, fs } = switchFixture({
    files: { [USER_MEMORY]: 'cross-project knowledge', [PROJECT_MEMORY]: 'this repository conventions' },
  })
  await callRoute(routes, '/api/memory/switch', { method: 'POST', body: { session: session.id, mode: 'project' } })
  const { status, json } = await callRoute(routes, '/api/memory/preview')
  assert.equal(status, 200)
  assert.equal(json.mode, 'project')
  assert.match(json.snapshot.text, /repository conventions/)
  assert.doesNotMatch(json.snapshot.text, /cross-project knowledge/)
  assert.ok(fs.reads.length > 0)
})

await test('a removed session id does not linger in the store forever', async () => {
  // The store is an override list, so a session that no longer exists is inert: an id nobody
  // can match simply never applies. This pins that it is not somehow applied to the CURRENT
  // session just because it is the only entry.
  const { routes, listeners, agent } = switchFixture({
    files: { [SWITCH_STORE]: JSON.stringify({ sessions: ['session-long-gone'] }) },
  })
  assert.equal((await runPreStep(listeners, agent)).messages.length, 1, 'another session id must not mute this one')
  assert.equal((await callRoute(routes, '/api/memory/status')).json.memoryMode, 'auto')
})

await test('the budget route writes the injection cap through configEditor', async () => {
  // The one editable configuration value. Each `edit` call receives the CURRENT raw config from the
  // Loader, so this double feeds the previous result forward — which makes the deep-merge assertion
  // below meaningful rather than a restatement of its own input.
  const fs = makeFs({})
  const { ctx, routes, services } = makeCtx(fs, makeLlm('{}'))
  apply(ctx, loadConfig({ mode: 'custom', generation: { turnComplete: { enabled: false } } }))
  // The stored config carries an explicit `mode: custom`, because that is the mode a cap is writable
  // in: the schema defaults `mode` to `native`, which refuses it, so a config that simply omits the
  // key is one this write must refuse. (Leaving `mode` out here is exactly how the fixture used to
  // hide the defect — the doubled `edit` never ran the real rules, so a `native` default never bit.)
  let current = { enabled: true, mode: 'custom', consumption: { maxTokens: 2000, overflow: 'truncate' }, trust: { folders: ['x'] } }
  const edits = []
  services.set('configEditor', {
    entries: () => [{ options: { id: 'memory', name: '@dsh-external/dsh-memory' } }],
    edit: async (entry, change) => {
      // The real signature is `(current, inherited)`; pass BOTH so the double exercises the same call
      // the harness makes. An ignored second argument would hide a guard that depends on the inherited
      // layer (a `mode: native` supplied from BELOW this entry, not by the patch).
      current = change(current, {})
      edits.push({ entry, next: current })
    },
  })

  // A form sends a STRING; the route coerces it and reports the coerced value.
  const written = await callRoute(routes, '/api/memory/budget', { method: 'POST', body: { maxTokens: '1500' } })
  assert.equal(written.status, 200)
  assert.equal(written.json.maxTokens, 1500, 'the coerced number is reported, not the string sent')
  assert.equal(edits.length, 1)
  assert.equal(edits[0].entry.options.name, '@dsh-external/dsh-memory', 'the entry is found by specifier')
  // Deep merge: the sibling keys survive, so a one-field write cannot erase the rest of the config.
  assert.deepEqual(edits[0].next, {
    enabled: true,
    mode: 'custom',
    consumption: { maxTokens: 1500, overflow: 'truncate' },
    trust: { folders: ['x'] },
  })

  // A number is accepted as-is, and the status route then reports the new cap.
  const numeric = await callRoute(routes, '/api/memory/budget', { method: 'POST', body: { maxTokens: 900 } })
  assert.equal(numeric.json.maxTokens, 900)
})

await test('the budget route refuses a value the schema would refuse, and says how to inject nothing', async () => {
  const fs = makeFs({})
  const { ctx, routes, services } = makeCtx(fs, makeLlm('{}'))
  apply(ctx, loadConfig({ mode: 'custom', generation: { turnComplete: { enabled: false } } }))
  services.set('configEditor', {
    entries: () => [{ options: { id: 'memory', name: '@dsh-external/dsh-memory' } }],
    edit: async () => {
      throw new Error('must not be called')
    },
  })

  // 0 is the interesting one: `render.js` WOULD honour it, but the schema and the SDK both require a
  // positive integer, so a route that accepted it would write a configuration the plugin rejects.
  // The refusal names the real way to inject nothing.
  const zero = await callRoute(routes, '/api/memory/budget', { method: 'POST', body: { maxTokens: 0 } })
  assert.equal(zero.status, 400)
  assert.match(zero.json.error, /at least 1/)
  assert.match(zero.json.error, /turn consumption off/, 'the refusal says how to really inject nothing')

  // `Number('')` is 0 and `Number(true)` is 1: neither may become a silent configuration change.
  for (const bad of ['', '  ', 'abc', '1.5', '1e3', '0x10', true, null, undefined, -5, {}, []]) {
    const response = await callRoute(routes, '/api/memory/budget', { method: 'POST', body: { maxTokens: bad } })
    assert.equal(response.status, 400, `maxTokens=${JSON.stringify(bad)} must be refused`)
  }
  // A missing field, and a body that is not an object at all.
  assert.equal((await callRoute(routes, '/api/memory/budget', { method: 'POST', body: {} })).status, 400)
  assert.equal((await callRoute(routes, '/api/memory/budget', { method: 'POST', body: [] })).status, 400)

  // No writer at all: 501, because the request was fine and the COMPOSITION cannot write config.
  const bare = makeCtx(makeFs({}), makeLlm('{}'))
  apply(bare.ctx, loadConfig({ mode: 'custom', generation: { turnComplete: { enabled: false } } }))
  const noWriter = await callRoute(bare.routes, '/api/memory/budget', { method: 'POST', body: { maxTokens: 100 } })
  assert.equal(noWriter.status, 501)
  assert.match(noWriter.json.error, /no configEditor/)
})

await test('the status route publishes the legal floor for the cap', async () => {
  // The panel needs the floor to render `min` on its input, and it cannot import a Host module — so
  // the value rides on the status payload, from the one constant the schema also uses.
  const { routes } = switchFixture()
  const { json } = await callRoute(routes, '/api/memory/status')
  assert.equal(json.minTokens, 1)
  assert.equal(json.maxTokens, 2000)
})

await test('writing the cap in `native` mode is REFUSED, and the plugin keeps activating', async () => {
  // Reported from a live profile, and the worst defect this plugin has had: the panel offered an
  // editable cap while the profile ran `mode: native`, where the SDK accepts only the two `onResult`
  // callbacks. The write went through `configEditor.edit` → the Loader reconciled → `apply()` threw
  // from `validateMemoryConfig` → **the plugin failed to ACTIVATE**, so memory disappeared from every
  // session in that profile rather than just losing a setting.
  //
  // Two things are pinned here, and the second is the one that matters:
  //   1. the write is refused with 400 and a reason that names the way out, and
  //   2. the refused configuration was NEVER PERSISTED, so `apply()` still succeeds on the config
  //      that is on disk.
  const fs = makeFs({})
  const { ctx, routes, services } = makeCtx(fs, makeLlm('{}'))
  const nativeConfig = { mode: 'native', userScope: true, projectScope: true }
  apply(ctx, loadConfig(nativeConfig))

  // A real `edit`: `change` is called first and its RESULT is what would be persisted.
  let persisted = { ...nativeConfig }
  let called = 0
  services.set('configEditor', {
    entries: () => [{ options: { id: 'memory', name: '@dsh-external/dsh-memory' } }],
    edit: async (entry, change) => {
      called += 1
      // The harness persists only what the callback RETURNS, so a throw leaves the file untouched.
      // Passing the inherited layer (`{}` here) matches the real call signature.
      persisted = change(persisted, {})
    },
  })

  const refused = await callRoute(routes, '/api/memory/budget', { method: 'POST', body: { maxTokens: 1500 } })
  assert.equal(refused.status, 400, 'a configuration the plugin refuses is the CALLER’s error, not a 501')
  assert.match(refused.json.error, /mode "native" only accepts/, 'the reason is the plugin’s own')
  assert.match(refused.json.error, /mode: custom/, 'and it names the way out')
  assert.equal(called, 1, 'the edit ran, and threw before persisting')
  assert.deepEqual(persisted, nativeConfig, 'NOTHING was persisted, so the working config survives')

  // The proof that matters: the plugin still activates on what is on disk. Before the fix this threw.
  const again = makeCtx(makeFs({}), makeLlm('{}'))
  apply(again.ctx, loadConfig(persisted))
  assert.equal(
    (await callRoute(again.routes, '/api/memory/status')).json.maxTokens,
    2000,
    'the plugin still loads, with its own default cap',
  )
})

await test('the same write SUCCEEDS in `custom` mode, where the plugin accepts it', async () => {
  // Without this, the test above would also pass on a write path that refused everything.
  const fs = makeFs({})
  const { ctx, routes, services } = makeCtx(fs, makeLlm('{}'))
  apply(ctx, loadConfig({ mode: 'custom', generation: { turnComplete: { enabled: false } } }))
  let persisted = { mode: 'custom', userScope: true, projectScope: true, consumption: { overflow: 'truncate' } }
  services.set('configEditor', {
    entries: () => [{ options: { id: 'memory', name: '@dsh-external/dsh-memory' } }],
    edit: async (entry, change) => {
      persisted = change(persisted, {})
    },
  })

  const written = await callRoute(routes, '/api/memory/budget', { method: 'POST', body: { maxTokens: 1500 } })
  assert.equal(written.status, 200)
  assert.equal(written.json.maxTokens, 1500)
  assert.equal(persisted.consumption.maxTokens, 1500)
  // And the persisted result is one the plugin accepts — checked the same way the Loader would.
  apply(makeCtx(makeFs({}), makeLlm('{}')).ctx, loadConfig(persisted))
})

await test('the status payload publishes the write budget, so the panel can show a control', async () => {
  // The panel cannot import a Host module, so the budget has to ride on `/status` like `minTokens`
  // does. Without this the control would read `undefined` and render a zero it never received.
  const { routes } = switchFixture()
  const { json } = await callRoute(routes, '/api/memory/status')
  // The defaults: `0` = no limit. Published as NUMBERS, not strings, so the panel's dirty-check
  // compares like with like.
  assert.equal(json.maxWrites, 0)
  assert.equal(json.maxWriteBytes, 0)

  // And a configured budget is published as configured.
  const configured = switchFixture({ config: { generation: { maxWrites: 7, maxWriteBytes: 4096 } } })
  const published = await callRoute(configured.routes, '/api/memory/status')
  assert.equal(published.json.maxWrites, 7)
  assert.equal(published.json.maxWriteBytes, 4096)
})

await test('the generation route carries the daily-journal switch with the other two', async () => {
  // Qoder's journal is a `generation.*` key, so it travels in the same request as the two policy
  // switches: one Save, three halves of one decision.
  const fs = makeFs({})
  const { ctx, routes, services } = makeCtx(fs, makeLlm('{}'))
  apply(ctx, loadConfig({ mode: 'custom', generation: { turnComplete: { enabled: false } } }))
  let persisted = { mode: 'custom', generation: { turnComplete: { enabled: false } } }
  services.set('configEditor', {
    entries: () => [{ options: { id: 'memory', name: '@dsh-external/dsh-memory' } }],
    edit: async (entry, change) => { persisted = change(persisted, {}) },
  })

  const on = await callRoute(routes, '/api/memory/generation', { method: 'POST', body: { journal: true } })
  assert.equal(on.status, 200, JSON.stringify(on.json))
  assert.equal(persisted.generation.journal.enabled, true)
  // Flipping the journal leaves the other two switches alone.
  assert.equal(persisted.generation.enabled, undefined, 'the pass switch is not touched')
  assert.equal(persisted.generation.turnComplete.enabled, false)

  // The status payload publishes it, with the scope and directory the panel needs. Read from a
  // SEPARATELY applied config: `/status` reports the configuration the plugin resolved at `apply()`,
  // and the `configEditor` fake above only records what a write WOULD persist (nothing re-applies it).
  const published = switchFixture({ config: { generation: { journal: { enabled: true, scope: 'user' } } } })
  const { json } = await callRoute(published.routes, '/api/memory/status')
  assert.equal(json.journalEnabled, true)
  assert.equal(json.journalScope, 'user')
  assert.equal(json.journalDir, 'journal')

  const off = await callRoute(routes, '/api/memory/generation', { method: 'POST', body: { journal: 'false' } })
  assert.equal(off.status, 200)
  assert.equal(persisted.generation.journal.enabled, false, 'the string form is narrowed, not coerced')

  // A non-boolean is refused like the other two switches.
  const bad = await callRoute(routes, '/api/memory/generation', { method: 'POST', body: { journal: 1 } })
  assert.equal(bad.status, 400)
})

await test('the generation route flips the two Qoder policy switches', async () => {
  // `generation.enabled` is Qoder's `auto_memory_policy.enabled` (the automatic per-turn pass) and
  // `generation.dream.enabled` is `auto_dream.enabled`. Both were read-only in the panel before this.
  const fs = makeFs({})
  const { ctx, routes, services } = makeCtx(fs, makeLlm('{}'))
  apply(ctx, loadConfig({ mode: 'custom', generation: { turnComplete: { enabled: false } } }))
  let persisted = { mode: 'custom', generation: { turnComplete: { enabled: false } } }
  services.set('configEditor', {
    entries: () => [{ options: { id: 'memory', name: '@dsh-external/dsh-memory' } }],
    edit: async (entry, change) => { persisted = change(persisted, {}) },
  })

  const off = await callRoute(routes, '/api/memory/generation', { method: 'POST', body: { enabled: false } })
  assert.equal(off.status, 200, JSON.stringify(off.json))
  assert.equal(off.json.enabled, false)
  assert.equal(persisted.generation.enabled, false)
  // The trigger was already false, so nothing needed correcting.
  assert.deepEqual(off.json.implied, [])

  // Dream is independent of the pass, and both travel in one request.
  const dream = await callRoute(routes, '/api/memory/generation', { method: 'POST', body: { dream: true } })
  assert.equal(dream.status, 200)
  assert.equal(persisted.generation.dream.enabled, true)
  assert.equal(persisted.generation.enabled, false, 'the untouched switch keeps its value')

  // Strings are accepted, but only the exact two spellings — never a truthy coercion.
  const strings = await callRoute(routes, '/api/memory/generation', { method: 'POST', body: { enabled: 'true', dream: 'false' } })
  assert.equal(strings.status, 200)
  assert.equal(persisted.generation.enabled, true)
  assert.equal(persisted.generation.dream.enabled, false)
})

await test('turning the pass OFF also disables its per-turn trigger, and says so', async () => {
  // THE rule that would otherwise make the switch look broken: the SDK refuses
  // `generation.enabled: false` beside `turnComplete.enabled: true`, so a route that only wrote
  // `enabled: false` would have its write DECLINED and the user would see a switch that does nothing.
  // The route carries the trigger with it and reports the key it touched.
  const fs = makeFs({})
  const { ctx, routes, services } = makeCtx(fs, makeLlm('{}'))
  apply(ctx, loadConfig({ mode: 'custom' }))
  let persisted = { mode: 'custom', generation: { turnComplete: { enabled: true, minPromptChars: 1 } } }
  services.set('configEditor', {
    entries: () => [{ options: { id: 'memory', name: '@dsh-external/dsh-memory' } }],
    edit: async (entry, change) => { persisted = change(persisted, {}) },
  })

  const off = await callRoute(routes, '/api/memory/generation', { method: 'POST', body: { enabled: false } })
  assert.equal(off.status, 200, 'a switch the SDK would refuse must not be written as-is')
  assert.equal(persisted.generation.enabled, false)
  assert.equal(persisted.generation.turnComplete.enabled, false, 'the trigger was carried with it')
  assert.deepEqual(off.json.implied, ['generation.turnComplete.enabled'], 'and the reply names it')
  // The rest of the block survives: only `enabled` was carried, not the whole `turnComplete` object.
  assert.equal(persisted.generation.turnComplete.minPromptChars, 1)

  // Turning it back ON restores the trigger, so "on" really means the pass runs again.
  const on = await callRoute(routes, '/api/memory/generation', { method: 'POST', body: { enabled: true } })
  assert.equal(on.status, 200)
  assert.equal(persisted.generation.turnComplete.enabled, true)
  assert.deepEqual(on.json.implied, ['generation.turnComplete.enabled'])

  // And the configuration the route persists is one the plugin ACCEPTS — checked the way the Loader
  // would, because a rejected config stops the plugin activating entirely.
  apply(makeCtx(makeFs({}), makeLlm('{}')).ctx, loadConfig(persisted))
})

await test('the generation route never invents a `turnComplete` key that was not there', async () => {
  // The rule only bites when the trigger is EXPLICITLY true. Asserting it otherwise would add a key the
  // user never set — and an absent `turnComplete` is not `enabled: true`.
  const fs = makeFs({})
  const { ctx, routes, services } = makeCtx(fs, makeLlm('{}'))
  apply(ctx, loadConfig({ mode: 'custom' }))
  let persisted = { mode: 'custom' }
  services.set('configEditor', {
    entries: () => [{ options: { id: 'memory', name: '@dsh-external/dsh-memory' } }],
    edit: async (entry, change) => { persisted = change(persisted, {}) },
  })
  const off = await callRoute(routes, '/api/memory/generation', { method: 'POST', body: { enabled: false } })
  assert.equal(off.status, 200)
  assert.deepEqual(off.json.implied, [])
  assert.equal('turnComplete' in persisted.generation, false, 'no key the user never wrote')
})

await test('the generation route refuses a non-boolean instead of coercing it', async () => {
  const fs = makeFs({})
  const { ctx, routes, services } = makeCtx(fs, makeLlm('{}'))
  apply(ctx, loadConfig({ mode: 'custom' }))
  let edits = 0
  services.set('configEditor', {
    entries: () => [{ options: { id: 'memory', name: '@dsh-external/dsh-memory' } }],
    edit: async (entry, change) => { edits += 1; change({ mode: 'custom' }, {}) },
  })
  // A `<select>` may send `"false"`, which is the string most likely to be mistaken for `true`; the
  // route accepts exactly that spelling, and refuses everything that is merely truthy.
  for (const body of [{ enabled: 1 }, { enabled: 0 }, { enabled: 'yes' }, { enabled: 'on' }, { enabled: null }, { dream: 1 }, {}]) {
    const response = await callRoute(routes, '/api/memory/generation', { method: 'POST', body })
    assert.equal(response.status, 400, `${JSON.stringify(body)} must be refused`)
  }
  assert.equal(edits, 0, 'a refused request must never reach the writer')
})

await test('the status payload publishes both policy switches and which env var pins them', async () => {
  // The panel needs the values (it cannot import a Host module) and needs to know when a switch would
  // be a no-op, because `DSH_MEMORY_DREAM` / `DSH_MEMORY_HEADLESS` override the config.
  //
  // The env var must be set BEFORE the fixture applies its config: `resolveMemoryConfig` reads the
  // environment once, at `apply()`, so setting it afterwards changes nothing about the resolved value.
  const previous = process.env.DSH_MEMORY_DREAM
  process.env.DSH_MEMORY_DREAM = 'false'
  try {
    const pinned = switchFixture({ config: { generation: { dream: { enabled: true } } } })
    const { json } = await callRoute(pinned.routes, '/api/memory/status')
    assert.deepEqual(json.envPinned, ['dream'], 'the panel must be told which switch an env var pins')
    assert.equal(json.dreamEnabled, false, 'and the override wins over the config that says true')
    assert.equal(json.generationEnabled, true, 'the other switch is unaffected')
  } finally {
    if (previous === undefined) delete process.env.DSH_MEMORY_DREAM
    else process.env.DSH_MEMORY_DREAM = previous
  }

  // With no override in scope the list is empty and the config value stands.
  const clean = switchFixture({ config: { generation: { dream: { enabled: true } } } })
  const { json: free } = await callRoute(clean.routes, '/api/memory/status')
  assert.deepEqual(free.envPinned, [])
  assert.equal(free.dreamEnabled, true)
})

await test('the write-budget route sets both limits, and `0` means no limit', async () => {
  // The two write budgets are now panel-editable, and BOTH default to `0` = no limit (they do not
  // exist in Qoder, so there is nothing to align a cap to). `0` therefore has to survive the route:
  // a control whose zero silently becomes "refuse everything" would be the worst kind of setting.
  const fs = makeFs({})
  const { ctx, routes, services } = makeCtx(fs, makeLlm('{}'))
  apply(ctx, loadConfig({ mode: 'custom', generation: { turnComplete: { enabled: false } } }))
  let persisted = { mode: 'custom', userScope: true, projectScope: true }
  services.set('configEditor', {
    entries: () => [{ options: { id: 'memory', name: '@dsh-external/dsh-memory' } }],
    edit: async (entry, change) => { persisted = change(persisted, {}) },
  })

  const set = await callRoute(routes, '/api/memory/write-budget', { method: 'POST', body: { maxWrites: 8, maxWriteBytes: 32768 } })
  assert.equal(set.status, 200, JSON.stringify(set.json))
  assert.deepEqual(set.json, { ok: true, maxWrites: 8, maxWriteBytes: 32768 })
  assert.deepEqual(persisted.generation, { maxWrites: 8, maxWriteBytes: 32768 })

  // A form sends strings; digits-only is accepted and reported as the number.
  const strings = await callRoute(routes, '/api/memory/write-budget', { method: 'POST', body: { maxWrites: '6', maxWriteBytes: '1024' } })
  assert.equal(strings.status, 200)
  assert.equal(strings.json.maxWrites, 6)
  assert.equal(persisted.generation.maxWrites, 6)

  // Back to unlimited — the default — through the same route.
  const unlimited = await callRoute(routes, '/api/memory/write-budget', { method: 'POST', body: { maxWrites: 0, maxWriteBytes: 0 } })
  assert.equal(unlimited.status, 200)
  assert.deepEqual(persisted.generation, { maxWrites: 0, maxWriteBytes: 0 })
  // And the plugin still writes with no limit in force — nothing is refused for being "over 0".
  const tool = makeCtx(fs, makeLlm('{}'))
  apply(tool.ctx, trustConfig({ generation: { maxWrites: 0, maxWriteBytes: 0 } }))
  const wrote = await runTool(tool.tools, makeAgent(makeSession([], 'C:\\proj')), { action: 'write', path: 'big.md', content: 'x'.repeat(20000) })
  assert.equal(wrote.ok, true, 'an unlimited budget must not refuse a large write')
})

await test('the write-budget route refuses a non-integer, a negative and an empty body', async () => {
  const fs = makeFs({})
  const { ctx, routes, services } = makeCtx(fs, makeLlm('{}'))
  apply(ctx, loadConfig({ mode: 'custom', generation: { turnComplete: { enabled: false } } }))
  let edits = 0
  services.set('configEditor', {
    entries: () => [{ options: { id: 'memory', name: '@dsh-external/dsh-memory' } }],
    edit: async (entry, change) => { edits += 1; change({ mode: 'custom' }, {}) },
  })
  for (const body of [{ maxWrites: -1 }, { maxWrites: 1.5 }, { maxWrites: 'x' }, { maxWrites: '' }, { maxWrites: true }, {}]) {
    const response = await callRoute(routes, '/api/memory/write-budget', { method: 'POST', body })
    assert.equal(response.status, 400, `${JSON.stringify(body)} must be refused`)
  }
  assert.equal(edits, 0, 'a refused request must never reach the writer')
})

await test('the mode route switches, and switching TO native reports what it removed', async () => {
  // Switching modes is not symmetric: `native` refuses every generation/consumption setting, so an
  // entry that already carries a prompt or a cap CANNOT become native while they are there. Rather
  // than offer a switch that must fail, the route prunes them — that IS what handing the policy back
  // to the runtime means — and REPORTS what went, so a prompt is never dropped in silence.
  const fs = makeFs({})
  const { ctx, routes, services } = makeCtx(fs, makeLlm('{}'))
  apply(ctx, loadConfig({ mode: 'custom', generation: { turnComplete: { enabled: false } } }))
  let persisted = {
    mode: 'custom',
    userScope: true,
    projectScope: true,
    generation: { prompt: '只记录部署步骤。', onResult: () => {} },
    consumption: { maxTokens: 2000 },
  }
  services.set('configEditor', {
    entries: () => [{ options: { id: 'memory', name: '@dsh-external/dsh-memory' } }],
    edit: async (entry, change) => {
      persisted = change(persisted, {})
    },
  })

  const toNative = await callRoute(routes, '/api/memory/mode', { method: 'POST', body: { mode: 'native' } })
  assert.equal(toNative.status, 200)
  assert.equal(toNative.json.mode, 'native')
  // The reply names every removed key, and nothing is removed silently.
  assert.deepEqual(toNative.json.dropped.sort(), ['consumption.maxTokens', 'generation.prompt'])
  // What landed is native-legal: the mode, the scopes, and only the allowed callback.
  assert.equal(persisted.mode, 'native')
  assert.equal(persisted.generation.prompt, undefined, 'the refused prompt is gone from the file')
  assert.equal(persisted.consumption, undefined, 'and the emptied block is deleted, not left as {}')
  assert.equal(typeof persisted.generation.onResult, 'function', 'the one allowed override survives')
  // The proof: the persisted result is one the plugin ACCEPTS. Before, this is where activation broke.
  apply(makeCtx(makeFs({}), makeLlm('{}')).ctx, loadConfig(persisted))

  // And the reverse switch removes nothing — `custom` accepts everything.
  const toCustom = await callRoute(routes, '/api/memory/mode', { method: 'POST', body: { mode: 'custom' } })
  assert.equal(toCustom.status, 200)
  assert.deepEqual(toCustom.json.dropped, [])
  assert.equal(persisted.mode, 'custom')
})

await test('the mode route refuses an unknown mode rather than guessing one', async () => {
  const fs = makeFs({})
  const { ctx, routes, services } = makeCtx(fs, makeLlm('{}'))
  apply(ctx, loadConfig({ mode: 'custom', generation: { turnComplete: { enabled: false } } }))
  services.set('configEditor', {
    entries: () => [{ options: { id: 'memory', name: '@dsh-external/dsh-memory' } }],
    edit: async () => {
      throw new Error('must not be called')
    },
  })
  for (const bad of ['nativ', 'auto', 'both', '', '  ', true, null, undefined, 7, {}, []]) {
    const response = await callRoute(routes, '/api/memory/mode', { method: 'POST', body: { mode: bad } })
    assert.equal(response.status, 400, `mode=${JSON.stringify(bad)} must be refused`)
  }
  assert.match((await callRoute(routes, '/api/memory/mode', { method: 'POST', body: {} })).json.error, /must be one of/)
})

await test('the mode route normalizes case, the same way the scope route does', async () => {
  // A form may send `Native`; the vocabulary is exact but the ROUTE is what normalizes. Pinned so the
  // two write routes cannot come to disagree about how strict they are — `scopes` lowercases too.
  const fs = makeFs({})
  const { ctx, routes, services } = makeCtx(fs, makeLlm('{}'))
  apply(ctx, loadConfig({ mode: 'custom', generation: { turnComplete: { enabled: false } } }))
  let persisted = { mode: 'custom', userScope: true, projectScope: true }
  services.set('configEditor', {
    entries: () => [{ options: { id: 'memory', name: '@dsh-external/dsh-memory' } }],
    edit: async (entry, change) => {
      persisted = change(persisted, {})
    },
  })
  const response = await callRoute(routes, '/api/memory/mode', { method: 'POST', body: { mode: '  Native  ' } })
  assert.equal(response.status, 200)
  assert.equal(response.json.mode, 'native', 'the reply carries the normalized value, not what was typed')
  assert.equal(persisted.mode, 'native')
})

await test('switching to native is what UNLOCKS the cap on the way back', async () => {
  // The panel's whole reason for exposing the mode: `native` refuses the cap, so a user locked out of
  // it needs a way back that is not "edit YAML and restart". This walks the round trip and checks the
  // cap is writable again at the end.
  const fs = makeFs({})
  const { ctx, routes, services } = makeCtx(fs, makeLlm('{}'))
  apply(ctx, loadConfig({ mode: 'custom', generation: { turnComplete: { enabled: false } } }))
  let persisted = { mode: 'custom', userScope: true, projectScope: true, consumption: { maxTokens: 2000 } }
  services.set('configEditor', {
    entries: () => [{ options: { id: 'memory', name: '@dsh-external/dsh-memory' } }],
    edit: async (entry, change) => {
      persisted = change(persisted, {})
    },
  })

  // Custom: the cap saves.
  assert.equal((await callRoute(routes, '/api/memory/budget', { method: 'POST', body: { maxTokens: 1500 } })).status, 200)
  // To native: the cap goes away, and with it the ability to write one.
  await callRoute(routes, '/api/memory/mode', { method: 'POST', body: { mode: 'native' } })
  const refused = await callRoute(routes, '/api/memory/budget', { method: 'POST', body: { maxTokens: 900 } })
  assert.equal(refused.status, 400, 'native refuses the cap')
  // Back to custom: writable again, with no YAML edit anywhere.
  await callRoute(routes, '/api/memory/mode', { method: 'POST', body: { mode: 'custom' } })
  const allowed = await callRoute(routes, '/api/memory/budget', { method: 'POST', body: { maxTokens: 900 } })
  assert.equal(allowed.status, 200)
  assert.equal(persisted.consumption.maxTokens, 900)
})

await test('the status route publishes the mode choices it accepts', async () => {
  const { routes } = switchFixture()
  const { json } = await callRoute(routes, '/api/memory/status')
  assert.deepEqual(json.modeChoices, ['native', 'custom'])
})

await test('the status payload says whether the cap is writable in this mode', async () => {
  // The panel cannot work this out for itself: `mode` is a Host fact, and the rule that maps it to
  // "which fields may be written" lives in the Host. So it rides with the payload, like `minTokens`.
  //
  // A native fixture must be genuinely native-legal: `switchFixture` writes `turnComplete`, which
  // native refuses, so this builds its own context rather than bending the shared fixture.
  const build = (mode) => {
    const made = makeCtx(makeFs({ [USER_MEMORY]: 'user knowledge' }), makeLlm('{}'))
    apply(made.ctx, loadConfig(mode === 'native' ? { mode } : { mode: 'custom', generation: { turnComplete: { enabled: false } } }))
    return made
  }
  assert.equal((await callRoute(build('native').routes, '/api/memory/status')).json.consumptionWritable, false)
  assert.equal((await callRoute(build('custom').routes, '/api/memory/status')).json.consumptionWritable, true)
})

await test('the scope route writes the global layer, through the SAME writer as /memory-scope', async () => {
  // The panel and the command must not be able to disagree about what `project` means, so both go
  // through `scopeFields` in one module. This drives the route and asserts the exact flags that land.
  const fs = makeFs({})
  const { ctx, routes, services } = makeCtx(fs, makeLlm('{}'))
  apply(ctx, loadConfig({ mode: 'custom', generation: { turnComplete: { enabled: false } } }))
  let current = { enabled: true, userScope: true, projectScope: true, mode: 'native' }
  const edits = []
  services.set('configEditor', {
    entries: () => [{ options: { id: 'memory', name: '@dsh-external/dsh-memory' } }],
    edit: async (entry, change) => {
      // The real signature is `(current, inherited)`; pass BOTH so the double exercises the same call
      // the harness makes. An ignored second argument would hide a guard that depends on the inherited
      // layer (a `mode: native` supplied from BELOW this entry, not by the patch).
      current = change(current, {})
      edits.push({ entry, next: current })
    },
  })

  for (const [scopes, want] of [
    ['all', { userScope: true, projectScope: true }],
    ['user', { userScope: true, projectScope: false }],
    ['project', { userScope: false, projectScope: true }],
  ]) {
    const before = edits.length
    const response = await callRoute(routes, '/api/memory/scope', { method: 'POST', body: { scopes } })
    assert.equal(response.status, 200, `${scopes} must be accepted`)
    assert.equal(response.json.scopes, scopes)
    assert.equal(edits.length, before + 1)
    // Deep merge: whatever else was in the config survives a two-flag write.
    assert.deepEqual(edits[edits.length - 1].next, { enabled: true, mode: 'native', ...want })
    assert.equal(edits[edits.length - 1].entry.options.name, '@dsh-external/dsh-memory', 'found by specifier')
  }
})

await test('the scope route refuses a state it cannot write, including the one it can only report', async () => {
  const fs = makeFs({})
  const { ctx, routes, services } = makeCtx(fs, makeLlm('{}'))
  apply(ctx, loadConfig({ mode: 'custom', generation: { turnComplete: { enabled: false } } }))
  services.set('configEditor', {
    entries: () => [{ options: { id: 'memory', name: '@dsh-external/dsh-memory' } }],
    edit: async () => {
      throw new Error('must not be called')
    },
  })

  // `none` is a state the panel REPORTS but must never OFFER: it is a fourth spelling of "no memory
  // at all" beside `enabled: false`, and accepting it here would give it a silent second door.
  for (const bad of ['none', 'everything', '', '  ', true, null, undefined, 7, {}, []]) {
    const response = await callRoute(routes, '/api/memory/scope', { method: 'POST', body: { scopes: bad } })
    assert.equal(response.status, 400, `scopes=${JSON.stringify(bad)} must be refused`)
  }
  assert.equal((await callRoute(routes, '/api/memory/scope', { method: 'POST', body: {} })).status, 400)
  assert.equal((await callRoute(routes, '/api/memory/scope', { method: 'POST', body: [] })).status, 400)

  // A well-formed, legal request in a composition that cannot write config is 501, not 400: the
  // caller did nothing wrong, the DEPLOYMENT cannot honour it.
  const bare = makeCtx(makeFs({}), makeLlm('{}'))
  apply(bare.ctx, loadConfig({ mode: 'custom', generation: { turnComplete: { enabled: false } } }))
  const noWriter = await callRoute(bare.routes, '/api/memory/scope', { method: 'POST', body: { scopes: 'all' } })
  assert.equal(noWriter.status, 501)
  assert.match(noWriter.json.error, /no configEditor/)
})

await test('the status route publishes the scope choices and whether config is writable here', async () => {
  // The panel cannot import the Host's vocabulary, so the choice list and the writability of this
  // composition both ride on the payload. Without the second, the panel would render a Save whose
  // only possible answer is 501.
  const { routes, services } = switchFixture()
  const bare = await callRoute(routes, '/api/memory/status')
  assert.deepEqual(bare.json.globalScopeChoices, ['all', 'user', 'project'])
  assert.ok(!bare.json.globalScopeChoices.includes('none'), 'a state that cannot be written must not be offered')
  assert.equal(bare.json.configWritable, false, 'this fixture has no configEditor')

  const writer = switchFixture()
  writer.services.set('configEditor', { entries: () => [], edit: async () => {} })
  const withWriter = await callRoute(writer.routes, '/api/memory/status')
  assert.equal(withWriter.json.configWritable, true)
  assert.equal(services.get('configEditor'), undefined, 'the first fixture must not have leaked a writer')
})

await test('/memory-scope reports `none` instead of reporting it as `project`', async () => {
  // A real defect the shared vocabulary fixes: the inline ternary chain read
  // `userScope: false, projectScope: false` as "project" — the opposite of the truth.
  const { commands } = switchFixture({ config: { userScope: false, projectScope: false } })
  const status = await runCommand(commands, 'memory-scope')
  assert.equal(status.kind, 'success')
  assert.match(status.text, /global memory scopes: none/)
  assert.doesNotMatch(status.text, /undefined/, 'a state with no entry in the table must not print undefined')
})
console.log(`\n${passed} integration session-switch tests passed`)
