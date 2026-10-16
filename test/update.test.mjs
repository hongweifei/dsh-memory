/**
 * Self-update tests.
 *
 * Three layers, deliberately:
 *
 *   1. the pure words (`updateStatusOf`) and the git plumbing with an INJECTED runner, so every
 *      branch — unavailable, detached, behind, ahead, diverged, dirty, fetch failure — is reachable
 *      without a network or a repository;
 *   2. a REAL temporary repository pair (bare origin + clone) in the system temp directory, which
 *      exercises `gitRunner` end to end while staying offline;
 *   3. the plugin surface: `/api/memory/status`, `POST /api/memory/update`, `/memory-update`.
 *
 * Run: node test/update.test.mjs
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  applyUpdate,
  checkForUpdate,
  createUpdateService,
  gitRunner,
  packageRoot,
  updateStatusOf,
} from '../lib/core/update.js'
import { apply } from '../lib/index.js'
import { runUpdateAction, UPDATE_USAGE, updateLine } from '../lib/host/update-surface.js'
import { callRoute, loadConfig, makeAgent, makeCtx, makeFs, makeLlm, makeSession, runCommand } from './support/integration-harness.mjs'

let passed = 0
const test = async (label, fn) => {
  await fn()
  passed += 1
  console.log(`  ok  ${label}`)
}
/** Report a case as skipped rather than failing when the machine has no git. */
const testIf = async (condition, label, fn) => {
  if (condition) return test(label, fn)
  console.log(`  --  ${label} (skipped: git is not installed)`)
}

console.log('dsh-memory self-update tests')

/* ================= the words ================= */

await test('one word per pair of counts', () => {
  assert.equal(updateStatusOf({ ahead: 0, behind: 0 }), 'up-to-date')
  assert.equal(updateStatusOf({ ahead: 0, behind: 3 }), 'behind')
  assert.equal(updateStatusOf({ ahead: 2, behind: 0 }), 'ahead')
  assert.equal(updateStatusOf({ ahead: 2, behind: 3 }), 'diverged')
})

/* ================= the plumbing, with an injected runner ================= */

/** A scripted git: map of joined argv → `{ ok, stdout, stderr }`, plus a call log. */
function fakeGit(table) {
  const calls = []
  const run = async (args) => {
    calls.push(args.join(' '))
    const key = args.join(' ')
    for (const [pattern, value] of Object.entries(table)) {
      if (key === pattern) return typeof value === 'function' ? value(args) : value
    }
    return { ok: false, stdout: '', stderr: `unexpected git ${key}` }
  }
  run.calls = calls
  return run
}

const WORK_TREE = { 'rev-parse --is-inside-work-tree': { ok: true, stdout: 'true\n' } }
const BRANCH = { ...WORK_TREE, 'symbolic-ref --quiet --short HEAD': { ok: true, stdout: 'main\n' } }
const FETCH_OK = { 'fetch --quiet --prune --no-tags origin': { ok: true, stdout: '' } }

await test('the default checkout is this package, and it is a git work tree here', async () => {
  // `packageRoot` is derived from the module's own location: `lib/core/` two levels down.
  assert.equal(packageRoot.endsWith('dsh-memory'), true, packageRoot)
  const found = await checkForUpdate({ run: gitRunner(packageRoot) })
  // The suite must not depend on the state of the real checkout (it may legitimately be behind,
  // ahead, or dirty) — only on git answering at all.
  assert.notEqual(found.status, 'unavailable', found.reason)
  assert.equal(typeof found.branch, 'string')
})

await test('not a git checkout is reported, and nothing is fetched', async () => {
  const run = fakeGit({ 'rev-parse --is-inside-work-tree': { ok: false, stdout: '', stderr: 'fatal: not a git repository' } })
  const result = await checkForUpdate({ dir: 'X:/nowhere', run })
  assert.equal(result.status, 'unavailable')
  assert.match(result.reason, /not a git checkout/)
  assert.deepEqual(run.calls, ['rev-parse --is-inside-work-tree'], 'an unavailable checkout must not fetch')
})

