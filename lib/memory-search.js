/**
 * Full-text search across the memory roots — Qoder's `memory_search`.
 *
 * Qoder's memory tools are a FAMILY, not one tool:
 *
 * ```js
 * "memory" === A ? new Set(["memory", "memory_search", "memory_get"]) : …
 * ```
 *
 * and its own prompt tells the agent when to reach for them:
 *
 *   "Use memory_search or memory_get first if duplication is likely."
 *   "- Do not write duplicate memories. First check if there is an existing
 *      memory you can update before writing a new one."
 *
 * Both sentences are carried verbatim in `memory-prompt.js`; this module is the
 * search they assume. The exact parameter schema of Qoder's `memory_search`
 * lives behind its service — the CLI bundle references the NAME only, so it
 * cannot be copied — and the contract here is what those two sentences imply:
 * a case-insensitive LITERAL match (not a regex: a model-supplied pattern can
 * backtrack catastrophically) over every `*.md` in the roots, reporting where
 * each hit is so the agent can decide between updating and creating.
 *
 * @module @dsh-external/dsh-memory/memory-search
 */

import { listRootFiles, readIfPresent } from './fs.js'
import { isIndexFile, parseMemoryFile } from './memory-file.js'
import { joinRoot } from './paths.js'

/** Hits reported per file. */
const MAX_HITS_PER_FILE = 5

/** Hits reported per search, across every root. */
const MAX_HITS = 40

/** Characters of context kept on each side of a hit. */
const SNIPPET_PADDING = 60

/** Shortest query worth searching for. */
const MIN_QUERY_LENGTH = 2

/**
 * Find every case-insensitive literal occurrence of `query` in `text`.
 *
 * Pure, so the matching rules are testable without a filesystem: the query is
 * matched literally (a `.` is a dot, not "any character"), and each hit reports
 * its one-based line number and a trimmed snippet.
 *
 * @param text - the file contents.
 * @param query - the literal text to find.
 * @returns `{ line, snippet }` per occurrence, in file order.
 */
export function findHits(text, query) {
  const needle = String(query ?? '').toLowerCase()
  if (needle.length < MIN_QUERY_LENGTH) return []
  const hits = []
  const lines = String(text ?? '').split('\n')
  for (const [index, line] of lines.entries()) {
    const at = line.toLowerCase().indexOf(needle)
    if (at < 0) continue
    const from = Math.max(0, at - SNIPPET_PADDING)
    const to = Math.min(line.length, at + needle.length + SNIPPET_PADDING)
    const prefix = from > 0 ? '…' : ''
    const suffix = to < line.length ? '…' : ''
    hits.push({ line: index + 1, snippet: `${prefix}${line.slice(from, to).trim()}${suffix}` })
  }
  return hits
}

/**
 * Search every memory root for a query.
 *
 * @param ctx - plugin context.
 * @param roots - the resolved (trust-gated) roots.
 * @param query - the literal text to find.
 * @param options - `{ rootId? }` to narrow the search to one root.
 * @param signal - cancellation.
 * @returns `{ query, hits, files, considered, truncated, error? }`.
 */
export async function searchMemory(ctx, roots, query, options, signal) {
  const needle = String(query ?? '')
  if (needle.trim().length < MIN_QUERY_LENGTH) {
    return { query: needle, hits: [], files: [], considered: 0, truncated: false, error: 'query is too short' }
  }
  const wanted = options?.rootId === undefined ? undefined : String(options.rootId)
  const selected = wanted === undefined ? roots : roots.filter((root) => root.id === wanted)
  if (wanted !== undefined && selected.length === 0) {
    return { query: needle, hits: [], files: [], considered: 0, truncated: false, error: `unknown root "${wanted}"` }
  }

  const fs = ctx.get('fs')
  const hits = []
  const files = []
  let considered = 0
  let truncated = false
  for (const root of selected) {
    const names = await listRootFiles(fs, root, signal).catch(() => [])
    for (const fileName of names) {
      considered += 1
      let text
      try {
        const found = await readIfPresent(fs, joinRoot(root.path, fileName), signal)
        if (found === undefined) continue
        text = found.text
      } catch {
        continue
      }
      const index = isIndexFile(fileName)
      const found = findHits(text, needle)
      if (found.length === 0) continue
      const parsed = index ? { type: 'index' } : parseMemoryFile(fileName, text)
      const kept = found.slice(0, MAX_HITS_PER_FILE)
      files.push({ rootId: root.id, path: fileName, type: parsed.type, index, matches: found.length })
      for (const hit of kept) {
        if (hits.length >= MAX_HITS) {
          truncated = true
          break
        }
        hits.push({ rootId: root.id, path: fileName, type: parsed.type, index, line: hit.line, snippet: hit.snippet })
      }
      if (kept.length < found.length || hits.length >= MAX_HITS) truncated = true
      if (hits.length >= MAX_HITS) break
    }
    if (hits.length >= MAX_HITS) break
  }

  return { query: needle, hits, files, considered, truncated, error: undefined }
}

/**
 * Render a search result as the text a tool call returns to the model.
 *
 * @param result - a {@link searchMemory} result.
 * @returns one line per hit, plus a summary line.
 */
export function formatSearchResult(result) {
  if (result.error !== undefined) return `memory_search: ${result.error}`
  if (result.hits.length === 0) {
    return `no memory matches ${JSON.stringify(result.query)} in ${result.considered} file(s).`
  }
  const lines = result.hits.map(
    (hit) => `${hit.rootId}:${hit.path}:${hit.line} [${hit.type}] ${hit.snippet}`,
  )
  const fileCount = result.files.length
  lines.push(
    `${result.hits.length} match(es) in ${fileCount} file(s)${result.truncated ? ' (truncated)' : ''}.`,
  )
  return lines.join('\n')
}
