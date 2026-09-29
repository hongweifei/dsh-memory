/**
 * Shared machinery for one memory pass.
 *
 * Both the per-turn generation pass and the dream (consolidation) pass make one
 * auxiliary model call and apply a JSON write plan under the same root
 * allow-list and the same size limits, so that machinery lives here rather than
 * being duplicated by each pass. This module sits below both of them.
 *
 * @module @dsh-external/dsh-memory/memory-pass
 */

import { deleteGuarded, readIfPresent, writeGuarded } from './fs.js'
import { indexWarnings } from './memory-file.js'
import { joinRoot, safeRelativePath } from './paths.js'

/**
 * Parse the model's JSON write plan, tolerating a fenced code block.
 *
 * @param text - the model's raw output.
 * @returns `{ writes, reason }`.
 * @throws when no JSON object is present.
 */
export function parsePlan(text) {
  const trimmed = String(text ?? '').trim()
  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  if (start === -1 || end <= start) throw new Error('generation produced no JSON object')
  const parsed = JSON.parse(trimmed.slice(start, end + 1))
  return {
    writes: Array.isArray(parsed.writes) ? parsed.writes : [],
    reason: typeof parsed.reason === 'string' ? parsed.reason : '',
  }
}

/**
 * Pick the model route: explicit config, then the session header, then the
 * harness default.
 *
 * @param ctx - plugin context.
 * @param config - the resolved configuration.
 * @param session - the session whose header records the last route.
 * @returns `{ provider, model, reasoningEffort?, sessionId? }`.
 * @throws when no route can be resolved.
 */
export function resolveRoute(ctx, config, session) {
  if (config.generation.provider.length > 0 && config.generation.model.length > 0) {
    return { provider: config.generation.provider, model: config.generation.model }
  }
  const headerConfig = session.requestHeader?.()?.config
  if (typeof headerConfig?.provider === 'string' && typeof headerConfig?.model === 'string') {
    return {
      provider: headerConfig.provider,
      model: headerConfig.model,
      reasoningEffort: headerConfig.reasoningEffort,
      sessionId: session.id,
    }
  }
  const fallback = ctx.get('agentDefaultModel')?.currentSelection?.()
  if (fallback !== undefined && typeof fallback.provider === 'string' && typeof fallback.model === 'string') {
    return {
      provider: fallback.provider,
      model: fallback.model,
      reasoningEffort: fallback.reasoningEffort,
      sessionId: session.id,
    }
  }
  throw new Error('memory: no model route available; set generation.provider and generation.model')
}

/**
 * One auxiliary model call.
 *
 * @param ctx - plugin context.
 * @param config - the resolved configuration.
 * @param route - the resolved model route.
 * @param system - the system instruction.
 * @param userText - the framed turn transcript and existing memory.
 * @param signal - cancellation.
 * @returns the assistant's text.
 * @throws when the call fails or finishes abnormally.
 */
export async function callMemoryModel(ctx, config, route, system, userText, signal) {
  const llm = ctx.get('llm')
  if (llm === undefined) throw new Error('the llm service is unavailable')
  let text = ''
  let finish
  const options = {
    provider: route.provider,
    model: route.model,
    system,
    messages: [{ role: 'user', content: [{ type: 'text', text: userText }] }],
    maxTokens: config.generation.maxOutputTokens,
    signal,
  }
  if (route.reasoningEffort !== undefined) options.reasoningEffort = route.reasoningEffort
  if (route.sessionId !== undefined) options.sessionId = route.sessionId
  for await (const chunk of llm.stream(options)) {
    if (chunk.type === 'text-delta') text += chunk.text
    else if (chunk.type === 'block-end' && chunk.block?.type === 'text' && text.length === 0) text += chunk.block.text
    else if (chunk.type === 'finish') finish = chunk.reason
  }
  if (finish !== undefined && finish.kind !== 'stop') {
    if (finish.kind === 'max-tokens') throw new Error('generation reached maxOutputTokens')
    if (finish.kind === 'tool-calls') throw new Error('generation unexpectedly requested a tool')
    throw new Error(finish.failure?.message ?? `generation ended with "${String(finish.kind)}"`)
  }
  return text
}

/**
 * Apply one write under the root allow-list.
 *
 * Shared by the JSON-plan path and the memory agent's `memory_write` tool so
 * both enforce exactly the same rules: a known root, write access, a relative
 * `.md` path inside it, non-empty content, and the byte ceiling.
 *
 * @param ctx - plugin context.
 * @param config - the resolved configuration.
 * @param rootById - roots keyed by id.
 * @param write - `{ rootId, path, content, mode? }`.
 * @param signal - cancellation.
 * @returns `{ file }` on success, or `{ rootId, path, error }` on refusal.
 */
