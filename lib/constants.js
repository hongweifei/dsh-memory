/**
 * Shared vocabulary of the memory model.
 *
 * These live in their own leaf module because both `paths`/`memory-file` (which
 * describe the layout) and the passes (which use it) need them, and the layering
 * forbids a lower module from importing a higher one.
 *
 * @module @dsh-external/dsh-memory/constants
 */

/** The index file name inside a memory root. It is an index, never content. */
export const MEMORY_INDEX_FILE = 'MEMORY.md'

/** The four memory kinds, in Qoder's vocabulary. */
export const MEMORY_TYPES = ['user', 'feedback', 'project', 'reference']

/** Applied when a content file omits or misspells `type`. */
export const DEFAULT_MEMORY_TYPE = 'project'

/**
 * This package's own id, as the Loader names it.
 *
 * Needed to find the plugin's own config entry (`Entry.options.name`) for `configEditor.edit`, so
 * the settings route and the slash command cannot disagree on the spelling.
 */
export const PACKAGE_NAME = '@dsh-external/dsh-memory'

/**
 * The floor on `consumption.maxTokens`, in ONE place.
 *
 * The SDK's rule and the schema's `min(1)`, and now also the range a control or a command may
 * offer — the three must agree, or a surface ends up offering a value the plugin then refuses.
 * `0` is deliberately not a legal value: `render.js` would honour it, but the configuration layer
 * rejects it first, so "inject nothing" is expressed as `consumption.enabled: false` instead.
 */
export const CONSUMPTION_MIN_TOKENS = 1

/** Root ids of the two built-in scopes; `paths` and `trust` both address them. */
export const USER_ROOT_ID = 'user'
export const PROJECT_ROOT_ID = 'project'

/**
 * Whether a configured write budget is in force, from ONE expression.
 *
 * `0` means "no cap" — and now that it is the DEFAULT for both write knobs, every enforcement site
 * must ask this rather than compare against the number directly. A bare
 * `bytes > maxWriteBytes` reads `0` as "the limit is zero bytes" and refuses EVERY write, which is
 * exactly what changing the default would have done to all four call sites (the `memory` tool's
 * `write` and `edit`, the background pass, and the panel's save route).
 *
 * @param limit - the configured `maxWrites` / `maxWriteBytes`.
 * @returns `true` when the limit is a positive number and must be enforced.
 */
export function isBudgetEnforced(limit) {
  return typeof limit === 'number' && Number.isFinite(limit) && limit > 0
}

/**
 * Qoder's notice for an index that did not load whole.
 *
 * Verbatim from qodercli: "Only part of it was loaded. Keep index entries to one
 * line under ~150 chars; move detail into topic files." It belongs here rather
 * than in `memory-prompt.js` because the renderer needs it too — the renderer and
 * the prompt are the same layer, so neither may import the other.
 */
export const TRUNCATED_INDEX_NOTICE =
  'Only part of it was loaded. Keep index entries to one line under ~150 chars; move detail into topic files.'
