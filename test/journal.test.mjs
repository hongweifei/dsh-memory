/**
 * The daily journal: Qoder's `action: "add"`, `target: "daily"` surface.
 *
 * The contract and every number here come from the installed `qodercli` bundle, decoded rather than
 * recalled — see `docs/qoder-memory-model.md` § the journal. The point of the suite is the three
 * properties that make the port honest:
 *
 *   1. The PLUGIN names the file and the date; the model supplies only bullets.
 *   2. A day APPENDS. Several passes and several sessions share one file.
 *   3. The journal is INVISIBLE to injection — it lives in a subdirectory, so it can never grow the
 *      context as days accumulate.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { resolveMemoryConfig } from '../lib/config/config.js'
import { listRootFiles } from '../lib/core/fs.js'
import {
  JOURNAL_BULLET_CHARS,
  JOURNAL_DIR,
  JOURNAL_MAX_BULLETS,
  journalDate,
  journalEntry,
  journalHasEntryFor,
  journalRelativePath,
  journalWarnings,
} from '../lib/memory/journal.js'
import { autoMemorySystemPrompt } from '../lib/memory/memory-prompt.js'
import { createMemoryToolkit } from '../lib/pipeline/memory-agent.js'
import { applyJournalEntry } from '../lib/memory/memory-pass.js'

/** A fake `fs` whose listing is derived from what was actually written.
 *
 * `resolve` returns a TARGET OBJECT, as the harness does — keying on `String(target)` would collapse
 * every file onto `'[object Object]'` and make an append look correct by accident.
 */
function makeFs(seed = {}) {
  const files = new Map(Object.entries(seed).map(([path, text]) => [path, { text, version: 1 }]))
  // `join` is platform-dependent, so keys are normalised to forward slashes: otherwise every lookup
  // written with `/` misses on Windows, and the failure reads as "the journal did not write".
  const keyOf = (target) => String(target?.path ?? target).replace(/\\/g, '/')
  return {
    files,
    async resolve(path) { return { path: String(path) } },
    async stat(target) {
      const key = keyOf(target)
      const hit = files.get(key)
      if (hit !== undefined) return { type: 'file', version: hit.version, size: hit.text.length }
      // A DIRECTORY has to be reported too. Without this, `listRootFiles` bails out on
      // `info.type !== 'directory'` before it ever filters, so "the journal is invisible to
      // injection" would pass for the wrong reason — it would pass even with a root-level file.
      const prefix = `${key.replace(/\/$/, '')}/`
      if ([...files.keys()].some((candidate) => candidate.startsWith(prefix))) return { type: 'directory' }
      return undefined
    },
    async readText(target) { return files.get(keyOf(target)).text },
    async writeText(target, content, intent) {
      const key = keyOf(target)
      if (intent.kind === 'createIfAbsent' && files.has(key)) { const e = new Error('exists'); e.code = 'FS_STALE_VERSION'; throw e }
      if (intent.kind === 'replaceIfVersion') {
        const hit = files.get(key)
        if (hit === undefined || hit.version !== intent.version) { const e = new Error('stale'); e.code = 'FS_STALE_VERSION'; throw e }
      }
      files.set(key, { text: content, version: (files.get(key)?.version ?? 0) + 1 })
      return { version: files.get(key).version }
    },
    async listDir(dir) {
      const base = keyOf(dir).replace(/\/$/, '')
      const seen = new Map()
      for (const key of files.keys()) {
        if (!key.startsWith(base)) continue
        const rest = key.slice(base.length).replace(/^\/+/, '')
        const cut = rest.indexOf('/')
        if (cut === -1) seen.set(rest, { type: 'file', name: rest, size: files.get(key).text.length })
        else seen.set(rest.slice(0, cut), { type: 'directory', name: rest.slice(0, cut) })
      }
      return [...seen.values()]
    },
  }
}

