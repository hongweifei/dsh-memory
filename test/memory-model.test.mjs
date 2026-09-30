/**
 * Tests for the Qoder memory model: two scopes, an index, and typed content.
 *
 * The layout under test was decoded from the installed qodercli
 * (`docs/qoder-memory-model.md`), not guessed from the SDK docs — the SDK only
 * validates options and carries no default paths.
 *
 * Run: node test/memory-model.test.mjs
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

import {
  DEFAULT_MEMORY_TYPE,
  MEMORY_INDEX_FILE,
  MEMORY_TYPES,
  isContentFile,
  isIndexFile,
  parseMemoryFile,
  serializeMemoryFile,
} from '../lib/memory-file.js'
import { TRUNCATED_INDEX_NOTICE } from '../lib/constants.js'
import {
  INDEX_SECTION,
  INDEX_SECTION_UNKNOWN_LINE_LIMIT,
  PURPOSE_SECTION,
  READING_SECTION,
  SEARCH_SECTION,
  STALENESS_SECTION,
  TYPE_SECTION,
  autoMemorySystemPrompt,
  dreamSystemPrompt,
  scopeSection,
} from '../lib/memory-prompt.js'
import { projectKey, projectMemoryDir, userMemoryDir, resolveDshHome } from '../lib/paths.js'
import {
  DREAM_LOCK_FILE,
  DREAM_LOCK_STALE_MS,
  createDreamScheduler,
  dreamDue,
  dreamLockHeld,
  dreamLockPath,
  dreamStatePath,
  parseDreamLock,
} from '../lib/dream.js'

let passed = 0
const test = (label, fn) => {
  fn()
  passed += 1
  console.log(`  ok  ${label}`)
}

console.log('dsh-memory model tests')

// Captured before any fixture repoints `DSH_HOME` at a fake home: the live oracle below
// needs the real one.
const realDshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')

/* ---------------- the two scopes ---------------- */

test('the user scope is one directory shared by every project', () => {
  process.env.DSH_HOME = 'C:\\home\\.dsh'
  assert.equal(userMemoryDir(), join('C:\\home\\.dsh', 'memory'))
})

test('the project scope lives under the harness home, keyed the way the harness keys a project', () => {
  process.env.DSH_HOME = 'C:\\home\\.dsh'
  const dir = projectMemoryDir('C:\\work\\repo')
  assert.equal(dir, join('C:\\home\\.dsh', 'projects', '--C-work-repo--', 'memory'))
  assert.ok(!dir.includes('C:\\work\\repo'), 'project memory must not be written into the repository')
})

test('projectKey reproduces the names the harness itself writes', () => {
  // The algorithm, on shapes that cover it: a drive letter, a segment starting with a
  // dot, a hyphen-heavy name, and a POSIX path.
  assert.equal(projectKey('C:\\work\\app'), '--C-work-app--')
  assert.equal(projectKey('C:\\srv\\.config'), '--C-srv-.config--')
  assert.equal(projectKey('D:\\code\\Video-Image-Renderer'), '--D-code-Video-Image-Renderer--')
  assert.equal(projectKey('C:\\Temp\\probe-abc123'), '--C-Temp-probe-abc123--')
  assert.equal(projectKey('/srv/proj'), '--srv-proj--')
})

// The real oracle, when this machine has a session store: every project directory under
// `$DSH_HOME/sessions` was created by the harness from some session's cwd, and each session
// header records that cwd verbatim. Re-deriving the directory name from it must reproduce
// the name exactly — including a path the slug can only escape (`~5DE5`), which is why the
// check runs in this direction: a slug is lossy and cannot be decoded back.
const sessionsRoot = join(realDshHome, 'sessions')

/** Each project directory's recorded cwd, read from one session header. */
function recordedProjectCwds() {
  const found = new Map()
  if (!existsSync(sessionsRoot)) return found
  for (const name of readdirSync(sessionsRoot)) {
    const project = join(sessionsRoot, name)
    let sessions = []
    try {
      sessions = readdirSync(project)
    } catch {
      continue
    }
    for (const session of sessions) {
      const file = join(project, session, 'session.v4.jsonl.zstd')
      // A header is a few hundred bytes, so a huge log is not worth decompressing for it.
      if (!existsSync(file) || statSync(file).size > 8_000_000) continue
      try {
        const header = JSON.parse(zstdDecompressSync(readFileSync(file)).toString('utf8').split('\n')[0])
        if (typeof header.cwd === 'string' && header.cwd.length > 0) {
          found.set(name, header.cwd)
          break
        }
      } catch {
        /* an unreadable or older session format is not this test's business */
      }
    }
  }
  return found
}

