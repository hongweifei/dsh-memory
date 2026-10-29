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

import { Config, resolveMemoryConfig, validateConsumptionFiles, validateRoots } from './config/config.js'
import { validateMemoryConfig } from './config/config-rules.js'
import { registerCommands } from './host/commands.js'
import { registerConsumptionSeam, registerInTurnGeneration } from './host/consumption-seam.js'
import { registerTurnEndTrigger } from './pipeline/turn-trigger.js'
import { createDreamScheduler } from './pipeline/dream.js'
import { createGenerationScheduler, reportGeneration } from './pipeline/generation.js'
import { createMemorySwitch } from './session/memory-switch.js'
import { registerRoutes, ROUTE_PATHS } from './host/routes.js'
import { registerConfigRoutes } from './host/config-route.js'
import { createUpdateService } from './core/update.js'
import { createMemoryService } from './host/service.js'
import { registerMemoryTool } from './host/tools.js'
import { resolveEffectiveRoots } from './session/trust.js'

export const name = 'memory'

export { Config }

export { CONSUMPTION_DEFAULT_TOKENS, CONSUMPTION_MIN_TOKENS, CONSUMPTION_UNLIMITED, PACKAGE_NAME } from './core/constants.js'
export { GLOBAL_SCOPE_CHOICES, describeGlobalScopes, scopeFields } from './config/scopes.js'
export { isOverridable, isPluginMode, MODES, pruneForNative, validateMemoryConfig } from './config/config-rules.js'
export { judgeConfig, merge, writeConfig } from './config/config-write.js'
export { UPDATE_MODES, UPDATE_TIMEOUT_MS } from './core/constants.js'
export {
  applyUpdate, checkForUpdate, createUpdateService, gitRunner, packageRoot, updateStatusOf,
} from './core/update.js'

