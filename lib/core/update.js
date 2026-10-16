/**
 * Self-update: is this checkout behind its git remote, and may it be fast-forwarded?
 *
 * A DSH bundle is installed as a package, and this one is normally a `link:` to the
 * checkout it was developed in, so "updating the plugin" means FAST-FORWARDING THAT
 * CHECKOUT. The Harness exposes no runtime reload for a host half (`plugin_manager`
 * has `install_bundle` / `list_plugins` / `list_bundles` and nothing that re-reads a
 * loaded bundle), so an update can only take effect on the next start: every result
 * here says so rather than pretending the running process changed.
 *
 * Four rules shape the whole module:
 *
 *   - **Check ≠ mutate.** `mode: check` (the default) fetches and compares; it never
 *     touches the working tree. Pulling is a deliberate act (`mode: auto` at startup,
 *     or the panel's button / `/memory-update`).
 *   - **Fast-forward only.** `git pull --ff-only`, never a merge/rebase/reset: a local
 *     commit is a human decision, and this module must not resolve it silently.
 *   - **A dirty tree is refused, not stashed.** Uncommitted work is the normal state of
 *     a checkout somebody is editing; stashing it would move a developer's work out
 *     from under them.
 *   - **Failure is a state, not an exception.** No git, no remote, no network, a
 *     detached HEAD — each gets its own word and reason, so the panel can say which.
 *
 * @module @dsh-external/dsh-memory/update
 */

import { execFile } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { UPDATE_MODES, UPDATE_TIMEOUT_MS } from './constants.js'

/**
 * The checkout this module belongs to (`lib/core/` → the package root).
 *
 * The same path `test/discovery.test.mjs` resolves through the manifest, but derived
 * from this file's own location so it works from a copy as well as from a link.
 */
export const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

/**
 * The default git runner: one `execFile` per command, never a shell.
 *
 * `GIT_TERMINAL_PROMPT=0` matters more than it looks: a fetch against a remote that
 * wants credentials would otherwise block a startup check forever, with no output and
 * no way for the panel to explain itself.
 *
 * @param dir - the working directory to run in.
 * @param options - `{ timeoutMs }`.
 * @returns a function from argv to `{ ok, stdout, stderr, error? }`.
 */
export function gitRunner(dir, options = {}) {
  const timeoutMs = options.timeoutMs ?? UPDATE_TIMEOUT_MS
  return (args) =>
    new Promise((resolve) => {
      execFile(
        'git',
        args,
        {
          cwd: dir,
          timeout: timeoutMs,
          windowsHide: true,
          // No prompt, no askpass, no credential-manager popup: a background check may
          // never wait on a human.
          env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '', GCM_INTERACTIVE: 'never' },
        },
        (error, stdout, stderr) => {
          const out = String(stdout ?? '')
          const err = String(stderr ?? '')
          if (error === null || error === undefined) {
            resolve({ ok: true, stdout: out, stderr: err })
            return
          }
          // `error.message` is what says "not a git repository" / "timed out"; stderr is
          // what says "could not resolve host". Both are worth keeping.
          const detail = err.trim().split('\n').filter((line) => line.trim().length > 0).pop()
          resolve({ ok: false, stdout: out, stderr: err, error: detail ?? error.message })
        },
      )
    })
}

/** The first non-empty line of git's stderr, for a reason a person can read. */
function firstLine(text) {
  const line = String(text ?? '')
    .split('\n')
    .map((part) => part.trim())
    .find((part) => part.length > 0)
  return line ?? ''
}

/**
 * The one word for a pair of counts.
 *
 * @param counts - `{ ahead, behind }`.
 * @returns `'up-to-date' | 'behind' | 'ahead' | 'diverged'`.
 */
export function updateStatusOf(counts) {
  if (counts.ahead === 0 && counts.behind === 0) return 'up-to-date'
  if (counts.behind > 0 && counts.ahead === 0) return 'behind'
  if (counts.ahead > 0 && counts.behind === 0) return 'ahead'
  return 'diverged'
}

/**
 * Is this directory a git work tree at all?
 *
 * @param run - the git runner.
 * @returns `true` / `false`; a missing git binary is also `false` (the reason travels).
 */
async function isWorkTree(run) {
  const result = await run(['rev-parse', '--is-inside-work-tree'])
  return result.ok === true && result.stdout.trim() === 'true'
}

