/**
 * Dream gates: the three conditions a consolidation pass must satisfy.
 *
 * Qoder's AutoDream checks, in order, the hours since a scope's last
 * consolidation, a throttle on the session scan, and how many of the project's
 * session artifacts have been produced since that consolidation. All three are
 * policy over values the caller supplies — the clock, a root's recorded run, and
 * the harness's session registries — so they are testable without a model call, a
 * clock or a filesystem, and `dream.js` keeps only the mechanism around them.
 *
 * @module @dsh-external/dsh-memory/dream-gate
 */

import { projectKey } from '../core/paths.js'

/**
 * A root's last consolidation instant, or `0` when it has never completed one.
 *
 * A missing, damaged or foreign value counts as never-run rather than as "recent":
 * the pass is the only writer of this file, so anything else is a lost timestamp.
 *
 * @param state - `{ [rootPath]: epochMs }` of previous runs.
 * @param rootPath - the root being considered.
 * @returns epoch milliseconds, or `0`.
 */
export function dreamLastRun(state, rootPath) {
  const last = state?.[rootPath]
  return typeof last === 'number' && Number.isFinite(last) ? last : 0
}

/**
 * The roots whose hours interval has elapsed.
 *
 * Qoder filters its scope roots by `hoursSince >= minHours` and then works per
 * root (`[AutoDream] skip ${scope} root; …`), so the gate has to hand back roots
 * rather than a single yes/no.
 *
 * @param state - `{ [rootPath]: epochMs }` of previous runs.
 * @param roots - the roots being consolidated.
 * @param minHours - minimum hours between runs.
 * @param now - current epoch milliseconds.
 * @returns the due subset of `roots`.
 */
export function dreamDueRoots(state, roots, minHours, now) {
  const interval = minHours * 60 * 60 * 1000
  return (roots ?? []).filter((root) => {
    const last = dreamLastRun(state, root.path)
    return last === 0 || now - last >= interval
  })
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
  return dreamDueRoots(state, rootPaths.map((rootPath) => ({ path: rootPath })), minHours, now).length > 0
}

/**
 * Whether the session scan may run again.
 *
 * Qoder guards the expensive half of the check — listing the project's session
 * artifacts — with `scanThrottleMinutes`, but only *after* the cheap per-root
 * hours filter has already found something due, and it starts the window on
 * every scan attempt rather than only on the attempts that consolidate:
 * `if (this.lastSessionScanAt > 0 && r < n) return`.
 *
 * @param lastScanAt - when this process last scanned, `0` when it never has.
 * @param now - current epoch milliseconds.
 * @param scanThrottleMinutes - minimum minutes between scans; `0` disables it.
 * @returns `true` when the scan may proceed.
 */
export function dreamScanDue(lastScanAt, now, scanThrottleMinutes) {
  const throttle = scanThrottleMinutes * 60 * 1000
  if (!(throttle > 0)) return true
  if (!(typeof lastScanAt === 'number' && Number.isFinite(lastScanAt) && lastScanAt > 0)) return true
  return now - lastScanAt >= throttle
}

/**
 * One session record as the session gate reads it.
 *
 * Only the header is needed, and only three of its fields — but the Harness
 * exposes no session modification time (its `fs` service strips mtime, and the
 * header carries `createdAt`), so a session counts by its CREATION instant.
 * Documented deviation: Qoder compares artifact mtimes, which would also count a
 * long-lived session that was merely resumed; this counts new sessions only.
 *
 * @param header - a `SessionHeader`: `{ id, cwd, createdAt }`.
 * @returns `{ id, createdAt, key }`, or `undefined` when the record is unusable.
 */
export function dreamSessionRecord(header) {
  const id = header?.id
  if (typeof id !== 'string' || id.length === 0) return undefined
  const createdAt = header?.createdAt
  let key
  try {
    key = typeof header?.cwd === 'string' && header.cwd.length > 0 ? projectKey(header.cwd) : undefined
  } catch {
    // An unencodable cwd leaves the session unattributable rather than unsound.
    key = undefined
  }
  return { id, createdAt: typeof createdAt === 'number' && Number.isFinite(createdAt) ? createdAt : undefined, key }
}

/**
 * The project the session asking for a check belongs to.
 *
 * Qoder counts the sessions under `getSessionArtifactProjectRoot()`, i.e. the
 * artifact root of the session running the check — one root for the whole gate,
 * not one per memory scope. Returns `undefined` when the cwd is unknown or
 * unencodable, and the counter then stops filtering by project (the gate paces
 * the pass, it does not decide whether consolidating is safe).
 *
 * @param agent - the agent whose turn just ended.
 * @returns the project key, or `undefined`.
 */
export function dreamSessionKey(agent) {
  const cwd = agent?.session?.header?.cwd ?? process.cwd()
  try {
    return typeof cwd === 'string' && cwd.length > 0 ? projectKey(cwd) : undefined
  } catch {
    return undefined
  }
}

/**
 * How many sessions satisfy one root's session gate.
 *
 * Qoder's line is `[AutoDream] skip ${scope} root; ${n} sessions since last
 * consolidation, need ${minSessions}`: `n` is the project's session artifacts
 * modified after THAT root's last consolidation, minus the current session,
 * which never counts itself.
 *
 * @param records - records from `listDreamSessions`.
 * @param options - `{ key, currentId, since }`: project key (or `undefined` to count every
 * project), the session asking for the check, and the root's last consolidation instant.
 * @returns the count.
 */
export function countDreamSessions(records, options = {}) {
  const { key, currentId, since } = options
  let count = 0
  for (const record of records ?? []) {
    if (typeof record?.id !== 'string' || record.id === currentId) continue
    if (typeof record.createdAt !== 'number' || !Number.isFinite(record.createdAt)) continue
    // Strictly newer than the last consolidation, as Qoder compares mtimes.
    if (!(record.createdAt > since)) continue
    if (key !== undefined && record.key !== key) continue
    count += 1
  }
  return count
}

/**
 * The Harness's session records, live ones first.
 *
 * Read through the same two services `dsh-workspace` itself uses —
 * `ctx.get('sessions').list()` for open sessions and
 * `(await ctx.get('sessionPersistence').list())` for stored ones, deduplicated by
 * id — rather than reaching into `$DSH_HOME/sessions`, because that store belongs
 * to another subsystem and is one of several backends.
 *
 * @param ctx - plugin context.
 * @param signal - cancellation.
 * @returns the records, or `undefined` when the harness exposes neither service.
 */
export async function listDreamSessions(ctx, signal) {
  const sessions = ctx.get('sessions')
  const persistence = ctx.get('sessionPersistence')
  const live = typeof sessions?.list === 'function'
  const stored = typeof persistence?.list === 'function'
  // Neither registry exists: the caller must say so rather than read "no sessions".
  if (!live && !stored) return undefined
  const records = new Map()
  const add = (header) => {
    const record = dreamSessionRecord(header)
    // Live sessions are listed first and a duplicate id keeps the live record:
    // an open session's header is the one the harness is still updating.
    if (record !== undefined && !records.has(record.id)) records.set(record.id, record)
  }
  if (live) for (const session of sessions.list() ?? []) add(session?.header)
  if (stored) for (const snapshot of (await persistence.list(signal)) ?? []) add(snapshot?.header)
  return [...records.values()]
}
