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
import { resolveEffectiveRoots } from './trust.js'
import { memoryBlockHash, memoryMessage } from './render.js'

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

    /** Latest observed results, for the panel and `/memory`. */
    status() {
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
