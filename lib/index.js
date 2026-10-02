/**
 * dsh-memory — a complete port of the Qoder Agent SDK memory contract to DSH.
 *
 * Reference: https://docs.qoder.com/zh/cli/sdk/memory
 * Verified against the real SDK `@qoder-ai/qoder-agent-sdk` v1.0.50 (its
 * `dist/types/memory.d.ts`, `dist/protocol/memory.d.ts`,
 * `dist/memory/memory-options.d.ts`, and `prepareMemoryOptions`), and against the
 * installed `qodercli` bundle for everything the SDK does not describe.
 *
 * Qoder splits memory into two independently configurable halves, so does this:
 *   Generation   a background pass decides what is worth remembering and writes
 *                it — after a turn ends, or, opt-in, during a long one.
 *   Consumption  files are loaded into Agent context on every step under a shared
 *                token budget, and only the changes are re-sent.
 *
 * Status vocabulary is Qoder's, verbatim; `constants.js` and the tests hold it.
 *
 * Harness mapping (verified against the installed 0.1.7-rc.2 packages):
 *   generation trigger   session/event turn/end, plus agent/pre-step when in-turn
 *   generation model     ctx.llm.stream()        (self-contained auxiliary call)
 *   token accounting     ctx.tokenMeter when mounted, else the harness heuristic
 *   file I/O             ctx.fs
 *   consumption seam     agent/pre-step waterfall (as dsh-agent-instructions)
 *   runtime methods      ctx.provide('memory', …) (Cordis service)
 *   explicit control     ctx.tools + ctx.commands
 *   panel                Client slot settings.section (see ./client.js)
 *
 * This module is wiring only: every concern lives in its own module, the layers
 * are enforced by test/architecture.test.mjs, which is the authoritative list of
 * what exists and which layer it belongs to.
 *
 * @module @dsh-external/dsh-memory
 */

import { Config, resolveMemoryConfig, validateConsumptionFiles, validateMemoryConfig, validateRoots } from './config.js'
import { registerCommands } from './commands.js'
import { composeConsumption } from './consumption.js'
import { readConsumptionState, writeConsumptionState } from './consumption-plan.js'
import { createDreamScheduler } from './dream.js'
import { createGenerationScheduler, registerInTurnGeneration, reportGeneration } from './generation.js'
import { isMemoryMessage } from './render.js'
import { registerRoutes } from './routes.js'
import { createMemoryService } from './service.js'
import { registerMemoryTool } from './tools.js'
import { resolveEffectiveRoots } from './trust.js'

export const name = 'memory'

export { Config }

export { collectTouchedPaths, isJitActive, jitDecision, parseJitTrigger, JIT_LOAD_REASON, JIT_TRIGGERS } from './jit.js'
export {
  GENERATION_DEFAULTS, CONSUMPTION_DEFAULTS, PROJECT_ROOT_MARKERS_DEFAULT, EXCLUDES_DEFAULT, IMPORTS_DEFAULTS,
  ENV_KEYS, applyEnvironmentOverrides, readBooleanEnv,
  validateMemoryConfig, validateRoots, validateConsumptionFiles, resolveMemoryConfig,
} from './config.js'
export { isExcluded, normalizeExcludes, partitionExcluded } from './excludes.js'
export { LARGE_FILE_CHARS, classifyLargeFiles, classifyFailedFiles, memoryChangeReport } from './consumption.js'
export { estimateBlock, estimateMessage } from './tokens.js'
export {
  renderMemoryContext, memoryMessage, isMemoryMessage, memoryIdentity, visibleMemoryMessage,
  hashText, memoryBlockHash, memoryDelta, renderMemoryDelta, visibleMemoryState,
} from './render.js'
export {
  safeRelativePath, joinRoot, resolveDshHome, folderContains, normalizeFolder,
  projectKey, projectMemoryDir, resolveProjectIdentity, resolveWorkspace, resolveRoots,
} from './paths.js'
export { findHits, formatSearchResult, searchMemory } from './memory-search.js'
export {
  IMPORT_FORMATS, IMPORT_MAX_DEPTH, codeFenceRanges, expandImports, flattenImportTree, importParentMap,
  isAllowedImport, isImportPath, parseImports, resolveTarget, externalImportsApproved,
} from './imports.js'
export {
  effectiveTrustedFolders,
  isFolderTrusted,
  resolveEffectiveRoots,
  trustState,
  trustStorePath,
} from './trust.js'
export { collectTurn, collectTranscript, turnInProgress, textOf } from './transcript.js'
export { parsePlan, generationSystemPrompt, turnIntervalAllows } from './generation.js'

