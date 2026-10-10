/**
 * Human-facing slash commands.
 *
 * `/memory` reports the effective configuration and recorded files;
 * `/memory-refresh` reloads memory into the current session (the manual
 * counterpart of session-start consumption); `/memory-flush` waits for
 * in-flight background generation, which CI and tests need before exiting.
 *
 * @module @dsh-external/dsh-memory/commands
 */

import { randomUUID } from 'node:crypto'
import { describeProject, describeTrust, GLOBAL_CONSEQUENCE, MODE_CONSEQUENCE } from './commands-report.js'
import { LARGE_FILE_CHARS, memoryChangeReport } from './consumption.js'
import { listRootFiles, memoryGuard } from './fs.js'
import { DELETE_INDEX_NOTE } from './memory-agent.js'
import { applyOneDelete } from './memory-pass.js'
import { resolveDshHome, resolveProjectIdentity } from './paths.js'
import {
  forgetTrustedFolder,
  rememberTrustedFolder,
  resolveEffectiveRoots,
  trustState,
  trustStorePath,
} from './trust.js'
import { memoryBlockHash, memoryMessage } from './render.js'
import { scopedConfig } from './memory-switch.js'
import { runConsumption } from './consumption.js'
import { writeConfig } from './config-write.js'
import { CONSUMPTION_MIN_TOKENS } from './constants.js'

/**
 * How to change the global scopes when this composition has no `configEditor`.
 *
 * @param ctx - plugin context.
 * @returns one line naming the config fields, or a note that they are writable here.
 */
function scopeConfigHint(ctx) {
  return typeof ctx.get('configEditor')?.edit === 'function'
    ? 'change these here: /memory-scope all | project | user'
    : 'set userScope / projectScope in the plugin configuration (no configEditor in this composition)'
}

/**
 * Render the `memory-changed` facts of the last load.
 *
 * Stays here rather than in `commands-report.js` because it reads `memoryChangeReport` from
 * `consumption.js`: keeping it beside the one caller that needs it leaves that module import-free,
 * which is what lets it sit below `commands.js` in the layering.
 *
 * @param result - a consumption result.
 * @returns the lines to report.
 */
function describeMemoryChangeOf(result) {
  const change = memoryChangeReport(result)
  if (change === undefined) return []
  const lines = [
    `memory change: files=${change.fileCount} large=${change.largeFiles?.length ?? 0} failed=${
      change.failedFiles?.length ?? 0
    } excluded=${change.excludedFiles?.length ?? 0} imports=${change.resolvedImportPaths?.length ?? 0} blocked=${
      change.pendingExternalImports?.length ?? 0
    }`,
  ]
  for (const file of change.largeFiles ?? []) {
    lines.push(`  large: ${file.path} (${file.characterCount} chars > ${LARGE_FILE_CHARS})`)
  }
  for (const file of change.failedFiles ?? []) lines.push(`  failed: ${file.path}: ${file.error}`)
  for (const path of change.excludedFiles ?? []) lines.push(`  excluded: ${path}`)
  for (const path of change.resolvedImportPaths ?? []) lines.push(`  imported: ${path}`)
  for (const entry of change.pendingExternalImports ?? []) {
    lines.push(`  import blocked: ${entry.importPath} → ${entry.resolvedPath}`)
  }
  return lines
}

/**
 * Register the memory commands.
 *
 * @param ctx - plugin context (must expose `commands`).
 * @param config - the resolved configuration.
 * @param customRoots - the validated `generation.roots` list.
 * @param lifecycle - the plugin's lifetime signal.
 * @param state - live plugin state: `{ pending, lastGeneration, lastConsumption, generationPause }`.
 * @param memorySwitch - the per-session switch, so `/memory-switch` and `/memory`
 *   can report and change it.
 */
