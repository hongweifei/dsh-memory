/**
 * Injection planning: the pure decision "given what this session has already
 * been shown, what — if anything — enters the next step?".
 *
 * This lives apart from `consumption.js` for one reason: the panel has to be
 * able to answer that question WITHOUT answering it. A preview that shares the
 * live per-session baseline would change the very behaviour it is describing
 * (consuming the comparison the next real step depends on), so the decision is
 * expressed here as a function of its inputs, and the two callers differ only in
 * what they do with the answer:
 *
 *   composeConsumption  reads the live baseline, applies the plan, records it
 *   the panel preview   reads the live baseline, applies NOTHING
 *
 * {@link planInjection} and {@link baselineFor} are pure: they read no file, touch
 * no session, and mutate nothing. The per-session baseline itself lives here too
 * (see {@link readConsumptionState}) because it is consumption domain state, and
 * holding it in `index.js` forced a callback through the plugin's live state just
 * so the panel could read it. The read/write split is the guard: only the real
 * per-step projection writes.
 *
 * @module @dsh-external/dsh-memory/consumption-plan
 */

import { memoryBlockHash, memoryDelta, memoryMessage, renderMemoryDelta } from './render.js'

/**
 * Live injection state, one entry per session.
 *
 * A WeakMap keyed by the session: memory is re-projected on every step, and this
 * is what lets an unchanged step answer "nothing to do" without re-deriving that
 * from the transcript. Duplicated in no other module — `index.js` used to hold it,
 * which forced a read-only accessor through the plugin's live state so the panel's
 * preview could describe the next step without advancing it.
 */
const CONSUMPTION_STATE = new WeakMap()

/**
 * The baseline one session has already been shown, if this process has one.
 *
 * @param session - the live session.
 * @returns the state record, or `undefined`.
 */
export function readConsumptionState(session) {
  return CONSUMPTION_STATE.get(session)
}

/**
 * Record what a session has just been shown.
 *
 * Only the real per-step projection calls this. A preview must never do so: it
 * would consume the change it was describing, and the next real step would then
 * find nothing to send.
 *
 * @param session - the live session.
 * @param next - the state to store.
 */
export function writeConsumptionState(session, next) {
  CONSUMPTION_STATE.set(session, next)
}

/**
 * What this session has already been shown, in the shape the plan compares against.
 *
 * Two sources, in priority order: the live per-session state this process keeps
 * (cheap, exact), then the durable surface — the block hash and per-file hashes
 * riding on the injected message's `source`. A resumed process has no live state
 * and this is what lets it continue with a delta instead of a full reload.
 *
 * A state whose `identity` no longer matches is not a baseline: the effective
 * configuration moved (roots, budget, file list), so the old comparison means
 * nothing and the next step reloads in full.
 *
 * @param identity - the current configuration identity.
 * @param state - this session's live state, when this process has one.
 * @param durable - `visibleMemoryState()`'s result, when it was consulted.
 * @returns `{ hash, files }`, or `undefined` when there is no usable baseline.
 */
export function baselineFor(identity, state, durable) {
  if (state !== undefined && state.identity === identity) {
    return { hash: state.blockHash, files: state.files }
  }
  if (durable === undefined) return undefined
  return { hash: durable.blockHash, files: durable.files }
}

/**
 * Decide one step's injection.
 *
 * The four outcomes, in the order they are tested — the order is the contract:
 *
 *   `silent`    the block hash is unchanged: inject nothing. This is the common
 *               case, and it is why the panel's preview usually says "nothing".
 *   `snapshot`  no usable baseline (a fresh session, a resumed one that never
 *               saw memory, or a changed identity): the whole budgeted block.
 *   `delta`     something changed mid-session: only the changed files, framed as
 *               a notice, never as a snapshot — what it omits is still true.
 *   `none`      a baseline exists but the block is empty: nothing to send.
 *
 * `publish` says whether the caller should record and report this outcome. A
 * silent step is deliberately NOT reported: one report per step would make
 * `onResult` fire on every request of every session.
 *
 * @param identity - the configuration identity this injection belongs to.
 * @param previous - a {@link baselineFor} result, or `undefined`.
 * @param result - a `runConsumption` result (`blockHash`, `contents`, `rendered`, `injected`).
 * @param options - `{ maxTokens, measure }` from the caller's `ctx`.
 * @returns `{ identity, action, reason, desired, nextState, publish, reused?, delta? }`.
 */
export function planInjection(identity, previous, result, options) {
  const files = memoryBlockHash(result.contents).files
  const nextState = { identity, blockHash: result.blockHash, files }

  if (previous !== undefined && previous.hash === result.blockHash) {
    return { identity, action: 'silent', reason: 'unchanged', desired: undefined, nextState, publish: false, reused: true }
  }

  // No baseline, or one that never recorded per-file hashes: only a snapshot can
  // be honest here, because a delta needs something to be a delta FROM.
  if (previous === undefined || previous.files === undefined) {
    if (!result.injected) {
      return { identity, action: 'none', reason: 'nothing to inject', desired: undefined, nextState, publish: false }
    }
    return {
      identity,
      action: 'snapshot',
      reason: previous === undefined ? 'no baseline for this session' : 'the baseline carries no file hashes',
      desired: memoryMessage(result.rendered, identity, { form: 'snapshot', ...nextState }),
      nextState,
      publish: true,
    }
  }

  const delta = memoryDelta(previous.files, result.contents)
  const rendered = renderMemoryDelta(delta, options.maxTokens, options.measure)
  if (rendered.text === undefined) {
    return {
      identity,
      action: 'silent',
      reason: 'the change does not fit the budget',
      desired: undefined,
      nextState,
      publish: false,
      delta,
      tokens: rendered.tokens,
    }
  }
  return {
    identity,
    action: 'delta',
    reason: 'memory changed since the last step',
    desired: memoryMessage(rendered, `${identity}#delta:${result.blockHash}`, {
      form: 'delta',
      ...nextState,
      files: nextState.files,
    }),
    nextState,
    publish: true,
    delta,
    // The DELTA's cost, not the whole block's: the log line says how much this
    // step actually added, and the two numbers differ by everything unchanged.
    tokens: rendered.tokens,
  }
}

/**
 * The text one planned injection would carry, for a preview or a log line.
 *
 * @param plan - a {@link planInjection} result.
 * @returns the message text, or `undefined` when nothing would be sent.
 */
export function plannedText(plan) {
  const content = plan?.desired?.content
  if (!Array.isArray(content) || content.length === 0) return undefined
  return typeof content[0]?.text === 'string' ? content[0].text : undefined
}
