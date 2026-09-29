/**
 * Load-exclusion patterns for project-scope memory.
 *
 * Qoder's loader takes an `agentsMdExcludes` list and applies three functions to
 * it, all decoded from the installed `qodercli`:
 *
 * ```js
 * // 1. normalize + re-canonicalize absolute patterns
 * function x8e(patterns) {
 *   const out = patterns.map(p => p.replaceAll('\\', '/'))
 *   for (const p of [...out]) {
 *     if (!p.startsWith('/')) continue
 *     const at = p.search(/[*?{[]/)
 *     const prefix = at === -1 ? p : p.slice(0, at)
 *     const dir = dirname(prefix)
 *     try {
 *       const real = realpathSync(dir).replaceAll('\\', '/')
 *       if (real !== dir) out.push(real + p.slice(dir.length))
 *     } catch {}
 *   }
 *   return out.filter(p => p.length > 0)
 * }
 *
 * // 2. the match itself
 * function D8e(path, patterns) {
 *   if (patterns.length === 0) return false
 *   const p = path.replaceAll('\\', '/')
 *   const nocase = process.platform === 'darwin' || process.platform === 'win32'
 *   return picomatch.isMatch(p, patterns, { dot: true, nocase })
 * }
 *
 * // 3. the SCOPE rule — project and local only, never global
 * function pet(memory, excludes) { … { ...memory, project: filter(memory.project), local: filter(memory.local) } }
 * ```
 *
 * So the semantics are: gitignore-flavoured globs, matched against the file's
 * absolute path with `/` separators, case-insensitively on Windows and macOS,
 * with `dot: true` so a pattern can address dotfiles — and applied to the
 * PROJECT scope only. Qoder's `global` layer is the user-global instruction
 * file, which no exclude may remove; the equivalent here is the user scope, so
 * `consumption.excludes` never touches it.
 *
 * Two deliberate, documented differences from the decoded original:
 *
 *   - Qoder canonicalizes a pattern's static prefix only when it begins with
 *     `/`, which on Windows is never true. This port canonicalizes a pattern
 *     that is absolute on the current platform, which is the case where the
 *     check does something useful.
 *   - canonicalization goes through `ctx.fs.processPath` rather than
 *     `node:fs.realpathSync`, so it stays inside the filesystem provider.
 *
 * That our match targets are already canonical (root paths are built from the
 * harness's project path) is why patterns can be matched as written.
 *
 * @module @dsh-external/dsh-memory/excludes
 */

import { dirname, isAbsolute, resolve } from 'node:path'
import picomatch from 'picomatch'

/** The glob options Qoder passes, verbatim. */
export const EXCLUDE_MATCH_OPTIONS = Object.freeze({
  dot: true,
  nocase: process.platform === 'darwin' || process.platform === 'win32',
})

/**
 * The scopes an exclusion may remove a file from.
 *
 * Qoder's `pet` filters `project` and `local` and leaves `global` alone. This
 * plugin has one built-in project root and no local layer, so the rule reduces
 * to "the project scope, never the user scope" — and a custom root is never
 * excluded either, because a root the operator listed explicitly is not
 * something a filename pattern should silently drop.
 */
export const EXCLUDABLE_ROOT_IDS = Object.freeze(['project'])

/**
 * Normalize separators the way Qoder does before matching.
 *
 * @param patterns - raw patterns.
 * @returns patterns with `/` separators and no empty entries.
 */
export function normalizeExcludes(patterns) {
  if (!Array.isArray(patterns)) return []
  return patterns
    .filter((pattern) => typeof pattern === 'string')
    .map((pattern) => pattern.replaceAll('\\', '/'))
    .filter((pattern) => pattern.length > 0)
}

/**
 * Whether one absolute path matches any exclusion pattern.
 *
 * Pure, so the matching rules are testable without a filesystem: the path keeps
 * its `/` separators, `dot` is on, and case is folded on Windows and macOS
 * exactly as Qoder folds it.
 *
 * @param absolutePath - the file being considered.
 * @param patterns - normalized patterns.
 * @returns `true` when the file is excluded.
 */
export function isExcluded(absolutePath, patterns) {
  if (!Array.isArray(patterns) || patterns.length === 0) return false
  const path = String(absolutePath).replaceAll('\\', '/')
  return picomatch.isMatch(path, patterns, EXCLUDE_MATCH_OPTIONS)
}

/**
 * Add a canonical spelling beside every absolute pattern.
 *
 * A pattern written against a symlinked or `..`-bearing prefix must still match
 * the canonical path, so the prefix before the first wildcard is resolved
 * through the provider and the resolved spelling is added as a second pattern.
 *
 * @param ctx - plugin context.
 * @param patterns - normalized patterns.
 * @param signal - cancellation.
 * @returns the patterns plus their canonical variants.
 */
export async function canonicalizeExcludes(ctx, patterns, signal) {
  const fs = ctx.get('fs')
  const out = [...patterns]
  for (const pattern of patterns) {
    if (!isAbsolute(pattern) && !/^[A-Za-z]:\//.test(pattern)) continue
    const wildcardAt = pattern.search(/[*?{[]/)
    const prefix = wildcardAt === -1 ? pattern : pattern.slice(0, wildcardAt)
    const directory = dirname(prefix)
    if (directory === '.' || directory.length === 0) continue
    try {
      const target = await fs.resolve(resolve(directory), { signal })
      const canonical =
        typeof fs.processPath === 'function' ? fs.processPath(target) : undefined
      const normalized = typeof canonical === 'string' ? canonical.replaceAll('\\', '/') : undefined
      if (normalized === undefined || normalized.length === 0 || normalized === directory.replaceAll('\\', '/')) {
        continue
      }
      out.push(normalized + pattern.slice(directory.length).replaceAll('\\', '/'))
    } catch {
      /* an unresolvable prefix simply contributes no variant */
    }
  }
  return out
}

/**
 * Split entries into those a pattern keeps and those it removes.
 *
 * @param entries - `{ rootId, absolute }` per considered file.
 * @param patterns - normalized (and optionally canonicalized) patterns.
 * @param excludableRootIds - root ids an exclusion may act on.
 * @returns `{ kept, excluded }`.
 */
export function partitionExcluded(entries, patterns, excludableRootIds = EXCLUDABLE_ROOT_IDS) {
  if (!Array.isArray(patterns) || patterns.length === 0) return { kept: entries, excluded: [] }
  const allowed = new Set(excludableRootIds)
  const kept = []
  const excluded = []
  for (const entry of entries) {
    if (typeof entry.rootId === 'string' && allowed.has(entry.rootId) && isExcluded(entry.absolute, patterns)) {
      excluded.push(entry)
      continue
    }
    kept.push(entry)
  }
  return { kept, excluded }
}

/**
 * Render the exclusion outcome for a log line or `/memory`.
 *
 * @param excluded - the excluded entries.
 * @returns a human-readable summary, or `''` when nothing was excluded.
 */
export function describeExcluded(excluded) {
  if (!Array.isArray(excluded) || excluded.length === 0) return ''
  return `${excluded.length} file(s) excluded by pattern: ${excluded.map((entry) => entry.absolute).join(', ')}`
}
