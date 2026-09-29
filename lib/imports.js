/**
 * `@`-import expansion for memory files — Qoder's "ImportProcessor".
 *
 * Decoded verbatim from the installed `qodercli`. Its entry point is
 * `iet(content, baseDir, warn, state, root, importFormat, boundaryMarkers, approved)`
 * with `state = { processedFiles: new Set(), maxDepth: 5, currentDepth: 0 }`,
 * `importFormat` defaulting to `'tree'`, and `root` discovered by walking up to a
 * boundary marker (default `['.git']`).
 *
 * The pieces that matter, all reproduced here:
 *
 * ```js
 * // an import is `@` at the start of a line or after whitespace, then a path
 * function gNi(text) { … }                       // see parseImports
 * function mNi(path) {                           // is it a path at all?
 *   if (path.startsWith('./') || path.startsWith('../') || path.startsWith('~/') ||
 *       (path.startsWith('/') && path.length > 1)) return true
 *   if (path.startsWith('@') || /^[#%^&*()]+/.test(path) || !/^[a-zA-Z0-9._-]/.test(path)) return false
 *   const hasExt = /\.[a-zA-Z0-9]+$/.test(path) || /\.[a-zA-Z0-9]+\//.test(path)
 *   if (!hasExt && !path.startsWith('.')) return false
 *   if (path.includes('/') && !hasExt && !path.split('/')[0].includes('.')) return false
 *   return true
 * }
 *
 * function GCn(path, baseDir, allowedRoots) {    // may this be followed?
 *   if (/^(file|https?):\/\//.test(path)) return false
 *   return allowedRoots.some((root) => contains(root, resolve(baseDir, path)))
 * }
 * ```
 *
 * so a `@user` mention is not an import, `@docs/x.md` is, a URL never is, and
 * only paths inside an allowed root are followed without approval. Imports inside
 * code fences are left as literal text (`/(`+)([\s\S]*?)\1/g` gives the fence
 * ranges), a file already on the current chain renders
 * `<!-- File already processed: X -->`, a refused one renders
 * `<!-- Import blocked: X - outside project root -->`, and a read failure renders
 * `<!-- Import failed: X - message -->`.
 *
 * The ALLOWED ROOTS differ from Qoder's, for a structural reason: Qoder passes
 * `[projectRoot]` because its memory files live inside the project. Here memory
 * lives under `$DSH_HOME`, so the importing file's own memory root is allowed (a
 * sibling memory file is the natural case), plus the session's project directory
 * when that folder is trusted. Everything else needs approval —
 * `imports.allowExternal`, or the session's project being listed in
 * `imports.approvedProjects` (Qoder's "Approved External Import Projects").
 *
 * @module @dsh-external/dsh-memory/imports
 */

import { dirname, normalize, resolve } from 'node:path'
import { folderContains, resolveDshHome } from './paths.js'

/** Qoder's default depth ceiling (`maxDepth: 5`). */
export const IMPORT_MAX_DEPTH = 5

/** Qoder's import syntaxes. */
export const IMPORT_FORMATS = Object.freeze(['tree', 'flat'])

/** URL-shaped imports are recognised only so they can be refused. */
const URL_IMPORT = /^(file|https?):\/\//

/** Qoder's whitespace predicate for "the `@` starts a path". */
const isSpace = (character) => character === ' ' || character === '\t' || character === '\n' || character === '\r'

/**
 * Whether a run of text after `@` names a path at all.
 *
 * Reproduced from Qoder's `mNi`, including the cases that make it useful: an
 * `@name` mention, an `@#tag` or `@(group)` is not an import, and a bare word
 * without an extension or leading dot is not either.
 *
 * @param path - the text after the `@`.
 * @returns `true` when it should be treated as an import.
 */
