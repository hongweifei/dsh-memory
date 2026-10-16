/**
 * Writing this plugin's own configuration, through the Harness's `configEditor`.
 *
 * The hard part is not the write, it is REFUSING one. A configuration this plugin rejects does not
 * merely fail to apply: `validateMemoryConfig` runs inside `apply()`, so the Loader's reconcile
 * throws and the plugin FAILS TO ACTIVATE — memory disappears from every session until somebody
 * edits the profile by hand. A write path that persists first and hopes the plugin accepts it is
 * therefore not a convenience, it is a way to break the installation.
 *
 * `configEditor.edit(entry, change)` is what lets us avoid that, and the harness's contract is why it
 * works: `change(current, inherited)` runs BEFORE the profile patch is persisted and again before the
 * config is resolved, so a throw inside the callback aborts the write. That is exactly where the
 * pre-flight check belongs.
 *
 * The scope vocabulary lives in `scopes.js` for a related reason: the flag pair a state means, and
 * the state a flag pair is in, must have one definition each.
 *
 * @module @dsh-external/dsh-memory/config-write
 */

import { Config } from './config.js'
import { validateMemoryConfig } from './config-rules.js'
import { PACKAGE_NAME } from '../core/constants.js'

/**
 * Merge one nested patch into a raw configuration, without mutating either.
 *
 * The patch is DEEP-merged rather than replacing: `edit` receives what the user wrote, which may be
 * a small object that leaves the rest to schema defaults, so replacing it would silently drop every
 * key the caller does not manage. Plain objects merge; anything else (arrays included) is replaced,
 * because a list edited in a form is a whole new list.
 *
 * @param current - the raw configuration as written.
 * @param patch - the change to apply.
 * @returns the next raw configuration.
 */
export function merge(current, patch) {
  const base = current !== null && typeof current === 'object' && !Array.isArray(current) ? current : {}
  const next = { ...base }
  for (const [key, value] of Object.entries(patch)) {
    const plain =
      value !== null && typeof value === 'object' && !Array.isArray(value) &&
      base[key] !== null && typeof base[key] === 'object' && !Array.isArray(base[key])
    next[key] = plain ? merge(base[key], value) : value
  }
  return next
}

/**
 * The configuration with `consumption.maxTokens` removed — the ONE spelling of "no limit".
 *
 * Qoder's own contract is an ABSENT field (its loader computes
 * `maxTokens ?? Number.POSITIVE_INFINITY`), so both writers of this value — the panel's budget route
 * and `/memory-budget unlimited` — delete the key rather than persist a zero or an `Infinity`.
 * Nothing is mutated: `edit` hands over the live raw configuration, and the result is a copy.
 *
 * @param current - the raw configuration as written.
 * @returns a copy without the cap (or the input unchanged when there is nothing to remove).
 */
export function withoutConsumptionCap(current) {
  if (current === null || typeof current !== 'object' || Array.isArray(current)) return current
  const consumption = current.consumption
  if (consumption === null || typeof consumption !== 'object' || Array.isArray(consumption)) return { ...current }
  const next = { ...consumption }
  delete next.maxTokens
  return { ...current, consumption: next }
}

/**
 * What the plugin would say about a next configuration, were the Loader to load it.
 *
 * Judged through the REAL schema and the REAL rules, in the order `apply()` uses them — not against
 * the patch, and not against a hand-rolled approximation. Two things make that necessary:
 *
 *   - A rule can be broken by a COMBINATION. This patch supplies `consumption.maxTokens`; a layer
 *     below supplies `mode: native`. Judging the patch alone sees neither.
 *   - A rule can be broken by a DEFAULT. `mode` defaults to `native` in the schema, so a profile that
 *     never mentions `mode` runs in the mode that refuses `consumption.*`. An earlier version of this
 *     function checked `raw.mode === 'native'` on the raw merge and therefore MISSED exactly that
 *     case — which is the common one, because `native` is the default.
 *
 * So the candidate config goes through `Config()` first (materializing every default the rules read),
 * then through `validateMemoryConfig`, which is what `apply()` does to the Loader's own output.
 *
 * @param next - the entry's own configuration after the patch.
 * @param inherited - the layers below the entry, as `edit` supplies them.
 * @returns the refusal message, or `undefined` when the configuration is acceptable.
 */
export function judgeConfig(next, inherited) {
  let schemaValidated
  try {
    // Merged for the same reason the patch is: `inherited` and `next` are both sparse, and a rule that
    // spans blocks needs the effective picture, not either half of it.
    schemaValidated = Config(merge(inherited ?? {}, next))
  } catch (error) {
    // The schema itself refuses it (a wrong type, an out-of-range number). That IS a refusal, and
    // letting it through would persist a configuration the Loader rejects.
    return `memory: ${error instanceof Error ? error.message : String(error)}`
  }
  try {
    validateMemoryConfig(schemaValidated)
    return undefined
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

/**
 * Write a change into this plugin's configuration, or refuse it.
 *
 * Two ways to describe the change, because they need different information:
 *
 *   - `patch` (the common one) — a nested object deep-merged into the raw config. Enough to set a
 *     value the caller already knows.
 *   - `options.mutation` — a function from the RAW config to the next one. Needed when the change
 *     depends on what the entry already holds, which a patch cannot express: a mode switch has to
 *     look at the existing blocks to decide what may stay. It runs inside `edit`'s callback, so it
 *     sees exactly the config that would be persisted.
 *
 * Either way the result is judged by the plugin's own rules BEFORE it is persisted.
 *
 * @param ctx - plugin context.
 * @param patch - the nested change, e.g. `{ consumption: { maxTokens: 1500 } }`.
 * @param options - `{ mutation }`, an alternative to `patch` for changes that read the current config.
 * @returns `{ ok: true }`, or `{ ok: false, kind, reason }` where `kind` is `'refused'` when the
 *   plugin would reject the configuration and `'unwritable'` when this composition has no writer.
 */
export async function writeConfig(ctx, patch, options = {}) {
  const editor = ctx.get('configEditor')
  if (typeof editor?.edit !== 'function') {
    return { ok: false, kind: 'unwritable', reason: 'this composition has no configEditor, so its configuration cannot be changed from here' }
  }
  // By module specifier: the entry's own `id` is a build-time patch id the plugin does not control.
  const entry = editor.entries().find((candidate) => candidate?.options?.name === PACKAGE_NAME)
  if (entry === undefined) {
    return { ok: false, kind: 'unwritable', reason: `no Loader entry for ${PACKAGE_NAME}; it is not an addressable config row here` }
  }
  const { mutation } = options
  try {
    await editor.edit(entry, (current, inherited) => {
      const next = typeof mutation === 'function' ? mutation(current) : merge(current, patch)
      const refused = judgeConfig(next, inherited)
      if (refused !== undefined) {
        // Thrown BEFORE the patch is persisted, so the profile keeps the configuration that works.
        throw new Error(refused)
      }
      return next
    })
    return { ok: true }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    // A refusal this plugin made is the caller's to fix; anything else is the environment's.
    return { ok: false, kind: reason.startsWith('memory:') ? 'refused' : 'unwritable', reason }
  }
}
