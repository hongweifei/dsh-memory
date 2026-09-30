/**
 * Folder trust: whether project-scope memory may be used in this folder.
 *
 * Qoder gates project memory behind a per-folder trust decision. Its predicate,
 * read out of the installed `qodercli` bundle, is:
 *
 * ```js
 * isTrustedFolder() { return !this.folderTrust || (this.trustedFolder ?? false) }
 * ```
 *
 * so the feature switch (`folderTrust`, the `security.folderTrust.enabled`
 * setting) defaults to OFF — while it is off every folder counts as trusted —
 * and turning it ON makes `trustedFolder` the deciding flag. The CLI decides
 * that flag through a prompt whose answers include "Trust (remember across
 * sessions)", and `setTrustedFolder` emits `trust-changed` and refreshes the
 * memory context.
 *
 * The DSH port keeps that shape:
 *
 *   config.trust.enabled   the feature switch (Qoder's `folderTrust`)
 *   config.trust.folders   user-level declared directories
 *   <DSH_HOME>/trusted-folders.json   remembered decisions, outside every root
 *
 * The folder it asks about is the harness's own project directory for the
 * session (see `resolveProjectIdentity`), and containment is by prefix, so
 * trusting a repository still covers the packages inside it.
 *
 * The gate drops the built-in PROJECT root when the folder is not trusted, at
 * the single seam both halves resolve their roots through, so consumption,
 * generation and the `memory` tool all see the same thing. Qoder's own evidence
 * covers the consumption string (`this.projectMemory = isTrustedFolder() && …`)
 * only; gating all three is deliberately stricter and is noted as a difference.
 *
 * @module @dsh-external/dsh-memory/trust
 */

import { isAbsolute, join } from 'node:path'
import { PROJECT_ROOT_ID } from './constants.js'
import { readIfPresent, writeGuarded } from './fs.js'
import { folderContains, normalizeFolder, resolveDshHome, resolveRoots } from './paths.js'

/**
 * Where remembered trust decisions live.
 *
 * Outside every memory root, like `dream-state.json`: a trust decision is not
 * memory, and it must not be injected into a session.
 *
 * @returns the absolute path of the store.
 */
export function trustStorePath() {
  return join(resolveDshHome(), 'trusted-folders.json')
}

/**
 * The effective trusted list: every declared directory plus every remembered
 * one, de-duplicated case-insensitively on Windows.
 *
 * @param config - the resolved configuration.
 * @param stored - the remembered list read from the store.
 * @returns absolute-ish directory entries in declaration order.
 */
export function effectiveTrustedFolders(config, stored) {
  const declared = Array.isArray(config?.trust?.folders) ? config.trust.folders : []
  const remembered = Array.isArray(stored) ? stored : []
  const seen = new Set()
  const folders = []
  for (const entry of [...declared, ...remembered]) {
    if (typeof entry !== 'string' || entry.trim().length === 0) continue
    const key = normalizeFolder(entry)
    if (seen.has(key)) continue
    seen.add(key)
    folders.push(entry)
  }
  return folders
}

/**
 * The trust predicate itself: `!enabled || some(trusted directory contains it)`.
 *
 * Pure, so the policy is testable without a filesystem or a store.
 *
 * @param folder - the folder being asked about.
 * @param config - the resolved configuration.
 * @param stored - the remembered trusted list.
 * @param cwd - the base for a relative entry.
 * @returns `true` when project-scope memory may be used here.
 */
export function isFolderTrusted(folder, config, stored, cwd = process.cwd()) {
  // Qoder: `!this.folderTrust || …` — an inert gate trusts everything.
  if (config?.trust?.enabled !== true) return true
  if (typeof folder !== 'string' || folder.length === 0) return false
  return effectiveTrustedFolders(config, stored).some((dir) => folderContains(dir, folder, cwd))
}

/**
 * Read the remembered trust decisions, treating a missing or damaged store as
 * "nothing remembered" rather than failing the pass.
 *
 * @param ctx - plugin context.
 * @param signal - cancellation.
 * @returns the remembered directory list.
 */
export async function loadTrustedFolders(ctx, signal) {
  try {
    const found = await readIfPresent(ctx.get('fs'), trustStorePath(), signal)
    if (found === undefined) return []
    const parsed = JSON.parse(found.text)
    const folders = parsed !== null && typeof parsed === 'object' ? parsed.folders : undefined
    return Array.isArray(folders) ? folders.filter((entry) => typeof entry === 'string' && entry.length > 0) : []
  } catch {
    return []
  }
}

