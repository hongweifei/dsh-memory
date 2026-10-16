/**
 * Harness doubles and fixtures shared by the integration suites.
 *
 * This module is the non-test half of what used to be one 4920-line file: the
 * in-memory `ctx.fs`/`ctx.llm`/session/agent/route doubles, the cordis `ctx` double,
 * and the fixtures the topic suites share. Every exported declaration below is used
 * by at least one integration suite; nothing here calls `test()` itself.
 *
 * Importing this module also pins `DSH_HOME` at the fake home the fixtures use, which
 * is why it must be imported before any test body runs (ESM imports do that for us).
 *
 * @module dsh-memory/test/integration-harness
 */
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { apply, Config, LARGE_FILE_CHARS } from '../../lib/index.js'
import { resolveInstalled } from './harness-env.mjs'

/** Pin the harness home so the user scope resolves into the fixture filesystem. */
export const HOME = 'C:\\home\\.dsh'
process.env.DSH_HOME = HOME
export const USER_MEMORY = `${HOME}\\memory\\MEMORY.md`

/* ------------------------------------------------------------------ *
 * Harness doubles
 * ------------------------------------------------------------------ */

/** In-memory ctx.fs matching the real resolve/stat/readText/listDir/writeText contract. */
export function makeFs(initial = {}, options = {}) {
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
export function makeLlm(plan, options = {}) {
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

/** A scripted model whose responses may carry tool calls — the shape the memory agent loop drives.
 * Needed here so a REAL pass can be observed calling `memory_write` with `target: "daily"`. */
export function makeScriptedLlm(script) {
  const calls = []
  return {
    calls,
    stream(options_) {
      calls.push(options_)
      const step = calls.length <= script.length ? script[calls.length - 1] : { text: '' }
      return (async function* () {
        let index = 0
        for (const call of step.calls ?? []) {
          yield { type: 'tool-call-delta', index, id: call.id, name: call.name, argumentsDelta: call.arguments }
          yield { type: 'block-end', index, block: { type: 'tool-call', id: call.id, name: call.name, arguments: call.arguments } }
          index += 1
        }
        if (step.text !== undefined) yield { type: 'block-end', index, block: { type: 'text', text: step.text } }
        const kind = step.finish ?? ((step.calls ?? []).length > 0 ? 'tool-calls' : 'stop')
        yield { type: 'finish', reason: { kind } }
      })()
    },
  }
}

/** Session double exposing the surface/event/header contract the plugin reads. */
export function makeSession(events, cwd) {
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
export function makeAgent(session) {
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
export function makeCommands() {
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
export function makeTools() {
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
export async function runCommand(commands, name, { agent, rawInput } = {}) {
  const definition = commands.registered.get(name)
  assert.ok(definition, `command /${name} was not registered`)
  return definition.handler({ agent, rawInput: rawInput ?? '', signal: new AbortController().signal })
}

/** Cordis ctx double that captures listeners and calls inject callbacks eagerly. */
export function makeCtx(fs, llm) {
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

/**
 * `count` session records of one project, as the dream gate counts them.
 *
 * The header is what matters: `createdAt` defaults to now (i.e. newer than any
 * recorded consolidation) and `cwd` decides the project key.
 */
export function sessionRecords(count, cwd = 'C:\\proj') {
  return Array.from({ length: count }, (unused, index) => ({ id: `sess-${index + 1}`, cwd }))
}

/**
 * Publish the Harness's two session registries, as the dream gate reads them.
 *
 * `sessions.list()` holds the open sessions, `sessionPersistence.list()` the
 * stored ones — the same pair `dsh-workspace` reads. The plugin deliberately does
 * not read `$DSH_HOME/sessions`, which belongs to another subsystem.
 *
 * @param ctx - the context double.
 * @param registries - `{ live, stored }`, each a list of `{ id, cwd?, createdAt? }`.
 * @returns how often each registry was listed, for the scan-throttle cases.
 */
export function provideSessions(ctx, registries = {}) {
  const calls = { live: 0, stored: 0 }
  const records = (entries) =>
    (entries ?? []).map(({ id, cwd = 'C:\\proj', createdAt = Date.now() }) => ({ header: { id, cwd, createdAt } }))
  ctx.provide('sessions', {
    list: () => {
      calls.live += 1
      return records(registries.live)
    },
  })
  ctx.provide('sessionPersistence', {
    list: async () => {
      calls.stored += 1
      return records(registries.stored)
    },
  })
  return calls
}

/** Call one registered web route with a Fetch Request. */
export async function callRoute(routes, path, init) {
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

export const loadConfig = (raw) => {
  // Self-update is switched OFF in fixtures: a check shells out to `git` and fetches a remote, and
  // no test may do that against the real checkout. `test/update.test.mjs` opts in with its own
  // `update` block, pointed at a temporary repository it builds itself.
  const merged = { ...raw, update: { mode: 'off', ...(raw?.update ?? {}) } }
  const result = Config['~standard'].validate(merged)
  assert.equal(result.issues, undefined, `config rejected: ${JSON.stringify(result.issues)}`)
  return result.value
}

/** Drive the captured `agent/pre-step` waterfall. */
export async function runPreStep(listeners, agent) {
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


/* ================= consumption ================= */





/* ================= generation ================= */

export const turnEvents = (prompt, response) => [
  { type: 'turn/start', seq: 1, time: 1, data: { turn: 1 } },
  { type: 'user/message', seq: 2, time: 2, data: { content: [{ type: 'text', text: prompt }] } },
  { type: 'assistant/message', seq: 3, time: 3, data: { message: { content: [{ type: 'text', text: response }] } } },
  { type: 'turn/end', seq: 4, time: 4, data: { turn: 1, reason: { kind: 'completed' } } },
]















/* ================= web routes (settings panel data) ================= */











/* ================= SDK-aligned option rules ================= */











/* ================= runtime service ================= */












/* ---------------- dream (consolidation) ---------------- */









/* ================= folder trust ================= */

// The project scope is keyed the way the HARNESS keys a project: session
// persistence would put `C:\proj` under `--C-proj--`, and so does memory. The
// trust gate asks about that same canonical directory.
export const PROJECT_MEMORY = 'C:\\home\\.dsh\\projects\\--C-proj--\\memory\\MEMORY.md'
export const TRUST_STORE = 'C:\\home\\.dsh\\trusted-folders.json'

export const projectMemoryFixture = (extra = {}) =>
  makeFs({ [USER_MEMORY]: 'user knowledge', [PROJECT_MEMORY]: 'project knowledge', ...extra })

/**
 * Trust-section config. `custom` mode is required because the SDK's `native`
 * rule rejects a `generation` override, and these tests turn the automatic
 * per-turn pass off so only the consumption half is under test. With no
 * explicit roots, `custom` still resolves the two built-in scope roots.
 */
export const trustConfig = (raw = {}) =>
  loadConfig({ mode: 'custom', ...raw, generation: { turnComplete: { enabled: false }, ...raw.generation } })

























/* ================= the memory tool ================= */

/** Invoke the registered `memory` tool as the Harness would. */
export async function runTool(tools, agent, args) {
  const definition = tools.registered.get('memory')
  assert.ok(definition, 'the memory tool was not registered')
  return definition.execute(args, { agent, signal: new AbortController().signal })
}












/* ================= project identity ================= */





/* ================= consumption discovery pipeline ================= */

export const PROJECT_DIR = 'C:\\home\\.dsh\\projects\\--C-proj--\\memory'





/* ================= @imports ================= */

// Imported targets live in a SUBDIRECTORY on purpose: a `.md` directly in the
// root is also a memory file in its own right, so it would be injected whether
// or not the import resolved. Only a nested file proves the expansion happened.
export const IMPORT = (name) => `${PROJECT_DIR}\\sub\\${name}`









/* ================= mid-session memory changes ================= */




/* ================= turn pacing and serialization ================= */

/** Spin the event loop until a condition holds, so a held pass is observable. */
export async function waitFor(predicate, label) {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (predicate()) return
    await new Promise((resolve) => setImmediate(resolve))
  }
  throw new Error(`timed out waiting for ${label}`)
}

/** Fire one completed turn at the plugin. */
export function endTurn(listeners, session, agent, turn) {
  listeners.get('agent/created')[0]({ agent })
  listeners.get('session/event')[0](session, { type: 'turn/end', data: { turn, reason: { kind: 'completed' } } })
}

/** A growing session log: the harness appends as turns complete. */
export function makeLog(session) {
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






/* ================= the read fast path ================= */




/* ================= just-in-time memory ================= */




/* ================= in-turn generation ================= */



/* ================= the per-session switch ================= */

/** The switch store, beside the plugin's other stores under `$DSH_HOME`. */
export const SWITCH_STORE = `${HOME}\\memory-off-sessions.json`

/**
 * A fixture with both halves enabled and a working generation plan, plus one live
 * agent registered so the routes can resolve it.
 */
export function switchFixture(options = {}) {
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



















































