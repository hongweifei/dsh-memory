/**
 * Per-session memory state: the three-state switch.
 *
 * Memory is global by configuration; a session may override it. Three states, and
 * the first is the default:
 *
 *   auto     follow the global configuration (the default; nothing is stored)
 *   project  project memory only — cross-project knowledge is not loaded or written
 *   off      nothing at all: nothing injected, nothing recorded
 *
 * `project` exists because "do not let OTHER projects' knowledge influence this one"
 * is a different request from "leave me alone": a scoped session still wants the
 * conventions recorded for its own repository, and still wants to contribute to them.
 *
 * Where the decision lives is forced by the Harness, and each choice is deliberate:
 *
 *   - **A map of session id → mode, in this process.** Every gating path holds the live
 *     session or can resolve it from an id, so the question is answered from memory.
 *   - **Durably, in one JSON store under `$DSH_HOME`.** A plugin CANNOT carry this in the
 *     session log: `Session.append` writes an unknown event type without its `data`, and
 *     the persistence read path then refuses the whole log — which blocks session reopen.
 *     (The envelope's `ignorable` marker is exactly the escape hatch, and only the
 *     Harness sets it.) So the durable carrier is a store beside `trusted-folders.json`,
 *     the same shape of fact: plugin state about sessions that must never be injected.
 *   - **What is stored is the OVERRIDE, never a permission.** `auto` is the absent state,
 *     so a lost, damaged, or absent store means memory follows the configuration. The
 *     failure mode is "the override was forgotten", never "memory went quiet everywhere".
 *
 * The state is per SESSION ID, so it follows a resume (the id survives) and does not leak
 * to a subagent (a child has its own id, and inheriting a parent's mute would make a
 * delegated session quietly unmemorable).
 *
 * @module @dsh-external/dsh-memory/memory-switch
 */

import { join } from 'node:path'
import { memoryGuard, readIfPresent, writeGuarded } from './fs.js'
import { resolveDshHome } from './paths.js'

/** The store file name, beside the plugin's other stores under `$DSH_HOME`. */
export const MEMORY_SWITCH_FILE = 'memory-off-sessions.json'

/** The three session states, in cycle order (the composer button steps through this). */
export const SESSION_MODES = Object.freeze(['auto', 'project', 'off'])

/**
 * Whether a value is one of the three modes.
 *
 * @param value - the candidate.
 * @returns `true` when it is a mode this build understands.
 */
export function isSessionMode(value) {
  return typeof value === 'string' && SESSION_MODES.includes(value)
}

/**
 * Where the per-session overrides are remembered.
 *
 * Outside every memory root, like `trusted-folders.json` and `dream-state.json`: a switch
 * is not memory, it must never be loaded into a session — least of all into one that muted
 * memory. (It is also a `.json`, and root listing only ever takes `*.md`, so it cannot be
 * picked up as content by accident either.)
 *
 * @returns the absolute path of the store.
 */
export function memorySwitchStorePath() {
  return join(resolveDshHome(), MEMORY_SWITCH_FILE)
}

/**
 * Parse a store into `id → mode` entries.
 *
 * Pure, so a damaged store is testable without a filesystem. Anything not in the expected
 * shape reads as "no override", which is the fail-open direction this store is designed
 * for — it only ever records a deviation from the configuration.
 *
 * Two shapes are accepted. Version 1 was an ARRAY of ids, all meaning "off"; version 2 is
 * an OBJECT mapping id → mode. Reading the old shape costs three lines and means an
 * upgrade cannot silently un-mute a session somebody muted.
 *
 * @param text - the store's content, or `undefined` when it does not exist.
 * @returns `{ [sessionId]: 'project' | 'off' }`, never containing `auto`.
 */
