/**
 * Generation: record durable knowledge after a turn ends.
 *
 * This is the other half of the Qoder memory contract. A pass is a background
 * auxiliary model call that decides what is worth keeping and writes it into the
 * memory roots. Status vocabulary is Qoder's verbatim:
 *
 *   saved | partial | no_change | skipped | failed
 *
 * The pass never throws: every outcome, including a failed one, is reported
 * through `generation.onResult` and the plugin's own log.
 *
 * @module @dsh-external/dsh-memory/generation
 */

import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { listRootFiles, readIfPresent } from './fs.js'
import { createMemoryToolkit, runMemoryAgent } from './memory-agent.js'
import { isIndexFile, parseMemoryFile } from './memory-file.js'
import { applyPlan, parsePlan, resolveRoute } from './memory-pass.js'
import { pausedOutcome, recordFailurePause, resumePaused } from './failure-pause.js'
import { autoMemorySystemPrompt } from './memory-prompt.js'
import { collectTranscript, collectTurn, textOf, turnInProgress } from './transcript.js'
import { resolveEffectiveRoots } from './trust.js'

export { parsePlan }

/**
 * The system instruction used for one generation pass.
 *
 * @param config - the resolved configuration.
 * @param roots - the resolved roots.
 * @returns the instruction text.
 */
export function generationSystemPrompt(config, roots) {
  return autoMemorySystemPrompt(roots, config.generation.prompt)
}

/**
 * Snapshot existing memory so the model can avoid duplicating it.
 *
 * @param ctx - plugin context.
 * @param roots - the resolved roots.
 * @param signal - cancellation.
 * @returns a textual snapshot, or a placeholder when nothing exists yet.
 */
async function readMemorySnapshot(ctx, roots, signal) {
  const fs = ctx.get('fs')
  const parts = []
  for (const root of roots) {
    let names = []
    try {
      names = await listRootFiles(fs, root, signal)
    } catch {
      continue
    }
    if (names.length === 0) {
      parts.push(`### root ${root.id} (${root.path})\n(empty)`)
      continue
    }
    // The INDEX is supplied in full — Qoder's prompt says "Never Read
    // MEMORY.md", because the pass receives it rather than fetching it. Content
    // files are only NAMED here, with their kind, so the agent decides what to
    // read instead of every file's body being dumped into the request.
    const indexName = names.find(isIndexFile)
    const lines = [`### root ${root.id} (${root.path})`, '', `Index (${indexName ?? 'none'}):`]
    if (indexName !== undefined) {
      const found = await readIfPresent(fs, join(root.path, indexName), signal).catch(() => undefined)
      lines.push(found === undefined ? '(absent)' : found.text.trim())
    } else {
      lines.push('(this root declares no index file)')
    }
    const content = names.filter((name) => !isIndexFile(name))
    lines.push('', 'Content files (read the ones you need with memory_read):')
    if (content.length === 0) lines.push('(none)')
    for (const fileName of content) {
      let kind = ''
      try {
        const found = await readIfPresent(fs, join(root.path, fileName), signal)
        if (found !== undefined) {
          const parsed = parseMemoryFile(fileName, found.text)
          kind = ` [${parsed.type}]${parsed.description ? ` ${parsed.description}` : ''}`
        }
      } catch {
        /* an unreadable file still lists */
      }
      lines.push(`- ${fileName}${kind}`)
    }
    parts.push(lines.join('\n'))
  }
  return parts.length === 0 ? '(no memory roots are enabled)' : parts.join('\n\n')
}

/**
 * Run the application gate.
 *
 * @param config - the resolved configuration.
 * @param input - the `MemoryGenerationGateInput` handed to a custom gate.
 * @returns `{ run: true }`, or `{ run: false, reason, gateError? }`.
 */
