/**
 * Dream: the background memory-consolidation pass.
 *
 * Qoder's CLI runs an "AutoDream" on turn completion, gated by a time interval
 * and guarded against concurrent runs; it re-reads a scope's memory and rewrites
 * it into a smaller, better-organised set, which is where the SDK's
 * `origin: 'dream'` generation result comes from. Reproduced here:
 *
 * @module @dsh-external/dsh-memory/dream
 */

import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { deleteGuarded, listRootFiles, memoryGuard, readIfPresent, writeGuarded } from './fs.js'
import { createMemoryToolkit, runMemoryAgent } from './memory-agent.js'
import { isIndexFile, parseMemoryFile } from './memory-file.js'
import { applyPlan, parsePlan, resolveRoute } from './memory-pass.js'
import { dreamSystemPrompt } from './memory-prompt.js'
import { joinRoot, resolveDshHome } from './paths.js'

/** Where the last-run timestamps live, outside every memory root. */
export function dreamStatePath() {
  return join(resolveDshHome(), 'dream-state.json')
}

/** Qoder's lock file name, verbatim (`dfl = ".consolidate-lock"`). */
export const DREAM_LOCK_FILE = '.consolidate-lock'

/** Qoder's staleness window, verbatim (`gfl = 36e5`): after this a lock is ignored. */
export const DREAM_LOCK_STALE_MS = 3600000

/**
 * Where the cross-process consolidation lock lives.
 *
 * Qoder writes `.consolidate-lock` beside the memory it consolidates; this keeps
 * the same file name but puts it next to `dream-state.json`, i.e. outside every
 * memory root, because a lock is not memory and must never be injected.
 *
 * @returns the absolute path of the lock file.
 */
export function dreamLockPath() {
  return join(resolveDshHome(), DREAM_LOCK_FILE)
}

/**
 * Read the PID recorded in a lock file.
 *
 * Qoder's `okn` parses a BARE pid (`Number.parseInt(text.trim(), 10)`), and that
 * form is accepted here too. This port WRITES `{ pid, startedAt }` instead,
 * because the Harness `fs` provider exposes no modification time — Qoder reads
 * the file's mtime for staleness, so the timestamp has to live in the file.
 *
 * @param text - the lock file's content.
 * @returns `{ pid, startedAt }`, or `undefined` when unreadable.
 */
export function parseDreamLock(text) {
  const raw = String(text ?? '').trim()
  if (raw.length === 0) return undefined
  if (raw.startsWith('{')) {
    try {
      const parsed = JSON.parse(raw)
      const pid = Number(parsed?.pid)
      const startedAt = Number(parsed?.startedAt)
      if (Number.isFinite(pid) && pid > 0) {
        return { pid, startedAt: Number.isFinite(startedAt) && startedAt > 0 ? startedAt : undefined }
      }
    } catch {
      return undefined
    }
    return undefined
  }
  const pid = Number.parseInt(raw, 10)
  return Number.isFinite(pid) && pid > 0 ? { pid, startedAt: undefined } : undefined
}

/** Whether a PID is alive: Qoder's `process.kill(pid, 0)` probe. */
export function isPidAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * Whether another process holds the consolidation lock.
 *
 * Pure, with the clock and the liveness probe injected, so the policy is
 * testable without spawning anything: a lock is held when it names a live PID
 * and has not gone stale. A dead PID or an expired record is NOT held — Qoder
 * deletes such a lock ("reclaimed lock from exited PID … before time gate"), and
 * the Harness `fs` service has no delete, so this ignores it instead and lets the
 * next run overwrite it.
 *
 * @param lock - `{ pid, startedAt }` as read, or `undefined`.
 * @param options - `{ now, alive, staleMs }`.
 * @returns `true` when a run must be skipped.
 */
export function dreamLockHeld(lock, options = {}) {
  if (lock === undefined || lock === null) return false
  const now = options.now ?? Date.now()
  const alive = options.alive ?? isPidAlive
  const staleMs = options.staleMs ?? DREAM_LOCK_STALE_MS
  // A bare-pid lock carries no claim instant; Qoder would use its mtime, which
  // this provider cannot read, so it cannot be proven live and is ignored.
  if (typeof lock.startedAt !== 'number' || !Number.isFinite(lock.startedAt)) return false
  if (now - lock.startedAt >= staleMs) return false
  return alive(lock.pid) === true
}

/**
 * Read the consolidation lock, if there is one.
 *
 * @param ctx - plugin context.
 * @param signal - cancellation.
 * @returns `{ pid, startedAt }`, or `undefined`.
 */
