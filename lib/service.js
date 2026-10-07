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
import { baselineFor, planInjection, plannedText, readConsumptionState } from './consumption-plan.js'
import { sessionSandboxPolicy } from './fs.js'
import { scopedConfig } from './memory-switch.js'
import { resolveEffectiveRoots } from './trust.js'
import { memoryBlockHash, memoryIdentity, memoryMessage, visibleMemoryState } from './render.js'
import { createMeasure } from './tokens.js'

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
 * The mode one session runs under, or `auto` when this build has no switch.
 *
 * Awaiting the read is what makes the answer trustworthy: the durable store may not have
 * been read yet on the first request after a restart, and an override read too late would
 * look like a session that follows the configuration.
 *
 * @param memorySwitch - the switch, when this build has one.
 * @param session - the session to ask about.
 * @returns `'auto' | 'project' | 'off'`.
 */
async function sessionModeOf(memorySwitch, session) {
  if (memorySwitch === undefined || memorySwitch === null) return 'auto'
  return memorySwitch.mode(session)
}

/**
 * Build the service object registered as `ctx.memory`.
 *
 * @param ctx - plugin context.
 * @param config - the resolved configuration.
 * @param customRoots - the validated `generation.roots` list.
 * @param lifecycle - the plugin's lifetime signal.
 * @param state - live plugin state: `{ pending, lastGeneration, lastConsumption, explicitFiles }`.
 * @param memorySwitch - the per-session switch, so a muted session's deliberate
 *   reloads report WHY they did nothing instead of appearing broken.
 * @returns the service value.
 */
export function createMemoryService(ctx, config, customRoots, lifecycle, state, memorySwitch) {
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
     * Describe what would be injected, without injecting anything.
     *
     * The panel needs to answer "did my note actually make it into the context?",
     * and the only honest answer comes from running the real consumption pass and
     * then THROWING AWAY the result. Four things make that safe, and each one is
     * deliberate:
     *
     *   - `publish: false` — nothing is recorded and `consumption.onResult` never
     *     fires. A preview must not look like a load to the rest of the system.
     *   - a throwaway version cache — the live one belongs to the real per-step
     *     projection; this call may not warm or invalidate it.
     *   - the session's live baseline is READ, never advanced. Advancing it would
     *     change the very behaviour being described: the next real step would then
     *     find "nothing changed" and inject nothing, because the preview consumed
     *     the change. That is the bug this method exists to avoid.
     *   - `planInjection` decides, exactly as the real step does, so the verdict
     *     shown here is the verdict that will be applied.
     *
     * @param agent - the session to speak for; defaults to the current initiator.
     * @returns the step verdict, the full-block snapshot, its budget accounting, and
     *   the per-file status — or `{ available: false, reason }`.
     */
    async previewMemory(agent) {
      const target = agent ?? ctx.get('agents')?.currentInitiator?.()
      if (target === undefined) {
        return { available: false, reason: 'no session is in scope: a preview has to speak for one' }
      }
      if (!consumptionEnabled) return { available: false, reason: 'consumption is disabled' }
      const mode = await sessionModeOf(memorySwitch, target.session)
      if (mode === 'off') {
        // A muted session's next step injects nothing, so the honest preview is that
        // verdict — running the pass would describe a step that will not happen.
        return { available: true, mode, switchedOff: true, step: { action: 'silent', reason: 'memory is switched off for this session' } }
      }
      // The session's scope choice narrows the roots the preview resolves, so what it
      // describes is what the next step would really do.
      const sessionConfig = scopedConfig(config, mode)
      const session = target.session
      const cwd = session?.header?.cwd ?? process.cwd()
      const roots = await resolveEffectiveRoots(ctx, sessionConfig, customRoots, cwd, lifecycle.signal)
      const identity = memoryIdentity(sessionConfig, roots)
      const previous = baselineFor(identity, readConsumptionState(session), visibleMemoryState(session, identity))
      const result = await runConsumption(ctx, sessionConfig, customRoots, state.explicitFiles, target, lifecycle.signal, undefined, {
        publish: false,
        versions: new Map(),
        sessionApprovedExternalImports: state.importApprovals?.has(session) === true,
        session,
      })
      const plan = planInjection(identity, previous, result, {
        maxTokens: sessionConfig.consumption.maxTokens,
        measure: createMeasure(ctx),
      })
      return {
        available: true,
        mode,
        session: { id: session?.id, cwd },
        identity,
        // What the NEXT step would send, decided by the same function that decides it.
        step: {
          action: plan.action,
          reason: plan.reason,
          tokens: plan.tokens ?? 0,
          text: plannedText(plan),
          changed: (plan.delta?.changed ?? []).map((file) => file.id),
          removed: plan.delta?.removed ?? [],
        },
        // What a session with no baseline at all would receive: the whole budgeted block.
        snapshot: {
          text: result.rendered.text,
          status: result.status,
          tokens: result.tokens,
          maxTokens: result.maxTokens,
          included: result.rendered.included,
          omitted: result.rendered.omitted,
          truncated: result.rendered.truncated,
          overflowed: result.rendered.overflowed === true,
        },
        files: result.files.map((file) => ({ id: file.id, path: file.path, status: file.status })),
        memoryChange: memoryChangeReport(result) ?? null,
        largeFileLimit: LARGE_FILE_CHARS,
      }
    },

    /**
     * Set one session's memory mode — the composer control, the panel and `/memory-switch`.
     *
     * Both halves follow the one decision, so there is nothing to coordinate here: the seam,
     * the generation trigger and the tool each consult the switch when they run.
     *
     * @param session - the live session to switch; a session is required, because a switch
     *   with no session would mean "everywhere", which is what `enabled`/the scope flags in
     *   the configuration are for.
     * @param mode - `'auto' | 'project' | 'off'`.
     * @returns `{ mode, changed, persisted, session }`.
     */
    async setMemorySwitch(session, mode) {
      if (memorySwitch === undefined || memorySwitch === null) {
        return { mode: 'auto', changed: false, persisted: false, error: 'this build has no session switch' }
      }
      if (session === undefined || session === null) {
        return { mode: 'auto', changed: false, persisted: false, error: 'a session is required: use /memory-switch in one' }
      }
      const result = await memorySwitch.setMode(session, mode)
      return { ...result, session: session.id }
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
      // A deliberate reload obeys the switch. It is not silently ignored: the caller
      // is told the session is muted and how to lift it, because "refresh did nothing"
      // with no reason is exactly the unactionable report this plugin avoids.
      const mode = await sessionModeOf(memorySwitch, target.session)
      if (mode === 'off') {
        return { injected: false, reason: 'memory is switched off for this session (turn it back on in the composer)', switchedOff: true }
      }
      // A `project`-scoped reload reads the session's own roots, not the global set.
      const sessionConfig = scopedConfig(config, mode)
      const result = await runConsumption(ctx, sessionConfig, customRoots, state.explicitFiles, target, lifecycle.signal, (next) => {
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
        // The session switch's AVAILABILITY. The session's own mode is deliberately NOT
        // reported here: this method is synchronous, and the mode lives behind an async store
        // read, so answering here would be reporting a value that may not have been read yet.
        // The route awaits `ready()` and adds the mode to this same payload.
        switchEnabled: memorySwitch !== undefined,
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
