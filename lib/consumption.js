/**
 * Consumption: load memory files into the Agent context under a token budget.
 *
 * This is one of the two halves of the Qoder memory contract. A pass reads the
 * selected files, applies the shared budget, frames the survivors, and reports a
 * per-file status. Status vocabulary is Qoder's verbatim:
 *
 *   overall      success | partial | failed
 *   per file     loaded | missing | failed | truncated
 *
 * @module @dsh-external/dsh-memory/consumption
 */

import { isAbsolute, join, resolve, basename } from 'node:path'
import { baselineFor, planInjection } from './consumption-plan.js'
import { canonicalizeExcludes, describeExcluded, normalizeExcludes, partitionExcluded } from './excludes.js'
import { listRootFiles, readVersioned } from './fs.js'
import { expandFileImports } from './imports.js'
import { collectTouchedPaths, jitDecision, parseJitTrigger } from './jit.js'
import { parseMemoryFile } from './memory-file.js'
import { resolveEffectiveRoots } from './trust.js'
import {
  hashText,
  memoryBlockHash,
  memoryIdentity,
  renderMemoryContext,
  visibleMemoryState,
} from './render.js'
import { createMeasure } from './tokens.js'

/**
 * The character count above which Qoder calls a memory file "large".
 *
 * Decoded verbatim from the installed `qodercli` (`met = 4e4`), and its own UI
 * says: "Large {path} will impact performance ({chars} chars > {limit})".
 */
export const LARGE_FILE_CHARS = 40000

/**
 * Classify the files whose content is large enough to hurt.
 *
 * Pure, and the same shape Qoder reports: `{ path, characterCount }` sorted by
 * size, descending. `characterCount` is the JS string length, as in the
 * original — not UTF-8 bytes.
 *
 * @param files - read files carrying `path`, `status` and `text`.
 * @param limit - the character ceiling.
 * @returns the large files, largest first.
 */
export function classifyLargeFiles(files, limit = LARGE_FILE_CHARS) {
  return files
    .filter((file) => typeof file.text === 'string' && file.text.length > limit)
    .map((file) => ({ path: file.path, characterCount: file.text.length }))
    .sort((left, right) => right.characterCount - left.characterCount)
}

/**
 * Classify the files that could not be read at all.
 *
 * @param files - read files carrying `path`, `status` and an optional `error`.
 * @returns `{ path, error }` per failure, in consideration order.
 */
export function classifyFailedFiles(files) {
  return files
    .filter((file) => file.status === 'failed' && file.error !== undefined)
    .map((file) => ({ path: file.path, error: String(file.error) }))
}

/**
 * The `memory-changed` payload Qoder emits after a load, minus the session id.
 *
 * Qoder has no in-band way to tell a session that the memory picture changed; it
 * fires an event. A DSH plugin cannot add a session event type (it would block
 * session reopen), so the same facts are exposed through `ctx.memory.status()`
 * and `/memory` instead.
 *
 * @param result - a consumption result.
 * @returns `{ fileCount, largeFiles?, failedFiles?, excludedFiles?, jitSkipped? }`.
 */
export function memoryChangeReport(result) {
  if (result === undefined || result === null) return undefined
  return {
    fileCount: result.fileCount ?? 0,
    ...(Array.isArray(result.largeFiles) && result.largeFiles.length > 0 ? { largeFiles: result.largeFiles } : {}),
    ...(Array.isArray(result.failedFiles) && result.failedFiles.length > 0 ? { failedFiles: result.failedFiles } : {}),
    ...(Array.isArray(result.excludedFiles) && result.excludedFiles.length > 0 ? { excludedFiles: result.excludedFiles } : {}),
    ...(Array.isArray(result.jitSkipped) && result.jitSkipped.length > 0 ? { jitSkipped: result.jitSkipped } : {}),
    // Qoder keeps blocked external imports pending until they are approved.
    ...(Array.isArray(result.blockedExternalImports) && result.blockedExternalImports.length > 0
      ? { pendingExternalImports: result.blockedExternalImports }
      : {}),
    ...(Array.isArray(result.resolvedImportPaths) && result.resolvedImportPaths.length > 0
      ? { resolvedImportPaths: result.resolvedImportPaths }
      : {}),
  }
}

/**
 * Collect the selected memory files with a per-file status.
 *
 * In `custom` mode an explicit `consumption.files` list replaces native auto
 * discovery; otherwise every `*.md` in each root is considered, index first.
 *
 * @returns `{ files, excluded, jitSkipped, imports }`.
 */