const recordedCwds = recordedProjectCwds()
if (recordedCwds.size === 0) {
  console.log('  --  projectKey reproduces the name of every session directory (skipped: no readable session header)')
} else {
  test('projectKey reproduces the name of every session directory it created', () => {
    for (const [name, cwd] of recordedCwds) {
      assert.equal(projectKey(cwd), name, `${cwd} must key to ${name}`)
    }
  })
}

test('projectKey escapes what it cannot spell', () => {
  // A run of separators collapses to ONE dash (the harness's readable form).
  assert.equal(projectKey('C:\\\\a//b'), '--C-a-b--')
  assert.equal(projectKey('\\\\server\\share'), '--server-share--')
  // `~` is the escape lead, so a literal one escapes itself…
  assert.match(projectKey('C:\\a~b'), /~007E/)
  // …so an escaped character can never be confused with a literal tilde.
  assert.equal(projectKey('C:\\a b'), '--C-a~0020b--')
  // Non-ASCII is escaped rather than mangled into dashes.
  assert.match(projectKey('C:\\我的项目'), /~[0-9A-F]{4}/)
})

test('the harness project key is lossy, and that is inherited on purpose', () => {
  // A literal dash is indistinguishable from a separator in the readable form,
  // so these two directories share ONE project directory. The harness groups its
  // own sessions exactly the same way — this is its project grouping, not an
  // identifier this plugin invented, and matching it is the point.
  assert.equal(projectKey('D:\\a-b'), projectKey('D:\\a\\b'))
  // Two very long paths sharing the 251-character readable prefix also share one
  // directory: the harness adds no hash suffix (Qoder's own scheme did).
  const long = `C:\\${'segment\\'.repeat(40)}end`
  assert.equal(projectKey(long).length, 255, '251 readable characters inside two-dash wrappers')
  assert.equal(projectKey(long), projectKey(`C:\\${'segment\\'.repeat(40)}other`))
  // A path of separators only falls back to the harness's own `root`; an empty
  // path is rejected, exactly as the harness rejects it.
  assert.equal(projectKey('/'), '--root--')
  assert.throws(() => projectKey(''), /empty project path/)
})

/* ---------------- index vs content ---------------- */

test('MEMORY.md is the index and never content', () => {
  assert.equal(MEMORY_INDEX_FILE, 'MEMORY.md')
  assert.equal(isIndexFile('MEMORY.md'), true)
  assert.equal(isContentFile('MEMORY.md'), false)
})

test('content files are .md, non-index, and not hidden', () => {
  assert.equal(isContentFile('build-commands.md'), true)
  assert.equal(isContentFile('NOTES.MD'), true, 'the extension check is case-insensitive')
  assert.equal(isContentFile('.hidden.md'), false, 'dotfiles are never memory')
  assert.equal(isContentFile('notes.txt'), false)
  assert.equal(isContentFile('sub'), false)
})

/* ---------------- front-matter ---------------- */

test('a typed content file round-trips', () => {
  const entry = {
    name: 'Build commands',
    description: 'How to build and test this repository',
    type: 'project',
    content: 'Run `pnpm build`, then `pnpm test`.',
  }
  const text = serializeMemoryFile(entry)
  assert.match(text, /^---\n/)
  assert.match(text, /\ntype: project\n/)
  const parsed = parseMemoryFile('build-commands.md', text)
  // `fields` is the raw front-matter map, which the JIT trigger reader consumes;
  // the round-trip is about the four fields below.
  assert.deepEqual({ ...parsed, fields: undefined }, { ...entry, fields: undefined })
  assert.equal(parsed.fields.type, 'project')
})

test('every memory kind survives the round-trip', () => {
  for (const type of MEMORY_TYPES) {
    const parsed = parseMemoryFile('x.md', serializeMemoryFile({ name: 'n', description: 'd', type, content: 'c' }))
    assert.equal(parsed.type, type)
  }
})

test('an unknown or missing type falls back to project', () => {
  assert.equal(parseMemoryFile('x.md', 'no front matter at all').type, DEFAULT_MEMORY_TYPE)
  assert.equal(parseMemoryFile('x.md', '---\ntype: nonsense\n---\nbody').type, DEFAULT_MEMORY_TYPE)
  assert.equal(parseMemoryFile('x.md', '---\nname: only a name\n---\nbody').type, DEFAULT_MEMORY_TYPE)
})

