/**
 * Just-in-time memory: a memory file that loads only when it is relevant.
 *
 * Decoded from the installed `qodercli`:
 *
 * ```js
 * function swn(file) {                       // the trigger a file declares
 *   if (i === undefined) return { trigger: "always_on" }
 *   if (i === false) return { trigger: "manual" }
 *   const n = fet(e.paths)
 *   return n ? { trigger: "glob", globs: n } : { trigger: "always_on" }
 * }
 * function GXi(content, fallbackReason) {
 *   const globs = content ? awn(content) : undefined
 *   return globs ? { loadReason: "path_glob_match", globs } : { loadReason: fallbackReason }
 * }
 * ```
 *
 * Three states, and the default one is today's behaviour: a file that declares
 * nothing is `always_on`; `trigger: false` is `manual` (never loaded on its own);
 * a `paths` list makes it `glob`, loaded when the session has touched a match.
 *
 * Decoded and NOT decoded, kept apart on purpose: the three return values are
 * verbatim, but the bundle does not show how `manual` is consumed, so this port
 * reads it as the minimal statement it makes — "do not load this on your own".
 *
 * @module @dsh-external/dsh-memory/jit
 */

import picomatch from 'picomatch'

/** Qoder's own reason string for a glob-triggered load. */
export const JIT_LOAD_REASON = 'path_glob_match'

/** The three trigger states, in Qoder's vocabulary. */
export const JIT_TRIGGERS = ['always_on', 'manual', 'glob']

/** One inline list, or a comma-separated value: `[a, b]` / `a, b` / `a`. */
const INLINE_LIST = /^\[(.*)\]$/

/**
 * Split a front-matter value into a list.
 *
 * The front-matter reader in `memory-file.js` is line-oriented and keeps values
 * as strings, so a list arrives as `[a, b]` or `a, b`; both are accepted, and
 * quotes are stripped.
 *
 * @param value - the raw field value.
 * @returns the entries, trimmed and unquoted.
 */
export function splitList(value) {
  const raw = String(value ?? '').trim()
  if (raw.length === 0) return []
  const inner = INLINE_LIST.exec(raw) === null ? raw : INLINE_LIST.exec(raw)[1]
  return inner
    .split(',')
    .map((entry) => entry.trim().replace(/^["']|["']$/g, ''))
    .filter((entry) => entry.length > 0)
}

/**
 * The trigger a memory file declares.
 *
 * `fields` is the parsed front-matter of a content file, as
 * `memory-file.js` produces it (`type`, `description`, `name`, and anything else
 * the file wrote — including `paths` and `trigger`).
 *
 * @param fields - the parsed front-matter fields.
 * @returns `{ trigger, globs }` where `globs` is empty unless the trigger is `glob`.
 */
export function parseJitTrigger(fields) {
  const source = fields === null || typeof fields !== 'object' ? {} : fields
  const declared = source.trigger
  if (declared === 'false' || declared === false || declared === 'manual') return { trigger: 'manual', globs: [] }
  if (declared === 'glob' || source.paths !== undefined || source.globs !== undefined) {
    const globs = splitList(source.paths ?? source.globs)
    // `trigger: glob` with no usable pattern would load never; Qoder falls back
    // to `always_on` when `paths` yields nothing, and so does this.
    if (globs.length > 0) return { trigger: 'glob', globs }
  }
  return { trigger: 'always_on', globs: [] }
}

/**
 * Whether a glob-triggered memory is active for the paths a session has touched.
 *
 * Matching is `picomatch` on forward-slashed paths with `dot: true` and
 * case-insensitive matching on Windows — the same options the exclude matcher
 * uses, because Qoder uses the same library for both.
 *
 * @param globs - the file's patterns.
 * @param touchedPaths - absolute or cwd-relative paths the session touched.
 * @param cwd - the session's working directory, to resolve relative paths.
 * @returns `true` when at least one pattern matches at least one touched path.
 */
export function isJitActive(globs, touchedPaths, cwd) {
  if (!Array.isArray(globs) || globs.length === 0) return false
  const patterns = globs.map((glob) => String(glob).replaceAll('\\', '/'))
  if (patterns.length === 0) return false
  const matcher = picomatch(patterns, { dot: true, nocase: process.platform === 'darwin' || process.platform === 'win32' })
  for (const touched of touchedPaths ?? []) {
    const value = String(touched ?? '')
      .trim()
      .replaceAll('\\', '/')
    if (value.length === 0) continue
    // Both the path as given and its path within the project are tried, so a
    // pattern may be written either absolute or project-relative.
    const base = String(cwd ?? '')
      .replaceAll('\\', '/')
      .replace(/\/$/, '')
    const candidates = [value]
    if (base.length > 0 && value.toLowerCase().startsWith(`${base.toLowerCase()}/`)) {
      candidates.push(value.slice(base.length + 1))
    }
    for (const candidate of candidates) {
      if (matcher(candidate)) return true
    }
  }
  return false
}

/**
 * The paths a session has touched, from the messages the model sees.
 *
 * Qoder matches a glob-triggered memory against the paths in play; the Harness
 * equivalent is `deriveMessages()`, which yields the projected conversation —
 * tool calls and their results included. Paths are taken as they appear and left
 * absolute or relative; {@link isJitActive} tries both against the session's cwd.
 *
 * @param session - the live session.
 * @returns the candidate paths, deduplicated.
 */
export function collectTouchedPaths(session) {
  const found = new Set()
  let messages = []
  try {
    messages = typeof session?.deriveMessages === 'function' ? session.deriveMessages() : []
  } catch {
    messages = []
  }
  const visit = (value) => {
    if (typeof value === 'string') {
      // A path-looking token: a drive path, a UNC path, or a slash path with a
      // file extension. Bare words are ignored, so prose does not match globs.
      for (const token of value.split(/[\s"'`()[\],;]+/)) {
        if (token.length < 3 || token.length > 512) continue
        if (/^[a-zA-Z]:[\\/]/.test(token) || token.startsWith('//') || /^\.{0,2}\//.test(token)) {
          if (/\.[a-zA-Z0-9]{1,8}$/.test(token)) found.add(token)
        }
      }
      return
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item)
      return
    }
    if (value !== null && typeof value === 'object') {
      for (const item of Object.values(value)) visit(item)
    }
  }
  visit(messages)
  return [...found]
}

/**
 * What to do with one considered file, given the session's touched paths.
 *
 * The decision is split out so it can be tested without a session: `always_on`
 * and non-glob files are unaffected, a `manual` file is never loaded on its own,
 * and a `glob` file needs a match.
 *
 * @param trigger - `{ trigger, globs }` from {@link parseJitTrigger}.
 * @param touchedPaths - paths the session has touched.
 * @param cwd - the session's working directory.
 * @returns `{ load, reason }` where `reason` explains a skip.
 */
export function jitDecision(trigger, touchedPaths, cwd) {
  const state = trigger ?? { trigger: 'always_on', globs: [] }
  if (state.trigger === 'manual') return { load: false, reason: 'manual only' }
  if (state.trigger !== 'glob') return { load: true, reason: 'always_on' }
  return isJitActive(state.globs, touchedPaths, cwd)
    ? { load: true, reason: JIT_LOAD_REASON }
    : { load: false, reason: `no touched path matches ${state.globs.join(', ')}` }
}
