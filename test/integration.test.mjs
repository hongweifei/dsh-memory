/**
 * Integration test: drives the real apply() against mocked Harness services.
 *
 * This exercises the complete Qoder memory contract end to end �?generation,
 * consumption, the gate, per-file status, custom roots, result callbacks and
 * the runtime service �?without a live Host.
 *
 * Run: node test/integration.test.mjs
 */
import assert from 'node:assert/strict'
import { apply, Config, LARGE_FILE_CHARS } from '../lib/index.js'

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
      if (expected?.kind === 'replaceIfVersion' && !files.has(key)) {
        const error = new Error('missing')
        error.code = 'FS_STALE_VERSION'
        throw error
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
  let initiator
  const agents = {
    list: () => [...liveAgents],
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
    addAgent: (agent) => liveAgents.push(agent),
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
    '/api/memory/file',
    '/api/memory/flush',
    '/api/memory/preview',
    '/api/memory/refresh',
    '/api/memory/status',
    '/api/memory/switch',
    '/api/memory/trust',
  ])
  for (const route of routes.values()) {
    assert.ok(route.methods.length > 0, 'a route must declare at least one method')
    assert.equal(new Set(route.methods).size, route.methods.length, 'methods must not repeat')
    assert.equal(route.requestBody, 'buffered')
  }
  assert.deepEqual(routes.get('/api/memory/status').methods, ['GET'])
  assert.deepEqual(routes.get('/api/memory/file').methods, ['GET', 'POST', 'DELETE'])
  assert.deepEqual(routes.get('/api/memory/trust').methods, ['POST'])
  assert.deepEqual(routes.get('/api/memory/switch').methods, ['POST'])
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

await test('previewMemory reports a changed config as a fresh snapshot, and unavailability honestly', async () => {
  const fs = makeFs({ [USER_MEMORY]: 'knowledge' })
  const { ctx, listeners, services } = makeCtx(fs, makeLlm('{}'))
  apply(ctx, loadConfig({
    mode: 'custom',
    userScope: true,
    generation: { turnComplete: { enabled: false } },
  }))
  const service = services.get('memory')
  const agent = makeAgent(makeSession([], 'C:\\proj'))
  await runPreStep(listeners, agent)

  // A preview with no session cannot answer: it has no cwd, no roots and no
  // baseline, so it says so rather than inventing a block for nobody.
  const orphan = await service.previewMemory(undefined)
  assert.equal(orphan.available, false)
  assert.match(orphan.reason, /no session/)

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
  assert.equal(agentless.json.sessionMode, undefined, 'no session answered, so none is reported')
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

await test('the memory tool offers list, read, search and write in one schema', async () => {
  const fs = projectMemoryFixture()
  const { ctx, tools } = makeCtx(fs, makeLlm('{}'))
  apply(ctx, trustConfig())
  const definition = tools.registered.get('memory')
  assert.ok(definition, 'the memory tool must be registered')
  assert.deepEqual(definition.parameters.properties.action.enum, ['list', 'read', 'search', 'write', 'delete'])
  assert.ok(definition.parameters.properties.query, 'search needs a query property')
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
      projectScope: false,
      generation: { turnComplete: { minPromptChars: 1 } },
    }),
  )
  const session = makeSession([], 'C:\\proj')
  const agent = makeAgent(session)
  made.addAgent(agent)
  // The preview and refresh routes speak for the initiator; a browser request usually
  // has none, which is why the switch ROUTE names its session instead.
  made.setInitiator(agent)
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
  const switched = await service.setMemorySwitch(agent.session, true)
  assert.equal(switched.off, true)
  assert.equal(switched.changed, true)
  const second = await runPreStep(listeners, agent)
  assert.equal(second.messages.length, 0, 'a muted session gets nothing injected, even after a change')
  log.turn(listeners, agent, 2, 'another long enough prompt to pass the gate')
  await service.flushMemory()
  assert.equal(llm.calls.length, 1, 'a muted session records nothing either')

  // The file is untouched by the muted turn, and the store names the session.
  assert.equal(fs.files.get(USER_MEMORY), recorded, 'the muted turn wrote nothing')
  assert.deepEqual(JSON.parse(fs.files.get(SWITCH_STORE)).sessions, ['session-1'])
})

