/**
 * Writing this plugin's own configuration, through the Harness's `configEditor`.
 *
 * One implementation for both callers (the budget route and `/memory-scope`), because the two
 * things that make this safe are easy to get wrong twice: finding the right Loader entry, and
 * reporting honestly when there is no writer at all.
 *
 * `configEditor.edit(entry, change)` validates, persists and reconciles through the normal Loader
 * path, so ordinary lifecycle rules still apply. A composition without it — headless, ACP, SDK —
 * simply cannot be reconfigured from here, and says so rather than accepting a write it cannot
 * honour.
 *
 * @module @dsh-external/dsh-memory/config-write
 */

import { PACKAGE_NAME } from './constants.js'

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
 * Write one nested patch into this plugin's configuration.
 *
 * @param ctx - plugin context.
 * @param patch - the nested change, e.g. `{ consumption: { maxTokens: 1500 } }`.
 * @returns `{ ok: true }` or `{ ok: false, reason }` — a reason the caller can show a human.
 */
export async function writeConfig(ctx, patch) {
  const editor = ctx.get('configEditor')
  if (typeof editor?.edit !== 'function') {
    return { ok: false, reason: 'this composition has no configEditor, so its configuration cannot be changed from here' }
  }
  // By module specifier: the entry's own `id` is a build-time patch id the plugin does not control.
  const entry = editor.entries().find((candidate) => candidate?.options?.name === PACKAGE_NAME)
  if (entry === undefined) {
    return { ok: false, reason: `no Loader entry for ${PACKAGE_NAME}; it is not an addressable config row here` }
  }
  try {
    await editor.edit(entry, (current) => merge(current, patch))
    return { ok: true }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
}