const ROOT = { id: 'project', path: '/mem/project', access: 'read-write', indexFile: 'MEMORY.md' }
const USER_ROOT = { id: 'user', path: '/mem/user', access: 'read-write', indexFile: 'MEMORY.md' }

const ctxFor = (fs) => ({ get: (name) => (name === 'fs' ? fs : undefined), logger: { info() {}, warn() {} } })

const journalConfig = (overrides = {}) =>
  resolveMemoryConfig(
    { mode: 'custom', generation: { journal: { enabled: true, scope: 'project', ...overrides } } },
    {},
  )

/* ---- the date and the path are computed, never supplied by the model ---- */

test('the journal date is the LOCAL calendar day', () => {
  // Not `toISOString().slice(0,10)`: in UTC+8 that rolls over at 08:00 local, so an evening's work
  // would be filed under tomorrow. The file that must make sense is the one a human opens.
  const localEvening = new Date(2026, 9, 15, 23, 30, 0)
  assert.equal(journalDate(localEvening), '2026-10-15')
  const localMorning = new Date(2026, 9, 15, 0, 30, 0)
  assert.equal(journalDate(localMorning), '2026-10-15')
  // Both ends of one local day agree, even though a UTC-derived name would split them.
  assert.equal(journalDate(localEvening), journalDate(localMorning))
})

test('the journal path is a dated file inside the journal subdirectory', () => {
  assert.equal(journalRelativePath('2026-10-15'), 'journal/2026-10-15.md')
  assert.equal(JOURNAL_DIR, 'journal')
  // The path must already be acceptable to the root guard, or every write would be refused.
  assert.match(journalRelativePath('2026-10-15'), /\.md$/)
})