export async function applyOneWrite(ctx, config, rootById, write, signal) {
  const fs = ctx.get('fs')
  const rootId = String(write.rootId)
  const root = rootById.get(rootId)
  if (root === undefined) return { rootId, path: String(write.path), error: 'unknown root' }
  if (root.access !== 'read-write') {
    return { rootId: root.id, path: String(write.path), error: 'root is read-only' }
  }
  const safe = safeRelativePath(write.path)
  if (safe === undefined) {
    return { rootId: root.id, path: String(write.path), error: 'path must be a relative .md path inside the root' }
  }
  if (typeof write.content !== 'string' || write.content.trim().length === 0) {
    return { rootId: root.id, path: safe, error: 'content must be a non-empty string' }
  }
  const absolute = joinRoot(root.path, safe)
  let content = write.content
  if (write.mode === 'append') {
    const existing = await readIfPresent(fs, absolute, signal).catch(() => undefined)
    content = `${existing === undefined ? '' : `${existing.text.replace(/\s+$/, '')}\n\n`}${content}`
  }
  if (Buffer.byteLength(content, 'utf8') > config.generation.maxWriteBytes) {
    return {
      rootId: root.id,
      path: safe,
      error: `content exceeds maxWriteBytes ${config.generation.maxWriteBytes}`,
    }
  }
  try {
    await writeGuarded(fs, absolute, content, signal)
    // The index limits live in the prompt; this only reports on them.
    const warnings = indexWarnings(safe, content)
    if (warnings.length > 0) {
      ctx.logger.warn('memory: index %s: %s', `${root.id}:${safe}`, warnings.map((item) => item.message).join('; '))
    }
    return {
      file: {
        rootId: root.id,
        path: safe,
        bytes: Buffer.byteLength(content, 'utf8'),
        warnings: warnings.length > 0 ? warnings : undefined,
      },
    }
  } catch (error) {
    return { rootId: root.id, path: safe, error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Delete one memory file under the same allow-list as a write.
 *
 * Shared by the memory agent's `memory_delete` tool and the human paths, so all of
 * them enforce exactly one policy: a known root, write access, a relative `.md`
 * path inside it. `expectedVersion` is optional and, when given, means "only if
 * the file is still the one I read".
 *
 * @param ctx - plugin context.
 * @param config - the resolved configuration.
 * @param rootById - roots keyed by id.
 * @param entry - `{ rootId, path, expectedVersion? }`.
 * @param signal - cancellation.
 * @returns `{ file }` on success, or `{ rootId, path, error }` on refusal.
 */
export async function applyOneDelete(ctx, config, rootById, entry, signal) {
  const rootId = String(entry.rootId)
  const root = rootById.get(rootId)
  if (root === undefined) return { rootId, path: String(entry.path), error: 'unknown root' }
  if (root.access !== 'read-write') {
    return { rootId: root.id, path: String(entry.path), error: 'root is read-only' }
  }
  const safe = safeRelativePath(entry.path)
  if (safe === undefined) {
    return { rootId: root.id, path: String(entry.path), error: 'path must be a relative .md path inside the root' }
  }
  const outcome = await deleteGuarded(ctx.get('fs'), joinRoot(root.path, safe), entry.expectedVersion, signal)
  if (outcome.missing === true) return { rootId: root.id, path: safe, error: 'no such memory file' }
  if (outcome.error !== undefined) return { rootId: root.id, path: safe, error: outcome.error }
  return { file: { rootId: root.id, path: safe, bytes: 0, deleted: true } }
}

/**
 * The generation result implied by a set of attempted writes.
 *
 * @param attempted - how many writes the model asked for.
 * @param writtenFiles - the writes that succeeded.
 * @param failedFiles - the writes that were refused or failed.
 * @param roots - the resolved roots.
 * @param reason - the model's stated reason, when it gave one.
 * @returns `{ status, writtenFiles, failedFiles, reason, indexUpdated, contentUpdated }`.
 */
export function summarizeWrites(attempted, writtenFiles, failedFiles, roots, reason, deletedFiles = [], attemptedDeletes = 0) {
  // A delete is an attempt too: two refused deletes with nothing written is a
  // failed pass, not "the model asked for nothing".
  const attempts = attempted + attemptedDeletes
  const landed = writtenFiles.length + deletedFiles.length
  let status
  if (attempts === 0) status = 'no_change'
  else if (landed === 0) status = 'failed'
  else if (failedFiles.length > 0) status = 'partial'
  else status = 'saved'

  // The SDK distinguishes index-file changes from content changes so a caller can tell
  // "the index moved" from "a content file moved".
  const changed = [...writtenFiles, ...deletedFiles]
  const indexIds = new Set(
    roots.filter((root) => root.indexFile !== undefined).map((root) => `${root.id}\u0000${root.indexFile}`),
  )
  const indexUpdated = changed.some((file) => indexIds.has(`${file.rootId}\u0000${file.path}`))
  // A delete is a content change too: the file that was pointed at is gone.
  const contentUpdated = changed.some((file) => !indexIds.has(`${file.rootId}\u0000${file.path}`))
  // A tool-driven pass states no reason of its own, so a failed one would carry
  // nothing at all and every reader would see a bare `failed`. The first refusal is
  // the explanation, and it is the only one available.
  const stated = typeof reason === 'string' && reason.trim().length > 0 ? reason : undefined
  const refused = failedFiles.length > 0 ? `every attempt was refused: ${failedFiles[0].error}` : undefined

  return { status, writtenFiles, failedFiles, deletedFiles, reason: stated ?? refused ?? '', indexUpdated, contentUpdated }
}

/**
 * Apply the model's writes under the root allow-list, with a per-file outcome.
 *
 * @param ctx - plugin context.
 * @param config - the resolved configuration.
 * @param roots - the resolved roots.
 * @param plan - the parsed write plan.
 * @param signal - cancellation.
 * @returns `{ status, writtenFiles, failedFiles, reason, indexUpdated, contentUpdated }`.
 */
export async function applyPlan(ctx, config, roots, plan, signal) {
  const rootById = new Map(roots.map((root) => [root.id, root]))
  const writtenFiles = []
  const failedFiles = []
  const attempted = plan.writes.slice(0, config.generation.maxWrites)

  for (const write of attempted) {
    if (write === null || typeof write !== 'object') continue
    const outcome = await applyOneWrite(ctx, config, rootById, write, signal)
    if (outcome.file !== undefined) writtenFiles.push(outcome.file)
    else failedFiles.push({ rootId: outcome.rootId, path: outcome.path, error: outcome.error })
  }

  return summarizeWrites(attempted.length, writtenFiles, failedFiles, roots, plan.reason)
}