export function isImportPath(path) {
  const text = String(path ?? '')
  if (text.length === 0) return false
  if (text.startsWith('./') || text.startsWith('../') || text.startsWith('~/')) return true
  if (text.startsWith('/') && text.length > 1) return true
  if (text.startsWith('@') || /^[#%^&*()]+/.test(text) || !/^[a-zA-Z0-9._-]/.test(text)) return false
  const hasExtension = /\.[a-zA-Z0-9]+$/.test(text) || /\.[a-zA-Z0-9]+\//.test(text)
  if (!hasExtension && !text.startsWith('.')) return false
  if (text.includes('/') && !hasExtension && !text.split('/')[0].includes('.')) return false
  return true
}

/**
 * The code-fence ranges in a document, which imports may not appear inside.
 *
 * Qoder's `pNi`: a run of backticks opens a fence and the same-length run closes
 * it, so ```` ``` ```` and ```` ```` ```` are matched correctly.
 *
 * @param text - the document.
 * @returns `[start, end)` pairs.
 */
export function codeFenceRanges(text) {
  const ranges = []
  const pattern = /(`+)([\s\S]*?)\1/g
  let match
  while ((match = pattern.exec(String(text))) !== null) ranges.push([match.index, match.index + match[0].length])
  return ranges
}

/**
 * Every import reference in a document, in order.
 *
 * Qoder's `gNi`: a `@` at the start of the document, a line, or after whitespace,
 * followed by a non-whitespace run that {@link isImportPath} accepts.
 *
 * @param text - the document.
 * @returns `{ path, start, end }` per reference.
 */
export function parseImports(text) {
  const source = String(text ?? '')
  const found = []
  let cursor = 0
  for (;;) {
    const at = source.indexOf('@', cursor)
    if (at < 0) break
    cursor = at + 1
    if (at > 0 && !isSpace(source[at - 1])) continue
    let end = at + 1
    while (end < source.length && !isSpace(source[end])) end += 1
    const path = source.slice(at + 1, end)
    if (path.length > 0 && isImportPath(path)) found.push({ path, start: at, end })
    cursor = end + 1
  }
  return found
}

/**
 * Flatten an import tree into the list of paths it resolved to.
 *
 * Qoder's `ENi`.
 *
 * @param imports - `{ path, imports? }` nodes.
 * @returns every resolved path, in traversal order.
 */
export function flattenImportTree(imports) {
  const paths = []
  for (const node of imports ?? []) {
    if (typeof node?.path === 'string' && node.path.length > 0) paths.push(node.path)
    if (Array.isArray(node?.imports)) paths.push(...flattenImportTree(node.imports))
  }
  return paths
}

/**
 * Build the child-to-parent map Qoder keeps as `importParentMap`.
 *
 * Qoder's `ret`: every resolved import maps to the file that imported it, which
 * is what makes a cycle visible to the caller rather than only inside one
 * expansion.
 *
 * @param imports - `{ path, imports? }` nodes.
 * @param parent - the importing file's path.
 * @returns a `Map` of imported path → importing path.
 */
export function importParentMap(imports, parent) {
  const map = new Map()
  for (const node of imports ?? []) {
    if (typeof node?.path !== 'string' || node.path.length === 0) continue
    map.set(node.path, parent)
    if (Array.isArray(node.imports)) {
      for (const [child, grandparent] of importParentMap(node.imports, node.path)) map.set(child, grandparent)
    }
  }
  return map
}

/**
 * Whether a target may be followed without approval.
 *
 * Pure: Qoder's `GCn` rule (a URL is never followed) plus containment in one of
 * the allowed roots.
 *
 * @param importPath - the text after the `@`.
 * @param baseDir - the importing file's directory.
 * @param allowedRoots - directories an import may come from.
 * @returns `true` when the target is inside an allowed root.
 */
export function isAllowedImport(importPath, baseDir, allowedRoots) {
  const raw = String(importPath ?? '')
  if (URL_IMPORT.test(raw)) return false
  const target = resolveTarget(raw, baseDir)
  return allowedRoots
    .filter((root) => typeof root === 'string' && root.length > 0)
    .some((root) => folderContains(root, target))
}

/**
 * Resolve an import reference the way Qoder's `PI.resolve` does.
 *
 * `~` is the harness home in Qoder's path layer; here it resolves against the
 * session's home directory when provided, otherwise against the base directory.
 *
 * @param importPath - the text after the `@`.
 * @param baseDir - the importing file's directory.
 * @param home - home directory for a `~/` reference.
 * @returns the absolute target path.
 */
export function resolveTarget(importPath, baseDir, home) {
  const raw = String(importPath ?? '')
  if (raw.startsWith('~/')) {
    const base = typeof home === 'string' && home.length > 0 ? home : baseDir
    return normalize(resolve(base, raw.slice(2)))
  }
  return normalize(resolve(baseDir, raw))
}

/**
 * Expand every import in one memory file.
 *
 * @param ctx - plugin context.
 * @param options - `{ file, text, allowedRoots, format, maxDepth, approved, home, state? }`.
 * @param signal - cancellation.
 * @returns the expanded content plus Qoder's import bookkeeping.
 */
export async function expandImports(ctx, options, signal) {
  const format = IMPORT_FORMATS.includes(options.format) ? options.format : 'tree'
  const maxDepth = Number.isInteger(options.maxDepth) ? options.maxDepth : IMPORT_MAX_DEPTH
  const state = options.state ?? { processedFiles: new Set(), currentDepth: 0, currentFile: options.file }
  const approved = options.approved === true
  const here = state.currentFile ?? options.file

  if (state.currentDepth >= maxDepth) {
    ctx.logger.warn('memory: maximum import depth (%d) reached at %s', maxDepth, here)
    return emptyResult(options.text, here)
  }

  const fences = codeFenceRanges(options.text)
  const references = parseImports(options.text)
  if (references.length === 0) return emptyResult(options.text, here)

  const inFence = (index) => fences.some(([start, end]) => index >= start && index < end)
  const baseDir = dirname(options.file)

  if (format === 'flat') {
    return expandFlat(ctx, { ...options, baseDir, approved, state, maxDepth }, signal)
  }
  return expandTree(ctx, { ...options, references, baseDir, inFence, approved, state, maxDepth }, signal)
}

/** Qoder returns the content untouched when there is nothing to expand. */
function emptyResult(text, file) {
  return {
    content: text,
    importTree: { path: file, imports: undefined },
    blockedExternalImports: [],
    resolvedImportPaths: [],
    failedImports: [],
    importParentMap: new Map(),
  }
}

/**
 * The `tree` format (Qoder's default): the imported text replaces the reference
 * in place, wrapped in HTML comments that say where it came from.
 */
async function expandTree(ctx, options, signal) {
  const { text, references, baseDir, inFence, approved, allowedRoots, state, maxDepth } = options
  let output = ''
  let cursor = 0
  const children = []
  const blocked = []
  const failed = []
  for (const reference of references) {
    output += text.slice(cursor, reference.start)
    cursor = reference.end
    if (inFence(reference.start)) {
      output += `@${reference.path}`
      continue
    }
    if (!isAllowedImport(reference.path, baseDir, allowedRoots) && !approved) {
      if (!URL_IMPORT.test(reference.path)) {
        blocked.push({
          importPath: reference.path,
          resolvedPath: resolveTarget(reference.path, baseDir, options.home),
          sourceFile: state.currentFile ?? options.file,
        })
      }
      output += `<!-- Import blocked: ${reference.path} - outside project root -->`
      continue
    }
    const target = resolveTarget(reference.path, baseDir, options.home)
    if (state.processedFiles.has(target)) {
      output += `<!-- File already processed: ${reference.path} -->`
      continue
    }
    const found = await readTarget(ctx, target, signal)
    if (found === undefined) {
      const message = 'could not be read'
      ctx.logger.warn('memory: failed to import %s: %s', reference.path, message)
      output += `<!-- Import failed: ${reference.path} - ${message} -->`
      failed.push({
        importPath: reference.path,
        resolvedPath: target,
        sourceFile: state.currentFile ?? options.file,
        error: message,
      })
      continue
    }
    const processed = new Set(state.processedFiles)
    processed.add(target)
    const child = await expandImports(
      ctx,
      {
        file: target,
        text: found,
        allowedRoots,
        format: options.format,
        maxDepth,
        approved,
        home: options.home,
        state: { processedFiles: processed, currentDepth: state.currentDepth + 1, currentFile: target },
      },
      signal,
    )
    output += `<!-- Imported from: ${reference.path} -->\n${child.content}\n<!-- End of import from: ${reference.path} -->`
    children.push(child.importTree)
    blocked.push(...child.blockedExternalImports)
    failed.push(...child.failedImports)
  }
  output += text.slice(cursor)
  return {
    content: output,
    importTree: { path: state.currentFile ?? options.file, imports: children.length > 0 ? children : undefined },
    blockedExternalImports: blocked,
    resolvedImportPaths: flattenImportTree(children),
    failedImports: failed,
    importParentMap: importParentMap(children, state.currentFile ?? options.file),
  }
}

/**
 * The `flat` format: every imported file is appended in its own
 * `--- File: path ---` block, each file once.
 */
async function expandFlat(ctx, options, signal) {
  const { text, baseDir, approved, allowedRoots, state, maxDepth } = options
  const seen = new Set()
  const files = []
  const blocked = []
  const failed = []

  /** Walk one file, appending whole-file blocks in import order. */
  const walk = async (content, directory, file, depth, chain) => {
    const key = normalize(file)
    if (seen.has(key)) return
    seen.add(key)
    files.push({ path: key, content })
    const fences = codeFenceRanges(content)
    const nested = parseImports(content)
    for (let index = nested.length - 1; index >= 0; index -= 1) {
      const reference = nested[index]
      if (fences.some(([start, end]) => reference.start >= start && reference.start < end)) continue
      if (depth + 1 >= maxDepth) continue
      if (!isAllowedImport(reference.path, directory, allowedRoots) && !approved) {
        if (!URL_IMPORT.test(reference.path)) {
          blocked.push({
            importPath: reference.path,
            resolvedPath: resolveTarget(reference.path, directory, options.home),
            sourceFile: file,
          })
        }
        continue
      }
      const target = resolveTarget(reference.path, directory, options.home)
      if (chain.has(target)) continue
      const found = await readTarget(ctx, target, signal)
      if (found === undefined) {
        failed.push({
          importPath: reference.path,
          resolvedPath: target,
          sourceFile: file,
          error: 'could not be read',
        })
        continue
      }
      const nextChain = new Set(chain)
      nextChain.add(target)
      await walk(found, dirname(target), target, depth + 1, nextChain)
    }
  }

  await walk(
    text,
    baseDir,
    state.currentFile ?? options.file,
    state.currentDepth,
    new Set([normalize(state.currentFile ?? options.file)]),
  )
  return {
    content: files.map((entry) => `--- File: ${entry.path} ---\n${entry.content.trim()}\n--- End of File: ${entry.path} ---`).join('\n\n'),
    importTree: { path: files[0]?.path ?? 'unknown' },
    blockedExternalImports: blocked,
    resolvedImportPaths: files.slice(1).map((entry) => entry.path),
    failedImports: failed,
    importParentMap: new Map(),
  }
}

/** Read one import target, treating any failure as "could not be read". */
async function readTarget(ctx, target, signal) {
  const fs = ctx.get('fs')
  try {
    const resolved = await fs.resolve(target, { signal })
    const info = await fs.stat(resolved, signal)
    if (info === undefined || info.type !== 'file') return undefined
    return await fs.readText(resolved, signal)
  } catch {
    return undefined
  }
}

/** The allowed roots for one file: its own memory root, plus a trusted project. */
export function allowedImportRoots(root, projectDir, trusted) {
  const roots = []
  if (root !== undefined && typeof root.path === 'string') roots.push(root.path)
  if (trusted === true && typeof projectDir === 'string' && projectDir.length > 0) roots.push(projectDir)
  return roots
}

/**
 * Whether a session's external imports are approved.
 *
 * Qoder's predicate is `isExternalImportApproved() || sessionExternalImportApproved`,
 * backed by the "automatically approve …" switch and the per-project "Approved
 * External Import Projects" list. The session-level grant is separate: see
 * `expandFileImports`.
 *
 * @param config - the resolved configuration.
 * @param projectDir - the session's project directory, when it has one.
 * @returns `true` when out-of-root imports may be followed.
 */
export function externalImportsApproved(config, projectDir) {
  const imports = config?.imports
  if (imports?.allowExternal === true) return true
  const approved = Array.isArray(imports?.approvedProjects) ? imports.approvedProjects : []
  if (typeof projectDir !== 'string' || projectDir.length === 0) return false
  return approved.some((dir) => typeof dir === 'string' && dir.length > 0 && folderContains(dir, projectDir))
}

/**
 * Expand the imports of one already-read memory file: the glue that decides which
 * roots are allowed and whether out-of-root references are approved.
 * `sessionApproved` is Qoder's `sessionExternalImportApproved` — a grant made for
 * ONE session, not for the configuration.
 *
 * @param ctx - plugin context.
 * @param config - the resolved configuration.
 * @param entry - the considered file (`{ path, rootId? }`).
 * @param roots - the resolved roots.
 * @param projectDir - the session's project directory, when present.
 * @param text - the file's raw content.
 * @param signal - cancellation.
 * @param sessionApproved - whether this session approved external imports.
 * @returns `{ text, resolvedImportPaths, blockedExternalImports, failedImports }`.
 */
export async function expandFileImports(ctx, config, entry, roots, projectDir, text, signal, sessionApproved) {
  const none = { text, resolvedImportPaths: [], blockedExternalImports: [], failedImports: [] }
  if (config.imports.enabled === false) return none

  const root = roots.find((candidate) => candidate.id === entry.rootId)
  // An explicit `consumption.files` entry has no root: its own directory is the
  // natural allowed root, so a relative import beside it still resolves.
  const allowedRoots = allowedImportRoots(root ?? { path: dirname(entry.path) }, projectDir, true)
  const result = await expandImports(
    ctx,
    {
      file: entry.path,
      text,
      allowedRoots,
      format: config.imports.format,
      maxDepth: config.imports.maxDepth,
      approved: sessionApproved === true || externalImportsApproved(config, projectDir),
      home: resolveDshHome(),
    },
    signal,
  )
  return {
    text: result.content,
    resolvedImportPaths: result.resolvedImportPaths,
    blockedExternalImports: result.blockedExternalImports,
    failedImports: result.failedImports,
  }
}
