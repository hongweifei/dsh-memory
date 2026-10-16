/**
 * The self-update vocabulary the two presentation surfaces share.
 *
 * `/memory-update` and `POST /api/memory/update` speak the same three verbs over the
 * same service and would otherwise each own a copy of the wording and of the "which
 * verb means what" decision. The client half cannot import this module (the browser
 * loader loads one artifact per package), so it keeps its own words in its own locale
 * dictionaries; the verbs, however, are the contract and live here once.
 *
 * @module @dsh-external/dsh-memory/host/update-surface
 */

/** The verbs `update.*` understands: read the last answer, re-check, or fast-forward. */
export const UPDATE_ACTIONS = Object.freeze(['status', 'check', 'apply'])

/** The same verbs as a sentence fragment — `status, check, or apply` — for a refusal message. */
export const UPDATE_USAGE = `${UPDATE_ACTIONS.slice(0, -1).join(', ')}, or ${UPDATE_ACTIONS[UPDATE_ACTIONS.length - 1]}`

/** The words `/memory-update` prints for one update state. */
const UPDATE_WORDS = {
  disabled: 'checks are switched off (update.mode)',
  unknown: 'not checked yet',
  'up-to-date': 'up to date',
  behind: 'BEHIND the remote',
  ahead: 'ahead of the remote (local commits)',
  diverged: 'diverged from the remote',
  updated: 'UPDATED',
  refused: 'not applied',
  failed: 'update FAILED',
  unavailable: 'cannot check',
}

/**
 * One line describing an update state, for `/memory` and `/memory-update`.
 *
 * @param result - a `createUpdateService().status()` / `check()` / `apply()` result.
 * @param mode - the configured `update.mode`, for the `off` case.
 * @returns the line.
 */
export function updateLine(result, mode) {
  const state = result ?? { status: 'unknown' }
  const word = UPDATE_WORDS[state.status] ?? state.status
  const parts = [`update: ${word}`]
  if (typeof state.behind === 'number' && state.behind > 0) {
    parts.push(`${state.behind} commit(s) behind ${state.remote ?? 'origin'}/${state.branch ?? 'HEAD'}`)
  }
  if (state.current !== undefined) {
    parts.push(state.latest !== undefined && state.latest !== state.current ? `${state.current} → ${state.latest}` : state.current)
  }
  if (state.reason !== undefined) parts.push(`— ${state.reason}`)
  if (mode === 'auto' && state.status === 'behind') parts.push('(update.mode is "auto": the next start fast-forwards it)')
  return parts.join(' · ')
}

/**
 * Run one update verb against the service.
 *
 * `status` is a read of the last answer and never touches git; `check` fetches and
 * compares without mutating; `apply` fast-forwards, but only when there is something to
 * fast-forward to. All three are memoized by the service, so a caller cannot stampede it.
 *
 * @param update - the self-update service.
 * @param rawAction - the verb as typed or posted, any case, possibly empty (`status`).
 * @param mode - the configured `update.mode`, for the reported line.
 * @returns `{ action, result, text }`, or `{ action, unknown: true }` for anything else.
 */
export async function runUpdateAction(update, rawAction, mode) {
  const action = String(rawAction ?? '').trim().toLowerCase() || 'status'
  if (!UPDATE_ACTIONS.includes(action)) return { action, unknown: true }
  const result = action === 'status' ? update.status() : await update[action]()
  return { action, result, text: updateLine(result, mode) }
}