export { collectTouchedPaths, isJitActive, jitDecision, parseJitTrigger, JIT_LOAD_REASON, JIT_TRIGGERS } from './memory/jit.js'
export {
  GENERATION_DEFAULTS, CONSUMPTION_DEFAULTS, UPDATE_DEFAULTS, PROJECT_ROOT_MARKERS_DEFAULT, EXCLUDES_DEFAULT, IMPORTS_DEFAULTS,
  validateRoots, validateConsumptionFiles, resolveMemoryConfig,
} from './config/config.js'
export { ENV_KEYS, applyEnvironmentOverrides, readBooleanEnv } from './config/env.js'
export { isExcluded, normalizeExcludes, partitionExcluded } from './memory/excludes.js'
export { LARGE_FILE_CHARS, classifyLargeFiles, classifyFailedFiles, memoryChangeReport } from './pipeline/consumption.js'
export { estimateBlock, estimateMessage } from './core/tokens.js'
export {
  renderMemoryContext, memoryMessage, isMemoryMessage, memoryIdentity, visibleMemoryMessage,
  hashText, memoryBlockHash, memoryDelta, renderMemoryDelta, visibleMemoryState,
} from './memory/render.js'
export {
  safeRelativePath, joinRoot, resolveDshHome, folderContains, normalizeFolder,
  projectKey, projectMemoryDir, resolveProjectIdentity, resolveWorkspace, resolveRoots,
} from './core/paths.js'
export { findHits, formatSearchResult, searchMemory } from './memory/memory-search.js'
export {
  IMPORT_FORMATS, IMPORT_MAX_DEPTH, codeFenceRanges, expandImports, flattenImportTree, importParentMap,
  isAllowedImport, isImportPath, parseImports, resolveTarget, externalImportsApproved,
} from './memory/imports.js'
export {
  effectiveTrustedFolders,
  isFolderTrusted,
  resolveEffectiveRoots,
  trustState,
  trustStorePath,
} from './session/trust.js'
export { collectTurn, collectTranscript, turnInProgress, textOf } from './memory/transcript.js'
export { parsePlan, generationSystemPrompt, turnIntervalAllows } from './pipeline/generation.js'
export {
  MEMORY_SWITCH_FILE, memorySwitchStorePath, parseMemoryOffSessions, serializeMemoryOffSessions,
  isSessionMode, isStoredSessionMode, scopedConfig, SESSION_MODES, resolveScopeAgent,
} from './session/memory-switch.js'

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

  /**
   * The per-session switch: memory can be turned off for one session, for both
   * halves at once. Its durable store is read lazily, before the first decision.
   */
  const memorySwitch = createMemorySwitch(ctx, config, lifecycle)

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

  /* ---------------- self-update ---------------- */

  // `check` (the default) fetches and compares and NEVER mutates; `auto` additionally
  // fast-forwards a clean tree; `off` does not even fetch. The startup pass itself is the
  // service's business — see `createUpdateService().start()` — because its ordering is the
  // contract (never pull on a diverged or dirty checkout) and a slow remote must not delay
  // this plugin's own wiring.
  const update = createUpdateService({ config, logger })
  update.start()

  /* ---------------- runtime service ---------------- */

  ctx.provide('memory', createMemoryService(ctx, config, customRoots, lifecycle, state, memorySwitch, update))

  /* ---------------- consumption seam ---------------- */

  if (config.consumption.enabled !== false) {
    registerConsumptionSeam(ctx, {
      config,
      customRoots,
      explicitFiles,
      memorySwitch,
      onResult: (result) => {
        state.lastConsumption = result
      },
      // A session-scoped import grant, if this session made one.
      sessionApprovedExternalImports: (agent) => state.importApprovals.has(agent.session),
    })
  }

  /* ---------------- generation trigger ---------------- */

  /** Consolidation scheduler; a no-op unless `generation.dream.enabled`. */
  const maybeDream = createDreamScheduler(
    ctx,
    config,
    (agent) => {
      const sessionConfig = memorySwitch.configFor(agent?.session, config)
      return resolveEffectiveRoots(ctx, sessionConfig, customRoots, agent.session.header?.cwd ?? process.cwd(), lifecycle.signal)
    },
    state,
    lifecycle.signal,
  )

  /** Serializes passes per session and paces them by turn interval. */
  const generationScheduler = createGenerationScheduler(ctx, config, customRoots, lifecycle, state, {
    // A `project`-scoped session must not WRITE cross-project knowledge either, so the pass
    // resolves its roots through the session's own configuration.
    configFor: (agent) => memorySwitch.configFor(agent?.session, config),
  })
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

  /** The session switch, consulted before anything that reads or writes memory. */
  const isSessionMuted = (session) => memorySwitch.isMuted(session)

  /* ---------------- the per-turn trigger ---------------- */

  // The trigger and its turn counters live in their own module; `record` is how a pass
  // reports back into this composition's live state, and `track` keeps it out of the way of
  // the next turn while `flushMemory()` can still wait for it.
  const { turnIndexFor } = registerTurnEndTrigger(ctx, {
    config,
    enabled: turnCompleteEnabled,
    logger,
    record: recordGeneration,
    track,
    scheduler: generationScheduler,
    dream: maybeDream,
    isMuted: isSessionMuted,
  })

  /* ---------------- in-turn generation ---------------- */

  registerInTurnGeneration(ctx, config, generationScheduler, {
    track,
    record: recordGeneration,
    turnIndexFor,
    isMuted: isSessionMuted,
  })

  /* ---------------- model-facing tool ---------------- */

  ctx.inject(['tools', 'fs'], (toolCtx) => {
    registerMemoryTool(toolCtx, config, customRoots, memorySwitch)
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
    }, memorySwitch, update)
    // Its own route module, wired here because both are layer 5 and neither may import the other. All
    // four writable values go through ONE registration: the same steps (narrow a form string, refuse
    // what the schema would refuse, write through `configEditor`).
    const paths = {
      budget: ROUTE_PATHS.budget, scope: ROUTE_PATHS.scope, mode: ROUTE_PATHS.mode, generation: ROUTE_PATHS.generation,
    }
    webCtx.effect(() => registerConfigRoutes(webCtx, { paths }), 'memory: config routes')
  })

  /* ---------------- slash commands ---------------- */

  ctx.inject(['commands', 'fs'], (commandCtx) => {
    registerCommands(commandCtx, config, customRoots, lifecycle, state, memorySwitch, update)
  })
}
