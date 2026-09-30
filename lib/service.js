/**
 * The `ctx.memory` runtime service.
 *
 * The Qoder SDK exposes three runtime methods on a query object; this service is
 * their DSH counterpart:
 *
 *   initializationResult()  read back the effective configuration
 *   flushMemory()           await in-flight background generation
 *   refreshMemory(agent)    reload memory files into a session
 *
 * `status()` is an addition: the Settings panel and `/memory` need one snapshot
 * of live state without performing a pass.
 *
 * @module @dsh-external/dsh-memory/service
 */

import { randomUUID } from 'node:crypto'
import { LARGE_FILE_CHARS, memoryChangeReport, runConsumption } from './consumption.js'
import { sessionSandboxPolicy } from './fs.js'
import { resolveEffectiveRoots } from './trust.js'
import { memoryBlockHash, memoryMessage } from './render.js'

/**
 * The sandbox modes one status call has to report.
 *
 * `sandboxMode` is what the plugin's own memory writes run under: `memory-root` declares its
 * own `workspace-write` root whatever the session is doing, while `session` resolves through
 * the harness's policy owner — WITH the calling session, so the answer is the session's real
 * mode rather than the deployment default the backend falls back to on its own. `sessionMode`
 * is the session's own mode whenever the caller named a session, even when the plugin's
 * writes ignore it, because "memory still writes while my session is read-only" is a fact the
 * panel has to be able to show.
 *
 * @param ctx - plugin context.
 * @param config - the resolved configuration.
 * @param session - the session the caller is speaking for, when there is one.
 * @returns `{ sandboxMode, sessionMode }`.
 */
function sandboxModes(ctx, config, session) {
  const sessionMode = session === undefined ? undefined : sessionSandboxPolicy(ctx, session)?.mode
  if (config.writePolicy !== 'session') return { sandboxMode: 'workspace-write', sessionMode }
  if (typeof sessionMode === 'string') return { sandboxMode: sessionMode, sessionMode }
  // No session to ask: the deployment's own answer, or the backend's last honest statement.
  const deployment = sessionSandboxPolicy(ctx, undefined)?.mode
  const mode = typeof deployment === 'string' ? deployment : ctx.get('fs')?.sandboxMode
  return { sandboxMode: typeof mode === 'string' ? mode : undefined, sessionMode: undefined }
}

/**
 * Build the service object registered as `ctx.memory`.
 *
 * @param ctx - plugin context.
 * @param config - the resolved configuration.
 * @param customRoots - the validated `generation.roots` list.
 * @param lifecycle - the plugin's lifetime signal.
 * @param state - live plugin state: `{ pending, lastGeneration, lastConsumption, explicitFiles }`.
 * @returns the service value.
 */