await test('a detached HEAD is reported, never guessed at', async () => {
  const run = fakeGit({
    ...WORK_TREE,
    'symbolic-ref --quiet --short HEAD': { ok: false, stdout: '', stderr: 'fatal: ref HEAD is not a symbolic ref' },
  })
  const result = await checkForUpdate({ dir: 'X:/repo', run })
  assert.equal(result.status, 'unavailable')
  assert.match(result.reason, /detached/)
  assert.equal(run.calls.includes('fetch --quiet --prune --no-tags origin'), false)
})

await test('a failed fetch is a state with git’s own reason, not an exception', async () => {
  const run = fakeGit({
    ...BRANCH,
    'fetch --quiet --prune --no-tags origin': { ok: false, stdout: '', stderr: 'fatal: unable to access: Could not resolve host' },
  })
  const result = await checkForUpdate({ dir: 'X:/repo', run })
  assert.equal(result.status, 'unavailable')
  assert.match(result.reason, /Could not resolve host/)
})

await test('behind / ahead / diverged come from the rev-list counts', async () => {
  for (const [counts, want] of [['0\t2', 'behind'], ['3\t0', 'ahead'], ['1\t1', 'diverged'], ['0\t0', 'up-to-date']]) {
    const run = fakeGit({
      ...BRANCH,
      ...FETCH_OK,
      'rev-list --left-right --count HEAD...origin/main': { ok: true, stdout: `${counts}\n` },
      'rev-parse --short HEAD': { ok: true, stdout: 'aaaaaaa\n' },
      'rev-parse --short origin/main': { ok: true, stdout: 'bbbbbbb\n' },
    })
    const result = await checkForUpdate({ dir: 'X:/repo', run })
    assert.equal(result.status, want, `${counts} → ${want}`)
    assert.equal(result.current, 'aaaaaaa')
    assert.equal(result.latest, 'bbbbbbb')
  }
})

await test('a missing remote-tracking ref is reported, not crashed on', async () => {
  const run = fakeGit({
    ...BRANCH,
    ...FETCH_OK,
    'rev-list --left-right --count HEAD...origin/main': { ok: false, stdout: '', stderr: 'fatal: ambiguous argument' },
  })
  const result = await checkForUpdate({ dir: 'X:/repo', run })
  assert.equal(result.status, 'unavailable')
  assert.match(result.reason, /origin\/main does not exist/)
})

await test('a clean fast-forward pulls, and reports both ids', async () => {
  const run = fakeGit({
    ...BRANCH,
    ...FETCH_OK,
    'rev-list --left-right --count HEAD...origin/main': { ok: true, stdout: '0\t2\n' },
    'rev-parse --short HEAD': { ok: true, stdout: 'aaaaaaa\n' },
    'rev-parse --short origin/main': { ok: true, stdout: 'bbbbbbb\n' },
    'status --porcelain': { ok: true, stdout: '' },
    'pull --ff-only --quiet origin main': { ok: true, stdout: '' },
  })
  const result = await applyUpdate({ dir: 'X:/repo', run })
  assert.equal(result.status, 'updated')
  assert.equal(result.current, 'bbbbbbb', 'the checked-out id becomes the remote one')
  assert.equal(run.calls.includes('pull --ff-only --quiet origin main'), true)
})

await test('a DIRTY tree refuses, and never pulls', async () => {
  const run = fakeGit({
    ...BRANCH,
    ...FETCH_OK,
    'rev-list --left-right --count HEAD...origin/main': { ok: true, stdout: '0\t2\n' },
    'rev-parse --short HEAD': { ok: true, stdout: 'aaaaaaa\n' },
    'rev-parse --short origin/main': { ok: true, stdout: 'bbbbbbb\n' },
    'status --porcelain': { ok: true, stdout: ' M lib/client.js\n' },
  })
  const result = await applyUpdate({ dir: 'X:/repo', run })
  assert.equal(result.status, 'refused')
  assert.match(result.reason, /local changes/)
  assert.equal(run.calls.includes('pull --ff-only --quiet origin main'), false, 'refusing means NOT pulling')
})

await test('nothing to fast-forward is left alone', async () => {
  for (const [counts, want] of [['0\t0', 'up-to-date'], ['2\t0', 'ahead'], ['1\t1', 'diverged']]) {
    const run = fakeGit({
      ...BRANCH,
      ...FETCH_OK,
      'rev-list --left-right --count HEAD...origin/main': { ok: true, stdout: `${counts}\n` },
      'rev-parse --short HEAD': { ok: true, stdout: 'aaaaaaa\n' },
      'rev-parse --short origin/main': { ok: true, stdout: 'bbbbbbb\n' },
    })
    const result = await applyUpdate({ dir: 'X:/repo', run })
    assert.equal(result.status, want)
    assert.equal(run.calls.some((call) => call.startsWith('pull')), false, `${want} must not pull`)
  }
})