async function collectConsumptionFiles(ctx, config, explicitFiles, cwd, roots, signal, options) {
  const fs = ctx.get('fs')
  const selected = []

  if (config.mode === 'custom' && explicitFiles !== undefined && explicitFiles.length > 0) {
    for (const file of explicitFiles) {
      if (file === null || typeof file !== 'object' || typeof file.path !== 'string') continue
      selected.push({
        id: typeof file.id === 'string' && file.id.length > 0 ? file.id : 'memory',
        path: isAbsolute(file.path) ? file.path : resolve(cwd, file.path),
        required: file.required === true,
        // No `rootId`: an explicitly listed file is never excluded by pattern.
      })
    }
  } else {
    for (const root of roots) {
      let names
      try {
        names = await listRootFiles(fs, root, signal)
      } catch (error) {
        // An unreadable root is one failed entry, not a failed pass.
        selected.push({ id: root.id, path: root.path, rootId: root.id, status: 'failed', error })
        continue
      }
      for (const fileName of names) {
        selected.push({ id: `${root.id}:${fileName}`, path: join(root.path, fileName), rootId: root.id })
      }
    }
  }

  // Qoder applies its exclusion patterns to the project/local layers only, so
  // the user scope is never filtered out by a filename pattern.
  const patterns = await canonicalizeExcludes(ctx, normalizeExcludes(config.excludes), signal)
  const { excluded } = partitionExcluded(
    selected.map((entry) => ({ ...entry, absolute: entry.path })),
    patterns,
  )
  if (excluded.length > 0) ctx.logger.info('memory: %s', describeExcluded(excluded))
  const excludedIds = new Set(excluded.map((entry) => entry.id))

  const files = []
  const resolvedImportPaths = []
  const blockedExternalImports = []
  const failedImports = []
  const filesWithExternalImports = []
  const jitSkipped = []
  // What the session has touched drives the glob-triggered files.
  const touched = options.touchedPaths ?? collectTouchedPaths(options.session)
  // The trust gate already removed an untrusted project root, so a missing
  // project root here means exactly "this folder may not contribute files".
  const projectDir = roots.find((candidate) => candidate.id === 'project')?.projectRoot
  for (const entry of selected) {
    if (entry.status === 'failed') {
      files.push({ ...entry, text: '' })
      continue
    }
    if (excludedIds.has(entry.id)) continue
    try {
      const found = await readVersioned(fs, entry.path, options.versions, signal)
      if (found === undefined) {
        files.push({ ...entry, status: 'missing', text: '' })
        continue
      }
      // Just-in-time memory: a file may declare `paths`, and then it loads only
      // when the session touched a match; declaring nothing means `always_on`.
      const trigger = parseJitTrigger(parseMemoryFile(basename(entry.path), found.text).fields)
      const decision = jitDecision(trigger, touched, cwd)
      if (decision.load !== true) {
        jitSkipped.push({ id: entry.id, path: entry.path, reason: decision.reason })
        files.push({ ...entry, status: 'jit_skipped', text: '' })
        continue
      }
      const imports = await expandFileImports(
        ctx,
        config,
        entry,
        roots,
        projectDir,
        found.text,
        signal,
        options.sessionApprovedExternalImports,
      )
      resolvedImportPaths.push(...imports.resolvedImportPaths)
      blockedExternalImports.push(...imports.blockedExternalImports)
      failedImports.push(...imports.failedImports)
      if (imports.blockedExternalImports.length > 0 || imports.failedImports.length > 0) {
        filesWithExternalImports.push(entry.path)
      }
      files.push({
        ...entry,
        status: 'loaded',
        text: imports.text,
        hash: hashText(imports.text),
        bytes: Buffer.byteLength(imports.text, 'utf8'),
        imports: imports.resolvedImportPaths.length > 0 ? imports.resolvedImportPaths : undefined,
      })
    } catch (error) {
      files.push({ ...entry, status: 'failed', text: '', error })
    }
  }
  return {
    files,
    excluded,
    jitSkipped,
    imports: {
      resolvedImportPaths: [...new Set(resolvedImportPaths)],
      blockedExternalImports,
      failedImports,
      filesWithExternalImports,
    },
  }
}

/**
 * Collect the selected memory files with a per-file status.

/**
 * Record one consumption outcome and fire the SDK callback, in that order, so a
 * callback reading `ctx.memory.status()` sees the result it was just handed.
 *
 * @param ctx - plugin context.
 * @param config - the resolved configuration.
 * @param result - the consumption result.
 * @param record - the plugin's own recorder.
 */