/**
 * The branch to compare against, when the caller did not name one.
 *
 * A detached HEAD has no branch to fast-forward, so it reports itself instead of
 * guessing `master` or `main`.
 *
 * @param run - the git runner.
 * @param configured - the configured branch, or `''`.
 * @returns `{ branch }` or `{ reason }`.
 */
async function resolveBranch(run, configured) {
  if (typeof configured === 'string' && configured.trim().length > 0) return { branch: configured.trim() }
  const symbolic = await run(['symbolic-ref', '--quiet', '--short', 'HEAD'])
  if (symbolic.ok === true && symbolic.stdout.trim().length > 0) return { branch: symbolic.stdout.trim() }
  return { reason: 'HEAD is detached, so there is no branch to fast-forward' }
}

/**
 * Fetch the remote and compare the checked-out branch with its remote-tracking ref.
 *
 * @param options - `{ dir, remote, branch, timeoutMs, run }`.
 * @returns `{ status, behind, ahead, current, latest, branch, remote }`, or
 *   `{ status: 'unavailable', reason }` when git cannot answer.
 */
export async function checkForUpdate(options = {}) {
  const dir = options.dir ?? packageRoot
  const remote = typeof options.remote === 'string' && options.remote.length > 0 ? options.remote : 'origin'
  const run = options.run ?? gitRunner(dir, { timeoutMs: options.timeoutMs })

  if (!(await isWorkTree(run))) {
    return { status: 'unavailable', dir, reason: 'not a git checkout (or git is not installed)' }
  }
  const resolved = await resolveBranch(run, options.branch)
  if (resolved.reason !== undefined) return { status: 'unavailable', dir, reason: resolved.reason }
  const branch = resolved.branch

  // `--no-tags`: a check that downloads every tag is slower than the thing it checks.
  const fetched = await run(['fetch', '--quiet', '--prune', '--no-tags', remote])
  if (fetched.ok !== true) {
    return {
      status: 'unavailable',
      dir,
      branch,
      remote,
      reason: `could not fetch ${remote}: ${firstLine(fetched.error ?? fetched.stderr) || 'unknown error'}`,
    }
  }

  const tracking = `${remote}/${branch}`
  const counts = await run(['rev-list', '--left-right', '--count', `HEAD...${tracking}`])
  if (counts.ok !== true) {
    return { status: 'unavailable', dir, branch, remote, reason: `${tracking} does not exist (${firstLine(counts.error ?? counts.stderr)})` }
  }
  const [aheadRaw, behindRaw] = counts.stdout.trim().split(/\s+/)
  const ahead = Number(aheadRaw)
  const behind = Number(behindRaw)
  if (!Number.isInteger(ahead) || !Number.isInteger(behind)) {
    return { status: 'unavailable', dir, branch, remote, reason: `could not read commit counts from ${tracking}` }
  }

  const current = await run(['rev-parse', '--short', 'HEAD'])
  const latest = await run(['rev-parse', '--short', tracking])
  return {
    status: updateStatusOf({ ahead, behind }),
    dir,
    branch,
    remote,
    ahead,
    behind,
    current: current.ok === true ? current.stdout.trim() : undefined,
    latest: latest.ok === true ? latest.stdout.trim() : undefined,
  }
}

/**
 * Whether the working tree has changes a fast-forward must not run over.
 *
 * @param run - the git runner.
 * @returns `true` when anything is modified, staged, or untracked.
 */
async function isDirty(run) {
  const result = await run(['status', '--porcelain'])
  return result.ok === true && result.stdout.trim().length > 0
}

/**
 * Fast-forward the checkout, or refuse and say why.
 *
 * The decision order is the contract: an unavailable/up-to-date/ahead/diverged state is
 * never pulled, and a dirty tree is refused BEFORE the pull (so nothing is half-applied).
 *
 * @param options - `{ dir, remote, branch, timeoutMs, run, requireClean }`.
 * @returns `{ status, ... }` where status is `'updated' | 'up-to-date' | 'ahead' |
 *   'diverged' | 'unavailable' | 'refused' | 'failed'`.
 */
export async function applyUpdate(options = {}) {
  const dir = options.dir ?? packageRoot
  const run = options.run ?? gitRunner(dir, { timeoutMs: options.timeoutMs })
  const checked = await checkForUpdate({ ...options, dir, run })
  if (checked.status !== 'behind') return checked
  if (options.requireClean !== false && (await isDirty(run))) {
    return {
      ...checked,
      status: 'refused',
      reason: 'the working tree has local changes; commit or stash them, then update again',
    }
  }
  const pulled = await run(['pull', '--ff-only', '--quiet', checked.remote, checked.branch])
  if (pulled.ok !== true) {
    return { ...checked, status: 'failed', reason: firstLine(pulled.error ?? pulled.stderr) || 'git pull failed' }
  }
  return {
    ...checked,
    status: 'updated',
    current: checked.latest,
  }
}

