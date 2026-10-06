/**
 * The per-session memory switch.
 *
 * Memory is on everywhere by default. One session may turn it off, and Qoder's two
 * halves stop TOGETHER: nothing is injected into that session's steps, and nothing
 * from it is recorded into memory. One switch rather than two, because "do not let
 * memory affect this session" is not satisfied by half of it — a muted session
 * should leave no trace in either direction.
 *
 * Where the decision lives is forced by the Harness, and each choice is deliberate:
 *
 *   - **A set of session ids, in this process.** Every gating path holds the live
 *     session or can resolve it from an id, so the question is answered from memory.
 *   - **Durably, in one JSON store under `$DSH_HOME`.** A plugin CANNOT carry this
 *     in the session log: `Session.append` writes the event without its `data` for
 *     any type outside the Harness's own table, and the persistence read path then
 *     refuses the whole log — which would block session reopen. (The envelope's
 *     `ignorable` marker is exactly the escape hatch, and only the Harness sets it.)
 *     So the durable carrier is a store beside `trusted-folders.json`, which is the
 *     same shape of fact: plugin state about sessions that must never be injected.
 *   - **What is stored is SUPPRESSION, never permission.** Only sessions turned off
 *     are listed, so a lost, damaged, or absent store means memory behaves normally.
 *     The failure mode is "the mute was forgotten", never "memory went quiet
 *     everywhere and nobody can see why".
 *
 * The mute is per SESSION ID, so it follows a resume (the id survives) and does not
 * leak to a subagent (a child has its own id, and inheriting a parent's mute would
 * make a delegated session quietly unmemorable).
 *
 * @module @dsh-external/dsh-memory/memory-switch
 */

import { join } from 'node:path'
import { memoryGuard, readIfPresent, writeGuarded } from './fs.js'
import { resolveDshHome } from './paths.js'

/** The store file name, beside the plugin's other stores under `$DSH_HOME`. */
export const MEMORY_SWITCH_FILE = 'memory-off-sessions.json'

/**
 * Where the muted sessions are remembered.
 *
 * Outside every memory root, like `trusted-folders.json` and `dream-state.json`: a
 * switch is not memory, it must never be loaded into a session — least of all into
 * one that muted memory. (It is also a `.json`, and root listing only ever takes
 * `*.md`, so it cannot be picked up as content by accident either.)
 *
 * @returns the absolute path of the store.
 */
export function memorySwitchStorePath() {
  return join(resolveDshHome(), MEMORY_SWITCH_FILE)
}

/**
 * Parse a store into a session-id list.
 *
 * Pure, so a damaged store is testable without a filesystem. Anything that is not
 * the expected shape reads as "nothing is muted", which is the fail-open direction
 * this store is designed for: it only ever records suppression.
 *
 * @param text - the store's content, or `undefined` when it does not exist.
 * @returns the muted session ids, de-duplicated, in file order.
 */
export function parseMemoryOffSessions(text) {
  if (typeof text !== 'string' || text.trim().length === 0) return []
  try {
    const parsed = JSON.parse(text)
    const entries = parsed !== null && typeof parsed === 'object' ? parsed.sessions : undefined
    if (!Array.isArray(entries)) return []
    return [...new Set(entries.filter((entry) => typeof entry === 'string' && entry.length > 0))]
  } catch {
    return []
  }
}

/**
 * Render a session-id list for the store.
 *
 * @param ids - the muted session ids.
 * @returns the file content, newline-terminated.
 */
export function serializeMemoryOffSessions(ids) {
  return `${JSON.stringify({ sessions: [...ids] }, null, 2)}\n`
}

/**
 * Resolve the exact live session a caller means.
 *
 * A named id is resolved through `agents.get`, the Harness's own live lookup — the
 * same "validate identity, then resolve the exact live Agent" rule its wire
 * receivers follow. A named id that does not resolve yields `undefined` rather than
 * falling back to whatever session happens to be driving: acting on a different
 * session than the one asked about is the one outcome worth refusing.
 *
 * With no id, the process-local initiator is the session in scope — which is what a
 * slash command and the `memory` tool have, and what a browser request usually does
 * not.
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
 * Every live session, for the panel's session rows.
 *
 * Sorted by directory then id so a poll cannot reshuffle the list under the user.
 *
 * @param ctx - plugin context.
 * @returns `{ id, cwd }` per live session.
 */