test('a file without front-matter is all content', () => {
  const parsed = parseMemoryFile('legacy-notes.md', '# Heading\n\nBody text.')
  assert.equal(parsed.name, 'legacy-notes')
  assert.equal(parsed.description, '')
  assert.equal(parsed.content, '# Heading\n\nBody text.')
})

test('a name is optional and falls back to the file name', () => {
  const parsed = parseMemoryFile('deploy-steps.md', '---\ntype: project\n---\nbody')
  assert.equal(parsed.name, 'deploy-steps')
})

test('front-matter tolerates CRLF and extra whitespace', () => {
  const parsed = parseMemoryFile('x.md', '---\r\nname:   Spaced   \r\ntype: feedback\r\n---\r\n\r\nbody\r\n')
  assert.equal(parsed.name, 'Spaced')
  assert.equal(parsed.type, 'feedback')
  assert.equal(parsed.content, 'body')
})

test('serialize omits fields that carry no value', () => {
  const text = serializeMemoryFile({ name: '', description: '', type: 'user', content: 'body' })
  assert.ok(!text.includes('name:'), 'an empty name is omitted')
  assert.ok(!text.includes('description:'), 'an empty description is omitted')
  assert.match(text, /type: user/)
})

test('serialize rejects an unknown type by falling back', () => {
  assert.match(serializeMemoryFile({ type: 'bogus', content: 'x' }), /type: project/)
})

/* ---------------- dream scheduling ---------------- */

const ROOT = 'C:\\home\\.dsh\\memory'
const HOUR = 60 * 60 * 1000

test('a root that has never consolidated is due', () => {
  assert.equal(dreamDue({}, [ROOT], 24, 1_000_000), true)
  assert.equal(dreamDue(undefined, [ROOT], 24, 1_000_000), true)
})

test('a root inside the interval is not due', () => {
  const now = 1_000_000_000
  assert.equal(dreamDue({ [ROOT]: now - 23 * HOUR }, [ROOT], 24, now), false)
})

test('a root past the interval is due', () => {
  const now = 1_000_000_000
  assert.equal(dreamDue({ [ROOT]: now - 25 * HOUR }, [ROOT], 24, now), true)
})

test('one due root is enough among several', () => {
  const now = 1_000_000_000
  const state = { [ROOT]: now, 'C:\\other': now - 48 * HOUR }
  assert.equal(dreamDue(state, [ROOT, 'C:\\other'], 24, now), true)
  assert.equal(dreamDue(state, [ROOT], 24, now), false)
})

test('a corrupt timestamp is treated as never run', () => {
  const now = 1_000_000_000
  assert.equal(dreamDue({ [ROOT]: 'yesterday' }, [ROOT], 24, now), true)
  assert.equal(dreamDue({ [ROOT]: Number.NaN }, [ROOT], 24, now), true)
})

test('no roots means nothing to consolidate', () => {
  assert.equal(dreamDue({}, [], 24, 1_000_000), false)
})

test('minHours 0 consolidates on every opportunity', () => {
  const now = 1_000_000_000
  assert.equal(dreamDue({ [ROOT]: now }, [ROOT], 0, now), true)
})

/* ---------------- the generator's guide ---------------- */

test('the type section defines all four kinds', () => {
  for (const type of MEMORY_TYPES) assert.match(TYPE_SECTION, new RegExp(`\`${type}\``), `must define ${type}`)
  assert.match(TYPE_SECTION, /when_to_save/)
  assert.match(TYPE_SECTION, /include the why/)
})