export async function loadDreamLock(ctx, signal) {
  try {
    const found = await readIfPresent(ctx.get('fs'), dreamLockPath(), signal)
    return found === undefined ? undefined : parseDreamLock(found.text)
  } catch {
    return undefined
  }
}

/**
 * Claim the consolidation lock for this process.
 *
 * @param ctx - plugin context.
 * @param startedAt - the claim instant.
 * @param signal - cancellation.
 */
export async function saveDreamLock(ctx, startedAt, signal, policy) {
  const payload = JSON.stringify({ pid: process.pid, startedAt }, null, 2)
  await writeGuarded(ctx.get('fs'), dreamLockPath(), `${payload}\n`, signal, policy)
}

/**
 * Reclaim a lock nobody can still be holding.
 *
 * Qoder deletes it — `[AutoDream] reclaimed lock from exited PID ${pid} before
 * time gate` — and now that deletion is possible (see `deleteGuarded`) this does
 * the same instead of merely ignoring the file. A lock is not memory, so it is
 * also the one file this plugin deletes on its own initiative.
 *
 * @param ctx - plugin context.
 * @param pid - the PID the stale lock names, for the log line.
 * @param signal - cancellation.
 * @param fenceMode - the sandbox mode this delete must obey, when the configuration follows
 * the session (`undefined` under the default `memory-root`).
 */
export async function reclaimDreamLock(ctx, pid, signal, fenceMode) {
  const outcome = await deleteGuarded(ctx.get('fs'), dreamLockPath(), undefined, signal, fenceMode).catch(() => undefined)
  if (outcome?.deleted === true) {
    ctx.logger.debug('memory: reclaimed consolidation lock from exited PID %s before time gate', pid)
  }
  return outcome
}

/**
 * Whether a consolidation is due.
 *
 * Pure, so the schedule is testable without a model call or a clock.
 *
 * @param state - `{ [rootPath]: epochMs }` of previous runs.
 * @param rootPaths - the roots being consolidated.
 * @param minHours - minimum hours between runs.
 * @param now - current epoch milliseconds.
 * @returns `true` when at least one root has never run, or is past the interval.
 */
export function dreamDue(state, rootPaths, minHours, now) {
  if (rootPaths.length === 0) return false
  const interval = minHours * 60 * 60 * 1000
  return rootPaths.some((rootPath) => {
    const last = state?.[rootPath]
    if (typeof last !== 'number' || !Number.isFinite(last)) return true
    return now - last >= interval
  })
}

/**
 * Read the persisted run timestamps, treating a missing or damaged file as
 * "never run" rather than failing the pass.
 *
 * @param ctx - plugin context.
 * @param signal - cancellation.
 * @returns the state object.
 */