test('an entry carries the time and a short session id, so a day reads as a timeline', () => {
  const at = new Date(2026, 9, 15, 9, 5, 0)
  const entry = journalEntry({ content: '- did a thing', sessionId: 'abcdef1234567890', now: at })
  assert.match(entry, /^## 09:05 · abcdef12\n/)
  assert.match(entry, /- did a thing/)
  // A full id is noise in a file a person reads; the short form is still enough to trace a line back.
  assert.doesNotMatch(entry, /abcdef1234567890/)
  // No session at all is still a valid entry.
  assert.match(journalEntry({ content: '- x', now: at }), /^## 09:05\n/)
})

/* ---- the bullet limits are advisory, exactly as Qoder has them ---- */

test('Qoder\'s numbers are the ones encoded, not remembered', () => {
  assert.equal(JOURNAL_MAX_BULLETS, 8)
  assert.equal(JOURNAL_BULLET_CHARS, 120)
})

test('an entry within the stated shape reports nothing', () => {
  assert.equal(journalWarnings('- one\n- two\n- three'), undefined)
  assert.equal(journalWarnings(`- ${'x'.repeat(JOURNAL_BULLET_CHARS)}`), undefined)
})

test('an over-long entry is REPORTED, never refused', () => {
  // Qoder states these limits in prose and has no rejection path for them anywhere in the bundle —
  // the same shape as the index's "about 25KB". A journal that stopped recording because a bullet ran
  // long would be worse than a slightly verbose one.
  const tooMany = Array.from({ length: 9 }, (_, i) => `- bullet ${i}`).join('\n')
  const many = journalWarnings(tooMany)
  assert.match(many, /9 bullets/)
  assert.match(many, /8/)
  assert.match(many, /kept as written/, 'the wording must say the entry was kept, not rejected')

  const long = journalWarnings(`- ${'y'.repeat(200)}`)
  assert.match(long, /200 characters/)
  assert.match(long, /120/)
  assert.match(long, /kept as written/)

  // Blank lines and prose are not bullets, so neither counts.
  assert.equal(journalWarnings('# heading\n\nprose only, no bullets'), undefined)
})

test('journalHasEntryFor tells a repeat of the same hour apart from a new one', () => {
  const at = new Date(2026, 9, 15, 9, 5, 0)
  const existing = journalEntry({ content: '- x', now: at })
  assert.equal(journalHasEntryFor(existing, at), true)
  assert.equal(journalHasEntryFor(existing, new Date(2026, 9, 15, 10, 0, 0)), false)
  assert.equal(journalHasEntryFor(undefined, at), false)
  assert.equal(journalHasEntryFor('', at), false)
})

/* ---- the write goes through the guarded path ---- */

test('the journal writes to journal/<date>.md under the configured scope', async () => {
  const fs = makeFs()
  const at = new Date(2026, 9, 15, 9, 5, 0)
  const outcome = await applyJournalEntry(
    ctxFor(fs), journalConfig(), new Map([[ROOT.id, ROOT]]),
    { content: '- first bullet', sessionId: 'sess1', now: at }, undefined, undefined,
  )
  assert.equal(outcome.error, undefined, JSON.stringify(outcome))
  assert.equal(outcome.file.path, 'journal/2026-10-15.md')
  assert.equal(outcome.file.rootId, 'project')
  assert.equal(outcome.file.journal, true)
  const text = fs.files.get('/mem/project/journal/2026-10-15.md').text
  assert.match(text, /^# 2026-10-15/)
  assert.match(text, /- first bullet/)
})

test('a second entry the same day APPENDS instead of replacing', async () => {
  // The property the whole feature turns on: a day accumulates several passes and several sessions.
  // `memory_write` replaces, so a journal built on it would keep only the last pass of the day.
  const fs = makeFs()
  const ctx = ctxFor(fs)
  const roots = new Map([[ROOT.id, ROOT]])
  await applyJournalEntry(ctx, journalConfig(), roots, { content: '- morning work', now: new Date(2026, 9, 15, 9, 0) }, undefined, undefined)
  await applyJournalEntry(ctx, journalConfig(), roots, { content: '- afternoon work', now: new Date(2026, 9, 15, 15, 0) }, undefined, undefined)
  const text = fs.files.get('/mem/project/journal/2026-10-15.md').text
  assert.match(text, /- morning work/, 'the first entry survives')
  assert.match(text, /- afternoon work/, 'and the second is added')
  assert.equal(text.match(/^# 2026-10-15$/gm).length, 1, 'one heading for the day, not one per entry')
  assert.equal(text.match(/^## /gm).length, 2, 'one block per entry')
})

test('two different days are two different files', async () => {
  const fs = makeFs()
  const ctx = ctxFor(fs)
  const roots = new Map([[ROOT.id, ROOT]])
  await applyJournalEntry(ctx, journalConfig(), roots, { content: '- day one', now: new Date(2026, 9, 15, 9, 0) }, undefined, undefined)
  await applyJournalEntry(ctx, journalConfig(), roots, { content: '- day two', now: new Date(2026, 9, 16, 9, 0) }, undefined, undefined)
  assert.ok(fs.files.has('/mem/project/journal/2026-10-15.md'))
  assert.ok(fs.files.has('/mem/project/journal/2026-10-16.md'))
})

test('the journal refuses an empty entry and a read-only root', async () => {
  const fs = makeFs()
  const ctx = ctxFor(fs)
  const empty = await applyJournalEntry(ctx, journalConfig(), new Map([['project', ROOT]]), { content: '   ' }, undefined, undefined)
  assert.match(empty.error, /non-empty/)

  const readOnly = { ...ROOT, access: 'read' }
  const refused = await applyJournalEntry(ctx, journalConfig(), new Map([['project', readOnly]]), { content: '- x' }, undefined, undefined)
  assert.match(refused.error, /read-only/)

  const missing = await applyJournalEntry(ctx, journalConfig(), new Map(), { content: '- x' }, undefined, undefined)
  assert.match(missing.error, /not enabled/)
  assert.equal(fs.files.size, 0, 'nothing was written by a refused call')
})

test('the scope setting decides which root the journal is filed into', async () => {
  const fs = makeFs()
  const roots = new Map([[ROOT.id, ROOT], [USER_ROOT.id, USER_ROOT]])
  const outcome = await applyJournalEntry(
    ctxFor(fs), journalConfig({ scope: 'user' }), roots,
    { content: '- shared note', now: new Date(2026, 9, 15, 9, 0) }, undefined, undefined,
  )
  assert.equal(outcome.file.rootId, 'user')
  assert.ok(fs.files.has('/mem/user/journal/2026-10-15.md'))
  assert.equal(fs.files.has('/mem/project/journal/2026-10-15.md'), false)
})

/* ---- the property that keeps the context from growing: it is never injected ---- */

test('the journal is INVISIBLE to injection because it is nested', async () => {
  // `listRootFiles` reads a root's top level only, so a nested file is not memory content. This is
  // the reason the journal is in a subdirectory at all: a root-level `2026-10-15.md` would be
  // injected on every step, and a month of them would crowd out the memory they complement.
  const fs = makeFs()
  const ctx = ctxFor(fs)
  await applyJournalEntry(ctx, journalConfig(), new Map([[ROOT.id, ROOT]]), { content: '- a day', now: new Date(2026, 9, 15, 9, 0) }, undefined, undefined)

  const entries = await fs.listDir({ path: ROOT.path })
  assert.deepEqual(entries.map((entry) => entry.name), ['journal'], 'the directory exists and is all that is at top level')
  assert.deepEqual(await listRootFiles(fs, ROOT, undefined), [], 'and injection sees nothing')

  // Control: a top-level content file IS seen, so the empty result above is the filter working and
  // not a listing stub that would return [] for anything.
  fs.files.set('/mem/project/NOTES.md', { text: '---\nname: N\n---\n\nbody', version: 1 })
  assert.deepEqual(await listRootFiles(fs, ROOT, undefined), ['NOTES.md'], 'the control file must be visible')

  // The CONSEQUENCE, pinned deliberately: `memory list/read/search` all read through `listRootFiles`,
  // so the journal is invisible to them too. That is a trade, not an oversight — the journal is a log
  // for a human, not retrievable memory — and it must not be "fixed" by moving the file to the root,
  // which would put a month of days into every injection.
  const { searchMemory } = await import('../lib/memory/memory-search.js')
  const found = await searchMemory(ctx, [ROOT], 'a day', {}, undefined)
  assert.equal(found.hits.length, 0, 'search does not reach the journal')
  // Positive control: the SAME search DOES reach the top-level file, so the zero above is the filter
  // and not a search that finds nothing for any query.
  const control = await searchMemory(ctx, [ROOT], 'body', {}, undefined)
  assert.equal(control.hits.length, 1, 'the control file is searchable, so the zero above means something')
})

/* ---- the tool surface the model actually calls ---- */

test('the toolkit files `target: "daily"` through the journal, not through memory_write', async () => {
  const fs = makeFs()
  const ctx = ctxFor(fs)
  const toolkit = createMemoryToolkit(ctx, journalConfig(), [ROOT], undefined, { id: 'sess1' })
  const result = await toolkit.execute('memory_write', { target: 'daily', content: '- wired up' })
  assert.match(result.text, /journal\/\d{4}-\d{2}-\d{2}\.md/)
  assert.equal(result.isError, undefined)

  const outcome = toolkit.result('')
  assert.equal(outcome.status, 'saved')
  assert.equal(outcome.writtenFiles.length, 1)
  assert.equal(outcome.writtenFiles[0].journal, true, 'the file is marked as a journal entry')
})

test('no rootId or path is needed for a daily entry, and an unknown target is refused', async () => {
  // Qoder's invocation sends content only, plus a chat_id the framework interpolates. A model that
  // has to invent a path is a model that can mis-file an entry.
  const fs = makeFs()
  const toolkit = createMemoryToolkit(ctxFor(fs), journalConfig(), [ROOT], undefined, { id: 'sess1' })
  const ok = await toolkit.execute('memory_write', { target: 'daily', content: '- no path given' })
  assert.doesNotMatch(ok.text, /refused/)

  const bad = await toolkit.execute('memory_write', { target: 'weekly', content: '- x' })
  assert.equal(bad.isError, true)
  assert.match(bad.text, /unknown target/)
})

test('a daily entry counts against the per-pass write budget like any other write', async () => {
  // It IS a write. Exempting it would make the budget a lie the moment the journal was enabled.
  const fs = makeFs()
  const config = resolveMemoryConfig({ mode: 'custom', generation: { maxWrites: 1, journal: { enabled: true } } }, {})
  const toolkit = createMemoryToolkit(ctxFor(fs), config, [ROOT], undefined, { id: 'sess1' })
  const first = await toolkit.execute('memory_write', { target: 'daily', content: '- one' })
  assert.doesNotMatch(first.text, /not attempted/)
  const second = await toolkit.execute('memory_write', { target: 'daily', content: '- two' })
  assert.match(second.text, /not attempted/)
  const outcome = toolkit.result('')
  assert.equal(outcome.deferredFiles.length, 1, 'deferred, not failed')
  assert.equal(outcome.status, 'saved')
})

/* ---- the prompt only teaches the journal when it is on ---- */

test('the prompt carries Qoder\'s journal wording, with the date filled in', () => {
  const at = new Date(2026, 9, 15, 9, 0)
  const text = autoMemorySystemPrompt([ROOT], '', {}, { enabled: true, scope: 'project', now: at })
  // Verbatim lines from the bundle.
  assert.match(text, /\*\*Daily Memory Journal\*\*: After the memory review above/)
  assert.match(text, /Bullet-point list, max 8 bullets, each <=120 chars/)
  assert.match(text, /Write all daily memory items in a single tool call\. If nothing qualifies, skip daily memory\./)
  assert.match(text, /EXCLUDE: information already in MEMORY\.md/)
  // And the port's additions: the real tool name and the date the plugin will file under.
  assert.match(text, /Call `memory` with `action: "add"`, `target: "daily"`/)
  assert.match(text, /Today's date is 2026-10-15/)
  // The model is told NOT to invent a path, because the plugin chooses one.
  assert.match(text, /the plugin names the file, so do not put a date or a path in the content/)
})

test('the journal section is absent while the journal is off', () => {
  // Teaching a tool call the toolkit would refuse is how a prompt promises what the plugin will not do.
  const off = autoMemorySystemPrompt([ROOT], '', {}, { enabled: false, scope: 'project' })
  assert.doesNotMatch(off, /Daily Memory Journal/)
  assert.doesNotMatch(off, /target: "daily"/)
})

test('the journal is OFF by default and files into the project scope', () => {
  const config = resolveMemoryConfig({ mode: 'custom' }, {})
  assert.equal(config.generation.journal.enabled, false)
  assert.equal(config.generation.journal.scope, 'project')
})

test('the journal is a generation.* key, so native mode prunes it like the rest', async () => {
  // The `native` gate is not special-cased anywhere: `pruneForNative` walks the block, so a new key is
  // covered by construction. This pins that, because the day it stops being true the panel would
  // offer a control whose write makes the plugin fail to activate.
  const { pruneForNative } = await import('../lib/config/config-rules.js')
  const pruned = pruneForNative({ mode: 'custom', generation: { journal: { enabled: true }, onResult: () => {} } })
  assert.deepEqual(pruned.dropped, ['generation.journal'])
  assert.equal('journal' in (pruned.config.generation ?? {}), false)
  assert.equal(typeof pruned.config.generation.onResult, 'function', 'native keeps the callback')
})
