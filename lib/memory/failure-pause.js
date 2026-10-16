/**
 * Consecutive-failure pause: Qoder's `hFl = 3`.
 *
 * The original counts consecutive extraction failures per sink and then stops trying —
 * `consecutiveFailureCount += 1 … >= hFl && (this.paused = !0)`, with
 * `onTurnComplete` logging `"[QoderWorkMemorySink] skipped because service is paused"`
 * and attempting nothing. A broken route or a bad configuration therefore costs nothing
 * until a human intervenes.
 *
 * Without it this plugin spends a model call on every turn and fails identically each
 * time: a pass whose output was cut short by the model's budget fails on turn 1, 2, 3 …
 * forever, which is exactly the shape a reader reports as "最近一次生成总是 failed".
 *
 * The original has **no resume path** — `paused` stays set for the sink's lifetime. A
 * DSH session can outlive that, so this port adds one explicit escape hatch
 * (`/memory-resume`) rather than leaving the user to restart the host.
 *
 * @module @dsh-external/dsh-memory/failure-pause
 */

/**
 * Consecutive failures before a session's generation pauses, matching Qoder's `hFl`.
 * `0` disables the pause and keeps retrying, which is what this port did before.
 */
export const FAILURE_PAUSE_DEFAULT = 3

/**
 * Advance the counter for one finished pass.
 *
 * A pass that did not fail clears the count — Qoder resets on every completed
 * extraction, so a single success is enough to forget the earlier failures — and only
 * a `failed` result counts toward the limit.
 *
 * @param previous - `{ failures, paused }` for the session.
 * @param result - the finished pass result (`{ status, reason }`).
 * @param limit - pause after this many consecutive failures; `0` never pauses.
 * @returns `{ failures, paused, reason, pausedNow }` — `pausedNow` marks the pass that
 * armed the pause, so the warning is logged once rather than every turn.
 */
export function advanceFailurePause(previous, result, limit) {
  const failures = previous.failures ?? 0
  if (result.status !== 'failed') return { failures: 0, paused: false, reason: '', pausedNow: false }
  const next = failures + 1
  if (limit > 0 && next >= limit) {
    return { failures: next, paused: true, reason: result.reason ?? '', pausedNow: previous.paused !== true }
  }
  return { failures: next, paused: false, reason: '', pausedNow: false }
}

/**
 * The result a paused session reports instead of spending a model call.
 *
 * It is a `skipped` pass, not a failure: nothing was attempted, and saying `failed`
 * every turn would be noise again — but the reason names the pause and its cause so the
 * panel and `/memory` answer "why did memory stop?".
 *
 * @param entry - the paused session entry (`{ failures, pauseReason }`).
 * @param turn - the turn number the trigger reported.
 * @param turnIndex - the pass sequence number for the session.
 * @returns a generation result with no writes.
 */
export function pausedOutcome(entry, turn, turnIndex) {
  return {
    status: 'skipped',
    attemptId: `paused-${turn}`,
    origin: 'turn_complete',
    reason: `paused after ${entry.failures} consecutive failures: ${entry.pauseReason}`,
    writtenFiles: [],
    failedFiles: [],
    durationMs: 0,
    turnIndex,
  }
}

/**
 * Fold one finished pass into the pause bookkeeping and mirror it into the service
 * state the panel reads.
 *
 * @param entry - the session entry, mutated in place.
 * @param result - the finished pass result.
 * @param limit - `config.generation.pauseAfterFailures`.
 * @param context - `{ state, pausedSessions, sessionId }` — the service state, the set of
 * armed sessions, and the session the pass belonged to.
 * @param logger - the plugin logger, for the one warning that announces the pause.
 */
export function recordFailurePause(entry, result, limit, context, logger) {
  const next = advanceFailurePause(entry, result, limit)
  entry.failures = next.failures
  entry.paused = next.paused
  entry.pauseReason = next.reason
  if (next.paused) {
    context.pausedSessions.add(entry)
    if (next.pausedNow) {
      logger.warn(
        'memory: generation paused after %d consecutive failures — %s',
        next.failures,
        next.reason,
      )
    }
  } else {
    context.pausedSessions.delete(entry)
  }
  // The panel reads the state, not the scheduler: show the pause while it is armed and
  // clear it the moment a pass succeeds again.
  context.state.generationPause = next.paused
    ? {
        failures: next.failures,
        reason: next.reason,
        since: context.state.generationPause?.since ?? Date.now(),
        sessionId: context.sessionId,
      }
    : undefined
}

/**
 * Clear every armed pause: this port's escape hatch, since the original never resumes.
 *
 * @param pausedSessions - the set of armed entries.
 * @param state - the service state holding the mirrored pause.
 * @returns how many sessions were resumed.
 */
export function resumePaused(pausedSessions, state) {
  const resumed = pausedSessions.size
  for (const entry of pausedSessions) {
    entry.paused = false
    entry.failures = 0
    entry.pauseReason = ''
  }
  pausedSessions.clear()
  state.generationPause = undefined
  return resumed
}