await test('a failed pull is a state with git’s reason', async () => {
  const run = fakeGit({
    ...BRANCH,
    ...FETCH_OK,
    'rev-list --left-right --count HEAD...origin/main': { ok: true, stdout: '0\t1\n' },
    'rev-parse --short HEAD': { ok: true, stdout: 'aaaaaaa\n' },
    'rev-parse --short origin/main': { ok: true, stdout: 'bbbbbbb\n' },
    'status --porcelain': { ok: true, stdout: '' },
    'pull --ff-only --quiet origin main': { ok: false, stdout: '', stderr: 'fatal: Not possible to fast-forward, aborting.' },
  })
  const result = await applyUpdate({ dir: 'X:/repo', run })
  assert.equal(result.status, 'failed')
  assert.match(result.reason, /Not possible to fast-forward/)
})

/* ================= the service ================= */

await test('mode off never runs git at all', async () => {
  const run = fakeGit({})
  const service = createUpdateService({ config: { update: { mode: 'off' } }, run })
  const status = await service.check()
  assert.equal(status.status, 'disabled')
  assert.deepEqual(run.calls, [])
  assert.equal((await service.apply()).status, 'disabled')
})

await test('a check is memoized while it is in flight, and the answer is retained', async () => {
  let fetches = 0
  const run = fakeGit({
    ...BRANCH,
    'fetch --quiet --prune --no-tags origin': () => {
      fetches += 1
      return { ok: true, stdout: '' }
    },
    'rev-list --left-right --count HEAD...origin/main': { ok: true, stdout: '0\t1\n' },
    'rev-parse --short HEAD': { ok: true, stdout: 'aaaaaaa\n' },
    'rev-parse --short origin/main': { ok: true, stdout: 'bbbbbbb\n' },
  })
  const service = createUpdateService({ config: { update: { mode: 'check' } }, run })
  const [first, second] = await Promise.all([service.check(), service.check()])
  assert.equal(fetches, 1, 'the panel polls /status; a fetch per poll would be rude')
  assert.equal(first.status, 'behind')
  assert.equal(second.status, 'behind')
  assert.equal(service.status().status, 'behind', 'the verdict is retained for /status')
  assert.equal(service.status().mode, 'check')
})

/* ================= the startup pass ================= */

/** A checkout one commit behind, clean, whose pull is allowed to succeed. */
const BEHIND_CLEAN = {
  ...BRANCH,
  ...FETCH_OK,
  'rev-list --left-right --count HEAD...origin/main': { ok: true, stdout: '0\t1\n' },
  'rev-parse --short HEAD': { ok: true, stdout: 'aaaaaaa\n' },
  'rev-parse --short origin/main': { ok: true, stdout: 'bbbbbbb\n' },
  'status --porcelain': { ok: true, stdout: '' },
  'pull --ff-only --quiet origin main': { ok: true, stdout: '' },
}

await test('the startup pass touches neither git nor the network when update.mode is off', async () => {
  const run = fakeGit({})
  const service = createUpdateService({ config: { update: { mode: 'off' } }, run })
  const result = await service.start()
  assert.equal(result.status, 'disabled')
  assert.deepEqual(run.calls, [], 'off means no git, not a check that happens to be ignored')
})

await test('the startup pass in check mode reports the verdict and never pulls', async () => {
  const run = fakeGit(BEHIND_CLEAN)
  const service = createUpdateService({ config: { update: { mode: 'check' } }, run })
  const result = await service.start()
  assert.equal(result.status, 'behind')
  assert.equal(run.calls.some((call) => call.startsWith('pull')), false, 'check must not mutate the checkout')
})

await test('the startup pass in auto mode fast-forwards exactly one clean behind checkout', async () => {
  const run = fakeGit(BEHIND_CLEAN)
  const service = createUpdateService({ config: { update: { mode: 'auto' } }, run })
  const result = await service.start()
  assert.equal(result.status, 'updated')
  assert.equal(run.calls.filter((call) => call.startsWith('pull')).length, 1)
  // The retained state is the POST-pull truth, and the panel still has to say "restart".
  assert.equal(service.status().status, 'up-to-date')
  assert.equal(service.status().justUpdated, true)
})