export async function loadDreamState(ctx, signal) {
  try {
    const found = await readIfPresent(ctx.get('fs'), dreamStatePath(), signal)
    if (found === undefined) return {}
    const parsed = JSON.parse(found.text)
    return parsed !== null && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

/**
 * Persist the run timestamps.
 *
 * @param ctx - plugin context.
 * @param state - the state object to write.
 * @param signal - cancellation.
 */
export async function saveDreamState(ctx, state, signal, policy) {
  await writeGuarded(ctx.get('fs'), dreamStatePath(), `${JSON.stringify(state, null, 2)}\n`, signal, policy)
}

/**
 * The consolidation instruction.
 *
 * @param roots - the roots being consolidated.
 * @returns the instruction text.
 */
export function dreamPrompt(roots) {
  return dreamSystemPrompt(roots)
}

/**
 * Gather the current memory content for one consolidation pass.
 *
 * @param ctx - plugin context.
 * @param roots - the roots being consolidated.
 * @param signal - cancellation.
 * @returns a textual snapshot of every root.
 */
export async function readMemoryForDream(ctx, roots, signal) {
  const fs = ctx.get('fs')
  const parts = []
  for (const root of roots) {
    const names = await listRootFiles(fs, root, signal).catch(() => [])
    if (names.length === 0) {
      parts.push(`### root ${root.id} (${root.path})\n(empty)`)
      continue
    }
    for (const fileName of names) {
      const found = await readIfPresent(fs, joinRoot(root.path, fileName), signal).catch(() => undefined)
      if (found !== undefined) parts.push(`### root ${root.id} file ${fileName}\n${found.text}`)
    }
  }
  return parts.join('\n\n')
}

/**
 * Build the scheduler that decides when a consolidation runs.
 *
 * Kept here rather than in `index.js` so the plugin entry stays wiring: this is
 * the whole policy — the enable switch, the concurrency guard (one pass per
 * plugin, as qodercli's AutoDream lock enforces), the time gate, and logging.
 *
 * @param ctx - plugin context.
 * @param config - the resolved configuration.
 * @param rootsFor - `async () => roots`, resolving the current scope roots.
 * @param state - live plugin state, to publish the last dream result.
 * @param signal - the plugin's lifetime signal.
 * @returns an async function taking the agent whose turn just ended.
 */
export function createDreamScheduler(ctx, config, rootsFor, state, signal) {
  let running = false
  return async function maybeDream(agent) {
    if (config.generation.dream.enabled !== true || running) return
    let roots
    try {
      roots = await rootsFor(agent)
    } catch {
      return
    }
    if (roots.length === 0) return

    // Cross-process exclusion, Qoder's `.consolidate-lock`: `running` only covers
    // this plugin instance, while two `dsh` processes can share one $DSH_HOME.
    const lock = await loadDreamLock(ctx, signal)
    const now = Date.now()
    if (dreamLockHeld(lock, { now })) {
      ctx.logger.info('memory: dream skipped — consolidation lock held by live PID %d', lock.pid)
      return
    }
    // Nobody can still hold it: take the file out rather than leaving a corpse,
    // exactly as Qoder does ("reclaimed lock from exited PID … before time gate").
    if (lock !== undefined) await reclaimDreamLock(ctx, lock.pid, signal, memoryGuard(ctx, config, agent.session, resolveDshHome()).fenceMode)

    const saved = await loadDreamState(ctx, signal).catch(() => ({}))
    if (!dreamDue(saved, roots.map((root) => root.path), config.generation.dream.minHours, Date.now())) return

    running = true
    const startedAt = Date.now()
    try {
      // Claim before the pass, so a second process starting mid-run skips rather
      // than consolidating the same files concurrently.
      await saveDreamLock(ctx, startedAt, signal, memoryGuard(ctx, config, agent.session, resolveDshHome()).policy).catch(() => undefined)
      const result = await runDream(ctx, config, roots, agent, saved, signal)
      state.lastDream = result
      ctx.logger.info(
        'memory: dream %s in %dms%s',
        result.status,
        result.durationMs,
        typeof result.reason === 'string' && result.reason.length > 0 ? ` — ${result.reason}` : '',
      )
    } catch (error) {
      ctx.logger.warn('memory: dream failed: %o', error)
    } finally {
      running = false
    }
  }
}

/**
 * Run one consolidation pass. Never throws.
 *
 * @param ctx - plugin context.
 * @param config - the resolved configuration.
 * @param roots - the roots being consolidated.
 * @param agent - the agent whose turn completed.
 * @param state - the loaded run timestamps (mutated on success).
 * @param signal - cancellation.
 * @returns the generation-shaped result with `origin: 'dream'`.
 */
export async function runDream(ctx, config, roots, agent, state, signal) {
  const started = Date.now()
  const attemptId = randomUUID()
  const session = agent.session
  const result = (fields) => ({ attemptId, origin: 'dream', ...fields })

  try {
    if (ctx.get('llm') === undefined) {
      return result({ status: 'skipped', reason: 'the llm service is unavailable', writtenFiles: [], failedFiles: [], durationMs: Date.now() - started })
    }
    const route = resolveRoute(ctx, config, session)
    const snapshot = await readMemoryForDream(ctx, roots, signal)
    // Consolidation is an agent too: it orients from the index, reads the topic
    // files it suspects need merging, then rewrites them.
    const toolkit = createMemoryToolkit(ctx, config, roots, signal, session)
    const { outcome, text } = await runMemoryAgent(
      ctx,
      config,
      route,
      dreamSystemPrompt(roots),
      `Current memory:\n${snapshot}`,
      toolkit,
      signal,
    )
    const finalOutcome =
      outcome.writtenFiles.length === 0 && text.includes('"writes"')
        ? await applyPlan(ctx, config, roots, parsePlan(text), signal, session)
        : outcome
    const finished = result({ ...finalOutcome, durationMs: Date.now() - started })

    if (finished.status === 'saved' || finished.status === 'partial' || finished.status === 'no_change') {
      const now = Date.now()
      const next = { ...state }
      for (const root of roots) next[root.path] = now
      await saveDreamState(ctx, next, signal, memoryGuard(ctx, config, session, resolveDshHome()).policy).catch(() => undefined)
    }
    return finished
  } catch (error) {
    return result({
      status: 'failed',
      reason: error instanceof Error ? error.message : String(error),
      writtenFiles: [],
      failedFiles: [],
      durationMs: Date.now() - started,
    })
  }
}