export function parseMemoryOffSessions(text) {
  if (typeof text !== 'string' || text.trim().length === 0) return {}
  try {
    const parsed = JSON.parse(text)
    if (parsed === null || typeof parsed !== 'object') return {}
    const entries = parsed.sessions
    // Version 1: an array of ids, every one of them "off".
    if (Array.isArray(entries)) {
      const legacy = {}
      for (const id of entries) if (typeof id === 'string' && id.length > 0) legacy[id] = 'off'
      return legacy
    }
    if (entries === null || typeof entries !== 'object') return {}
    const modes = {}
    for (const [id, mode] of Object.entries(entries)) {
      // `auto` is the absence of an override, so it is never stored — and an unknown mode
      // is dropped rather than guessed at.
      if (id.length > 0 && (mode === 'project' || mode === 'off')) modes[id] = mode
    }
    return modes
  } catch {
    return {}
  }
}

/**
 * Render `id → mode` entries for the store.
 *
 * @param modes - the overrides, as `parseMemoryOffSessions` returns them.
 * @returns the file content, newline-terminated.
 */
export function serializeMemoryOffSessions(modes) {
  const sessions = {}
  for (const id of Object.keys(modes).sort()) {
    if (modes[id] === 'project' || modes[id] === 'off') sessions[id] = modes[id]
  }
  return `${JSON.stringify({ version: 2, sessions }, null, 2)}\n`
}

/**
 * The configuration one session actually runs under.
 *
 * This is how `project` is implemented, and it is deliberately the ONLY mechanism: the
 * session's mode is folded into the same `userScope`/`projectScope` switches the
 * configuration already has, so every reader of the configuration — roots, the trust gate,
 * the identity hash, the generation prompt — sees one consistent picture with no second
 * code path to keep in sync.
 *
 * No special case for `mode: 'custom'`: `resolveRoots` returns an explicit `generation.roots`
 * list BEFORE it consults these flags, so narrowing is simply ignored there. Guarding on the
 * mode instead would silently fail to narrow a `custom` configuration that names no roots,
 * which is exactly when the built-ins are still in use.
 *
 * @param config - the resolved configuration.
 * @param mode - the session's mode.
 * @returns the configuration to use for that session.
 */
export function scopedConfig(config, mode) {
  if (mode !== 'project') return config
  return { ...config, userScope: false }
}

/**
 * Resolve the exact live session a caller means.
 *
 * A named id is resolved through `agents.get`, the Harness's own live lookup — the same
 * "validate identity, then resolve the exact live Agent" rule its wire receivers follow. A
 * named id that does not resolve yields `undefined` rather than falling back to whatever
 * session happens to be driving: acting on a different session than the one asked about is
 * the one outcome worth refusing.
 *
 * With no id, the process-local initiator is the session in scope — what a slash command and
 * the `memory` tool have, and what a browser request usually does not.
 *
 * @param ctx - plugin context.
 * @param sessionId - the session asked about, when the caller named one.
 * @returns the live agent, or `undefined`.
 */
export function resolveLiveAgent(ctx, sessionId) {
  const agents = ctx?.get?.('agents')
  if (typeof sessionId === 'string' && sessionId.length > 0) {
    return typeof agents?.get === 'function' ? agents.get(sessionId) : undefined
  }
  return typeof agents?.currentInitiator === 'function' ? agents.currentInitiator() : undefined
}

/**
 * Build the switch.
 *
 * @param ctx - plugin context (must expose `fs` once it is available).
 * @param config - the resolved configuration, for the store's write policy.
 * @param lifecycle - the plugin's lifetime signal.
 * @returns the switch.
 */