/**
 * Persist the remembered trust decisions.
 *
 * @param ctx - plugin context.
 * @param folders - the list to write.
 * @param signal - cancellation.
 */
export async function saveTrustedFolders(ctx, folders, signal, policy) {
  await writeGuarded(ctx.get('fs'), trustStorePath(), `${JSON.stringify({ folders }, null, 2)}\n`, signal, policy)
}

/**
 * Remember one folder across sessions — Qoder's "Trust (remember across
 * sessions)".
 *
 * @param ctx - plugin context.
 * @param folder - the folder to trust.
 * @param signal - cancellation.
 * @returns the new stored list.
 */
export async function rememberTrustedFolder(ctx, folder, signal, policy) {
  const stored = await loadTrustedFolders(ctx, signal)
  if (stored.some((entry) => folderContains(entry, folder))) return stored
  const next = [...stored, folder]
  await saveTrustedFolders(ctx, next, signal, policy)
  return next
}

/**
 * Forget a remembered folder, covering every entry that contains it.
 *
 * @param ctx - plugin context.
 * @param folder - the folder to stop trusting.
 * @param signal - cancellation.
 * @returns `{ stored, removed }`.
 */
export async function forgetTrustedFolder(ctx, folder, signal, policy) {
  const stored = await loadTrustedFolders(ctx, signal)
  const kept = stored.filter((entry) => !folderContains(entry, folder))
  const removed = stored.filter((entry) => folderContains(entry, folder))
  if (removed.length > 0) await saveTrustedFolders(ctx, kept, signal, policy)
  return { stored: kept, removed }
}

/**
 * One snapshot of the trust decision, for `/memory` and the panel.
 *
 * The folder reported is the same one the gate is decided against — the
 * built-in project root when there is one, otherwise the working directory — so
 * the snapshot and the behaviour cannot drift apart.
 *
 * @param ctx - plugin context.
 * @param config - the resolved configuration.
 * @param customRoots - the validated `generation.roots` list.
 * @param cwd - the session working directory.
 * @param signal - cancellation.
 * @returns `{ enabled, folder, trusted, declared, remembered, folders }`.
 */
export async function trustState(ctx, config, customRoots, cwd, signal) {
  const enabled = config?.trust?.enabled === true
  const roots = await resolveRoots(ctx, config, customRoots, cwd, signal).catch(() => [])
  const folder = gatedProjectRoot(roots)?.projectRoot ?? cwd
  const declared = Array.isArray(config?.trust?.folders) ? config.trust.folders : []
  const remembered = enabled ? await loadTrustedFolders(ctx, signal) : []
  return {
    enabled,
    folder,
    trusted: isFolderTrusted(folder, config, remembered, cwd),
    declared,
    remembered,
    folders: effectiveTrustedFolders(config, remembered),
  }
}

/**
 * The project root the trust gate is decided against.
 *
 * @param roots - the resolved roots.
 * @returns the built-in project root, or `undefined` when this run has none.
 */
export function gatedProjectRoot(roots) {
  // Only the BUILT-IN project root is gated: it carries `projectRoot`, whereas a
  // custom root is explicitly configured and therefore already trusted.
  return roots.find((root) => root.id === PROJECT_ROOT_ID && root.projectRoot !== undefined)
}

/**
 * Resolve the roots with the trust gate applied.
 *
 * Every pass and every surface resolves its roots through here, so an untrusted
 * folder has no project root at all — nothing to consume, nothing to write, and
 * nothing the `memory` tool can address in the project scope.
 *
 * @param ctx - plugin context.
 * @param config - the resolved configuration.
 * @param customRoots - the validated `generation.roots` list.
 * @param cwd - the session working directory.
 * @param signal - cancellation.
 * @returns the roots in load order, minus an untrusted project root.
 */
export async function resolveEffectiveRoots(ctx, config, customRoots, cwd, signal) {
  const roots = await resolveRoots(ctx, config, customRoots, cwd, signal)
  if (config?.trust?.enabled !== true) return roots
  const project = gatedProjectRoot(roots)
  if (project === undefined) return roots
  const remembered = await loadTrustedFolders(ctx, signal)
  if (isFolderTrusted(project.projectRoot, config, remembered, cwd)) return roots
  return roots.filter((root) => root !== project)
}