export function registerCommands(ctx, config, customRoots, lifecycle, state, memorySwitch) {
  const { pending } = state

  ctx.commands.register({
    name: 'memory',
    description: 'Show memory configuration, scopes, recorded files, and the latest results.',
    async handler({ agent }) {
      const cwd = agent.session.header?.cwd ?? process.cwd()
      const roots = await resolveEffectiveRoots(ctx, config, customRoots, cwd, lifecycle.signal)
      const generationEnabled = config.generation.enabled !== false
      const turnCompleteEnabled = generationEnabled && config.generation.turnComplete.enabled !== false
      const lines = [
        `memory: mode=${config.mode} enabled=${config.enabled} generation=${generationEnabled} turnComplete=${turnCompleteEnabled} consumption=${config.consumption.enabled !== false}`,
        `budget: maxTokens=${config.consumption.maxTokens} overflow=${config.consumption.overflow} failureMode=${config.consumption.failureMode}`,
        `gate: ${
          typeof config.generation.turnComplete.shouldGenerate === 'function'
            ? `custom shouldGenerate (timeout ${config.generation.turnComplete.timeoutMs}ms, onGateError=${config.generation.turnComplete.onGateError})`
            : `minPromptChars=${config.generation.turnComplete.minPromptChars}`
        }`,
        ...describeTrust(await trustState(ctx, config, customRoots, cwd, lifecycle.signal)),
        ...describeProject(await resolveProjectIdentity(ctx, cwd, config.projectRootMarkers, lifecycle.signal)),
      ]
      for (const root of roots) {
        try {
          const names = await listRootFiles(ctx.get('fs'), root, lifecycle.signal)
          lines.push(
            `- ${root.id} (${root.access}): ${root.path}${names.length === 0 ? ' (no files)' : ` → ${names.join(', ')}`}`,
          )
        } catch (error) {
          lines.push(`- ${root.id}: ${root.path} (unreadable: ${error instanceof Error ? error.message : String(error)})`)
        }
      }
      lines.push(`pending generations: ${pending.size}`)
      // The session state, stated before the results below: when it is not `auto`, every other
      // line on this report may be describing a scope the session does not use, and saying so
      // is the difference between "memory is broken" and "memory is scoped here".
      const sessionMode = await memorySwitch?.mode?.(agent.session) ?? 'auto'
      lines.push(`session memory: ${sessionMode} — ${MODE_CONSEQUENCE[sessionMode]}`)
      // Memory lives outside every session workspace, so WHICH policy its writes declare
      // decides whether memory is writable at all under the sandbox.
      const status = ctx.get('memory')?.status?.({ session: agent.session })
      // Both facts, never one number: `memory-root` keeps writing while a fenced session is
      // in force, and that is exactly the case a single mode reading would hide.
      const readOnly =
        config.writePolicy === 'session' &&
        status?.sandboxMode !== undefined &&
        status.sandboxMode !== 'danger-full-access'
      const sessionDiffers = status?.sessionMode !== undefined && status.sessionMode !== status.sandboxMode
      lines.push(
        `write policy: ${config.writePolicy}${status?.sandboxMode === undefined ? '' : ` (${status.sandboxMode})`}${
          readOnly
            ? ` — memory is READ-ONLY under this session's sandbox (${status.sandboxMode}); set writePolicy: memory-root to let the plugin write its own storage`
            : sessionDiffers
              ? ` — writes use the memory root; the session's own policy is ${status.sessionMode}`
              : ''
        }`,
      )
      // A pause is the answer to "why did memory stop?"; without it the only clue is
      // that no new result ever appears.
      if (state.generationPause !== undefined) {
        lines.push(
          `generation PAUSED after ${state.generationPause.failures} consecutive failures — ${state.generationPause.reason} (run /memory-resume to clear)`,
        )
      }
      if (state.lastGeneration !== undefined) {
        lines.push(
          `last generation: ${state.lastGeneration.status} (turn ${state.lastGeneration.turnIndex})${
            state.lastGeneration.reason ? ` — ${state.lastGeneration.reason}` : ''
          }`,
        )
        // Index limits are advisory (the prompt teaches them); report, never refuse.
        for (const file of state.lastGeneration.writtenFiles ?? []) {
          for (const warning of file.warnings ?? []) {
            lines.push(`index warning: ${file.rootId}:${file.path} — ${warning.message}`)
          }
        }
        // The per-pass budget is enforced and taught, so a write it stopped is reported as
        // deferred — never as a refusal, which is what made a finished pass look broken.
        for (const file of state.lastGeneration.deferredFiles ?? []) {
          lines.push(`deferred: ${file.rootId}:${file.path} — ${file.error}`)
        }
      }
      if (state.lastConsumption !== undefined) {
        lines.push(
          `last consumption: ${state.lastConsumption.status} — ${
            state.lastConsumption.files.map((file) => `${file.id}=${file.status}`).join(', ') || '(no files)'
          }`,
        )
        lines.push(...describeMemoryChangeOf(state.lastConsumption))
      }
      return { kind: 'success', text: lines.join('\n') }
    },
  })

  ctx.commands.register({
    name: 'memory-scope',
    description: 'Read or set the GLOBAL scopes every `auto` session follows: all | project | user.',
    input: { hint: '[status|all|project|user]' },
    async handler({ rawInput }) {
      const action = String(rawInput ?? '').trim().toLowerCase() || 'status'
      if (!['status', 'all', 'project', 'user'].includes(action)) {
        return { kind: 'error', text: `memory-scope: unknown action "${action}" — use status, all, project or user` }
      }
      const current = config.userScope === false ? 'project' : config.projectScope === false ? 'user' : 'all'
      if (action === 'status') {
        return { kind: 'success', text: `global memory scopes: ${current}\n${GLOBAL_CONSEQUENCE[current]}\n${scopeConfigHint(ctx)}` }
      }
      // The write goes through the shared `config-write`, the one sanctioned path (validates,
      // persists, reconciles through the Loader). A composition without a writer gets a reason
      // rather than a silent no-op.
      const written = await writeConfig(ctx, { userScope: action !== 'project', projectScope: action !== 'user' })
      if (written.ok !== true) return { kind: 'error', text: `memory-scope: ${written.reason}` }
      return { kind: 'success', text: `global memory scopes: ${action} (written to the plugin configuration)\n${GLOBAL_CONSEQUENCE[action]}` }
    },
  })

  ctx.commands.register({
    name: 'memory-budget',
    description: 'Read or set the INJECTION token cap (`consumption.maxTokens`).',
    input: { hint: '[status|<tokens>]' },
    async handler({ rawInput }) {
      const action = String(rawInput ?? '').trim().toLowerCase() || 'status'
      if (action === 'status') {
        // The label must not claim "0 = inject nothing": the schema and the SDK both require a
        // positive integer, so 0 is rejected before it can reach the renderer that would honour it.
        return {
          kind: 'success',
          text: `injection cap: ${config.consumption.maxTokens} tokens\n${scopeConfigHint(ctx)}\nto inject nothing, set consumption.enabled to false`,
        }
      }
      const tokens = /^\d+$/.test(action) ? Number(action) : Number.NaN
      if (!Number.isInteger(tokens) || tokens < CONSUMPTION_MIN_TOKENS) {
        return { kind: 'error', text: `memory-budget: "${action}" is not a token count — give a positive whole number of tokens` }
      }
      const written = await writeConfig(ctx, { consumption: { maxTokens: tokens } })
      if (written.ok !== true) return { kind: 'error', text: `memory-budget: ${written.reason}` }
      return { kind: 'success', text: `injection cap: ${tokens} tokens (written to the plugin configuration)` }
    },
  })

  ctx.commands.register({
    name: 'memory-switch',
    description: 'Set memory for THIS session: auto (follow the configuration) | project (project memory only) | off.',
    input: { hint: '[auto|project|off|status]' },
    async handler({ agent, rawInput }) {
      const action = String(rawInput ?? '').trim().toLowerCase() || 'status'
      if (!['status', 'auto', 'project', 'off'].includes(action)) {
        return { kind: 'error', text: `memory-switch: unknown action "${action}" — use status, auto, project or off` }
      }
      if (memorySwitch === undefined) return { kind: 'error', text: 'memory-switch: this build has no session switch' }
      const session = agent?.session
      if (session === undefined) return { kind: 'error', text: 'memory-switch: a session is required' }
      const result =
        action === 'status'
          ? { mode: await memorySwitch.mode(session), changed: false, persisted: true }
          : await memorySwitch.setMode(session, action)
      const lines = [`session memory: ${result.mode} (session ${session.id})`]
      if (action !== 'status') {
        lines.push(result.persisted ? 'remembered across restarts' : 'NOT persisted — the decision holds for this process only')
      }
      lines.push(MODE_CONSEQUENCE[result.mode])
      // Leaving `off` does not re-inject by itself: the next step finds an unchanged block and
      // stays silent, which is correct but looks like nothing happened. Say so, and name the
      // command that forces a load.
      if (action !== 'status' && result.changed && result.mode !== 'off') {
        lines.push('the next step reloads memory; /memory-refresh forces it now')
      }
      return { kind: 'success', text: lines.join('\n') }
    },
  })

  ctx.commands.register({
    name: 'memory-trust',
    description: 'Show, grant or revoke the folder trust that gates project-scope memory.',
    input: { hint: '[allow|deny|list] [folder]' },
    async handler({ agent, rawInput, signal }) {
      const cwd = agent.session.header?.cwd ?? process.cwd()
      const tokens = String(rawInput ?? '')
        .trim()
        .split(/\s+/)
        .filter((token) => token.length > 0)
      const action = (tokens[0] ?? 'status').toLowerCase()
      const named = tokens.slice(1).join(' ')
      const before = await trustState(ctx, config, customRoots, cwd, signal)
      const folder = named.length > 0 ? named : before.folder ?? cwd

      // The trust store lives under `$DSH_HOME`, outside every workspace: it declares the
      // same per-call sandbox policy as memory (see `writePolicy`).
      const trustPolicy = memoryGuard(ctx, config, agent.session, resolveDshHome()).policy
      if (['allow', 'trust', 'yes'].includes(action)) {
        await rememberTrustedFolder(ctx, folder, signal, trustPolicy)
      } else if (['deny', 'forget', 'no'].includes(action)) {
        await forgetTrustedFolder(ctx, folder, signal, trustPolicy)
      } else if (!['status', 'list', 'show'].includes(action)) {
        return {
          kind: 'error',
          text: `memory-trust: unknown action "${action}" — use status, list, allow [folder] or deny [folder]`,
        }
      }

      const after = await trustState(ctx, config, customRoots, cwd, signal)
      return {
        kind: 'success',
        text: [...describeTrust(after), `remembered: ${trustStorePath()}`].join('\n'),
      }
    },
  })

  /**
   * Reload memory into a session, the manual counterpart of session-start
   * consumption. `/memory-refresh` and a session-scoped grant both need it.
   */
  const reload = async (agent) => {
    // Both callers below load memory on request, so both obey the session switch. The
    // refusal NAMES the switch: "/memory-refresh did nothing" with no reason is exactly
    // the unactionable report this plugin avoids.
    const mode = await memorySwitch?.mode?.(agent.session) ?? 'auto'
    if (mode === 'off') {
      return { injected: false, switchedOff: true, reason: 'memory is switched off for this session (turn it back on in the composer)' }
    }
    const result = await runConsumption(
      ctx,
      scopedConfig(config, mode),
      customRoots,
      state.explicitFiles,
      agent,
      lifecycle.signal,
      (next) => {
        state.lastConsumption = next
      },
      { sessionApprovedExternalImports: state.importApprovals?.has(agent.session) === true },
    )
    if (!result.injected) return { result, injected: false }
    // A refresh identity is unique, so the message is always admitted even when a
    // previous memory message with the base identity is visible. The hashes ride
    // along so the next step diffs against this load.
    agent.inject(
      memoryMessage(result.rendered, `${result.identity}#refresh:${randomUUID()}`, {
        form: 'snapshot',
        blockHash: result.blockHash,
        files: memoryBlockHash(result.contents).files,
      }),
    )
    return { result, injected: true }
  }

  ctx.commands.register({
    name: 'memory-imports',
    description: 'Show, approve or revoke external @import expansion for THIS session.',
    input: { hint: '[status|allow|deny]' },
    async handler({ agent, rawInput }) {
      const action = String(rawInput ?? '').trim().toLowerCase() || 'status'
      if (!['status', 'allow', 'deny'].includes(action)) {
        return { kind: 'error', text: `memory-imports: unknown action "${action}" — use status, allow or deny` }
      }
      const approved = state.importApprovals
      if (action !== 'status') {
        if (approved === undefined) return { kind: 'error', text: 'memory-imports: this build has no session grants' }
        if (action === 'allow') approved.add(agent.session)
        else approved.delete(agent.session)
      }
      const session = approved?.has(agent.session) === true
      const lines = [
        `session external imports: ${session ? 'approved' : 'not approved'}`,
        `configuration: allowExternal=${config.imports.allowExternal} approvedProjects=${
          config.imports.approvedProjects.join(', ') || '(none)'
        }`,
      ]
      if (action === 'allow') {
        // Qoder's `refreshExternalImports()` re-resolves what was pending; the
        // closest equivalent is a reload, which is what actually injects them.
        const { result, injected, switchedOff, reason } = await reload(agent)
        if (switchedOff === true) {
          lines.push(`reload skipped: ${reason}`)
        } else {
          const blocked = result.blockedExternalImports.length
          lines.push(
            injected
              ? `reloaded ${result.status}: ${result.resolvedImportPaths.length} import(s) resolved, ${blocked} still blocked`
              : `nothing to reload (${result.status})`,
          )
        }
      } else if (session) {
        lines.push('the next step reloads with the grant in effect; withheld imports stay blocked')
      }
      return { kind: 'success', text: lines.join('\n') }
    },
  })

  ctx.commands.register({
    name: 'memory-delete',
    description: 'Delete one memory file: /memory-delete <scope>:<path>.',
    input: { hint: '<scope>:<path>' },
    async handler({ agent, rawInput, signal }) {
      const spec = String(rawInput ?? '').trim()
      const at = spec.indexOf(':')
      if (at <= 0 || at === spec.length - 1) {
        return { kind: 'error', text: 'memory-delete: use <scope>:<path>, for example user:notes.md' }
      }
      const cwd = agent.session.header?.cwd ?? process.cwd()
      const roots = await resolveEffectiveRoots(ctx, config, customRoots, cwd, signal ?? lifecycle.signal)
      const rootById = new Map(roots.map((root) => [root.id, root]))
      const outcome = await applyOneDelete(
        ctx,
        config,
        rootById,
        { rootId: spec.slice(0, at).trim(), path: spec.slice(at + 1).trim() },
        signal ?? lifecycle.signal,
        agent.session,
      )
      if (outcome.error !== undefined) return { kind: 'error', text: `memory-delete: ${outcome.error}` }
      return {
        kind: 'success',
        text: `memory: deleted ${outcome.file.rootId}:${outcome.file.path}\n${DELETE_INDEX_NOTE}`,
      }
    },
  })

  ctx.commands.register({
    name: 'memory-refresh',
    description: 'Reload memory files into this session, picking up external edits.',
    async handler({ agent }) {
      try {
        const { result, injected, switchedOff, reason } = await reload(agent)
        // A muted session is reported for what it is, not as "nothing to inject": the
        // two have different fixes, and only one of them is a bug.
        if (switchedOff === true) return { kind: 'success', text: `memory: ${reason}` }
        if (!injected) {
          return { kind: 'success', text: `memory: refreshed (${result.status}) — nothing to inject` }
        }
        return {
          kind: 'success',
          text: `memory: refreshed ${result.status} — loaded ${
            result.files
              .filter((file) => file.status === 'loaded')
              .map((file) => file.id)
              .join(', ')
          } (${result.tokens} tokens)`,
        }
      } catch (error) {
        return { kind: 'error', text: `memory: refresh failed: ${error instanceof Error ? error.message : String(error)}` }
      }
    },
  })

  ctx.commands.register({
    name: 'memory-flush',
    description: 'Wait for in-flight background memory generation to finish.',
    async handler() {
      if (pending.size === 0) return { kind: 'success', text: 'memory: no generation in flight' }
      const count = pending.size
      await Promise.allSettled([...pending])
      return { kind: 'success', text: `memory: flushed ${count} generation(s)` }
    },
  })

  ctx.commands.register({
    name: 'memory-resume',
    description: 'Clear a generation pause armed by consecutive failures.',
    async handler() {
      // The original never resumes — `paused` stays set for its sink's lifetime — so
      // without this a transient outage would keep memory silent until a host restart.
      const pause = state.generationPause
      const { resumed } = await ctx.memory.resumeGeneration()
      if (resumed === 0 && pause === undefined) return { kind: 'success', text: 'memory: generation was not paused' }
      const reason = pause === undefined ? '' : ` (was: ${pause.failures} failures — ${pause.reason})`
      return { kind: 'success', text: `memory: generation resumed${reason}` }
    },
  })
}