export function createMemorySwitch(ctx, config, lifecycle) {
  /** Session id → mode. `auto` is represented by absence. */
  const modes = new Map()
  /** The memoized first read; `undefined` until it succeeds, so a missing `fs` retries. */
  let pending

  /**
   * Read the durable store once, before the first step can inject anything.
   *
   * Lazy rather than eager: `apply()` may run before the filesystem service is mounted, and
   * an override read too early would be silently absent. Every gating caller awaits this, so
   * "the store has been consulted" is a precondition of the decision rather than a race.
   *
   * @returns a promise resolving when the store has been read.
   */
  const ready = () => {
    if (pending !== undefined) return pending
    const fs = ctx.get('fs')
    if (fs === undefined) return Promise.resolve()
    pending = readIfPresent(fs, memorySwitchStorePath(), lifecycle.signal)
      .then((found) => {
        for (const [id, mode] of Object.entries(parseMemoryOffSessions(found?.text))) modes.set(id, mode)
      })
      .catch(() => {
        /* No store, or an unreadable one: no override. */
      })
    return pending
  }

  /** Write the store, logging rather than throwing: an override that cannot be saved warns. */
  const persist = async (session) => {
    try {
      await writeGuarded(
        ctx.get('fs'),
        memorySwitchStorePath(),
        serializeMemoryOffSessions(Object.fromEntries(modes)),
        lifecycle.signal,
        memoryGuard(ctx, config, session, resolveDshHome()).policy,
      )
      return true
    } catch (error) {
      ctx.logger.warn('memory: could not persist the session mode: %o', error)
      return false
    }
  }

  /**
   * The mode one session runs under, WITHOUT awaiting the store.
   *
   * Only for a surface that has already awaited {@link ready} — the composer renders a state
   * it fetched after `ready()` resolved. A gating caller uses {@link mode} instead.
   *
   * @param session - the live session, or a session id.
   * @returns `'auto' | 'project' | 'off'`.
   */
  const modeOf = (session) => {
    const id = typeof session === 'string' ? session : session?.id
    if (typeof id !== 'string') return 'auto'
    return modes.get(id) ?? 'auto'
  }

  return {
    ready,

    /**
     * The mode this session runs under.
     *
     * Awaits {@link ready} first, so the answer cannot race the store's first read — the one
     * way an override could be silently missed on the first step after a restart. There is
     * deliberately NO synchronous gate beside this: a caller that forgets to await is a
     * caller that skips the store, and one entry point makes that mistake impossible.
     *
     * @param session - the live session, or a session id.
     * @returns `'auto' | 'project' | 'off'`.
     */
    async mode(session) {
      await ready()
      return modeOf(session)
    },

    /** The synchronous already-read variant, for a surface that awaited `ready()`. */
    modeOf,

    /**
     * Whether this session has memory switched off entirely.
     *
     * @param session - the live session, or a session id.
     * @returns `true` when memory is off for it.
     */
    async isMuted(session) {
      return (await this.mode(session)) === 'off'
    },

    /** The synchronous already-read variant of {@link isMuted}. */
    isOff(session) {
      return modeOf(session) === 'off'
    },

    /**
     * The configuration this session runs under: the global one, narrowed by its mode.
     *
     * @param session - the live session.
     * @param globalConfig - the resolved configuration.
     * @returns the configuration to use for that session.
     */
    configFor(session, globalConfig) {
      return scopedConfig(globalConfig, modeOf(session))
    },

    /** @returns `{ [sessionId]: mode }`, never containing `auto`. */
    list() {
      return Object.fromEntries(modes)
    },

    /**
     * Set one session's mode and persist the decision.
     *
     * @param session - the live session.
     * @param mode - the wanted mode.
     * @returns `{ mode, changed, persisted }`; `changed` is `false` when it was already in
     *   that state, so a caller can skip follow-up work.
     */
    async setMode(session, mode) {
      await ready()
      const id = session?.id
      const wanted = isSessionMode(mode) ? mode : 'auto'
      if (typeof id !== 'string' || id.length === 0) return { mode: wanted, changed: false, persisted: false }
      if (modeOf(session) === wanted) return { mode: wanted, changed: false, persisted: true }
      // `auto` is stored as ABSENCE, so a session that follows the configuration leaves no
      // trace in the store and a later configuration change is picked up rather than pinned.
      if (wanted === 'auto') modes.delete(id)
      else modes.set(id, wanted)
      return { mode: wanted, changed: true, persisted: await persist(session) }
    },
  }
}