export async function publishConsumption(ctx, config, result, record) {
  if (typeof record === 'function') record(result)
  if (typeof config.consumption.onResult !== 'function') return
  // The SDK allows the callback to return a promise; a throw or rejection is
  // recorded as a diagnostic and never fails the query.
  try {
    await config.consumption.onResult(result)
  } catch (error) {
    ctx.logger.warn('memory: consumption onResult threw: %o', error)
  }
}

/**
 * Run one consumption pass: read, budget, frame, report.
 *
 * @param ctx - plugin context.
 * @param config - the resolved configuration.
 * @param customRoots - the validated `generation.roots` list.
 * @param explicitFiles - the validated `consumption.files` list.
 * @param agent - the agent whose session is being prepared.
 * @param signal - cancellation.
 * @param record - called with the result, so the plugin can expose it.
 * @param options - `{ publish }`; `false` makes this a silent probe, which is
 *   what the per-request "did anything change?" check uses. A probe never
 *   records a result or fires `onResult`, because nothing was injected.
 * @returns the SDK-shaped result plus the plugin's own extras (`roots`, `rendered`).
 * @throws when a required file is unreadable and `failureMode` is `fail_query`,
 *   or when the content overflows and `overflow` is `fail_query`.
 */
export async function runConsumption(ctx, config, customRoots, explicitFiles, agent, signal, record, options = {}) {
  const started = Date.now()
  const cwd = agent.session.header?.cwd ?? process.cwd()
  const roots = await resolveEffectiveRoots(ctx, config, customRoots, cwd, signal)
  const { files, excluded, jitSkipped, imports } = await collectConsumptionFiles(
    ctx,
    config,
    explicitFiles,
    cwd,
    roots,
    signal,
    options,
  )

  /** Report one outcome, unless this pass is a silent probe. */
  const publish = async (result) => {
    if (options.publish === false) return
    await publishConsumption(ctx, config, result, record)
  }

  /** Per-file reporting shared by the success and failure paths. */
  const reportFiles = (rendered) => {
    const included = new Set(rendered.included)
    const truncated = new Set(rendered.truncated)
    return files.map((file) => {
      const base = { id: file.id, path: file.path }
      if (file.status !== 'loaded') {
        return file.error === undefined
          ? { ...base, status: file.status }
          : { ...base, status: file.status, error: String(file.error) }
      }
      if (truncated.has(file.id)) return { ...base, status: 'truncated' }
      if (included.has(file.id)) return { ...base, status: 'loaded' }
      return { ...base, status: 'loaded' }
    })
  }

  /**
   * The `memory-changed` facts, derived from the per-file outcome.
   *
   * Qoder's loader returns `{ fileCount, filePaths, largeFiles, failedFiles }`
   * and then emits them as `memory-changed`; a DSH plugin cannot add a session
   * event type, so the same facts ride on the result and `ctx.memory.status()`.
   * `fileCount` counts files whose content was actually read — Qoder counts
   * `content !== null`, and a truncated file still had its content read.
   */
  const changeFields = (reported) => ({
    fileCount: reported.filter((file) => file.status === 'loaded' || file.status === 'truncated').length,
    filePaths: reported.map((file) => file.path),
    largeFiles: classifyLargeFiles(files),
    failedFiles: classifyFailedFiles(files),
    excludedFiles: excluded.map((entry) => entry.path),
    jitSkipped,
    // Qoder's import bookkeeping, aggregated across the pass.
    resolvedImportPaths: imports.resolvedImportPaths,
    blockedExternalImports: imports.blockedExternalImports,
    failedImports: imports.failedImports,
    filesWithExternalImports: imports.filesWithExternalImports,
  })

  /**
   * Report a `failed` pass, then throw. The SDK defines a `failed` consumption
   * status precisely so an aborted pass is still observable; throwing without
   * reporting would leave `status()` and `onResult` silent about it.
   *
   * A failure reports even during a silent probe: "nothing was injected" is a
   * reason to stay quiet, but "this could not be loaded" never is.
   */
  const fail = async (message, rendered) => {
    await publishConsumption(
      ctx,
      config,
      {
        status: 'failed',
        files: reportFiles(rendered ?? { included: [], truncated: [] }),
        injected: false,
        tokens: 0,
        maxTokens: config.consumption.maxTokens,
        omitted: [],
        truncated: [],
        durationMs: Date.now() - started,
        identity: memoryIdentity(config, roots),
        error: message,
        ...changeFields(reportFiles(rendered ?? { included: [], truncated: [] })),
      },
      record,
    )
    throw new Error(message)
  }

  const requiredFailed = files.filter((file) => file.required === true && file.status !== 'loaded')
  if (config.consumption.failureMode === 'fail_query' && requiredFailed.length > 0) {
    await fail(`memory: required memory file could not be read: ${requiredFailed.map((file) => file.path).join(', ')}`)
  }

  const readable = files.filter((file) => file.status === 'loaded' && file.text.trim().length > 0)
  const rendered = renderMemoryContext(readable, config.consumption.maxTokens, createMeasure(ctx))

  if (rendered.overflowed && config.consumption.overflow === 'fail_query') {
    await fail(
      `memory: memory content exceeds maxTokens ${config.consumption.maxTokens} and overflow is "fail_query"`,
      rendered,
    )
  }

  // Re-label the per-file statuses with the budget outcome. The SDK's
  // MemoryConsumptionResult carries `{ id, path, status, error? }` per file.
  const reported = reportFiles(rendered)

  const failedCount = reported.filter((file) => file.status === 'failed').length
  const loadedCount = reported.filter((file) => file.status === 'loaded' || file.status === 'truncated').length
  let status
  if (failedCount === 0) status = 'success'
  else if (loadedCount > 0) status = 'partial'
  else status = 'failed'

  const result = {
    status,
    files: reported,
    // Qoder's loader-shaped change facts (`memory-changed` equivalent).
    ...changeFields(reported),
    // Plugin-side extras, kept alongside the SDK-shaped fields.
    injected: rendered.text !== undefined,
    tokens: rendered.tokens,
    maxTokens: config.consumption.maxTokens,
    omitted: rendered.omitted,
    truncated: rendered.truncated,
    durationMs: Date.now() - started,
    identity: memoryIdentity(config, roots),
    // The block hash, so a caller can tell "the same memory" from "the same
    // configuration" — Qoder tracks exactly this per request.
    blockHash: memoryBlockHash(readable).blockHash,
  }

  await publish(result)
  return { ...result, roots, rendered, contents: readable }
}