async function runGate(config, input) {
  const turnComplete = config.generation.turnComplete
  const gate = turnComplete.shouldGenerate
  if (typeof gate !== 'function') {
    // `minPromptChars` asks "did the user ask for enough to be worth a pass?".
    // An in-turn pass can be triggered by assistant or tool output alone — the
    // user prompt was already counted when the turn began — so it measures the
    // whole new transcript instead of demanding a fresh prompt.
    const measured = input.midTurn === true ? `${input.prompt}${input.response}` : input.prompt
    if (measured.length < turnComplete.minPromptChars) {
      return { run: false, reason: `prompt shorter than ${turnComplete.minPromptChars} characters` }
    }
    return { run: true }
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('gate timeout')), turnComplete.timeoutMs)
  try {
    const decision = await gate(input, { signal: controller.signal })
    if (decision !== null && typeof decision === 'object' && decision.run === false) {
      return { run: false, reason: typeof decision.reason === 'string' ? decision.reason : 'vetoed by shouldGenerate' }
    }
    return { run: true }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (turnComplete.onGateError === 'report_failed') {
      return { run: false, reason: `shouldGenerate failed: ${message}`, gateError: true }
    }
    return { run: false, reason: `shouldGenerate skipped: ${message}` }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Report one generation outcome to the configured callback.
 *
 * Recording happens HERE, before the callback runs, so a callback that reads
 * `ctx.memory.status()` observes the result it was just handed rather than the
 * previous pass. Consumption does the same, and keeping both in one place is
 * what stops the two halves from drifting apart again.
 *
 * @param ctx - plugin context.
 * @param config - the resolved configuration.
 * @param result - the finished pass result.
 * @param record - called with the result before the callback fires.
 */
export function reportGeneration(ctx, config, result, record) {
  if (typeof record === 'function') record(result)
  if (typeof config.generation.onResult !== 'function') return
  // The SDK allows the callback to return a promise; a throw or rejection is
  // recorded as a diagnostic and never fails the background pass.
  try {
    const returned = config.generation.onResult(result)
    if (returned !== undefined && typeof returned.then === 'function') {
      Promise.resolve(returned).catch((error) => {
        ctx.logger.warn('memory: generation onResult rejected: %o', error)
      })
    }
  } catch (error) {
    ctx.logger.warn('memory: generation onResult threw: %o', error)
  }
}

/**
 * Qoder's turn-interval arithmetic, as a pure function.
 *
 * Decoded from the installed `qodercli`:
 *
 * ```js
 * shouldRunForTurnCompleteInterval(context, first) {
 *   return !((!first && !context.skipExtractionIntervalGate &&
 *             (this.turnsSinceLastExtraction += 1, this.turnsSinceLastExtraction < mZr())) ||
 *            (this.turnsSinceLastExtraction = 0, 0))
 * }
 * ```
 *
 * so the counter advances on every turn, a pass is due once it reaches
 * `everyTurns`, and the counter resets when a pass runs.
 *
 * @param turnsSince - turns completed since the last pass.
 * @param everyTurns - the configured interval; `1` means every turn.
 * @param bypass - run regardless of the interval (Qoder's `skipExtractionIntervalGate`).
 * @returns `{ run, turnsSince }` — the decision and the counter to store.
 */
export function turnIntervalAllows(turnsSince, everyTurns, bypass = false) {
  const interval = Number.isInteger(everyTurns) && everyTurns > 0 ? everyTurns : 1
  if (bypass) return { run: true, turnsSince: 0 }
  const counted = (Number.isFinite(turnsSince) ? turnsSince : 0) + 1
  if (counted < interval) return { run: false, turnsSince: counted }
  return { run: true, turnsSince: 0 }
}

/**
 * Build the per-session generation scheduler.
 *
 * Qoder's extraction manager does two things this plugin did not, and both
 * matter for a long session:
 *
 *   - **It serializes.** `if (this.inProgress) this.pendingContext = context`
 *     keeps only the LATEST context, so several turns completing while a pass
 *     runs coalesce into one follow-up pass instead of running concurrently over
 *     the same files.
 *   - **It gates by interval.** `extractionEveryNTurns` (default `1`) lets a long
 *     session pay for a pass less often, and an operator-supplied callback
 *     bypasses that gate (`skipExtractionIntervalGate`) because then the operator
 *     owns the decision.
 *
 * @param ctx - plugin context.
 * @param config - the resolved configuration.
 * @param customRoots - the validated `generation.roots` list.
 * @param lifecycle - the plugin's lifetime signal.
 * @param state - live plugin state, so `pending` reflects in-flight work.
 * @returns `{ onTurnEnd, onStep }` — the per-turn trigger and the in-turn one.
 */
export function createGenerationScheduler(ctx, config, customRoots, lifecycle, state) {
  /** Per-session queue: at most one running pass and one coalesced follow-up. */
  const sessions = new WeakMap()

  /** Sessions paused by consecutive failures, so one command can clear them all. */
  const pausedSessions = new Set()

  const pass = async (entry, request) => {
    // Paused after repeated failures: attempt nothing, exactly as the original does
    // ("skipped because service is paused"), and say why in the recorded result.
    if (entry.paused === true) return reportGeneration(ctx, config, pausedOutcome(entry, request.turn, request.turnIndex), request.record)
    const everyTurns = config.generation.incremental?.everyTurns ?? 1
    // An operator gate owns the decision, exactly as a `shouldGenerateCallbackId`
    // bypasses Qoder's interval. A COALESCED follow-up bypasses it too: Qoder's
    // `runExtractionLoop` passes `first = true` for the stashed context, and its
    // `shouldRunForTurnCompleteInterval` then short-circuits on `!first`.
    const bypass = request.followUp === true || typeof config.generation.turnComplete.shouldGenerate === 'function'
    const decision = turnIntervalAllows(entry.turnsSince, everyTurns, bypass)
    entry.turnsSince = decision.turnsSince
    if (!decision.run) {
      reportGeneration(
        ctx,
        config,
        {
          status: 'skipped',
          attemptId: `interval-${request.turn}`,
          origin: 'turn_complete',
          reason: `turn interval gate (${entry.turnsSince} of ${everyTurns} turns)`,
          writtenFiles: [],
          failedFiles: [],
          durationMs: 0,
          turnIndex: request.turnIndex,
        },
        request.record,
      )
      return
    }
    // The transcript starts where the last pass stopped, so paced-out turns are
    // not dropped. `lastSeq` advances only when a pass actually runs.
    const transcript = collectTranscript(request.agent.session, entry.lastSeq)
    // In-turn passes fire per step, so most of them find nothing new. Staying
    // quiet there is the difference between "paced" and "a skip per step".
    if (request.midTurn === true && transcript.prompt.length === 0 && transcript.response.length === 0) {
      return
    }
    const result = await generateFor(
      ctx,
      config,
      customRoots,
      lifecycle,
      request.agent,
      request.turn,
      request.turnIndex,
      request.record,
      { transcript, midTurn: request.midTurn === true },
    )
    if (transcript.lastSeq !== undefined) entry.lastSeq = transcript.lastSeq
    recordFailurePause(entry, result, config.generation.pauseAfterFailures, {
      state,
      pausedSessions,
      sessionId: request.agent.session.id,
    }, ctx.logger)
  }

  /**
   * Enqueue a pass; shared by both triggers.
   *
   * @param agent - the agent to generate for.
   * @param request - `{ turn, turnIndex, record, midTurn? }`.
   */
  const enqueue = async (agent, request) => {
    const entry = sessions.get(agent.session) ?? {
      running: false,
      pending: undefined,
      turnsSince: 0,
      lastSeq: undefined,
    }
    sessions.set(agent.session, entry)
    if (entry.running) {
      // Coalesce: only the newest context survives, so N turns during one pass
      // cost one extra pass, not N.
      entry.pending = { ...request, agent }
      return
    }
    entry.running = true
    let next = { ...request, agent }
    try {
      while (next !== undefined) {
        entry.pending = undefined
        await pass(entry, next)
        // The stashed context is the follow-up: Qoder marks it as "first", which
        // is what lets it past the interval gate.
        next = entry.pending === undefined ? undefined : { ...entry.pending, followUp: true }
      }
    } catch (error) {
      ctx.logger.warn('memory: background generation rejected: %o', error)
    } finally {
      entry.running = false
    }
  }

  return {
    /** A completed turn (the SDK's TurnComplete trigger). */
    onTurnEnd(agent, request) {
      return enqueue(agent, request)
    },

    /**
     * A step inside a turn — Qoder's in-turn variant.
     *
     * The cursor is what makes this cheap: a step that produced no new messages
     * enqueues nothing at all, and a pass covers only what came after the last
     * one, so a long turn is recorded in pieces instead of being lost until it
     * ends. Never awaited by the caller: a pass must not delay the step.
     */
    onStep(agent, request = {}) {
      const turn = turnInProgress(agent.session)
      if (turn <= 0) return
      return enqueue(agent, {
        turn,
        // `turnIndex` counts COMPLETED turns, so an in-turn pass reports the last
        // one and marks itself instead of inventing a number.
        turnIndex: request.turnIndex ?? 0,
        record: request.record,
        midTurn: true,
      })
    },

    /** Clear every armed pause. The original never resumes; a human must be able to. */
    resumeAll() {
      return resumePaused(pausedSessions, state)
    },
  }
}

/**
 * Register Qoder's in-turn trigger on the `agent/pre-step` seam.
 *
 * Off unless `generation.incremental.midTurn` is set — Qoder keeps its in-turn
 * variant behind an experiment flag too, and it spends model calls inside turns
 * that used to be free. The pass is never awaited here: it must not delay the
 * step that triggered it. The promise goes to `options.track`, so `flushMemory()`
 * still covers it.
 *
 * @param ctx - plugin context.
 * @param config - the resolved configuration.
 * @param scheduler - the object from {@link createGenerationScheduler}.
 * @param options - `{ track, record, turnIndexFor }`.
 */
export function registerInTurnGeneration(ctx, config, scheduler, options) {
  if (config.generation.incremental?.midTurn !== true) return
  ctx.on('agent/pre-step', async ({ agent }, next) => {
    const decision = await next()
    const pass = scheduler.onStep(agent, { turnIndex: options.turnIndexFor(agent), record: options.record })
    if (pass !== undefined) options.track('in-turn generation', pass)
    return decision
  })
}

/**
 * One background generation pass. Never throws.
 *
 * @param ctx - plugin context.
 * @param config - the resolved configuration.
 * @param customRoots - the validated `generation.roots` list.
 * @param lifecycle - the plugin's lifetime signal.
 * @param agent - the agent whose turn just ended.
 * @param turn - the turn number.
 * @param turnIndex - the one-based generation sequence for this session.
 * @param record - called with each result before its callback fires.
 * @returns the finished pass result.
 */
export async function generateFor(ctx, config, customRoots, lifecycle, agent, turn, turnIndex, record, options = {}) {
  const logger = ctx.logger
  const session = agent.session
  const signal = lifecycle.signal
  const started = Date.now()
  // The SDK identifies every attempt and records which origin produced it.
  const attemptId = randomUUID()
  const origin = 'turn_complete'
  // A pass that ran inside a turn is still the turn-complete strategy (Qoder's
  // in-turn variant is the same pipeline), so it keeps that origin and says so.
  const midTurn = options.midTurn === true

  /** A pass that stopped before writing anything. */
  const stop = (status, reason) => {
    const result = {
      status, attemptId, origin, reason, writtenFiles: [], failedFiles: [],
      durationMs: Date.now() - started, turn, turnIndex,
    }
    if (midTurn) result.midTurn = true
    if (status === 'failed') logger.warn('memory: generation %s — %s', status, reason)
    else logger.info('memory: generation %s — %s', status, reason)
    reportGeneration(ctx, config, result, record)
    return result
  }

  try {
    const cwd = session.header?.cwd ?? process.cwd()
    const roots = await resolveEffectiveRoots(ctx, config, customRoots, cwd, signal)
    const { prompt, response } = options.transcript ?? collectTurn(session, turn)

    const gate = await runGate(config, {
      prompt,
      response,
      sessionId: session.id,
      cwd,
      turnIndex,
      midTurn,
    })
    if (!gate.run) return stop(gate.gateError === true ? 'failed' : 'skipped', gate.reason)
    if (response.length === 0) return stop('skipped', 'turn produced no assistant text')
    if (ctx.get('llm') === undefined) return stop('skipped', 'the llm service is unavailable')

    const route = resolveRoute(ctx, config, session)
    const snapshot = await readMemorySnapshot(ctx, roots, signal)
    const userText = [
      'Current memory:',
      snapshot,
      '',
      'Turn transcript:',
      `USER:\n${prompt}`,
      '',
      `ASSISTANT:\n${response}`,
    ].join('\n')
    // The pass is an AGENT, not one call: it orients from the supplied indexes,
    // reads the few content files it needs, then writes. See memory-agent.js.
    const toolkit = createMemoryToolkit(ctx, config, roots, signal)
    const { outcome, text, rounds } = await runMemoryAgent(
      ctx,
      config,
      route,
      generationSystemPrompt(config, roots),
      userText,
      toolkit,
      signal,
    )
    // A model that answers in prose with a JSON plan instead of calling tools
    // still lands, so the older path stays as a fallback.
    const finalOutcome =
      outcome.writtenFiles.length === 0 && text.includes('"writes"')
        ? await applyPlan(ctx, config, roots, parsePlan(text), signal)
        : outcome
    const result = { ...finalOutcome, attemptId, origin, durationMs: Date.now() - started, turn, turnIndex, rounds }
    if (midTurn) result.midTurn = true
    if (result.status === 'saved' || result.status === 'partial') {
      logger.info(
        'memory: generation %s in %dms — wrote %s%s',
        result.status,
        result.durationMs,
        result.writtenFiles.map((file) => `${file.rootId}:${file.path}`).join(', ') || '(none)',
        result.failedFiles.length > 0
          ? `; failed ${result.failedFiles.map((file) => `${file.rootId}:${file.path}`).join(', ')}`
          : '',
      )
    } else {
      logger.info(
        'memory: generation %s in %dms%s',
        result.status,
        result.durationMs,
        result.reason.length > 0 ? ` — ${result.reason}` : '',
      )
    }
    reportGeneration(ctx, config, result, record)
    return result
  } catch (error) {
    const aborted = lifecycle.signal.aborted
    const result = {
      status: 'failed',
      attemptId,
      origin,
      reason: aborted ? 'plugin disposed' : error instanceof Error ? error.message : String(error),
      writtenFiles: [],
      failedFiles: [],
      durationMs: Date.now() - started,
      turnIndex,
    }
    if (!aborted) logger.warn('memory: generation failed: %o', error)
    reportGeneration(ctx, config, result, record)
    return result
  }
}