await test('auto mode leaves an ahead or diverged checkout alone', async () => {
  for (const counts of ['2\t0', '1\t1']) {
    const run = fakeGit({
      ...BRANCH,
      ...FETCH_OK,
      'rev-list --left-right --count HEAD...origin/main': { ok: true, stdout: `${counts}\n` },
      'rev-parse --short HEAD': { ok: true, stdout: 'aaaaaaa\n' },
      'rev-parse --short origin/main': { ok: true, stdout: 'bbbbbbb\n' },
    })
    const service = createUpdateService({ config: { update: { mode: 'auto' } }, run })
    await service.start()
    assert.equal(run.calls.some((call) => call.startsWith('pull')), false, `${counts} must not be pulled`)
    // Not just "no pull": auto must not enter the apply path at all — no cleanliness probe, no
    // second look at the counts. `apply` would refuse anyway, but only after more git calls.
    assert.equal(run.calls.some((call) => call.startsWith('status --porcelain')), false, `${counts} must not be applied`)
    // And the verdict already fetched must be reused: a second `fetch` would be a second network
    // round-trip at startup for an answer we are holding.
    assert.equal(run.calls.filter((call) => call.startsWith('fetch')).length, 1, `${counts} must not re-check`)
  }
})

await test('the startup pass turns a broken runner into a state, never a rejection', async () => {
  const service = createUpdateService({
    config: { update: { mode: 'auto' } },
    run: async () => {
      throw new Error('git is missing')
    },
  })
  const result = await service.start()
  assert.equal(result.status, 'unavailable')
  assert.match(result.reason, /git is missing/)
})

/* ================= the shared surface ================= */

await test('one line per update state, and the auto hint only where it applies', () => {
  assert.match(updateLine({ status: 'disabled' }, 'off'), /checks are switched off/)
  assert.match(updateLine({ status: 'behind', behind: 2, remote: 'origin', branch: 'main' }, 'check'), /BEHIND the remote · 2 commit\(s\) behind origin\/main/)
  assert.match(updateLine({ status: 'behind', behind: 1, remote: 'origin', branch: 'main' }, 'auto'), /next start fast-forwards/)
  assert.doesNotMatch(updateLine({ status: 'behind', behind: 1 }, 'check'), /fast-forwards/)
  assert.match(updateLine(undefined, 'check'), /not checked yet/)
  assert.match(updateLine({ status: 'updated', current: 'aaaaaaa', latest: 'bbbbbbb' }, 'auto'), /UPDATED · aaaaaaa → bbbbbbb/)
  assert.match(updateLine({ status: 'refused', reason: 'local changes' }, 'check'), /not applied · — local changes/)
})

await test('the three verbs, the usage sentence built from them, and nothing else', async () => {
  assert.equal(UPDATE_USAGE, 'status, check, or apply')
  const calls = []
  const service = {
    status: () => ({ status: 'idle' }),
    check: async () => {
      calls.push('check')
      return { status: 'up-to-date' }
    },
    apply: async () => {
      calls.push('apply')
      return { status: 'updated' }
    },
  }
  const read = await runUpdateAction(service, '  ', 'check')
  assert.equal(read.action, 'status')
  assert.deepEqual(calls, [], 'status is a read of the retained answer, not a git call')
  const checked = await runUpdateAction(service, 'CHECK', 'check')
  assert.equal(checked.result.status, 'up-to-date')
  const applied = await runUpdateAction(service, 'apply', 'auto')
  assert.equal(applied.result.status, 'updated')
  assert.deepEqual(calls, ['check', 'apply'])
  const bogus = await runUpdateAction(service, 'pull', 'check')
  assert.deepEqual(bogus, { action: 'pull', unknown: true })
  assert.deepEqual(calls, ['check', 'apply'], 'an unknown verb must not reach the service')
})

/* ================= a real repository pair (offline) ================= */