test('the prompts carry Qoder\'s actual sentences, not paraphrases', () => {
  // These strings were decoded from the installed qodercli and must survive
  // verbatim; a paraphrase would mean the prompt drifted from the original.
  assert.match(PURPOSE_SECTION, /Memory is one of several persistence mechanisms available to you/)
  assert.match(PURPOSE_SECTION, /When to use or update a plan instead of memory/)
  assert.match(PURPOSE_SECTION, /When to use or update tasks instead of memory/)
  assert.match(STALENESS_SECTION, /frozen in time/)
  assert.match(STALENESS_SECTION, /is a claim that it existed \*when the memory was written\*/)
  assert.match(INDEX_SECTION, /It is an index, not a dump/)
  assert.match(INDEX_SECTION, /Never Read MEMORY\.md/)
  assert.match(READING_SECTION, /Do not read every file in a manifest/)
  assert.match(SEARCH_SECTION, /Use memory_search or memory_get first if duplication is likely\./)
  assert.match(
    SEARCH_SECTION,
    /Do not write duplicate memories\. First check if there is an existing memory you can update before writing a new one\./,
  )
  // The prompt names a tool this deployment calls something else; the mapping
  // has to be stated rather than silently corrected inside the quote.
  assert.match(SEARCH_SECTION, /memory_get` means "the read tool" here/)
})

test('the scope guidance quotes Qoder on where each kind belongs', () => {
  assert.match(TYPE_SECTION, /Save `feedback` or `reference` only when it applies across projects\./)
  assert.match(TYPE_SECTION, /Save `feedback` or `reference` only when it is specific to this project\./)
  // Both sentences are Qoder's; the port must not have merged them into advice.
  assert.ok(!TYPE_SECTION.includes('── port: a `feedback`'), 'recovered text must replace the paraphrase')
})

test('the index rules state the real limits and the prune duties', () => {
  assert.match(INDEX_SECTION, /under about 150 characters/)
  assert.match(INDEX_SECTION, /about 25KB/)
  assert.match(INDEX_SECTION, /stale, wrong, or superseded/)
  assert.match(INDEX_SECTION, /Demote verbose entries/)
  assert.match(INDEX_SECTION, /Resolve contradictions/)
  // Recovered verbatim, including the rule that the index holds no content.
  assert.match(
    INDEX_SECTION,
    /Keep each configured index concise: one line per memory, no frontmatter, and at most/,
  )
  assert.match(INDEX_SECTION, /Never put memory content directly in an index\./)
  // The line limit is a runtime constant inside qodercli, not a string in the
  // bundle, so the prompt must SAY it is unknown instead of guessing a number.
  assert.ok(INDEX_SECTION.includes(INDEX_SECTION_UNKNOWN_LINE_LIMIT), 'the unknown limit must be marked')
  assert.match(INDEX_SECTION, /⟨lines⟩ lines/)
  // And the un-recovered opening clause must be declared, not smoothed over.
  assert.match(INDEX_SECTION, /the recovered string starts mid-sentence/)
  assert.match(TRUNCATED_INDEX_NOTICE, /^Only part of it was loaded\./)
  assert.match(TRUNCATED_INDEX_NOTICE, /Keep index entries to one line under ~150 chars/)
})

test('the scope notes differ per scope exactly as Qoder words them', () => {
  const user = scopeSection({ id: 'user', path: 'C:\\home\\.dsh\\memory' })
  assert.match(user, /Memory scope: USER \(shared across all projects\)/)
  assert.match(user, /canonical user profile or preference file/)
  const project = scopeSection({ id: 'project', path: 'C:\\p' })
  assert.match(project, /Memory scope: PROJECT \(only this project\)/)
  assert.match(project, /Do not move project-only facts into USER scope/)
  // A custom root still gets a truthful header.
  assert.match(scopeSection({ id: 'team', path: '/srv/team' }), /Memory scope: TEAM/)
})

test('the auto-memory prompt assembles every section and the operator policy', () => {
  const prompt = autoMemorySystemPrompt([{ id: 'user', path: 'C:\\u', access: 'read-write' }], 'Only record deploy steps.')
  assert.match(prompt, /Memory types/)
  assert.match(prompt, /Memory scope: USER/)
  assert.match(prompt, /id "user": read-write/)
  assert.match(prompt, /Only record deploy steps\./)
  assert.match(prompt, /Never Read MEMORY\.md/)
  assert.match(prompt, /if duplication is likely/)
})

test('the auto-memory prompt omits the operator block when unset', () => {
  const prompt = autoMemorySystemPrompt([{ id: 'user', path: 'C:\\u', access: 'read-write' }], '')
  assert.ok(!prompt.includes('operator policy'))
})

test('the consolidation prompt keeps Qoder\'s phases and budget', () => {
  const prompt = dreamSystemPrompt([{ id: 'user', path: 'C:\\u', indexFile: 'MEMORY.md' }])
  assert.match(prompt, /^# Dream: Memory Consolidation/)
  assert.match(prompt, /reflective pass over persistent memory files/)
  assert.match(prompt, /## Operating Budget/)
  assert.match(prompt, /## Phase 1 - Orient/)
  assert.match(prompt, /## Phase 3 - Consolidate/)
  assert.match(prompt, /## Phase 4 - Prune And Index/)
  assert.match(prompt, /Merging new signal into existing topic files/)
  assert.match(prompt, /Converting relative dates/)
  assert.match(prompt, /exact repo paths, commands, artifacts, and verification evidence/)
  assert.match(prompt, /Do not exhaustively read transcripts/)
})

test('the prompt states the write budget the toolkit enforces', () => {
  // Reported live: a pass asked for a fifth file, the toolkit stopped it at four, and nothing
  // in the prompt had ever said four. A limit the model is not told about is a trap.
  const budget = { maxWrites: 4, maxWriteBytes: 16384 }
  const prompt = autoMemorySystemPrompt([{ id: 'user', path: 'C:\\u', access: 'read-write' }], '', budget)
  assert.match(prompt, /at most 4 files per pass across every scope \(the index counts as one of them\)/)
  assert.match(prompt, /at most 16384 bytes per file/)
  assert.match(prompt, /A write past the budget is not attempted/)

  // The consolidation pass enforces the same budget, so it is taught the same numbers.
  const dream = dreamSystemPrompt([{ id: 'user', path: 'C:\\u', indexFile: 'MEMORY.md' }], budget)
  assert.match(dream, /at most 4 files per pass across every scope/)

  // `0 = no cap` is this port's convention for these knobs; there is then nothing to teach.
  const uncapped = autoMemorySystemPrompt([{ id: 'user', path: 'C:\\u', access: 'read-write' }], '', {
    maxWrites: 0,
    maxWriteBytes: 0,
  })
  assert.doesNotMatch(uncapped, /budget this deployment enforces/)
})

test('the consolidation prompt tells the model that pruning means deleting', () => {
  const prompt = dreamSystemPrompt([{ id: 'user', path: 'C:\\u', indexFile: 'MEMORY.md' }])
  // Verbatim from qodercli, and the sentence that puts deletion in the model's job.
  assert.match(prompt, /Only create, edit, or delete memory files and indexes in directories marked read-write/)
  assert.match(prompt, /Pruning is deletion, not abandonment/)
  assert.match(prompt, /never claim a memory is retired while its file remains/)
  // And the old claim — that files cannot be deleted — must be gone for good.
  assert.doesNotMatch(prompt, /cannot delete files/)
})

test('the dream state file lives outside every memory root', () => {
  process.env.DSH_HOME = 'C:\\home\\.dsh'
  const path = dreamStatePath()
  assert.equal(path, join('C:\\home\\.dsh', 'dream-state.json'))
  assert.ok(!path.includes(join('memory', '')), 'state must not be listed as memory content')
})

/* ---------------- the consolidation lock ---------------- */

test('the consolidation lock keeps Qoder file name and staleness window', () => {
  process.env.DSH_HOME = 'C:\\home\\.dsh'
  assert.equal(DREAM_LOCK_FILE, '.consolidate-lock')
  assert.equal(DREAM_LOCK_STALE_MS, 3600000, 'decoded verbatim (`gfl = 36e5`)')
  assert.equal(dreamLockPath(), join('C:\\home\\.dsh', '.consolidate-lock'))
  assert.ok(!dreamLockPath().includes(join('memory', '')), 'a lock is not memory')
})

test('parseDreamLock accepts a bare pid and this port JSON form', () => {
  assert.deepEqual(parseDreamLock('1234'), { pid: 1234, startedAt: undefined })
  assert.deepEqual(parseDreamLock('  1234\n'), { pid: 1234, startedAt: undefined })
  assert.deepEqual(parseDreamLock('{"pid":42,"startedAt":1000}'), { pid: 42, startedAt: 1000 })
  // A JSON record without a usable instant still names a pid.
  assert.deepEqual(parseDreamLock('{"pid":42}'), { pid: 42, startedAt: undefined })
  for (const text of ['', '   ', 'not-a-pid', '0', '-5', '{"pid":"x"}', '{ broken']) {
    assert.equal(parseDreamLock(text), undefined, `${JSON.stringify(text)} must not parse`)
  }
})

test('dreamLockHeld only when a live PID holds a fresh claim', () => {
  const now = 1_000_000
  const alive = () => true
  const fresh = { pid: 42, startedAt: now - 1000 }
  assert.equal(dreamLockHeld(fresh, { now, alive }), true)
  assert.equal(dreamLockHeld(undefined, { now, alive }), false, 'no lock, no exclusion')
  assert.equal(dreamLockHeld(fresh, { now, alive: () => false }), false, 'a dead PID is reclaimable')
  assert.equal(
    dreamLockHeld({ pid: 42, startedAt: now - DREAM_LOCK_STALE_MS }, { now, alive }),
    false,
    'a claim at the window edge is stale',
  )
  assert.equal(
    dreamLockHeld({ pid: 42, startedAt: now - 1 }, { now, alive, staleMs: 1 }),
    false,
    'Qoder reclaims once the window closes',
  )
  // Qoder's bare-pid form carries no instant, and this provider has no mtime to
  // fall back on, so it cannot be proven live.
  assert.equal(dreamLockHeld({ pid: 42, startedAt: undefined }, { now, alive }), false)
})

test('a live lock makes the scheduler skip, a dead one does not', async () => {
  process.env.DSH_HOME = 'C:\\home\\.dsh'
  const lockingFs = (content) => {
    const files = new Map([[join('C:\\home\\.dsh', '.consolidate-lock'), content]])
    return {
      files,
      async resolve(path) {
        return { targetKey: String(path), displayPath: String(path) }
      },
      async stat(target) {
        return files.has(target.targetKey) ? { version: 'v1', type: 'file' } : undefined
      },
      async readText(target) {
        return files.get(target.targetKey)
      },
      async writeText(target, value) {
        files.set(target.targetKey, value)
        return { operation: 'create', version: 'v2' }
      },
    }
  }

  const run = async (fs) => {
    const state = {}
    const schedule = createDreamScheduler(
      { logger: { info() {}, warn() {} }, get: (name) => (name === 'fs' ? fs : undefined) },
      { generation: { dream: { enabled: true, minHours: 0 } } },
      async () => [{ id: 'user', path: 'C:\\home\\.dsh\\memory', access: 'read-write' }],
      state,
      new AbortController().signal,
    )
    await schedule({ session: { header: { cwd: 'C:\\proj' } } })
    return state
  }

  const held = await run(lockingFs(JSON.stringify({ pid: process.pid, startedAt: Date.now() })))
  assert.equal(held.lastDream, undefined, 'a live lock blocks the pass before it starts')

  const dead = await run(lockingFs(JSON.stringify({ pid: 999999, startedAt: Date.now() })))
  assert.ok(dead.lastDream !== undefined, 'a lock from an exited PID is reclaimed and the pass runs')
  assert.equal(dead.lastDream.status, 'skipped', 'no llm service in the double, so the pass skips')

  const stale = await run(lockingFs(JSON.stringify({ pid: process.pid, startedAt: Date.now() - DREAM_LOCK_STALE_MS - 1 })))
  assert.ok(stale.lastDream !== undefined, 'a stale claim no longer excludes')
})

/* ---------------- the dream scheduler ---------------- */

/** A minimal ctx double for the scheduler. */
const schedulerCtx = () => ({
  logger: { info() {}, warn() {} },
  get: () => undefined,
})

test('the scheduler does nothing while dream is disabled', async () => {
  let called = false
  const schedule = createDreamScheduler(
    schedulerCtx(),
    { generation: { dream: { enabled: false, minHours: 0 } } },
    async () => (called = true) || [],
    {},
    new AbortController().signal,
  )
  await schedule({ session: { header: { cwd: 'C:\\proj' } } })
  assert.equal(called, false, 'a disabled dream must not even resolve roots')
})

test('the scheduler stays silent when no scope is enabled', async () => {
  const state = {}
  const schedule = createDreamScheduler(
    schedulerCtx(),
    { generation: { dream: { enabled: true, minHours: 0 } } },
    async () => [],
    state,
    new AbortController().signal,
  )
  await schedule({ session: { header: { cwd: 'C:\\proj' } } })
  assert.equal(state.lastDream, undefined, 'nothing ran, so nothing is recorded')
})

test('the scheduler survives a roots resolver that throws', async () => {
  const state = {}
  const schedule = createDreamScheduler(
    schedulerCtx(),
    { generation: { dream: { enabled: true, minHours: 0 } } },
    async () => {
      throw new Error('fs unavailable')
    },
    state,
    new AbortController().signal,
  )
  await schedule({ session: { header: { cwd: 'C:\\proj' } } })
  assert.equal(state.lastDream, undefined)
})

console.log(`\n${passed} model tests passed`)
