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
import { LARGE_FILE_CHARS, memoryChangeReport } from './consumption.js'
import { listRootFiles } from './fs.js'
import { DELETE_INDEX_NOTE } from './memory-agent.js'
import { applyOneDelete } from './memory-pass.js'
import { resolveProjectIdentity } from './paths.js'
import {
  forgetTrustedFolder,
  rememberTrustedFolder,
  resolveEffectiveRoots,
  trustState,
  trustStorePath,
} from './trust.js'
import { memoryBlockHash, memoryMessage } from './render.js'
import { runConsumption } from './consumption.js'

/**
 * Render one trust snapshot as a single line, plus the consequence when the gate
 * is on and this folder is not trusted.
 *
 * @param trust - a `trustState()` snapshot.
 * @returns the lines to report.
 */
export function describeTrust(trust) {
  if (!trust.enabled) {
    return ['trust: disabled (every folder is trusted; set trust.enabled to gate project memory)']
  }
  const folders = trust.folders.length > 0 ? trust.folders.join(', ') : '(none)'
  return [
    `trust: enabled trusted=${trust.trusted} folder=${trust.folder}`,
    `trusted folders: ${folders}`,
    ...(trust.trusted ? [] : ['project scope is skipped here: run `/memory-trust allow` to trust this folder']),
  ]
}

/**
 * Render the `memory-changed` facts of the last load.
 *
 * Qoder emits them as an event and surfaces the same content as high-priority
 * warnings in its own UI; here `/memory` states them, because a memory file that
 * is too large, unreadable or excluded is exactly what an operator needs to see.
 *
 * @param result - a consumption result.
 * @returns the lines to report.
 */
export function describeMemoryChange(result) {
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
  for (const file of change.failedFiles ?? []) {
    lines.push(`  failed: ${file.path}: ${file.error}`)
  }
  for (const path of change.excludedFiles ?? []) {
    lines.push(`  excluded: ${path}`)
  }
  for (const path of change.resolvedImportPaths ?? []) {
    lines.push(`  imported: ${path}`)
  }
  for (const entry of change.pendingExternalImports ?? []) {
    lines.push(`  import blocked: ${entry.importPath} → ${entry.resolvedPath}`)
  }
  return lines
}

/**
 * Render the project identity memory is scoped to.
 *
 * Both halves are worth showing: the directory the harness would group this
 * session under, and the workspace record when the registry knows one — that id
 * is the harness's stable anchor, while the path is what the key is built from.
 *
 * @param identity - a `resolveProjectIdentity()` result.
 * @returns the lines to report.
 */
export function describeProject(identity) {
  return [
    `project: ${identity.path} (key ${identity.key}, workspace ${identity.workspaceId ?? 'none'})`,
  ]
}

/**
 * Register the four memory commands.
 *
 * @param ctx - plugin context (must expose `commands`).
 * @param config - the resolved configuration.
 * @param customRoots - the validated `generation.roots` list.
 * @param lifecycle - the plugin's lifetime signal.
 * @param state - live plugin state: `{ pending, lastGeneration, lastConsumption }`.
 */
export function registerCommands(ctx, config, customRoots, lifecycle, state) {
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
      if (state.lastGeneration !== undefined) {
        lines.push(`last generation: ${state.lastGeneration.status} (turn ${state.lastGeneration.turnIndex})`)
        // Index limits are advisory (the prompt teaches them); report, never refuse.
        for (const file of state.lastGeneration.writtenFiles ?? []) {
          for (const warning of file.warnings ?? []) {
            lines.push(`index warning: ${file.rootId}:${file.path} — ${warning.message}`)
          }
        }
      }
      if (state.lastConsumption !== undefined) {
        lines.push(
          `last consumption: ${state.lastConsumption.status} — ${
            state.lastConsumption.files.map((file) => `${file.id}=${file.status}`).join(', ') || '(no files)'
          }`,
        )
        lines.push(...describeMemoryChange(state.lastConsumption))
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

      if (['allow', 'trust', 'yes'].includes(action)) {
        await rememberTrustedFolder(ctx, folder, signal)
      } else if (['deny', 'forget', 'no'].includes(action)) {
        await forgetTrustedFolder(ctx, folder, signal)
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
    const result = await runConsumption(
      ctx,
      config,
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
        const { result, injected } = await reload(agent)
        const blocked = result.blockedExternalImports.length
        lines.push(
          injected
            ? `reloaded ${result.status}: ${result.resolvedImportPaths.length} import(s) resolved, ${blocked} still blocked`
            : `nothing to reload (${result.status})`,
        )
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
        const { result, injected } = await reload(agent)
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
}
