/**
 * The global-scope vocabulary: the state names a control may offer, and the two flags they mean.
 *
 * A leaf module with no imports, so the writer, the routes, the session switch and the panel can all
 * agree on what `user` means without any of them importing each other. Both directions live here on
 * purpose — the flag pair a state means, and the state a flag pair is in — because a control and the
 * route behind it that disagree about that are how one word comes to mean two things.
 *
 * @module @dsh-external/dsh-memory/scopes
 */

/**
 * The global scope states a control may OFFER, in the order to offer them: both scopes, the
 * cross-project one, the per-project one.
 *
 * This is the ONE order for all three values everywhere — the panel's dropdown, the route's refusal
 * message and `/memory-scope`'s usage hint all read this array — because two orders for the same
 * three states is how a reader concludes they are different things.
 *
 * `none` (both scopes off) is deliberately absent. It is a legal configuration and it is still
 * REPORTED — see {@link describeGlobalScopes} — but offering it would be a fourth way to say "no
 * memory at all" beside `enabled: false`, and it is not something a settings row should hand
 * somebody by accident.
 */
export const GLOBAL_SCOPE_CHOICES = Object.freeze(['all', 'user', 'project'])

/**
 * The two scope flags one global state means.
 *
 * @param scopes - `'all' | 'user' | 'project'`.
 * @returns `{ userScope, projectScope }`, or `undefined` when the state is not writable.
 */
export function scopeFields(scopes) {
  if (scopes === 'all') return { userScope: true, projectScope: true }
  if (scopes === 'user') return { userScope: true, projectScope: false }
  if (scopes === 'project') return { userScope: false, projectScope: true }
  return undefined
}

/**
 * The global state a configuration is in, in the same vocabulary.
 *
 * All FOUR combinations are reported, not just "both" vs "project": `userScope: true` with
 * `projectScope: false` is legal — it is exactly what `scopeFields('user')` writes — and collapsing
 * it to `all` would tell the user the opposite of the truth.
 *
 * @param config - the resolved configuration.
 * @returns `'all' | 'project' | 'user' | 'none'`.
 */
export function describeGlobalScopes(config) {
  const user = config.userScope !== false
  const project = config.projectScope !== false
  if (user && project) return 'all'
  return project ? 'project' : user ? 'user' : 'none'
}