/**
 * Compose the injection decision for one agent.
 *
 * Qoder rebuilds the memory block on EVERY request and compares it with the
 * previous one: a file changed mid-session (by this session's own `memory` tool,
 * by the background pass, or by an editor) is therefore visible to the next
 * request without an explicit refresh, and only the change is sent. This is that
 * loop, on the `agent/pre-step` seam.
 *
 * @param state - this session's live consumption state, if any.
 * @param options - `{ sessionApprovedExternalImports }`, Qoder's session grant.
 * @returns `{ identity, desired?, reused?, nextState? }`.
 */
export async function composeConsumption(
  ctx,
  config,
  customRoots,
  explicitFiles,
  agent,
  state,
  signal,
  record,
  options = {},
) {
  const cwd = agent.session.header?.cwd ?? process.cwd()
  const roots = await resolveEffectiveRoots(ctx, config, customRoots, cwd, signal)
  const identity = memoryIdentity(config, roots)

  // What this session has already been shown: live state first, then the durable
  // surface (a resumed process has no live state; the message carries the hashes).
  const durable = state === undefined ? visibleMemoryState(agent.session, identity) : undefined
  const previous = baselineFor(identity, state, durable)

  // A silent probe: nothing is recorded and `onResult` does not fire, because most
  // steps find nothing changed. The version cache is what keeps it cheap.
  const versions = state?.versions ?? new Map()
  const result = await runConsumption(ctx, config, customRoots, explicitFiles, agent, signal, record, {
    publish: false,
    versions,
    sessionApprovedExternalImports: options.sessionApprovedExternalImports === true,
    session: agent.session,
  })
  const plan = planInjection(identity, previous, result, {
    maxTokens: config.consumption.maxTokens,
    measure: createMeasure(ctx),
  })
  const nextState = { ...plan.nextState, versions }

  if (plan.publish) {
    await publishConsumption(ctx, config, result, record)
    if (plan.action === 'snapshot') {
      ctx.logger.info(
        'memory: consumption %s in %dms — loaded %s%s (%d tokens of %d)',
        result.status,
        result.durationMs,
        result.files.filter((file) => file.status === 'loaded').map((file) => file.id).join(', ') || '(none)',
        result.omitted.length > 0 ? `; omitted ${result.omitted.join(', ')}` : '',
        result.tokens,
        result.maxTokens,
      )
    } else {
      ctx.logger.info(
        'memory: memory changed — %d note(s) updated, %d removed (%d tokens)',
        plan.delta.changed.length,
        plan.delta.removed.length,
        plan.tokens ?? result.tokens,
      )
    }
  }
  return { identity, desired: plan.desired, action: plan.action, nextState, reused: plan.reused === true }
}
