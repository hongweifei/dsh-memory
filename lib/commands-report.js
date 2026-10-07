/**
 * The command layer's pure reporting: the tables and one-line renderers, with no context.
 *
 * Split out of `commands.js` when the command registry outgrew its 500-line budget. Everything here
 * is a pure function of a domain value — the tables an operator reads when a session is quiet, and
 * the one-line renderers `/memory` prints — so it lives outside the registry that calls it, and it
 * imports nothing at all: that is what lets it sit below `commands.js` in the layering.
 *
 * @module @dsh-external/dsh-memory/commands-report
 */

/**
 * What each GLOBAL scope setting means, in one sentence.
 *
 * The global layer is what every `auto` session follows, so a session's own mode is meaningless
 * without being able to see it — which is why `/memory-switch` reports the mode and `/memory-scope`
 * reports the layer underneath.
 */
export const GLOBAL_CONSEQUENCE = {
  all: 'every configured scope is loaded and recorded (user + project)',
  project: 'cross-project (user-scope) memory is excluded everywhere: no session loads or records it',
  user: 'project memory is excluded everywhere: only cross-project knowledge is used',
}

/**
 * What each session mode means, in one sentence, for `/memory-switch` and `/memory`.
 *
 * A table rather than an inline ternary chain: the three states are the whole point of the feature,
 * and a reader should be able to see all three at once.
 */
export const MODE_CONSEQUENCE = {
  auto: 'following the global configuration: every configured scope is loaded and recorded',
  project: 'project memory only — cross-project (user-scope) knowledge is neither loaded nor recorded',
  off: 'nothing is injected into this session, and nothing from it is recorded',
}

/**
 * Render the trust snapshot as a single line, plus the consequence when the gate is on and this
 * folder is not trusted.
 *
 * @param trust - a `trustState()` snapshot.
 * @returns the lines to report.
 */
export function describeTrust(trust) {
  if (!trust.enabled) {
    return ['trust: disabled (every folder is trusted; set trust.enabled to gate project memory)']
  }
  const folders = trust.folders.length > 0 ? trust.folders.join(', ') : '(none)'
  return [
    `trust: enabled trusted=${trust.trusted} folder=${trust.folder}`,
    `trusted folders: ${folders}`,
    ...(trust.trusted ? [] : ['project scope is skipped here: run `/memory-trust allow` to trust this folder']),
  ]
}

/**
 * Render the project identity memory is scoped to.
 *
 * Both halves are worth showing: the directory the harness would group this session under, and the
 * workspace record when the registry knows one — that id is the harness's stable anchor, while the
 * path is what the key is built from.
 *
 * @param identity - a `resolveProjectIdentity()` result.
 * @returns the lines to report.
 */
export function describeProject(identity) {
  return [`project: ${identity.path} (key ${identity.key}, workspace ${identity.workspaceId ?? 'none'})`]
}