const hasGit = (() => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()

/** A bare origin plus a clone of it, with one extra commit waiting in the origin. */
function makeRepos() {
  const root = mkdtempSync(join(tmpdir(), 'dshmem-update-'))
  const work = join(root, 'work')
  const origin = join(root, 'origin.git')
  const clone = join(root, 'clone')
  const git = (cwd, args) => execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', ...args], { cwd, stdio: 'ignore' })
  git(root, ['init', '--quiet', '--initial-branch=main', 'work'])
  writeFileSync(join(work, 'file.txt'), 'one\n')
  git(work, ['add', '.'])
  git(work, ['commit', '--quiet', '-m', 'one'])
  git(root, ['init', '--quiet', '--bare', '--initial-branch=main', 'origin.git'])
  git(work, ['remote', 'add', 'origin', origin])
  git(work, ['push', '--quiet', '-u', 'origin', 'main'])
  git(root, ['clone', '--quiet', origin, 'clone'])
  // The commit the clone does not have yet.
  writeFileSync(join(work, 'file.txt'), 'two\n')
  git(work, ['commit', '--quiet', '-am', 'two'])
  git(work, ['push', '--quiet', 'origin', 'main'])
  return { root, work, origin, clone, git }
}

await testIf(hasGit, 'a real clone sees the new commit, fast-forwards, and is then up to date', async () => {
  const repos = makeRepos()
  try {
    const before = await checkForUpdate({ dir: repos.clone, timeoutMs: 30_000 })
    assert.equal(before.status, 'behind')
    assert.equal(before.behind, 1)
    assert.equal(before.branch, 'main')

    const applied = await applyUpdate({ dir: repos.clone, timeoutMs: 30_000 })
    assert.equal(applied.status, 'updated')
    assert.equal(applied.current, applied.latest)

    const after = await checkForUpdate({ dir: repos.clone, timeoutMs: 30_000 })
    assert.equal(after.status, 'up-to-date')
    // And the file really moved: the pull was not merely reported.
    assert.equal(execFileSync('git', ['-C', repos.clone, 'show', 'HEAD:file.txt'], { encoding: 'utf8' }), 'two\n')
  } finally {
    rmSync(repos.root, { recursive: true, force: true })
  }
})

await testIf(hasGit, 'auto mode on a real clone fast-forwards it at startup, and says the host half is stale', async () => {
  const repos = makeRepos()
  try {
    // The service is what `apply()` calls at startup, so this is the whole `update.mode: auto`
    // path with real git underneath: fetch, compare, pull, and the retained post-pull state.
    const service = createUpdateService({
      config: { update: { mode: 'auto', dir: repos.clone, timeoutMs: 30_000 } },
    })
    const result = await service.start()
    assert.equal(result.status, 'updated')
    assert.equal(execFileSync('git', ['-C', repos.clone, 'show', 'HEAD:file.txt'], { encoding: 'utf8' }), 'two\n')
    const state = service.status()
    assert.equal(state.status, 'up-to-date')
    assert.equal(state.justUpdated, true, 'the panel must still be told to restart')
  } finally {
    rmSync(repos.root, { recursive: true, force: true })
  }
})

await testIf(hasGit, 'a real dirty clone is refused, and the working tree survives', async () => {
  const repos = makeRepos()
  try {
    writeFileSync(join(repos.clone, 'file.txt'), 'my local edit\n')
    writeFileSync(join(repos.clone, 'scratch.txt'), 'untracked\n')
    const refused = await applyUpdate({ dir: repos.clone, timeoutMs: 30_000 })
    assert.equal(refused.status, 'refused')
    assert.match(refused.reason, /local changes/)
    // Nothing moved: the edit is still there and still uncommitted.
    assert.equal(execFileSync('git', ['-C', repos.clone, 'status', '--porcelain'], { encoding: 'utf8' }), ' M file.txt\n?? scratch.txt\n')
  } finally {
    rmSync(repos.root, { recursive: true, force: true })
  }
})

/* ================= the plugin surface ================= */

await testIf(hasGit, 'the panel sees the verdict, applies it, and then sees up-to-date', async () => {
  const repos = makeRepos()
  try {
    const fs = makeFs({})
    const { ctx, routes } = makeCtx(fs, makeLlm('{}'))
    apply(
      ctx,
      loadConfig({
        mode: 'custom',
        generation: { turnComplete: { enabled: false } },
        update: { mode: 'check', dir: repos.clone, timeoutMs: 30_000 },
      }),
    )

    // The startup check is fire-and-forget; the route's own `check` is what this asserts.
    const checked = await callRoute(routes, '/api/memory/update', { method: 'POST', body: { action: 'check' } })
    assert.equal(checked.status, 200)
    assert.equal(checked.json.update.status, 'behind')
    assert.equal(checked.json.update.behind, 1)
    assert.equal(checked.json.update.mode, 'check')

    // `/status` carries the same state, because the panel cannot run git itself.
    const status = await callRoute(routes, '/api/memory/status')
    assert.equal(status.json.update.status, 'behind')
    assert.equal(status.json.update.behind, 1)
    assert.equal(status.json.update.current === status.json.update.latest, false)

    const applied = await callRoute(routes, '/api/memory/update', { method: 'POST', body: { action: 'apply' } })
    assert.equal(applied.status, 200)
    assert.equal(applied.json.ok, true)
    assert.equal(applied.json.update.status, 'updated')

    const now = await callRoute(routes, '/api/memory/status')
    // The retained verdict is the POST-pull truth: keeping "1 commit behind" after the pull would
    // make the panel demand an update that has just happened. `justUpdated` is the one fact that
    // still has to be said out loud (the running host half is old until the next start).
    assert.equal(now.json.update.status, 'up-to-date')
    assert.equal(now.json.update.behind, 0)
    assert.equal(now.json.update.justUpdated, true)

    // The verbs are exact: anything else is a caller error, not a guess.
    const bad = await callRoute(routes, '/api/memory/update', { method: 'POST', body: { action: 'pull' } })
    assert.equal(bad.status, 400)
    assert.match(bad.json.error, /check.*apply/)
  } finally {
    rmSync(repos.root, { recursive: true, force: true })
  }
})

await testIf(hasGit, '/memory-update reports, checks and applies; /memory carries the line', async () => {
  const repos = makeRepos()
  try {
    const fs = makeFs({})
    const { ctx, commands } = makeCtx(fs, makeLlm('{}'))
    apply(
      ctx,
      loadConfig({
        mode: 'custom',
        generation: { turnComplete: { enabled: false } },
        update: { mode: 'check', dir: repos.clone, timeoutMs: 30_000 },
      }),
    )

    const spoken = await runCommand(commands, 'memory-update', { rawInput: 'check' })
    assert.equal(spoken.kind, 'success')
    assert.match(spoken.text, /BEHIND the remote/)
    assert.match(spoken.text, /1 commit\(s\) behind origin\/main/)

    const applied = await runCommand(commands, 'memory-update', { rawInput: 'apply' })
    assert.equal(applied.kind, 'success')
    assert.match(applied.text, /UPDATED/)
    assert.match(applied.text, /restart `dsh web`/, 'an update that cannot take effect yet must say so')

    const after = await runCommand(commands, 'memory-update', {})
    assert.match(after.text, /update: up to date/)

    const report = await runCommand(commands, 'memory', { agent: makeAgent(makeSession([], 'C:\\proj')) })
    assert.match(report.text, /update: up to date/)

    const bogus = await runCommand(commands, 'memory-update', { rawInput: 'upgrade' })
    assert.equal(bogus.kind, 'error')
    assert.match(bogus.text, /status, check, or apply/)
  } finally {
    rmSync(repos.root, { recursive: true, force: true })
  }
})

await test('with update.mode off the command says so and runs no git', async () => {
  const fs = makeFs({})
  const { ctx, routes, commands } = makeCtx(fs, makeLlm('{}'))
  // The harness turns self-update OFF for every fixture; this asserts what that looks like.
  apply(ctx, loadConfig({ mode: 'custom', generation: { turnComplete: { enabled: false } } }))

  const status = await callRoute(routes, '/api/memory/status')
  assert.equal(status.json.update.mode, 'off')
  assert.equal(status.json.update.status, 'disabled')

  const spoken = await runCommand(commands, 'memory-update')
  assert.match(spoken.text, /checks are switched off/)

  const report = await runCommand(commands, 'memory', { agent: makeAgent(makeSession([], 'C:\\proj')) })
  assert.doesNotMatch(report.text, /update:/, 'an off switch is not reported as a line about updates')
})

console.log(`\n${passed} self-update tests passed`)
