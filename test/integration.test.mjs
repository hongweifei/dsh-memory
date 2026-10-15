/**
 * Integration test: drives the real apply() against mocked Harness services.
 *
 * This exercises the complete Qoder memory contract end to end —generation,
 * consumption, the gate, per-file status, custom roots, result callbacks and
 * the runtime service —without a live Host.
 *
 * Run: node test/integration.test.mjs
 */
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { apply, Config, LARGE_FILE_CHARS } from '../lib/index.js'
import { resolveInstalled } from './harness-env.mjs'

/** Pin the harness home so the user scope resolves into the fixture filesystem. */
const HOME = 'C:\\home\\.dsh'
process.env.DSH_HOME = HOME
const USER_MEMORY = `${HOME}\\memory\\MEMORY.md`

let passed = 0
const test = async (label, fn) => {
  await fn()
  passed += 1
  console.log(`  ok  ${label}`)
}

/* ------------------------------------------------------------------ *
 * Harness doubles
 * ------------------------------------------------------------------ */

/** In-memory ctx.fs matching the real resolve/stat/readText/listDir/writeText contract. */
function makeFs(initial = {}, options = {}) {
  const files = new Map(Object.entries(initial))
  /** Keys whose read throws even though `stat` reports the file. */
  const failReads = new Set((options.failReads ?? []).map((path) => String(path)))
  const dirs = new Set()
  for (const path of files.keys()) {
    const parts = path.split(/[\\/]/)
    for (let index = 1; index < parts.length; index += 1) dirs.add(parts.slice(0, index).join('\\'))
  }
  let version = 0
  /** Every writeText's target key and declared sandbox policy. */
  const writes = []
  const normalize = (path) => String(path).replace(/\//g, '\\').replace(/\\+$/, '')
  /** Every readText, so a test can prove the version cache skipped one. */
  const reads = []
  return {
    files,
    reads,
    writes,
    /**
     * Simulate an editor writing a file: content AND provider version change.
     * `files.set` alone would leave the version stale, which is the one thing a
     * real provider never does.
     */
    touch(path, content) {
      files.set(normalize(path), content)
      version += 1
    },
    async resolve(path) {
      return { targetKey: normalize(path), displayPath: normalize(path) }
    },
    async stat(target) {
      const key = normalize(target.targetKey)
      if (files.has(key)) return { version: `v${version}`, type: 'file', size: files.get(key).length }
      if (dirs.has(key)) return { version: `v${version}`, type: 'directory' }
      return undefined
    },
    /**
     * A provider that CAN delete: `deleteGuarded` prefers this over reaching for
     * the OS, and the node:fs fallback is covered against a real temp file in the
     * unit suite.
     */
    async remove(target) {
      const key = normalize(target.targetKey)
      if (!files.has(key)) throw new Error(`ENOENT ${key}`)
      files.delete(key)
    },
    async readText(target) {
      const key = normalize(target.targetKey)
      reads.push(key)
      if (failReads.has(key)) {
        const error = new Error(`EACCES ${key}`)
        error.code = 'EACCES'
        throw error
      }
      if (!files.has(key)) throw new Error(`ENOENT ${key}`)
      return files.get(key)
    },
    async listDir(target) {
      const key = normalize(target.targetKey)
      const prefix = `${key}\\`
      const names = new Set()
      for (const path of files.keys()) {
        if (!path.startsWith(prefix)) continue
        const rest = path.slice(prefix.length)
        if (rest.includes('\\')) continue
        names.add(rest)
      }
      // Directory children are entries too: a provider that only reported files
      // would hide every project directory from a caller listing them.
      for (const dir of dirs) {
        if (!dir.startsWith(prefix)) continue
        const rest = dir.slice(prefix.length)
        if (rest.length === 0 || rest.includes('\\')) continue
        names.add(rest)
      }
      // A real provider reports each entry's type; a directory is what a caller
      // listing `<DSH_HOME>/projects` needs to see.
      return [...names].map((name) => ({
        name,
        type: dirs.has(`${key}\\${name}`) ? 'directory' : 'file',
        // Real listings carry cheap metadata; the scope rows show the total size.
        size: files.get(`${key}\\${name}`)?.length ?? 0,
        target: { targetKey: `${key}\\${name}`, displayPath: name },
      }))
    },
    async writeText(target, content, expected, _signal, sandboxPolicy) {
      const key = normalize(target.targetKey)
      // Every per-call policy the plugin declares, so a test can prove the sandbox argument
      // reaches the provider instead of the write being fenced out of the workspace.
      writes.push({ key, sandboxPolicy })
      if (expected?.kind === 'createIfAbsent' && files.has(key)) {
        const error = new Error('exists')
        error.code = 'FS_NOT_OBSERVED'
        throw error
      }
      if (expected?.kind === 'replaceIfVersion') {
        if (!files.has(key)) {
          const error = new Error('missing')
          error.code = 'FS_STALE_VERSION'
          throw error
        }
        // COMPARE the version, do not merely require the file to exist. A provider that ignored the
        // version would make every compare-and-swap look like it worked, so a lost update could not be
        // tested at all — and the whole point of `editGuarded` is that a change between the read and
        // the write is REFUSED rather than overwritten.
        if (expected.version !== undefined && expected.version !== `v${version}`) {
          const error = new Error('stale')
          error.code = 'FS_STALE_VERSION'
          throw error
        }
      }
      files.set(key, content)
      version += 1
      return { operation: files.has(key) ? 'update' : 'create', version: `v${version}` }
    },
  }
}

/** ctx.llm double that replays a scripted JSON plan. */
function makeLlm(plan, options = {}) {
  const calls = []
  return {
    calls,
    stream(options_) {
      const nth = calls.length
      calls.push(options_)
      const text = typeof plan === 'function' ? plan(options_) : plan
      return (async function* generate() {
        // `options.before` lets a test hold one pass open, which is what makes
        // "two turns during one pass" observable.
        if (typeof options.before === 'function') await options.before(nth)
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text }
        yield { type: 'block-end', index: 0, block: { type: 'text', text } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
  }
}

/** Session double exposing the surface/event/header contract the plugin reads. */
function makeSession(events, cwd) {
  return {
    id: 'session-1',
    header: { cwd },
    requestHeader: () => ({ config: { provider: 'test-provider', model: 'test-model' } }),
    snapshotEvents: () => events,
    surface: { nodes: [] },
    eventAt: () => undefined,
  }
}

/** Agent double with the inbox and inject faces the plugin uses. */
function makeAgent(session) {
  const injected = []
  const removed = []
  return {
    session,
    injected,
    removed,
    inbox: {
      nextStep: [],
      remove: (id) => {
        removed.push(id)
        return true
      },
      prepend: () => {},
    },
    inject: (message) => injected.push(message),
  }
}

/** Commands double capturing every registration so a test can invoke a handler. */
function makeCommands() {
  const registered = new Map()
  return {
    registered,
    register(definition) {
      registered.set(definition.name, definition)
      return () => registered.delete(definition.name)
    },
  }
}

/** Tools double capturing every registration so a test can invoke a tool. */
function makeTools() {
  const registered = new Map()
  return {
    registered,
    register(definition) {
      registered.set(definition.name, definition)
      return () => registered.delete(definition.name)
    },
  }
}

/** Invoke one registered command as the Host would. */
async function runCommand(commands, name, { agent, rawInput } = {}) {
  const definition = commands.registered.get(name)
  assert.ok(definition, `command /${name} was not registered`)
  return definition.handler({ agent, rawInput: rawInput ?? '', signal: new AbortController().signal })
}

/** Cordis ctx double that captures listeners and calls inject callbacks eagerly. */
function makeCtx(fs, llm) {
  const listeners = new Map()
  const services = new Map()
  /** Routes registered on the fake connection.fetch registry, keyed by path. */
  const routes = new Map()
  const connection = {
    fetch: {
      register(route) {
        routes.set(route.path, route)
        return async () => {
          routes.delete(route.path)
        }
      },
    },
  }
  const commands = makeCommands()
  const tools = makeTools()
  /**
   * The live-agent registry, as a route sees it. A browser request arrives with NO
   * initiator boundary (no HTTP path establishes one), so `currentInitiator` is
   * undefined there unless a test says otherwise — which is exactly the condition the
   * switch route has to survive by naming its session.
   */
  const liveAgents = []
  /** Top-level agents, i.e. the sessions a user has open (subagents are NOT in here). */
  const rootAgents = []
  let initiator
  const agents = {
    // A COPY, like the real registry: `list()` says "a fresh array; mutating it does not affect the
    // registry". A test that pushes onto the returned array changes nothing, which is worth the
    // double mirroring exactly — it caught one of these tests doing precisely that.
    list: () => [...liveAgents],
    roots: () => [...rootAgents],
    get: (id) => liveAgents.find((agent) => agent.session.id === id),
    currentInitiator: () => initiator,
  }
  const ctx = {
    // A real Cordis context exposes injected services as properties, and
    // `commands.register` is reached that way.
    commands,
    tools,
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    // Real Cordis runs the effect body immediately and registers its returned
    // disposer; the double must do the same or route registrations never happen.
    effect: (body) => {
      const dispose = body()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    on: (name, handler) => {
      const list = listeners.get(name) ?? []
      list.push(handler)
      listeners.set(name, list)
      return () => {}
    },
    inject: (deps, callback) => {
      const available = deps.every(
        (dep) =>
          dep === 'fs' || dep === 'llm' || dep === 'connection' || dep === 'commands' || dep === 'tools' || services.has(dep),
      )
      if (available) callback(ctx)
      return () => {}
    },
    provide: (name, value) => {
      services.set(name, value)
      return () => {}
    },
    get: (name) => {
      if (name === 'fs') return fs
      if (name === 'llm') return llm
      if (name === 'connection') return connection
      if (name === 'commands') return commands
      if (name === 'tools') return tools
      if (name === 'agents') return agents
      return services.get(name)
    },
  }
  return {
    ctx,
    listeners,
    services,
    routes,
    commands,
    tools,
    agents,
    /** Register a live agent, so `agents.list()`/`get()` can see it. */
    addAgent: (agent) => {
      liveAgents.push(agent)
      rootAgents.push(agent)
    },
    /** Register a SUBAGENT: live, but not a session the user has open. */
    addSubagent: (agent) => liveAgents.push(agent),
    /** Set the process-local initiator (a slash command / tool has one; a route does not). */
    setInitiator: (agent) => {
      initiator = agent
    },
  }
}

/** Call one registered web route with a Fetch Request. */
async function callRoute(routes, path, init) {
  const route = routes.get(path)
  assert.ok(route, `route ${path} was not registered`)
  const request = new Request(`http://127.0.0.1:3080${path}${init?.query ?? ''}`, {
    method: init?.method ?? 'GET',
    headers: init?.body === undefined ? undefined : { 'content-type': 'application/json' },
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
  })
  const response = await route.fetch(request)
  let json
  try {
    json = await response.json()
  } catch {
    json = null
  }
  return { status: response.status, json }
}

const loadConfig = (raw) => {
  const result = Config['~standard'].validate(raw)
  assert.equal(result.issues, undefined, `config rejected: ${JSON.stringify(result.issues)}`)
  return result.value
}

/** Drive the captured `agent/pre-step` waterfall. */
async function runPreStep(listeners, agent) {
  const handlers = listeners.get('agent/pre-step') ?? []
  assert.ok(handlers.length > 0, 'agent/pre-step listener was not registered')
  const messages = []
  const signal = new AbortController().signal
  // A real waterfall: each listener may decide, and `next()` continues the chain.
  const run = async (index) => {
    const handler = handlers[index]
    if (handler === undefined) return { kind: 'enter', messages }
    return handler({ agent, messages, turn: 1, step: 1, signal }, () => run(index + 1))
  }
  return run(0)
}

console.log('dsh-memory integration tests')

/* ================= consumption ================= */

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

/* ================= generation ================= */

const turnEvents = (prompt, response) => [
  { type: 'turn/start', seq: 1, time: 1, data: { turn: 1 } },
  { type: 'user/message', seq: 2, time: 2, data: { content: [{ type: 'text', text: prompt }] } },
  { type: 'assistant/message', seq: 3, time: 3, data: { message: { content: [{ type: 'text', text: response }] } } },
  { type: 'turn/end', seq: 4, time: 4, data: { turn: 1, reason: { kind: 'completed' } } },
]

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

await test('a write past the per-pass budget is deferred, and the pass is still a success', async () => {
  // Reported live in the panel as `写入被拒 status.md：at most 4 files may be written per pass`:
  // a pass that had merely spent its budget read as a broken one. The budget is the plugin's
  // own runaway guard (Qoder states no such cap), so a write it stops is deferred, reported,
  // and continues in the next pass — never counted as a failure.
  const plan = (count) =>
    JSON.stringify({
      writes: Array.from({ length: count }, (_, index) => ({
        rootId: 'project',
        path: `note-${index}.md`,
        content: '# note',
      })),
      reason: 'several notes',
    })
  const run = async (config, count) => {
    const fs = makeFs({})
    const { ctx, listeners, services, commands } = makeCtx(fs, makeLlm(plan(count)))
    let reported
    apply(
      ctx,
      loadConfig({
        mode: 'custom',
        userScope: false,
        generation: { ...config, turnComplete: { minPromptChars: 1 }, onResult: (result) => (reported = result) },
      }),
    )
    const session = makeSession(turnEvents('a reasonably long prompt to pass the gate', 'ok'), 'C:\\proj')
    const agent = makeAgent(session)
    listeners.get('agent/created')[0]({ agent })
    listeners.get('session/event')[0](session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    await services.get('memory').flushMemory()
    return { reported, commands }
  }

  const capped = await run({ maxWrites: 2 }, 3)
  assert.equal(capped.reported.status, 'saved', 'nothing failed: the budget ran out')
  assert.deepEqual(capped.reported.failedFiles, [], 'a deferred write is not a failure')
  assert.deepEqual(
    capped.reported.writtenFiles.map((file) => file.path),
    ['note-0.md', 'note-1.md'],
  )
  assert.deepEqual(
    capped.reported.deferredFiles.map((file) => file.path),
    ['note-2.md'],
  )
  assert.match(capped.reported.deferredFiles[0].error, /per-pass write budget \(2\) is spent/)
  assert.match(capped.reported.reason, /several notes/, "the model's own summary still wins the reason")

  // `/memory` reports the deferral as such, so the CLI report cannot read as a failure either.
  const report = await runCommand(capped.commands, 'memory', { agent: makeAgent(makeSession([], 'C:\\proj')) })
  assert.match(report.text, /deferred: project:note-2\.md — the per-pass write budget \(2\) is spent/)

  // `0` means "no cap" for these knobs: the same plan lands whole.
  const uncapped = await run({ maxWrites: 0 }, 3)
  assert.equal(uncapped.reported.writtenFiles.length, 3)
  assert.deepEqual(uncapped.reported.deferredFiles, [])
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

/* ================= web routes (settings panel data) ================= */

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
  assert.equal(json.maxTokens, 2000)
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

/* ================= SDK-aligned option rules ================= */

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

await test('consumption.maxTokens must be a positive integer', () => {
  // The schema enforces this before apply() ever runs, mirroring the SDK's
  // positive-integer requirement.
  assert.throws(() => loadConfig({ mode: 'custom', consumption: { maxTokens: 1.5 } }), /maxTokens/)
  assert.throws(() => loadConfig({ mode: 'custom', consumption: { maxTokens: 0 } }), /maxTokens/)
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

/* ================= runtime service ================= */

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

/* ---------------- dream (consolidation) ---------------- */

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

/* ================= folder trust ================= */

// The project scope is keyed the way the HARNESS keys a project: session
// persistence would put `C:\proj` under `--C-proj--`, and so does memory. The
// trust gate asks about that same canonical directory.
const PROJECT_MEMORY = 'C:\\home\\.dsh\\projects\\--C-proj--\\memory\\MEMORY.md'
const TRUST_STORE = 'C:\\home\\.dsh\\trusted-folders.json'

const projectMemoryFixture = (extra = {}) =>
  makeFs({ [USER_MEMORY]: 'user knowledge', [PROJECT_MEMORY]: 'project knowledge', ...extra })

/**
 * Trust-section config. `custom` mode is required because the SDK's `native`
 * rule rejects a `generation` override, and these tests turn the automatic
 * per-turn pass off so only the consumption half is under test. With no
 * explicit roots, `custom` still resolves the two built-in scope roots.
 */
const trustConfig = (raw = {}) =>
  loadConfig({ mode: 'custom', ...raw, generation: { turnComplete: { enabled: false }, ...raw.generation } })

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

/* ================= the memory tool ================= */

/** Invoke the registered `memory` tool as the Harness would. */
async function runTool(tools, agent, args) {
  const definition = tools.registered.get('memory')
  assert.ok(definition, 'the memory tool was not registered')
  return definition.execute(args, { agent, signal: new AbortController().signal })
}

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

await test('an edit cannot grow a file past maxWriteBytes', async () => {
  // The bound `write` enforces, enforced on the RESULT and checked before persisting: a tool that
  // could grow a memory file without limit while `write` refuses to is a hole, not a convenience.
  const path = `${HOME}\\projects\\--C-proj--\\memory\\NOTE.md`
  const fs = makeFs({ [path]: 'small\n' })
  const { ctx, tools } = makeCtx(fs, makeLlm('{}'))
  // `trustConfig` is the fixture that resolves BOTH built-in scopes; override only the bound, since
  // replacing `generation` wholesale would drop the `turnComplete` switch this config needs.
  apply(ctx, trustConfig({ generation: { maxWriteBytes: 64 } }))
  const agent = makeAgent(makeSession([], 'C:\\proj'))

  const grown = await runTool(tools, agent, { action: 'edit', path: 'NOTE.md', old_string: 'small', new_string: 'x'.repeat(200) })
  assert.equal(grown.ok, false)
  assert.match(grown.message, /maxWriteBytes 64/)
  assert.equal(fs.files.get(path), 'small\n', 'the refusal must not have written anything')
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

/* ================= project identity ================= */

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

/* ================= consumption discovery pipeline ================= */

const PROJECT_DIR = 'C:\\home\\.dsh\\projects\\--C-proj--\\memory'

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

/* ================= @imports ================= */

// Imported targets live in a SUBDIRECTORY on purpose: a `.md` directly in the
// root is also a memory file in its own right, so it would be injected whether
// or not the import resolved. Only a nested file proves the expansion happened.
const IMPORT = (name) => `${PROJECT_DIR}\\sub\\${name}`

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

/* ================= mid-session memory changes ================= */

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

/* ================= turn pacing and serialization ================= */

/** Spin the event loop until a condition holds, so a held pass is observable. */
async function waitFor(predicate, label) {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (predicate()) return
    await new Promise((resolve) => setImmediate(resolve))
  }
  throw new Error(`timed out waiting for ${label}`)
}

/** Fire one completed turn at the plugin. */
function endTurn(listeners, session, agent, turn) {
  listeners.get('agent/created')[0]({ agent })
  listeners.get('session/event')[0](session, { type: 'turn/end', data: { turn, reason: { kind: 'completed' } } })
}

/** A growing session log: the harness appends as turns complete. */
function makeLog(session) {
  const log = []
  session.snapshotEvents = () => log
  return {
    log,
    /** Append one turn's events, then report that the turn ended. */
    turn(listeners, agent, turn, prompt, response = 'done') {
      const base = log.length
      log.push(
        { type: 'turn/start', seq: base, time: base, data: { turn } },
        { type: 'user/message', seq: base + 1, time: base + 1, data: { content: [{ type: 'text', text: prompt }] } },
        {
          type: 'assistant/message',
          seq: base + 2,
          time: base + 2,
          data: { message: { content: [{ type: 'text', text: response }] } },
        },
        { type: 'turn/end', seq: base + 3, time: base + 3, data: { turn, reason: { kind: 'completed' } } },
      )
      endTurn(listeners, session, agent, turn)
    },
  }
}

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

/* ================= the read fast path ================= */

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

/* ================= just-in-time memory ================= */

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

/* ================= in-turn generation ================= */

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

/* ================= the per-session switch ================= */

/** The switch store, beside the plugin's other stores under `$DSH_HOME`. */
const SWITCH_STORE = `${HOME}\\memory-off-sessions.json`

/**
 * A fixture with both halves enabled and a working generation plan, plus one live
 * agent registered so the routes can resolve it.
 */
function switchFixture(options = {}) {
  const fs = makeFs({ [USER_MEMORY]: 'user knowledge', ...(options.files ?? {}) })
  const plan = JSON.stringify({
    writes: [{ rootId: 'user', path: 'MEMORY.md', content: '# Recorded\n\nsomething', mode: 'replace' }],
    reason: 'recorded a fact',
  })
  const llm = makeLlm(plan)
  const made = makeCtx(fs, llm)
  apply(
    made.ctx,
    loadConfig({
      mode: 'custom',
      // Both built-in scopes ON, so a session's own scope choice has something to narrow.
      // `mode: custom` without a roots list still resolves the built-ins.
      userScope: true,
      projectScope: true,
      generation: { turnComplete: { minPromptChars: 1 } },
      // Overrides for the global-scope tests, applied last so they win.
      ...(options.config ?? {}),
    }),
  )
  const session = makeSession([], 'C:\\proj')
  const agent = makeAgent(session)
  // `noInitialAgent` leaves the registry EMPTY, so a test can express "nothing open" or register
  // only a subagent. Every other fixture registers one top-level agent and sets it as the initiator.
  if (options.noInitialAgent !== true) {
    made.addAgent(agent)
    // The preview and refresh routes speak for the initiator; a browser request usually
    // has none, which is why the switch ROUTE names its session instead.
    made.setInitiator(agent)
  }
  return { fs, llm, session, agent, ...made }
}

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

console.log(`\n${passed} integration tests passed`)