await test('a muted session drops memory already queued in its inbox', async () => {
  // The half-step case that matters: a message injected before the switch was flipped
  // is a lie sitting in the reader's own queue, so it must be removed, not left there.
  const { listeners, services, agent } = switchFixture()
  const service = services.get('memory')
  await runPreStep(listeners, agent)
  const queued = { id: 'queued-memory', source: { kind: 'memory', identity: 'x' } }
  agent.inbox.nextStep.push(queued)
  await service.setMemorySwitch(agent.session, true)
  const decision = await runPreStep(listeners, agent)
  assert.deepEqual(agent.removed, ['queued-memory'], 'the stale injection must be removed')
  assert.equal(decision.messages.length, 0)
})

await test('turning the switch back on injects again, and is persisted', async () => {
  const { fs, listeners, services, agent } = switchFixture({
    files: { [SWITCH_STORE]: JSON.stringify({ sessions: ['session-1'] }) },
  })
  const service = services.get('memory')

  // The store was read before the first step, so a resumed mute is honoured at once.
  const muted = await runPreStep(listeners, agent)
  assert.equal(muted.messages.length, 0, 'a mute remembered on disk is honoured on the first step')

  const back = await service.setMemorySwitch(agent.session, false)
  assert.equal(back.off, false)
  assert.equal(back.changed, true)
  const injected = await runPreStep(listeners, agent)
  assert.equal(injected.messages.length, 1, 'turning it back on injects again')
  assert.deepEqual(JSON.parse(fs.files.get(SWITCH_STORE)).sessions, [], 'the store no longer names it')
})

await test('setting the switch twice is a no-op that does not rewrite the store', async () => {
  const { fs, services, agent } = switchFixture()
  const service = services.get('memory')
  await service.setMemorySwitch(agent.session, true)
  const writes = fs.writes.length
  const again = await service.setMemorySwitch(agent.session, true)
  assert.equal(again.changed, false, 'an unchanged switch reports that nothing changed')
  assert.equal(fs.writes.length, writes, 'and does not write the store again')
})

await test('a damaged switch store reads as nothing muted, not as everything muted', async () => {
  // The store only ever records SUPPRESSION, so a lost or damaged one must fail open:
  // the failure mode is "the mute was forgotten", never "memory went quiet everywhere".
  const { listeners, services, agent } = switchFixture({
    files: { [SWITCH_STORE]: '{ this is not json' },
  })
  const injected = await runPreStep(listeners, agent)
  assert.equal(injected.messages.length, 1, 'a damaged store must not mute anything')
  assert.deepEqual(services.get('memory').status({ session: agent.session }).switchedOff, false)
})

await test('the switch is per session: a muted session does not mute another', async () => {
  const { listeners, services, agent, ctx } = switchFixture()
  const service = services.get('memory')
  await service.setMemorySwitch(agent.session, true)

  const other = makeAgent({ ...makeSession([], 'C:\\other'), id: 'session-2' })
  const injected = await runPreStep(listeners, other)
  assert.equal(injected.messages.length, 1, 'another session still gets its memory')
})