/**
 * The cached updater the plugin shares: one check at a time, one retained answer.
 *
 * The panel polls `/status` every few seconds while it is open, so the check must not
 * be re-run per poll — a `git fetch` each time would be rude to the network and to the
 * user's CPU. `check()` is memoized while in flight and until the next explicit call.
 *
 * @param options - `{ config, logger, run, dir }`.
 * @returns `{ check, apply, start, mode, status }`.
 */
export function createUpdateService(options = {}) {
  const settings = options.config?.update ?? {}
  const mode = UPDATE_MODES.includes(settings.mode) ? settings.mode : 'check'
  const dir = typeof settings.dir === 'string' && settings.dir.length > 0 ? settings.dir : packageRoot
  const base = {
    dir,
    remote: typeof settings.remote === 'string' && settings.remote.length > 0 ? settings.remote : 'origin',
    branch: typeof settings.branch === 'string' ? settings.branch : '',
    timeoutMs: typeof settings.timeoutMs === 'number' ? settings.timeoutMs : UPDATE_TIMEOUT_MS,
  }
  const run = options.run ?? gitRunner(dir, { timeoutMs: base.timeoutMs })
  const logger = options.logger

  let state = mode === 'off' ? { status: 'disabled', reason: 'update checks are switched off' } : { status: 'unknown' }
  let inFlight

  const settle = (next) => {
    state = { ...next, mode, checkedAt: new Date().toISOString() }
    return state
  }

  const check = () => {
    if (mode === 'off') return Promise.resolve(state)
    if (inFlight !== undefined) return inFlight
    inFlight = checkForUpdate({ ...base, run })
      .then(settle)
      .catch((error) => settle({ status: 'unavailable', reason: error instanceof Error ? error.message : String(error) }))
      .finally(() => {
        inFlight = undefined
      })
    return inFlight
  }

  const apply = () => {
    if (mode === 'off') return Promise.resolve(state)
    if (inFlight !== undefined) return inFlight
    inFlight = applyUpdate({ ...base, run })
      .then((result) => {
        if (result.status === 'updated') {
          logger?.info('memory: updated %s (%s → %s)', dir, result.current, result.latest)
          // The pull moved HEAD onto the ref we compared against, so the RETAINED state is
          // "up to date" — keeping `behind: 1` would make /status demand an update that has just
          // happened. `justUpdated` keeps the one fact the panel still has to say out loud (the
          // running host half is old until the next start), and the caller gets the action
          // verdict (`updated`) back as the return value.
          state = { ...result, status: 'up-to-date', behind: 0, ahead: 0, justUpdated: true, mode, checkedAt: new Date().toISOString() }
          return { ...result, mode, checkedAt: state.checkedAt }
        }
        if (result.status === 'refused' || result.status === 'failed') {
          logger?.warn('memory: update %s: %s', result.status, result.reason)
        }
        return settle(result)
      })
      .catch((error) => settle({ status: 'failed', reason: error instanceof Error ? error.message : String(error) }))
      .finally(() => {
        inFlight = undefined
      })
    return inFlight
  }

  /**
   * The startup pass, owned here rather than by the wiring.
   *
   * Order is the whole point: check first, and only a `behind` verdict in `auto` mode may pull,
   * so a diverged or dirty checkout is never touched. The result is deliberately NOT awaited by
   * `apply()` — a slow remote must not delay the plugin's own wiring — but it IS logged, because
   * an update nobody mentions is an update nobody installs. A failure is a warning, never a
   * thrown error: the plugin's job is memory, and a broken remote must not cost the user that.
   *
   * @returns a promise for the final result (or the encountered error), for tests to await.
   */
  const start = () => {
    if (mode === 'off') return Promise.resolve({ ...state, mode })
    return check()
      .then((first) => (mode === 'auto' && first.status === 'behind' ? apply() : first))
      .then((result) => {
        logger?.info('memory: self-update %s%s', result.status, result.reason === undefined ? '' : ` (${result.reason})`)
        return result
      })
      .catch((error) => {
        logger?.warn('memory: self-update check failed: %o', error)
        return error
      })
  }

  return {
    check,
    apply,
    start,
    mode: () => mode,
    status: () => ({ ...state, mode }),
  }
}
