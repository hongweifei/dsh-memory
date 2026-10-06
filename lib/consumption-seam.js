/**
 * The consumption seam: memory's `agent/pre-step` listener.
 *
 * This is where a step's context is decided, and it was 55 lines inside `index.js`
 * until the session switch needed a place in it — `index.js` is held to 300 lines of
 * wiring and a handler of that size is not wiring. Moving it here is what made room
 * for the switch without raising the budget, and it gives the one rule that matters a
 * home: **the listener's job is to reconcile the inbox with the decision, and every
 * early exit must still remove stale memory from the inbox.**
 *
 * @module @dsh-external/dsh-memory/consumption-seam
 */

import { composeConsumption } from './consumption.js'
import { readConsumptionState, writeConsumptionState } from './consumption-plan.js'
import { isMemoryMessage } from './render.js'

/**
 * Register the per-step consumption listener.
 *
 * @param ctx - plugin context.
 * @param options - `{ config, customRoots, explicitFiles, memorySwitch, onResult,
 *   sessionApprovedExternalImports }`: the resolved configuration, the validated
 *   `generation.roots` and `consumption.files` lists, the session switch, the
 *   plugin's result recorder, and Qoder's session-scoped import grant predicate.
 */
export function registerConsumptionSeam(ctx, options) {
  const { config, customRoots, explicitFiles, memorySwitch, onResult } = options

  ctx.on('agent/pre-step', async ({ agent, messages, signal }, next) => {
    const decision = await next()
    // Memory messages already waiting in the inbox, from a previous step or a
    // refresh. Every exit below has to deal with them: an injected message that is
    // no longer wanted is a lie sitting in the reader's own queue.
    const pendingMemory = agent.inbox.nextStep.filter(isMemoryMessage)

    // The session switch. A muted session gets nothing — and anything queued before
    // it was muted goes too. Checked before the pass runs, so a muted session does
    // not read a single memory file on any step.
    if (await memorySwitch.isMuted(agent.session)) {
      for (const message of pendingMemory) agent.inbox.remove(message.id)
      return decision
    }

    let composed
    try {
      composed = await composeConsumption(
        ctx,
        config,
        customRoots,
        explicitFiles,
        agent,
        readConsumptionState(agent.session),
        signal,
        onResult,
        // A session-scoped import grant, if this session made one.
        { sessionApprovedExternalImports: options.sessionApprovedExternalImports?.(agent) === true },
      )
    } catch (error) {
      ctx.logger.warn('memory: consumption failed: %o', error)
      return decision
    }
    signal.throwIfAborted()

    const { desired } = composed
    if (desired === undefined) {
      for (const message of pendingMemory) agent.inbox.remove(message.id)
      return decision
    }
    const remember = () => {
      // The state is the block hash plus per-file hashes, so the next step can
      // tell "unchanged" from "changed" — and send only the change.
      if (composed.nextState !== undefined) writeConsumptionState(agent.session, composed.nextState)
    }
    if (decision.kind === 'reject') {
      for (const message of pendingMemory) agent.inbox.remove(message.id)
      agent.inbox.prepend('next-step', desired)
      return decision
    }
    for (const message of pendingMemory) {
      if (message.id !== desired.id) agent.inbox.remove(message.id)
    }
    if (decision.messages.some((message) => message.id === desired.id || isMemoryMessage(message))) {
      remember()
      return decision
    }
    const lastClaimed = decision.messages.findLastIndex((message) => messages.includes(message))
    const entered = decision.messages.toSpliced(lastClaimed + 1, 0, desired)
    remember()
    return { ...decision, messages: entered }
  })
}