await test('a deliberate refresh and the memory tool respect the switch, and say why', async () => {
  const { services, commands, tools, agent, fs } = switchFixture()
  const service = services.get('memory')
  await service.setMemorySwitch(agent.session, true)

  // `/memory-refresh`: not silently ignored — the caller is told how to lift the mute.
  const refreshed = await runCommand(commands, 'memory-refresh', { agent })
  assert.equal(refreshed.kind, 'success')
  assert.match(refreshed.text, /memory is switched off/i)
  assert.match(refreshed.text, /\/memory-switch on/)

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

await test('/memory-switch reports and changes the decision, and /memory states it', async () => {
  const { commands, agent } = switchFixture()
  const status = await runCommand(commands, 'memory-switch', { agent })
  assert.match(status.text, /session memory: ON/)
  assert.match(status.text, /session-1/)

  const off = await runCommand(commands, 'memory-switch', { agent, rawInput: 'off' })
  assert.match(off.text, /session memory: OFF/)
  assert.match(off.text, /nothing is injected into this session, and nothing from it is recorded/)

  // `/memory` says the switch's state BEFORE its results, so a quiet session is explained.
  const report = await runCommand(commands, 'memory', { agent })
  assert.match(report.text, /session switch: OFF/)

  const on = await runCommand(commands, 'memory-switch', { agent, rawInput: 'on' })
  assert.match(on.text, /session memory: ON/)
  // Turning it back on does not re-inject by itself, and the command says so.
  assert.match(on.text, /\/memory-refresh forces it now/)

  const bad = await runCommand(commands, 'memory-switch', { agent, rawInput: 'maybe' })
  assert.equal(bad.kind, 'error')
  assert.match(bad.text, /unknown action "maybe"/)
})

await test('/memory-switch is registered, and reported by the panel command list', async () => {
  const { commands } = switchFixture()
  assert.ok(commands.registered.has('memory-switch'), '/memory-switch must be registered')
  assert.match(commands.registered.get('memory-switch').description, /THIS session/)
})

await test('the switch route toggles a NAMED session and refuses an unknown one', async () => {
  const { routes, session, setInitiator, agent } = switchFixture()

  // No session named AND no initiator: this is the real browser case (no HTTP path
  // establishes an initiator boundary), so the route must say so rather than guess.
  setInitiator(undefined)
  const unnamed = await callRoute(routes, '/api/memory/switch', { method: 'POST', body: { off: true } })
  assert.equal(unnamed.status, 409)
  assert.match(unnamed.json.error, /session is required/)

  // A named session that does not exist is refused, not silently redirected to another.
  const unknown = await callRoute(routes, '/api/memory/switch', {
    method: 'POST',
    body: { session: 'session-nope', off: true },
  })
  assert.equal(unknown.status, 409)
  assert.match(unknown.json.error, /no live session has that id/)

  // A live session is switched, and the reply carries the recomputed session list.
  const off = await callRoute(routes, '/api/memory/switch', {
    method: 'POST',
    body: { session: session.id, off: true },
  })
  assert.equal(off.status, 200)
  assert.equal(off.json.off, true)
  assert.equal(off.json.changed, true)
  assert.deepEqual(off.json.sessions, [{ id: 'session-1', cwd: 'C:\\proj', off: true }])

  const on = await callRoute(routes, '/api/memory/switch', {
    method: 'POST',
    body: { session: session.id, off: false },
  })
  assert.equal(on.json.off, false)

  // With an initiator in scope (a programmatic caller rather than the panel) an unnamed
  // request means THAT session — the same seam preview and refresh resolve through.
  setInitiator(agent)
  const implied = await callRoute(routes, '/api/memory/switch', { method: 'POST', body: { off: true } })
  assert.equal(implied.status, 200)
  assert.equal(implied.json.session, 'session-1')

  // A body without a boolean is a client error, not a default.
  const bad = await callRoute(routes, '/api/memory/switch', { method: 'POST', body: { session: session.id } })
  assert.equal(bad.status, 400)
  assert.match(bad.json.error, /off must be a boolean/)
})

await test('the status route publishes the switch and every live session', async () => {
  const { routes, session, agent } = switchFixture()
  const before = await callRoute(routes, '/api/memory/status')
  assert.deepEqual(before.json.sessions, [{ id: 'session-1', cwd: 'C:\\proj', off: false }])
  assert.equal(before.json.memorySwitch.available, true)

  await callRoute(routes, '/api/memory/switch', { method: 'POST', body: { session: session.id, off: true } })
  const after = await callRoute(routes, '/api/memory/status')
  assert.deepEqual(after.json.sessions, [{ id: 'session-1', cwd: 'C:\\proj', off: true }])
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
  assert.equal(response.json.off, undefined)
  assert.match(response.json.snapshot.text, /user knowledge/)
  assert.ok(response.json.snapshot.tokens > 0)
  assert.ok(fs.reads.length > 0, 'an unmuted preview really reads the memory files')
})

await test('a preview of a muted session says the switch is why, without running the pass', async () => {
  const { routes, session, fs } = switchFixture()
  await callRoute(routes, '/api/memory/switch', { method: 'POST', body: { session: session.id, off: true } })
  const reads = fs.reads.length
  const { status, json } = await callRoute(routes, '/api/memory/preview')
  assert.equal(status, 200)
  assert.equal(json.available, true)
  assert.equal(json.switchedOff, true)
  assert.equal(json.step.action, 'silent')
  assert.match(json.step.reason, /switched off/)
  assert.equal(fs.reads.length, reads, 'muted previews must not read memory files')
})

await test('a removed session id does not linger in the store forever', async () => {
  // The store is a suppression list, so a session that no longer exists is inert: an
  // id nobody can match simply never applies. This pins that it is not somehow
  // applied to the CURRENT session just because it is the only entry.
  const { listeners, services, agent } = switchFixture({
    files: { [SWITCH_STORE]: JSON.stringify({ sessions: ['session-long-gone'] }) },
  })
  assert.equal((await runPreStep(listeners, agent)).messages.length, 1, 'another session id must not mute this one')
  assert.deepEqual(services.get('memory').status({ session: agent.session }).switchedOff, false)
})

console.log(`\n${passed} integration tests passed`)