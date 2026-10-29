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

/**
 * The `memory` tool's name, as the model sees it.
 *
 * Here rather than in `tools.js` because the PROMPT has to name the tool too — the journal section
 * tells the model which tool to call — and `memory-prompt.js` sits in a lower layer than `tools.js`,
 * so it cannot import it. One spelling, in the leaf both can read: a prompt that names a tool the
 * plugin does not register is a silent no-op.
 */
export const MEMORY_TOOL_NAME = 'memory'

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
 * The SDK refuses anything but a positive integer — but only when the field is PRESENT.
 * An absent cap is this plugin's DEFAULT (see `CONSUMPTION_DEFAULT_TOKENS`), and "no cap at
 * all" is the explicit string {@link CONSUMPTION_UNLIMITED}. So this constant is the floor for a
 * cap that IS set, and the range a control or a command may offer; `0` stays illegal, and
 * "inject nothing" is expressed as `consumption.enabled: false`.
 */
export const CONSUMPTION_MIN_TOKENS = 1

/**
 * The default injection budget, in tokens.
 *
 * A deployment that says nothing about the cap gets this one, so memory is bounded out of the
 * box instead of growing until it crowds out the conversation. It is a DEFAULT, not a rule: the
 * effective cap is whatever `consumption.maxTokens` says, and {@link CONSUMPTION_UNLIMITED} says
 * there is none at all.
 */
export const CONSUMPTION_DEFAULT_TOKENS = 5000

/**
 * The one spelling of "no injection cap" — a string, not a number and not `null`.
 *
 * It has to be a STRING for two reasons that are both about the Harness rather than about taste:
 *
 *   - The Loader writes an entry's configuration back through `Config.simplify` when the plugin
 *     updates itself, and schemastery's `simplify` DROPS a key whose value is `null` inside an
 *     object. A `null` sentinel would therefore vanish from the persisted profile on the next
 *     write-back, and the deployment would silently fall back to the default cap.
 *   - `null` is also the shape the panel's wire protocol already uses for "clear this", so a
 *     `null` in the CONFIGURATION would mean one thing on the wire and another on disk.
 *
 * A string survives both: it is validated, simplified and persisted verbatim, and it cannot be
 * confused with any token count.
 */
export const CONSUMPTION_UNLIMITED = 'unlimited'

/**
 * The numeric cap a configuration means, or `undefined` when it means "no cap".
 *
 * ONE reader for the whole plugin: the renderer, the identity hash, the log line and the panel
 * all have to agree on whether a configuration is bounded, and a second copy of this test is how a
 * budget silently stops applying to one of them.
 *
 * @param maxTokens - the configured cap: a positive integer, {@link CONSUMPTION_UNLIMITED}, or
 *   `undefined`.
 * @returns the cap in tokens, or `undefined` when there is none.
 */
export function consumptionCapTokens(maxTokens) {
  return typeof maxTokens === 'number' ? maxTokens : undefined
}

/** Root ids of the two built-in scopes; `paths` and `trust` both address them. */
export const USER_ROOT_ID = 'user'
export const PROJECT_ROOT_ID = 'project'

/**
 * The modes `update.mode` accepts, in ONE place.
 *
 * `check` (the default) fetches and compares; `auto` additionally fast-forwards a clean
 * tree at startup; `off` does not even fetch. The schema, the updater and the panel all
 * read this list, so none of them can offer a mode another refuses.
 */
export const UPDATE_MODES = Object.freeze(['off', 'check', 'auto'])

/** How long one update git command may take before it is killed. */
export const UPDATE_TIMEOUT_MS = 10_000

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