export function createMemoryService(ctx, config, customRoots, lifecycle, state) {
  const generationEnabled = config.generation.enabled !== false
  const turnCompleteEnabled = generationEnabled && config.generation.turnComplete.enabled !== false
  const consumptionEnabled = config.consumption.enabled !== false

  return {
    /** The effective configuration, read back after runtime negotiation. */
    async initializationResult() {
      let roots = []
      try {
        roots = await resolveEffectiveRoots(ctx, config, customRoots, process.cwd(), lifecycle.signal)
      } catch {
        roots = []
      }
      return {
        enabled: config.enabled,
        requester: 'plugin',
        mode: config.mode,
        generationEnabled,
        turnCompleteEnabled,
        consumptionEnabled,
        roots: roots.map((root) => ({ id: root.id, path: root.path, access: root.access })),
        maxTokens: config.consumption.maxTokens,
        overflow: config.consumption.overflow,
        failureMode: config.consumption.failureMode,
        // Declared trust only: the remembered list needs a filesystem read, and
        // this method is the cheap "read back the effective configuration" call.
        trust: { enabled: config.trust.enabled === true, folders: config.trust.folders },
      }
    },

    /** Await every in-flight background generation. */
    async flushMemory() {
      if (state.pending.size === 0) return { flushed: 0 }
      const count = state.pending.size
      await Promise.allSettled([...state.pending])
      return { flushed: count }
    },

    /**
     * Clear a generation pause armed by consecutive failures.
     *
     * The original never resumes — `paused` stays set for the sink's lifetime — but a
     * DSH session outlives that, so this is the one explicit escape hatch. It is wired
     * to the scheduler by `index.js`.
     *
     * @returns `{ resumed }` — how many sessions were unpaused.
     */
    resumeGeneration() {
      const resumed = typeof state.resumeGeneration === 'function' ? state.resumeGeneration() : 0
      return { resumed }
    },

    /**
     * Reload memory files into a session.
     *
     * @param agent - the target agent; defaults to the current initiator.
     * @returns `{ injected, reason?, result? }`.
     */
    async refreshMemory(agent) {
      const target = agent ?? ctx.get('agents')?.currentInitiator?.()
      if (target === undefined) return { injected: false, reason: 'no agent available to refresh' }
      const result = await runConsumption(ctx, config, customRoots, state.explicitFiles, target, lifecycle.signal, (next) => {
        state.lastConsumption = next
      })
      if (!result.injected) return { injected: false, reason: 'nothing to inject', result }
      // A refresh identity is unique, so the message is always admitted even
      // when a previous memory message with the base identity is visible. The
      // hashes ride along so the next step diffs against this load rather than
      // reloading everything.
      target.inject(
        memoryMessage(result.rendered, `${result.identity}#refresh:${randomUUID()}`, {
          form: 'snapshot',
          blockHash: result.blockHash,
          files: memoryBlockHash(result.contents).files,
        }),
      )
      return { injected: true, result }
    },

    /**
     * Latest observed results, for the panel and `/memory`.
     *
     * @param request - `{ session }`: the session the caller is speaking for. It is what
     * makes the sandbox row honest — the harness resolves a policy per call and the
     * backend otherwise reports the deployment default, which is not the session's mode.
     * @returns the live status snapshot.
     */
    status(request = {}) {
      return {
        enabled: config.enabled,
        mode: config.mode,
        generationEnabled,
        turnCompleteEnabled,
        consumptionEnabled,
        dreamEnabled: config.generation.dream?.enabled === true,
        trustEnabled: config.trust.enabled === true,
        trustedFolders: config.trust.folders,
        maxTokens: config.consumption.maxTokens,
        overflow: config.consumption.overflow,
        failureMode: config.consumption.failureMode,
        // The generation-side knobs belong beside the injection budget: a panel section
        // showing half the token story is how a spent budget went unnoticed.
        maxOutputTokens: config.generation.maxOutputTokens,
        pauseAfterFailures: config.generation.pauseAfterFailures,
        // Which sandbox policy memory writes declare, and the modes that follow from it:
        // `memory-root` declares the memory directory as their own workspace, while
        // `session` resolves the calling session's real policy — under which memory is
        // read-only whenever that policy fences writes out of the workspace.
        writePolicy: config.writePolicy,
        ...sandboxModes(ctx, config, request?.session),
        gate:
          typeof config.generation.turnComplete.shouldGenerate === 'function'
            ? {
                kind: 'custom',
                timeoutMs: config.generation.turnComplete.timeoutMs,
                onGateError: config.generation.turnComplete.onGateError,
              }
            : { kind: 'minPromptChars', minPromptChars: config.generation.turnComplete.minPromptChars },
        pendingGenerations: state.pending.size,
        lastGeneration: state.lastGeneration ?? null,
        lastConsumption: state.lastConsumption ?? null,
        lastDream: state.lastDream ?? null,
        // Set while generation is paused by consecutive failures, so the panel and
        // `/memory` can say why memory stopped instead of just showing age.
        generationPause: state.generationPause ?? null,
        // Qoder fires a `memory-changed` event after every load; a plugin cannot
        // add a session event type here, so the same facts are readable instead.
        memoryChange: memoryChangeReport(state.lastConsumption) ?? null,
        // The client half cannot import a Host module, so the threshold travels
        // with the payload instead of being duplicated in the browser bundle.
        largeFileLimit: LARGE_FILE_CHARS,
      }
    },
  }
}