export function apply(ctx, validatedConfig) {
  // SDK cross-field rules run against the sparse validated config, where absent fields
  // are still absent (see config.js), so the rules can tell what the caller wrote.
  validateMemoryConfig(validatedConfig)
  const config = resolveMemoryConfig(validatedConfig)
  const customRoots = validateRoots(config.generation.roots)
  const explicitFiles = validateConsumptionFiles(config.consumption.files)

  const logger = ctx.logger
  const lifecycle = new AbortController()

  /** Live state shared with the service, the panel, and the commands. */
  const state = {
    pending: new Set(),
    lastGeneration: undefined,
    lastConsumption: undefined,
    explicitFiles,
    /** Sessions that approved external `@import` expansion (Qoder's session grant). */
    importApprovals: new WeakSet(),
  }
  /** Live agents by session, so `turn/end` can reach its agent. */
  const agentsBySession = new WeakMap()
  /** Turns observed per session, reported Qoder-style as `turnIndex`. */
  const turnCounters = new WeakMap()

  ctx.effect(() => () => {
    lifecycle.abort(new Error('dsh-memory disposed'))
    state.pending.clear()
  }, 'memory.lifecycle')

  if (!config.enabled) {
    logger.info('memory: disabled by configuration')
    // Still provide the service so `memory.initializationResult()` answers.
    ctx.provide('memory', {
      initializationResult: () => undefined,
      flushMemory: async () => ({ flushed: 0 }),
      refreshMemory: async () => ({ injected: false, reason: 'memory disabled' }),
      status: () => ({ enabled: false }),
    })
    return
  }

  const generationEnabled = config.generation.enabled !== false
  const turnCompleteEnabled = generationEnabled && config.generation.turnComplete.enabled !== false

  /* ---------------- runtime service ---------------- */

  ctx.provide('memory', createMemoryService(ctx, config, customRoots, lifecycle, state))

  /* ---------------- consumption seam ---------------- */

  if (config.consumption.enabled !== false) {
    ctx.on('agent/pre-step', async ({ agent, messages, signal }, next) => {
      const decision = await next()
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
          (result) => {
            state.lastConsumption = result
          },
          // A session-scoped import grant, if this session made one.
          { sessionApprovedExternalImports: state.importApprovals.has(agent.session) },
        )
      } catch (error) {
        logger.warn('memory: consumption failed: %o', error)
        return decision
      }
      signal.throwIfAborted()

      const pendingMemory = agent.inbox.nextStep.filter(isMemoryMessage)
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

  /* ---------------- generation trigger ---------------- */

  ctx.on('agent/created', ({ agent }) => {
    agentsBySession.set(agent.session, agent)
  })

  /** Consolidation scheduler; a no-op unless `generation.dream.enabled`. */
  const maybeDream = createDreamScheduler(
    ctx,
    config,
    (agent) => resolveEffectiveRoots(ctx, config, customRoots, agent.session.header?.cwd ?? process.cwd(), lifecycle.signal),
    state,
    lifecycle.signal,
  )

  /** Serializes passes per session and paces them by turn interval. */
  const generationScheduler = createGenerationScheduler(ctx, config, customRoots, lifecycle, state)
  // `/memory-resume` reaches the scheduler through the service, which holds the state.
  state.resumeGeneration = () => generationScheduler.resumeAll()

  /** Track a background pass, so `flushMemory()` waits for it and logs its failure. */
  const track = (label, promise) => {
    const tracked = promise
      .catch((error) => logger.warn('memory: %s rejected: %o', label, error))
      .finally(() => state.pending.delete(tracked))
    state.pending.add(tracked)
    return tracked
  }

  /** The record callback every pass reports through. */
  const recordGeneration = (result) => {
    state.lastGeneration = result
  }

  ctx.on('session/event', (session, event) => {
    // `turnComplete` gates only the automatic per-turn trigger.
    if (event.type !== 'turn/end' || !turnCompleteEnabled) return
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
        recordGeneration,
      )
      return
    }

    // `turnIndex` counts completed turns — the SDK's "one-based TurnComplete
    // sequence number" — so a turn that did not complete does not advance it.
    const turnIndex = (turnCounters.get(session) ?? 0) + 1
    turnCounters.set(session, turnIndex)

    // Fire-and-forget: the pass must not delay the next turn, and the scheduler
    // serializes per session, so a turn during a pass coalesces into one follow-up.
    track(
      'background generation',
      generationScheduler
        .onTurnEnd(agent, { turn: event.data.turn, turnIndex, record: recordGeneration })
        .then(() => maybeDream(agent)),
    )
  })

  /* ---------------- in-turn generation ---------------- */

  registerInTurnGeneration(ctx, config, generationScheduler, {
    track,
    record: recordGeneration,
    turnIndexFor: (agent) => turnCounters.get(agent.session) ?? 0,
  })

  /* ---------------- model-facing tool ---------------- */

  ctx.inject(['tools', 'fs'], (toolCtx) => {
    registerMemoryTool(toolCtx, config, customRoots)
  })

  /* ---------------- panel routes ---------------- */

  // Optional: a profile without a web connection (headless, ACP, SDK) gets no
  // routes, and the panel is simply absent.
  ctx.inject(['connection', 'fs'], (webCtx) => {
    registerRoutes(webCtx, config, customRoots, lifecycle, (request) => {
      const service = ctx.get('memory')
      return service !== undefined && typeof service.status === 'function'
        ? service.status(request ?? {})
        : { enabled: config.enabled, mode: config.mode }
    })
  })

  /* ---------------- slash commands ---------------- */

  ctx.inject(['commands', 'fs'], (commandCtx) => {
    registerCommands(commandCtx, config, customRoots, lifecycle, state)
  })
}
