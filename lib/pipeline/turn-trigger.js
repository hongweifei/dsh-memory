/**
 * The per-turn generation trigger.
 *
 * Qoder's `TurnComplete` extraction fires once a turn ends; this module owns that
 * subscription and the bookkeeping around it — which session has a live agent, how many turns
 * each has completed, and which of them are muted — so `index.js` stays what it says it is:
 * wiring. Everything it calls (the scheduler, the consolidation pass, the pending tracker) is
 * injected, because those are the composition's business, not the trigger's.
 *
 * @module @dsh-external/dsh-memory/turn-trigger
 */

import { reportGeneration } from './generation.js'

/**
 * Subscribe the turn-ended trigger, and expose its counter.
 *
 * @param ctx - plugin context.
 * @param options - `{ config, enabled, isMuted, scheduler, dream, track, record, logger }`.
 *   `enabled` is the `turnComplete` gate, which applies ONLY to this automatic trigger.
 * @returns `{ turnIndexFor }`, the per-session completed-turn count, for the in-turn trigger.
 */
export function registerTurnEndTrigger(ctx, options) {
  const { config, enabled, isMuted, scheduler, dream, track, record, logger } = options

  /** Live agents by session, so `turn/end` can reach its agent. */
  const agentsBySession = new WeakMap()
  /** Turns observed per session, reported Qoder-style as `turnIndex`. */
  const turnCounters = new WeakMap()

  ctx.on('agent/created', ({ agent }) => {
    agentsBySession.set(agent.session, agent)
  })

  ctx.on('session/event', (session, event) => {
    if (event.type !== 'turn/end' || !enabled) return
    const agent = agentsBySession.get(session)
    if (agent === undefined) return

    const reason = event.data.reason?.kind
    if (reason !== 'completed') {
      logger.info('memory: generation skipped — turn %d ended as %s', event.data.turn, reason ?? 'unknown')
      reportGeneration(
        ctx,
        config,
        {
          status: 'skipped',
          attemptId: `turn-${event.data.turn}`,
          origin: 'turn_complete',
          reason: `turn ended as ${reason ?? 'unknown'}`,
          writtenFiles: [],
          failedFiles: [],
          durationMs: 0,
          turnIndex: turnCounters.get(session) ?? 0,
        },
        record,
      )
      return
    }

    // `turnIndex` counts completed turns — the SDK's "one-based TurnComplete
    // sequence number" — so a turn that did not complete does not advance it. It is
    // counted here, SYNCHRONOUSLY: two turns ending back to back must not both read
    // the pre-increment value while an async gate is open.
    const turnIndex = (turnCounters.get(session) ?? 0) + 1
    turnCounters.set(session, turnIndex)

    // The session switch, on the generation half too: a muted session is not
    // recorded into memory either. Nothing is REPORTED when it is off — an
    // automatic trigger the user deliberately switched off is not a skipped pass,
    // and a report per turn would fill the panel with a decision already made.
    const run = async () => {
      if (await isMuted(session)) {
        logger.info('memory: generation skipped — memory is switched off for this session')
        return
      }
      // Fire-and-forget from here: the pass must not delay the next turn, and the
      // scheduler serializes per session, so a turn during a pass coalesces into one
      // follow-up.
      await scheduler.onTurnEnd(agent, { turn: event.data.turn, turnIndex, record })
      await dream(agent)
    }
    track('background generation', run())
  })

  return { turnIndexFor: (agent) => turnCounters.get(agent.session) ?? 0 }
}