export function liveSessions(ctx) {
  const agents = ctx?.get?.('agents')
  if (typeof agents?.list !== 'function') return []
  const sessions = []
  for (const agent of agents.list()) {
    const id = agent?.session?.id
    if (typeof id !== 'string' || id.length === 0) continue
    sessions.push({ id, cwd: agent.session.header?.cwd })
  }
  return sessions.sort((left, right) => String(left.cwd).localeCompare(String(right.cwd)) || left.id.localeCompare(right.id))
}

/**
 * Build the switch.
 *
 * @param ctx - plugin context (must expose `fs` once it is available).
 * @param config - the resolved configuration, for the store's write policy.
 * @param lifecycle - the plugin's lifetime signal.
 * @returns `{ ready, isOff, list, set }`.
 */
export function createMemorySwitch(ctx, config, lifecycle) {
  /** Muted session ids. */
  const muted = new Set()
  /** The memoized first read; `undefined` until it succeeds, so a missing `fs` retries. */
  let pending

  /**
   * Read the durable store once, before the first step can inject anything.
   *
   * Lazy rather than eager: `apply()` may run before the filesystem service is
   * mounted, and a mute that was read too early would be silently absent. Every
   * gating caller awaits this, so "the store has been consulted" is a precondition
   * of the decision rather than a race against it.
   *
   * @returns a promise resolving when the store has been read.
   */
  const ready = () => {
    if (pending !== undefined) return pending
    const fs = ctx.get('fs')
    if (fs === undefined) return Promise.resolve()
    pending = readIfPresent(fs, memorySwitchStorePath(), lifecycle.signal)
      .then((found) => {
        for (const id of parseMemoryOffSessions(found?.text)) muted.add(id)
      })
      .catch(() => {
        /* No store, or an unreadable one: nothing is muted. */
      })
    return pending
  }

  /** Write the store, logging rather than throwing: a mute that cannot be saved is a warning. */
  const persist = async (session) => {
    try {
      await writeGuarded(
        ctx.get('fs'),
        memorySwitchStorePath(),
        serializeMemoryOffSessions(muted),
        lifecycle.signal,
        memoryGuard(ctx, config, session, resolveDshHome()).policy,
      )
      return true
    } catch (error) {
      ctx.logger.warn('memory: could not persist the session switch: %o', error)
      return false
    }
  }

  return {
    ready,

    /**
     * The async answer every gating caller should use.
     *
     * Awaits {@link ready} first, so the decision cannot race the store's first read —
     * the one way a mute could be silently missed on the first step after a restart.
     * There is deliberately NO synchronous gate beside this one: a caller that forgets
     * to await is a caller that skips the store, and one entry point makes that
     * mistake impossible to make.
     *
     * @param session - the live session, or a session id.
     * @returns `true` when memory is off for it.
     */
    async isMuted(session) {
      await ready()
      const id = typeof session === 'string' ? session : session?.id
      return typeof id === 'string' && muted.has(id)
    },

    /**
     * Whether this session has memory switched off, WITHOUT awaiting the store.
     *
     * Only for a surface that has already awaited {@link ready} — the panel renders a
     * state it fetched after `ready()` resolved, and `status()` is called from a route
     * that awaited it. A gating caller uses {@link isMuted} instead.
     *
     * @param session - the live session, or a session id.
     * @returns `true` when memory is off for it.
     */
    isOff(session) {
      const id = typeof session === 'string' ? session : session?.id
      return typeof id === 'string' && muted.has(id)
    },

    /** @returns the muted session ids. */
    list() {
      return [...muted]
    },

    /**
     * Turn memory on or off for one session and persist the decision.
     *
     * @param session - the live session.
     * @param off - the wanted state.
     * @returns `{ off, changed, persisted }`; `changed` is `false` when it was
     *   already in that state, so a caller can skip follow-up work.
     */
    async set(session, off) {
      await ready()
      const id = session?.id
      const wanted = off === true
      if (typeof id !== 'string' || id.length === 0) return { off: wanted, changed: false, persisted: false }
      if (muted.has(id) === wanted) return { off: wanted, changed: false, persisted: true }
      if (wanted) muted.add(id)
      else muted.delete(id)
      return { off: wanted, changed: true, persisted: await persist(session) }
    },
  }
}
