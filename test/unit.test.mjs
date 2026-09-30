/**
 * Focused unit tests for dsh-memory's pure helpers and Config schema.
 * Run: node test/unit.test.mjs
 */
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deleteGuarded, memoryWritePolicy, readVersioned } from '../lib/fs.js'
import { FAILURE_PAUSE_DEFAULT, advanceFailurePause, pausedOutcome, resumePaused } from '../lib/failure-pause.js'
import { collectTouchedPaths, isJitActive, jitDecision, parseJitTrigger } from '../lib/jit.js'
import { indexWarnings } from '../lib/memory-file.js'
import {
  Config,
  estimateMessage,
  safeRelativePath,
  joinRoot,
  renderMemoryContext,
  memoryMessage,
  isMemoryMessage,
  parsePlan,
  textOf,
  memoryIdentity,
  generationSystemPrompt,
  validateRoots,
  validateConsumptionFiles,
  resolveMemoryConfig,
  resolveDshHome,
  folderContains,
  isFolderTrusted,
  effectiveTrustedFolders,
  trustStorePath,
  findHits,
  formatSearchResult,
  normalizeExcludes,
  isExcluded,
  partitionExcluded,
  classifyLargeFiles,
  classifyFailedFiles,
  memoryChangeReport,
  LARGE_FILE_CHARS,
  isImportPath,
  parseImports,
  codeFenceRanges,
  flattenImportTree,
  importParentMap,
  isAllowedImport,
  resolveTarget,
  hashText,
  memoryBlockHash,
  memoryDelta,
  renderMemoryDelta,
  readBooleanEnv,
  turnIntervalAllows,
  collectTranscript,
} from '../lib/index.js'

let passed = 0
const test = (label, fn) => {
  fn()
  passed += 1
  console.log(`  ok  ${label}`)
}

console.log('dsh-memory unit tests')

/* ================= Config schema ================= */

const validate = (raw) => Config['~standard'].validate(raw)
const accepted = (raw) => {
  const result = validate(raw)
  assert.equal(result.issues, undefined, `expected acceptance, got ${JSON.stringify(result.issues)}`)
  return result.value
}
const rejected = (raw) => {
  const result = validate(raw)
  assert.ok(result.issues !== undefined && result.issues.length > 0, 'expected a validation issue')
  return result.issues
}

test('Config is a native schemastery schema (Config inspector can project it)', () => {
  assert.equal(Reflect.get(Config, Symbol.for('schemastery')), true)
  assert.equal(typeof Config.type, 'string')
  assert.equal(typeof Config.meta, 'object')
})

test('the schema defaults the top-level switches', () => {
  const value = accepted({})
  assert.equal(value.enabled, true)
  assert.equal(value.mode, 'native')
  assert.equal(value.userScope, true)
  assert.equal(value.projectScope, true)
})

test('the nested blocks stay sparse so the SDK rules remain checkable', () => {
  // No field defaults inside generation/consumption: an absent key must stay
  // absent, because native mode only accepts `onResult` and
  // `turnComplete.enabled` conflicts with `generation.enabled: false`.
  const value = accepted({})
  assert.equal(value.generation.enabled, undefined)
  assert.equal(value.generation.prompt, undefined)
  assert.equal(value.consumption.maxTokens, undefined)
  assert.equal(value.consumption.overflow, undefined)
})

test('resolveMemoryConfig fills the plugin defaults', () => {
  const resolved = resolveMemoryConfig(accepted({}))
  assert.equal(resolved.generation.enabled, true)
  // The generation output cap is this port's own knob (the original's memory options
  // have no token field at all), and 0 means "no cap": the adapter's default applies,
  // which is the only budget that fits a model writing file bodies through tools.
  assert.equal(resolved.generation.maxOutputTokens, 0)
  assert.deepEqual(resolved.generation.turnComplete, {
    enabled: true,
    minPromptChars: 40,
    timeoutMs: 10000,
    onGateError: 'skip',
  })
  assert.equal(resolved.consumption.maxTokens, 2000)
  assert.equal(resolved.consumption.overflow, 'truncate')
  assert.equal(resolved.consumption.failureMode, 'best_effort')
})

test('resolveMemoryConfig keeps explicit values over defaults', () => {
  const resolved = resolveMemoryConfig(
    accepted({ mode: 'custom', generation: { prompt: 'only deploys' }, consumption: { maxTokens: 500 } }),
  )
  assert.equal(resolved.generation.prompt, 'only deploys')
  assert.equal(resolved.consumption.maxTokens, 500)
  assert.equal(resolved.generation.maxWrites, 4)
})

test('mode rejects an unknown value', () => {
  assert.match(rejected({ mode: 'nope' })[0].message, /expected "native" \| "custom"/)
})

test('turnComplete.onGateError rejects an unknown value', () => {
  assert.match(
    rejected({ generation: { turnComplete: { onGateError: 'nope' } } })[0].message,
    /expected "skip" \| "report_failed"/,
  )
})

test('consumption.overflow rejects an unknown value', () => {
  assert.match(rejected({ consumption: { overflow: 'nope' } })[0].message, /expected "truncate" \| "fail_query"/)
})

/* ---- roots / files: validated in apply(), mirroring the SDK's layering ---- */

test('validateRoots accepts a well-formed custom root list', () => {
  const roots = validateRoots([
    { id: 'team', path: '/srv/knowledge/team', access: 'read' },
    { id: 'service', path: '/srv/knowledge/checkout', indexFile: 'INDEX.md' },
  ])
  assert.equal(roots[0].access, 'read')
  assert.equal(roots[1].indexFile, 'INDEX.md')
})

test('validateRoots treats an omitted list as no custom roots', () => {
  assert.deepEqual(validateRoots(undefined), [])
})

test('validateRoots rejects an empty array', () => {
  assert.throws(() => validateRoots([]), /must be a non-empty array/)
})

test('validateRoots rejects a missing id or path', () => {
  assert.throws(() => validateRoots([{ path: '/x' }]), /\.id must be a non-empty string/)
  assert.throws(() => validateRoots([{ id: 'x' }]), /\.path must be a non-empty string/)
})

test('validateRoots rejects a duplicate id', () => {
  assert.throws(
    () => validateRoots([{ id: 'dup', path: '/a' }, { id: 'dup', path: '/b' }]),
    /duplicate id "dup"/,
  )
})

test('validateRoots rejects an indexFile that escapes its root', () => {
  assert.throws(() => validateRoots([{ id: 'x', path: '/a', indexFile: '../outside.md' }]), /must stay within its root/)
  assert.throws(() => validateRoots([{ id: 'x', path: '/a', indexFile: 'C:\\abs.md' }]), /must stay within its root/)
})

test('validateConsumptionFiles defaults required to false', () => {
  const files = validateConsumptionFiles([{ id: 'a', path: '/a.md' }])
  assert.equal(files[0].required, false)
})

test('validateConsumptionFiles rejects duplicates, empty lists, and bad required', () => {
  assert.throws(() => validateConsumptionFiles([]), /must be a non-empty array/)
  assert.throws(() => validateConsumptionFiles([{ id: 'a', path: '/a' }, { id: 'a', path: '/b' }]), /duplicate id "a"/)
  assert.throws(() => validateConsumptionFiles([{ id: 'a', path: '/a', required: 'yes' }]), /required must be a boolean/)
})

test('shouldGenerate accepts a real function (Loader !!js gate)', () => {
  const gate = async () => ({ run: false, reason: 'test' })
  const value = accepted({ generation: { turnComplete: { shouldGenerate: gate } } })
  assert.equal(typeof value.generation.turnComplete.shouldGenerate, 'function')
})

test('onResult callbacks accept real functions in both halves', () => {
  const value = accepted({
    generation: { onResult: () => {} },
    consumption: { onResult: () => {} },
  })
  assert.equal(typeof value.generation.onResult, 'function')
  assert.equal(typeof value.consumption.onResult, 'function')
})

test('explicit consumption.files accepts a list', () => {
  const value = accepted({
    mode: 'custom',
    consumption: { files: [{ id: 'conventions', path: '/srv/CONVENTIONS.md', required: true }] },
  })
  // The list passes through the schema; validateConsumptionFiles normalizes it.
  assert.equal(validateConsumptionFiles(value.consumption.files)[0].required, true)
})

/* ================= path guards ================= */

test('plain .md path accepted', () => {
  assert.equal(safeRelativePath('MEMORY.md'), 'MEMORY.md')
})

test('nested .md path normalized to forward slashes', () => {
  assert.equal(safeRelativePath('sub\\deep.md'), 'sub/deep.md')
})

test('parent traversal rejected', () => {
  assert.equal(safeRelativePath('../escape.md'), undefined)
})

test('nested traversal rejected', () => {
  assert.equal(safeRelativePath('a/../../escape.md'), undefined)
})

test('absolute path rejected', () => {
  assert.equal(safeRelativePath('C:\\Windows\\evil.md'), undefined)
})

test('non-md extension rejected', () => {
  assert.equal(safeRelativePath('NOTES.txt'), undefined)
})

test('empty and dot paths rejected', () => {
  assert.equal(safeRelativePath(''), undefined)
  assert.equal(safeRelativePath('.'), undefined)
  assert.equal(safeRelativePath('/'), undefined)
})

test('joinRoot keeps the path inside the root', () => {
  const joined = joinRoot('C:\\root', 'sub/deep.md')
  assert.ok(joined.startsWith('C:\\root'))
  assert.ok(joined.endsWith('deep.md'))
})

/* ================= token accounting ================= */

test('message pricing mirrors the harness heuristic (4 chars/token + framing)', () => {
  // 8 ascii chars -> ceil(8/4)=2, plus one block overhead 4, plus role framing 4
  assert.equal(estimateMessage({ content: [{ type: 'text', text: 'abcdefgh' }] }), 10)
})

test('empty content prices only the role framing', () => {
  assert.equal(estimateMessage({ content: [] }), 4)
})

test('tool-call blocks price name and arguments', () => {
  const priced = estimateMessage({ content: [{ type: 'tool-call', name: 'read', arguments: 'abcd' }] })
  assert.equal(priced, 1 + 1 + 4 + 4)
})

/* ================= budget rendering ================= */

const file = (id, text) => ({ id, text })
/** Price a candidate render the way the plugin does. */
const measure = (messages) => messages.reduce((total, message) => total + estimateMessage(message), 0)

test('under budget keeps every file', () => {
  const out = renderMemoryContext([file('user:MEMORY.md', 'hello')], 10000, measure)
  assert.match(out.text, /user:MEMORY\.md/)
  assert.deepEqual(out.omitted, [])
  assert.deepEqual(out.truncated, [])
  assert.equal(out.included.length, 1)
})

test('over budget drops broadest scope first, truncates the last', () => {
  const big = 'x'.repeat(4000)
  const out = renderMemoryContext([file('user:MEMORY.md', big), file('project:MEMORY.md', big)], 300, measure)
  assert.deepEqual(out.omitted, ['user:MEMORY.md'])
  assert.deepEqual(out.truncated, ['project:MEMORY.md'])
  assert.ok(measure([{ content: [{ type: 'text', text: out.text }] }]) <= 300)
})

test('zero budget injects nothing', () => {
  const out = renderMemoryContext([file('user:MEMORY.md', 'hello')], 0, measure)
  assert.equal(out.text, undefined)
  assert.equal(out.included.length, 0)
})

test('a truncated index carries Qoder own notice, a topic file does not', () => {
  const big = 'y'.repeat(8000)
  // The file entries carry a path in production, which is what identifies an index.
  const index = renderMemoryContext([{ id: 'user', path: 'C:\\home\\.dsh\\memory\\MEMORY.md', text: big }], 300, measure)
  assert.deepEqual(index.truncated, ['user'])
  assert.match(index.text, /\[memory truncated to fit maxTokens 300\]/)
  assert.match(index.text, /Only part of it was loaded\. Keep index entries to one line under ~150 chars/)

  const topic = renderMemoryContext([{ id: 'user', path: 'C:\\home\\.dsh\\memory\\notes.md', text: big }], 300, measure)
  assert.deepEqual(topic.truncated, ['user'])
  assert.doesNotMatch(topic.text, /Only part of it was loaded/, 'an index notice must not follow a topic file')

  // Without a path there is nothing to identify, so the notice is withheld.
  const bare = renderMemoryContext([file('user', big)], 300, measure)
  assert.deepEqual(bare.truncated, ['user'])
  assert.doesNotMatch(bare.text, /Only part of it was loaded/)
})

test('rendered frame is a system-reminder', () => {
  const out = renderMemoryContext([file('user:MEMORY.md', 'note')], 10000, measure)
  assert.match(out.text, /^<system-reminder>/)
  assert.match(out.text, /<\/system-reminder>$/)
})

test('a single oversized file reports overflow instead of injecting past budget', () => {
  const out = renderMemoryContext([file('user:MEMORY.md', 'y'.repeat(8000))], 20, measure)
  assert.equal(out.overflowed, true)
})

/* ================= generation plan ================= */

test('parses a bare JSON plan', () => {
  const plan = parsePlan('{"writes":[{"rootId":"project","path":"MEMORY.md","content":"x"}],"reason":"r"}')
  assert.equal(plan.writes.length, 1)
  assert.equal(plan.reason, 'r')
})

test('parses a fenced JSON plan', () => {
  assert.deepEqual(parsePlan('```json\n{"writes":[],"reason":"nothing"}\n```').writes, [])
})

test('non-JSON output throws', () => {
  assert.throws(() => parsePlan('I could not decide.'), /no JSON object/)
})

test('missing writes defaults to an empty array', () => {
  assert.deepEqual(parsePlan('{"reason":"x"}').writes, [])
})

/* ================= message identity ================= */

test('memory message declares snapshot form with named sections', () => {
  const message = memoryMessage({ text: 'body', included: ['user:MEMORY.md'] }, 'identity-1')
  assert.equal(message.role, 'user')
  assert.equal(message.source.kind, 'memory')
  assert.equal(message.source.form, 'snapshot')
  assert.equal(message.source.identity, 'identity-1')
  assert.deepEqual(message.source.sections, [{ name: 'user:MEMORY.md', text: '' }])
  assert.equal(message.content[0].text, 'body')
  assert.ok(isMemoryMessage(message))
})

test('ordinary user message is not a memory message', () => {
  assert.equal(isMemoryMessage({ id: 'a', role: 'user', content: [], source: { kind: 'user' } }), false)
  assert.equal(isMemoryMessage(undefined), false)
})

/* ================= identity + prompt ================= */

test('memory identity changes when the budget changes', () => {
  const roots = [{ id: 'user', path: 'C:\\u', access: 'read-write', indexFile: 'MEMORY.md' }]
  const base = { mode: 'native', consumption: { maxTokens: 1000, overflow: 'truncate', files: undefined } }
  const a = memoryIdentity(base, roots)
  const b = memoryIdentity({ ...base, consumption: { ...base.consumption, maxTokens: 2000 } }, roots)
  assert.notEqual(a, b)
})

test('generation prompt lists roots and the operator policy', () => {
  const prompt = generationSystemPrompt(
    { generation: { prompt: 'Only record deploy steps.' } },
    [{ id: 'team', path: '/x', access: 'read', indexFile: 'INDEX.md' }],
  )
  assert.match(prompt, /id "team": read/)
  // A custom root still has to name its index file for the agent.
  assert.match(prompt, /index file `INDEX\.md`/)
  assert.match(prompt, /Only record deploy steps\./)
  // The instructions that make the pass an agent rather than a blind write.
  assert.match(prompt, /memory_list/)
  assert.match(prompt, /Never Read MEMORY\.md/)
})

/* ================= content extraction ================= */

test('textOf joins only text blocks', () => {
  assert.equal(
    textOf([
      { type: 'text', text: 'a' },
      { type: 'tool-call', name: 'read', arguments: '{}' },
      { type: 'text', text: 'b' },
    ]),
    'a\nb',
  )
})

test('textOf tolerates malformed content', () => {
  assert.equal(textOf(undefined), '')
  assert.equal(textOf('nope'), '')
})

/* ================= folder trust ================= */

test('folderContains accepts the directory itself and anything under it', () => {
  assert.equal(folderContains('C:\\proj', 'C:\\proj'), true)
  assert.equal(folderContains('C:\\proj', 'C:\\proj\\packages\\a'), true)
  assert.equal(folderContains('C:\\proj', 'C:\\proj-other'), false, 'a shared prefix is not containment')
  assert.equal(folderContains('C:\\proj', 'C:\\elsewhere'), false)
  assert.equal(folderContains('C:\\proj', 'C:\\proj\\..\\escape'), false, 'traversal is not containment')
})

test('folder comparison follows the platform case rule', () => {
  // Windows resolves paths case-insensitively, so a differently-cased folder
  // must still match; elsewhere the comparison stays exact.
  const matched = folderContains('C:\\Proj', 'c:\\proj\\sub')
  assert.equal(matched, process.platform === 'win32')
})

test('the trust predicate is inert until it is switched on', () => {
  // Qoder: `isTrustedFolder() { return !this.folderTrust || (this.trustedFolder ?? false) }`
  assert.equal(isFolderTrusted('C:\\proj', { trust: { enabled: false, folders: [] } }, []), true)
  assert.equal(isFolderTrusted('C:\\proj', undefined, []), true, 'an absent trust block cannot gate anything')
})

test('an enabled gate trusts only a covering folder', () => {
  const config = { trust: { enabled: true, folders: ['C:\\proj'] } }
  assert.equal(isFolderTrusted('C:\\proj', config, []), true)
  assert.equal(isFolderTrusted('C:\\proj\\packages\\a', config, []), true)
  assert.equal(isFolderTrusted('C:\\other', config, []), false)
  assert.equal(isFolderTrusted('C:\\other', { trust: { enabled: true, folders: [] } }, []), false)
})

test('remembered folders join the declared ones without duplicates', () => {
  const config = { trust: { enabled: true, folders: ['C:\\proj', 'C:\\shared'] } }
  assert.deepEqual(effectiveTrustedFolders(config, ['C:\\PROJ', 'C:\\remembered']), [
    'C:\\proj',
    'C:\\shared',
    'C:\\remembered',
  ])
  assert.deepEqual(effectiveTrustedFolders(undefined, ['C:\\a', '', null]), ['C:\\a'])
})

test('the remembered decisions live outside every memory root', () => {
  assert.equal(trustStorePath(), join(resolveDshHome(), 'trusted-folders.json'))
  assert.ok(!trustStorePath().startsWith(join(resolveDshHome(), 'memory')))
})

test('the trust block defaults to inert and validates its shape', () => {
  const resolved = resolveMemoryConfig({})
  assert.deepEqual(resolved.trust, { enabled: false, folders: [] })
  const validated = accepted({ trust: { enabled: true, folders: ['C:\\proj'] } })
  assert.deepEqual(resolveMemoryConfig(validated).trust, { enabled: true, folders: ['C:\\proj'] })
  rejected({ trust: { enabled: 'yes' } })
  rejected({ trust: { folders: [42] } })
})

/* ================= memory search ================= */

test('findHits matches literally, not as a pattern', () => {
  const text = 'Use pnpm test.\nA dot . matches one character in a regex.'
  // A regex-flavoured query must not be interpreted: `.` is a dot.
  const dots = findHits(text, '.')
  assert.deepEqual(dots, [], 'a one-character query is below the minimum, and never a wildcard')
  const literal = findHits(text, '. matches')
  assert.equal(literal.length, 1)
  assert.equal(literal[0].line, 2)
  assert.match(literal[0].snippet, /A dot \. matches one character/)
  // `.*` would match everything as a regex; as literal text it matches nothing.
  assert.deepEqual(findHits(text, '.*'), [])
})

test('findHits is case-insensitive and reports one-based line numbers', () => {
  const hits = findHits('first\nPNPM install\nthird\npnpm test', 'pnpm')
  assert.deepEqual(
    hits.map((hit) => hit.line),
    [2, 4],
  )
})

test('findHits truncates only the context it keeps', () => {
  const long = `${'x'.repeat(200)}needle${'y'.repeat(200)}`
  const [hit] = findHits(long, 'needle')
  assert.match(hit.snippet, /needle/)
  assert.ok(hit.snippet.length < 140, `snippet must be trimmed, got ${hit.snippet.length}`)
  assert.ok(hit.snippet.startsWith('…') && hit.snippet.endsWith('…'))
})

test('formatSearchResult reports a miss without pretending to succeed', () => {
  assert.match(
    formatSearchResult({ query: 'nope', hits: [], files: [], considered: 3, truncated: false }),
    /no memory matches "nope" in 3 file\(s\)/,
  )
  const hit = formatSearchResult({
    query: 'pnpm',
    hits: [{ rootId: 'project', path: 'build.md', type: 'project', index: false, line: 7, snippet: 'use pnpm test' }],
    files: [{ rootId: 'project', path: 'build.md' }],
    considered: 2,
    truncated: false,
  })
  assert.match(hit, /project:build\.md:7 \[project\] use pnpm test/)
  assert.match(hit, /1 match\(es\) in 1 file\(s\)/)
  assert.match(formatSearchResult({ query: 'x', hits: [], files: [], considered: 0, error: 'unknown root "nope"' }), /memory_search: unknown root/)
})

/* ================= exclusion patterns ================= */

test('normalizeExcludes folds separators and drops empties', () => {
  assert.deepEqual(normalizeExcludes(['**\\node_modules\\**', '', 42, 'a\\b.md']), ['**/node_modules/**', 'a/b.md'])
  assert.deepEqual(normalizeExcludes(undefined), [])
})

test('isExcluded matches gitignore-flavoured globs against absolute paths', () => {
  const patterns = normalizeExcludes(['**/node_modules/**', '**/*.draft.md', 'C:/tmp/**'])
  assert.equal(isExcluded('C:\\proj\\node_modules\\a\\MEMORY.md', patterns), true)
  assert.equal(isExcluded('C:\\proj\\notes.draft.md', patterns), true)
  assert.equal(isExcluded('C:\\tmp\\x.md', patterns), true)
  assert.equal(isExcluded('C:\\proj\\MEMORY.md', patterns), false)
  assert.equal(isExcluded('C:\\proj\\MEMORY.md', []), false, 'no patterns excludes nothing')
})

test('isExcluded can address dotfiles and folds case where the platform does', () => {
  assert.equal(isExcluded('C:\\proj\\.hidden.md', normalizeExcludes(['**/.*.md'])), true, 'dot: true')
  const upper = isExcluded('C:\\PROJ\\seekrit.md', normalizeExcludes(['**/Seekrit.md']))
  assert.equal(upper, process.platform === 'win32' || process.platform === 'darwin')
})

test('only the project scope is excludable, never the user scope', () => {
  const patterns = normalizeExcludes(['**/MEMORY.md'])
  const entries = [
    { rootId: 'user', absolute: 'C:\\home\\.dsh\\memory\\MEMORY.md' },
    { rootId: 'project', absolute: 'C:\\home\\.dsh\\projects\\--p--\\memory\\MEMORY.md' },
    { absolute: 'C:\\explicit\\MEMORY.md' },
    { rootId: 'team', absolute: 'C:\\team\\MEMORY.md' },
  ]
  const { kept, excluded } = partitionExcluded(entries, patterns)
  // Qoder's `pet` filters `project` and `local` and leaves `global` alone; the
  // user scope is this port's `global`, and a custom root is operator-declared.
  assert.deepEqual(
    excluded.map((entry) => entry.rootId),
    ['project'],
  )
  assert.equal(kept.length, 3)
})

test('classifyLargeFiles uses Qoder threshold, order and unit', () => {
  const big = 'x'.repeat(LARGE_FILE_CHARS + 1)
  const bigger = 'y'.repeat(LARGE_FILE_CHARS + 100)
  const files = [
    { path: 'a.md', status: 'loaded', text: 'small' },
    { path: 'b.md', status: 'loaded', text: big },
    { path: 'c.md', status: 'loaded', text: bigger },
    { path: 'd.md', status: 'missing', text: '' },
  ]
  assert.equal(LARGE_FILE_CHARS, 40000, 'decoded verbatim from qodercli (`met = 4e4`)')
  assert.deepEqual(classifyLargeFiles(files), [
    { path: 'c.md', characterCount: LARGE_FILE_CHARS + 100 },
    { path: 'b.md', characterCount: LARGE_FILE_CHARS + 1 },
  ])
  // Exactly at the limit is not large (Qoder compares with `>`).
  assert.deepEqual(classifyLargeFiles([{ path: 'x.md', status: 'loaded', text: 'x'.repeat(LARGE_FILE_CHARS) }]), [])
})

test('classifyFailedFiles reports path and error, and ignores plain misses', () => {
  const files = [
    { path: 'a.md', status: 'loaded', text: 'ok' },
    { path: 'b.md', status: 'missing', text: '' },
    { path: 'c.md', status: 'failed', text: '', error: new Error('EACCES') },
  ]
  assert.deepEqual(classifyFailedFiles(files), [{ path: 'c.md', error: 'Error: EACCES' }])
})

test('memoryChangeReport exposes what Qoder emits as memory-changed', () => {
  // Empty lists are omitted, exactly as Qoder builds the event payload.
  assert.deepEqual(memoryChangeReport({ fileCount: 2 }), { fileCount: 2 })
  assert.deepEqual(
    memoryChangeReport({
      fileCount: 1,
      largeFiles: [{ path: 'a.md', characterCount: 50000 }],
      failedFiles: [],
      excludedFiles: ['C:\\p\\x.md'],
    }),
    {
      fileCount: 1,
      largeFiles: [{ path: 'a.md', characterCount: 50000 }],
      excludedFiles: ['C:\\p\\x.md'],
    },
  )
  assert.equal(memoryChangeReport(undefined), undefined)
  // A glob-held file is neither missing nor excluded, so it carries its own field
  // with the reason — the panel needs something to say.
  const jit = memoryChangeReport({
    fileCount: 0,
    jitSkipped: [{ id: 'user:ts.md', path: 'C:\\home\\ts.md', reason: 'no match' }],
  })
  assert.equal(jit.jitSkipped.length, 1)
  assert.match(jit.jitSkipped[0].reason, /no match/)
  // An empty list is absent, so the panel never renders a zero-count line.
  assert.equal(memoryChangeReport({ fileCount: 0, jitSkipped: [] }).jitSkipped, undefined)
})

test('the excludes setting defaults to empty and validates as strings', () => {
  assert.deepEqual(resolveMemoryConfig({}).excludes, [])
  assert.deepEqual(resolveMemoryConfig(accepted({ excludes: ['**/*.draft.md'] })).excludes, ['**/*.draft.md'])
  rejected({ excludes: [42] })
  // It is a top-level key, so it stays usable in `native` mode, where the SDK
  // rejects extra keys inside the generation/consumption blocks.
  assert.equal(accepted({ mode: 'native', excludes: ['**/x.md'] }).excludes.length, 1)
})

/* ================= @imports ================= */

test('isImportPath accepts paths and rejects mentions', () => {
  // Qoder's `mNi`: the syntaxes it follows…
  for (const path of ['./a.md', '../a.md', '~/a.md', '/abs/a.md', 'docs/notes.md', '.hidden.md', 'x.md']) {
    assert.equal(isImportPath(path), true, `${path} must be an import`)
  }
  // …and the things that merely look like one.
  for (const path of ['user', '@name', '#tag', '(group)', '*star', '', 'foo', 'notes/readme']) {
    assert.equal(isImportPath(path), false, `${path} must not be an import`)
  }
})

test('parseImports finds @paths at line starts and after whitespace only', () => {
  const text = ['@docs/one.md', 'see @docs/two.md here', 'mail me at a@b.com', 'not@here.md', '@@skip'].join('\n')
  assert.deepEqual(
    parseImports(text).map((entry) => entry.path),
    ['docs/one.md', 'docs/two.md'],
  )
  // The reported range covers `@` plus the path, and excludes the whitespace.
  const [first] = parseImports('@a.md rest')
  assert.equal(first.start, 0)
  assert.equal(first.end, 5)
})

test('codeFenceRanges marks fenced regions so imports inside stay literal', () => {
  const text = ['```', '@inside/fence.md', '```', '`@inline.md`'].join('\n')
  const ranges = codeFenceRanges(text)
  assert.equal(ranges.length, 2)
  const [first] = parseImports(text)
  assert.ok(
    ranges.some(([start, end]) => first.start >= start && first.start < end),
    'the first reference is inside the block fence',
  )
})

test('flattenImportTree and importParentMap describe the expansion', () => {
  const tree = [ { path: 'a.md', imports: [{ path: 'b.md' }] }, { path: 'c.md' } ]
  assert.deepEqual(flattenImportTree(tree), ['a.md', 'b.md', 'c.md'])
  assert.deepEqual(
    [...importParentMap(tree, 'root.md').entries()],
    [
      ['a.md', 'root.md'],
      ['b.md', 'a.md'],
      ['c.md', 'root.md'],
    ],
  )
  assert.deepEqual(flattenImportTree(undefined), [])
})

test('isAllowedImport follows Qoder GCn: never a URL, only inside a root', () => {
  const base = 'C:\\home\\.dsh\\projects\\--p--\\memory'
  const roots = [base]
  assert.equal(isAllowedImport('notes.md', base, roots), true)
  assert.equal(isAllowedImport('sub/notes.md', base, roots), true)
  assert.equal(isAllowedImport('../../escape.md', base, roots), false)
  assert.equal(isAllowedImport('C:/secrets/keys.md', base, roots), false)
  // A URL is refused by the first rule, whatever the roots say.
  assert.equal(isAllowedImport('file:///C:/home/.dsh/memory/x.md', base, roots), false)
  assert.equal(isAllowedImport('https://example.com/x.md', base, roots), false)
})

test('resolveTarget handles ~/ against the harness home', () => {
  assert.equal(resolveTarget('notes.md', 'C:\\a\\b'), 'C:\\a\\b\\notes.md')
  assert.equal(resolveTarget('~/notes.md', 'C:\\a\\b', 'C:\\home'), 'C:\\home\\notes.md')
  // `..` is normalized away, which is what makes the containment check honest.
  assert.equal(resolveTarget('sub/../notes.md', 'C:\\a\\b'), 'C:\\a\\b\\notes.md')
  assert.equal(resolveTarget('../notes.md', 'C:\\a\\b'), 'C:\\a\\notes.md')
})

test('the imports block defaults match Qoder and validates its shape', () => {
  const resolved = resolveMemoryConfig({})
  assert.deepEqual(resolved.imports, {
    enabled: true,
    format: 'tree',
    maxDepth: 5,
    allowExternal: false,
    approvedProjects: [],
  })
  assert.equal(resolveMemoryConfig(accepted({ imports: { format: 'flat' } })).imports.format, 'flat')
  rejected({ imports: { format: 'yaml' } })
  rejected({ imports: { maxDepth: 0 } })
  // Top-level, so it stays usable in `native` mode.
  assert.equal(accepted({ mode: 'native', imports: { enabled: false } }).imports.enabled, false)
})

/* ================= delta hashing ================= */

test('hashText is stable, hex, and content-sensitive', () => {
  assert.equal(hashText('abc'), hashText('abc'))
  assert.notEqual(hashText('abc'), hashText('abd'))
  assert.match(hashText('abc'), /^[0-9a-f]{8}$/)
  assert.equal(hashText(''), hashText(''))
})

test('memoryBlockHash hashes each file and the block', () => {
  const first = memoryBlockHash([
    { id: 'a', text: 'one' },
    { id: 'b', text: 'two' },
  ])
  assert.deepEqual(first.files.map(([id]) => id), ['a', 'b'])
  assert.match(first.blockHash, /^[0-9a-f]{8}$/)
  // The same content in the same order is the same block.
  assert.deepEqual(memoryBlockHash([{ id: 'a', text: 'one' }]).blockHash, memoryBlockHash([{ id: 'a', text: 'one' }]).blockHash)
  // Renaming a file changes the block even when the text is identical.
  assert.notEqual(
    memoryBlockHash([{ id: 'a', text: 'one' }]).blockHash,
    memoryBlockHash([{ id: 'b', text: 'one' }]).blockHash,
  )
})

test('memoryDelta reports only what changed, and what went away', () => {
  const before = memoryBlockHash([
    { id: 'a', text: 'one' },
    { id: 'b', text: 'two' },
  ]).files
  const delta = memoryDelta(before, [
    { id: 'a', text: 'one' },
    { id: 'b', text: 'two changed' },
    { id: 'c', text: 'new' },
  ])
  assert.deepEqual(delta.changed.map((file) => file.id), ['b', 'c'])
  assert.deepEqual(delta.removed, [])

  const withRemoval = memoryDelta(before, [{ id: 'a', text: 'one' }])
  assert.deepEqual(withRemoval.changed, [])
  assert.deepEqual(withRemoval.removed, ['b'])

  // No previous state means everything is new, which is what a first load is.
  assert.equal(memoryDelta(undefined, [{ id: 'a', text: 'one' }]).changed.length, 1)
})

test('renderMemoryDelta frames a change and names removals', () => {
  const measure = (messages) => Math.ceil(JSON.stringify(messages).length / 4)
  const changed = renderMemoryDelta(
    { changed: [{ id: 'project:notes.md', text: 'second version' }], removed: [] },
    5000,
    measure,
  )
  assert.match(changed.text, /Memory changed since the last request/)
  assert.match(changed.text, /## Memory from: project:notes\.md/)
  assert.match(changed.text, /second version/)
  assert.doesNotMatch(changed.text, /recorded in earlier sessions/, 'a delta must not read like a snapshot')

  const removedOnly = renderMemoryDelta({ changed: [], removed: ['project:gone.md'] }, 5000, measure)
  assert.match(removedOnly.text, /Removed: project:gone\.md/)
})

/* ================= environment overrides ================= */

test('readBooleanEnv uses Qoder vocabulary, and anything else is unset', () => {
  for (const value of ['1', 'true', 'TRUE', ' yes ', 'On']) {
    assert.equal(readBooleanEnv({ X: value }, 'X'), true, `${value} must read as true`)
  }
  for (const value of ['0', 'false', 'NO', ' off ']) {
    assert.equal(readBooleanEnv({ X: value }, 'X'), false, `${value} must read as false`)
  }
  for (const value of ['', '  ', 'maybe', '2', undefined]) {
    assert.equal(readBooleanEnv({ X: value }, 'X'), undefined, `${value} must read as unset`)
  }
  assert.equal(readBooleanEnv(undefined, 'X'), undefined)
})

test('the environment overrides the scopes, the dream pass, and can switch memory off', () => {
  const base = resolveMemoryConfig({}, {})
  assert.equal(base.enabled, true)
  assert.equal(base.userScope, true)
  assert.equal(base.projectScope, true)
  assert.equal(base.generation.dream.enabled, false)

  assert.equal(resolveMemoryConfig({}, { DSH_MEMORY_HEADLESS: 'false' }).enabled, false)
  assert.equal(resolveMemoryConfig({}, { DSH_MEMORY_HEADLESS: 'true' }).enabled, true, 'the gate only switches off')

  const scopes = resolveMemoryConfig({}, { DSH_MEMORY_USER: 'false', DSH_MEMORY_PROJECT: 'false' })
  assert.equal(scopes.userScope, false)
  assert.equal(scopes.projectScope, false)
  assert.equal(resolveMemoryConfig({}, { DSH_MEMORY_DREAM: 'on' }).generation.dream.enabled, true)

  // Environment wins over an explicit setting, as it does in Qoder's headless path.
  assert.equal(resolveMemoryConfig({ userScope: true }, { DSH_MEMORY_USER: 'false' }).userScope, false)
  // And nothing else is reachable from the environment.
  assert.equal(resolveMemoryConfig({}, { DSH_MEMORY_TOKEN_BUDGET: '10' }).consumption.maxTokens, 2000)
})

/* ================= turn pacing ================= */

test('the turn interval counts turns and resets when a pass runs', () => {
  // Qoder's arithmetic: increment, run once the count reaches the interval,
  // reset on a run (`extractionEveryNTurns` defaults to 1).
  assert.deepEqual(turnIntervalAllows(0, 1), { run: true, turnsSince: 0 })
  assert.deepEqual(turnIntervalAllows(0, 3), { run: false, turnsSince: 1 })
  assert.deepEqual(turnIntervalAllows(1, 3), { run: false, turnsSince: 2 })
  assert.deepEqual(turnIntervalAllows(2, 3), { run: true, turnsSince: 0 })
  // An unusable interval falls back to Qoder's own normalization (`1`).
  for (const everyTurns of [0, -1, 1.5, undefined, 'x']) {
    assert.deepEqual(turnIntervalAllows(0, everyTurns), { run: true, turnsSince: 0 }, `${everyTurns} must mean 1`)
  }
  // A bypass runs and resets, which is what an operator gate and a coalesced
  // follow-up both do.
  assert.deepEqual(turnIntervalAllows(0, 5, true), { run: true, turnsSince: 0 })
  assert.deepEqual(turnIntervalAllows(4, 5, true), { run: true, turnsSince: 0 })
})

/* ================= the read fast path ================= */

test('readVersioned reuses a cached body while the version holds', async () => {
  const reads = []
  let version = 0
  const fs = {
    async resolve(path) {
      return { targetKey: String(path), displayPath: String(path) }
    },
    async stat() {
      return version === -1 ? undefined : { version: `v${version}`, type: 'file' }
    },
    async readText() {
      reads.push(version)
      return `body at v${version}`
    },
  }
  const cache = new Map()

  const first = await readVersioned(fs, 'C:\\a\\x.md', cache)
  assert.equal(first.cached, false)
  assert.equal(first.text, 'body at v0')

  const second = await readVersioned(fs, 'C:\\a\\x.md', cache)
  assert.equal(second.cached, true, 'an unchanged version must not be re-read')
  assert.equal(second.text, 'body at v0')
  assert.equal(reads.length, 1)

  version += 1
  const changed = await readVersioned(fs, 'C:\\a\\x.md', cache)
  assert.equal(changed.cached, false, 'a new version must be re-read')
  assert.equal(changed.text, 'body at v1')

  // No cache at all is still correct, just not fast.
  assert.equal((await readVersioned(fs, 'C:\\a\\x.md', undefined)).cached, false)
  // An absent file is absent, cached or not.
  version = -1
  assert.equal(await readVersioned(fs, 'C:\\a\\x.md', cache), undefined)
})

test('collectTranscript slices from the cursor, like Qoder MOl', () => {
  const events = [
    { type: 'turn/start', seq: 0, data: { turn: 1 } },
    { type: 'user/message', seq: 1, data: { content: [{ type: 'text', text: 'first' }] } },
    { type: 'assistant/message', seq: 2, data: { message: { content: [{ type: 'text', text: 'answer one' }] } } },
    { type: 'turn/end', seq: 3, data: { turn: 1 } },
    { type: 'turn/start', seq: 4, data: { turn: 2 } },
    { type: 'user/message', seq: 5, data: { content: [{ type: 'text', text: 'second' }] } },
    { type: 'assistant/message', seq: 6, data: { message: { content: [{ type: 'text', text: 'answer two' }] } } },
  ]
  const session = { snapshotEvents: () => events }

  const all = collectTranscript(session, undefined)
  assert.match(all.prompt, /first[\s\S]*second/)
  assert.equal(all.lastSeq, 6, 'the cursor is the newest event')

  const rest = collectTranscript(session, 3)
  assert.equal(rest.prompt, 'second', 'only what came after the cursor')
  assert.equal(rest.response, 'answer two')

  // Qoder's fallback: an unknown cursor means the whole transcript, never an
  // empty one — losing history is worse than repeating it.
  assert.equal(collectTranscript(session, 99).prompt, 'first\n\nsecond')
})

test('index limits are reported, never enforced', () => {
  // Qoder states them in the prompt (about 25KB, about 200 characters a line),
  // so this is advice — a write is never refused for it.
  assert.deepEqual(indexWarnings('MEMORY.md', '# Index\n\n- [a](a.md) - short'), [])

  // Topic files are not indexes and are not judged by index limits.
  assert.deepEqual(indexWarnings('notes.md', 'x'.repeat(30000)), [])

  const longLine = indexWarnings('MEMORY.md', `# Index\n- [a](a.md) - ${'x'.repeat(250)}`)
  assert.equal(longLine.length, 1)
  assert.equal(longLine[0].kind, 'long_lines')
  assert.match(longLine[0].message, /1 index line\(s\) over about 200 characters/)

  const tooBig = indexWarnings('MEMORY.md', `# Index\n${'- [a](a.md) - short\n'.repeat(2000)}`)
  assert.ok(tooBig.some((item) => item.kind === 'size'))
  assert.match(tooBig.find((item) => item.kind === 'size').message, /over about 25600/)

  // The byte boundary is the documented one, inclusive: 20-byte short lines, so
  // exactly 1280 of them is 25600 bytes and the next line crosses it.
  const shortLine = '- [a](a.md) - short\n'
  assert.equal(Buffer.byteLength(shortLine, 'utf8'), 20)
  assert.deepEqual(indexWarnings('MEMORY.md', shortLine.repeat(1280)), [])
  assert.deepEqual(
    indexWarnings('MEMORY.md', shortLine.repeat(1281)).map((item) => item.kind),
    ['size'],
  )
})

/* ================= just-in-time memory ================= */

test('a memory file declares its own trigger, and declaring nothing changes nothing', () => {
  // Qoder's `swn`: no declaration is `always_on`, `trigger: false` is `manual`,
  // and a `paths` list makes it `glob`.
  assert.deepEqual(parseJitTrigger({}), { trigger: 'always_on', globs: [] })
  assert.deepEqual(parseJitTrigger(undefined), { trigger: 'always_on', globs: [] })
  assert.deepEqual(parseJitTrigger({ trigger: 'always_on' }), { trigger: 'always_on', globs: [] })
  assert.deepEqual(parseJitTrigger({ trigger: 'false' }), { trigger: 'manual', globs: [] })
  assert.deepEqual(parseJitTrigger({ trigger: 'manual' }), { trigger: 'manual', globs: [] })

  assert.deepEqual(parseJitTrigger({ paths: 'src/**/*.ts' }), { trigger: 'glob', globs: ['src/**/*.ts'] })
  assert.deepEqual(parseJitTrigger({ paths: '[a.ts, b/b.ts]' }), { trigger: 'glob', globs: ['a.ts', 'b/b.ts'] })
  assert.deepEqual(parseJitTrigger({ globs: '["x/*.md"]' }), { trigger: 'glob', globs: ['x/*.md'] })
  // `trigger: glob` with nothing usable would load never, so Qoder's fallback
  // applies: it stays always-on rather than silently vanishing.
  assert.deepEqual(parseJitTrigger({ trigger: 'glob', paths: '' }), { trigger: 'always_on', globs: [] })
})

test('the glob trigger matches the paths a session touched', () => {
  const cwd = 'C:\\proj'
  assert.equal(isJitActive(['**/*.ts'], ['C:\\proj\\src\\deep\\a.ts'], cwd), true)
  assert.equal(isJitActive(['src/**/*.ts'], ['C:\\proj\\src\\deep\\a.ts'], cwd), true)
  assert.equal(isJitActive(['src/**/*.ts'], ['C:\\proj\\other\\a.ts'], cwd), false)
  // A pattern may also be written against the absolute path.
  assert.equal(isJitActive(['C:/proj/**/*.py'], ['C:\\proj\\a\\b.py'], cwd), true)
  // No patterns, no match.
  assert.equal(isJitActive([], ['C:\\proj\\a.ts'], cwd), false)
  assert.equal(isJitActive(undefined, ['C:\\proj\\a.ts'], cwd), false)
  assert.equal(isJitActive(['**/*.ts'], [], cwd), false)
})

test('the trigger decides, and a manual file never loads on its own', () => {
  const cwd = 'C:\\proj'
  assert.deepEqual(jitDecision({ trigger: 'always_on', globs: [] }, [], cwd), { load: true, reason: 'always_on' })
  assert.deepEqual(jitDecision({ trigger: 'manual', globs: [] }, ['C:\\proj\\a.ts'], cwd), {
    load: false,
    reason: 'manual only',
  })
  const hit = jitDecision({ trigger: 'glob', globs: ['**/*.ts'] }, ['C:\\proj\\a.ts'], cwd)
  assert.equal(hit.load, true)
  // Qoder's own wording for this reason.
  assert.equal(hit.reason, 'path_glob_match')
  const miss = jitDecision({ trigger: 'glob', globs: ['**/*.ts'] }, ['C:\\proj\\a.py'], cwd)
  assert.equal(miss.load, false)
  assert.match(miss.reason, /no touched path matches \*\*\/\*\.ts/)
})

test('touched paths come from the projected messages, not from prose', () => {
  const session = {
    deriveMessages: () => [
      { role: 'user', content: 'please look at C:\\proj\\src\\a.ts and also ../notes/b.md' },
      { role: 'assistant', content: [{ type: 'text', text: 'reading /home/u/c.py now' }] },
      { role: 'tool', content: [{ type: 'tool-result', output: 'ok' }] },
    ],
  }
  const touched = collectTouchedPaths(session)
  assert.ok(touched.includes('C:\\proj\\src\\a.ts'))
  assert.ok(touched.includes('../notes/b.md'))
  assert.ok(touched.includes('/home/u/c.py'))
  // A bare word is not a path, and neither is a sentence.
  assert.ok(!touched.includes('please'))
  assert.ok(!touched.some((entry) => entry.includes(' ')))

  // A session with no projection, or a throwing one, yields nothing rather than
  // failing the pass.
  assert.deepEqual(collectTouchedPaths(undefined), [])
  assert.deepEqual(
    collectTouchedPaths({
      deriveMessages: () => {
        throw new Error('nope')
      },
    }),
    [],
  )
})

test('the memory-changed report keeps the jit-skipped reason visible', () => {
  // A file held back by its own glob is neither missing nor excluded, so it needs
  // its own field with the reason — the panel needs something to say.
  const report = memoryChangeReport({
    fileCount: 0,
    jitSkipped: [{ id: 'user:ts.md', path: 'C:\\home\\.dsh\\memory\\ts.md', reason: 'no match' }],
  })
  assert.equal(report.jitSkipped.length, 1)
  assert.match(report.jitSkipped[0].reason, /no match/)
  // Empty is absent, so the panel never renders a zero-count line.
  assert.equal(memoryChangeReport({ fileCount: 0, jitSkipped: [] }).jitSkipped, undefined)
})

/* ================= deleting ================= */

test('deleteGuarded deletes through the provider when it can, and the OS when it cannot', async () => {
  const signal = new AbortController().signal
  const dir = await mkdtemp(join(tmpdir(), 'dshmem-'))
  try {
    // 1. A provider with its own delete: nothing is bypassed.
    const providerRemoved = []
    const provider = {
      async resolve(path) {
        return { targetKey: path, displayPath: path }
      },
      async stat() {
        return { version: 'v1', type: 'file' }
      },
      async remove(target) {
        providerRemoved.push(target.targetKey)
      },
    }
    assert.deepEqual(await deleteGuarded(provider, 'C:\\mem\\a.md', undefined, signal), {
      deleted: true,
      via: 'provider',
    })
    assert.deepEqual(providerRemoved, ['C:\\mem\\a.md'])

    // 2. No provider delete: the target's own `processPath` is what gets unlinked,
    //    which is the documented way to hand a target to another OS capability.
    const real = join(dir, 'real.md')
    await writeFile(real, 'x')
    const hostPath = () => real
    const bare = {
      async resolve(path) {
        return { targetKey: path, displayPath: path }
      },
      async stat() {
        return { version: 'v1', type: 'file' }
      },
      processPath: hostPath,
    }
    assert.deepEqual(await deleteGuarded(bare, real, undefined, signal), { deleted: true, via: 'node:fs' })
    assert.equal(existsSync(real), false, 'the real file is gone')

    // 3. A backend that declares itself read-only is refused, not disobeyed.
    await writeFile(real, 'x')
    const readOnly = { ...bare, sandboxMode: 'read-only' }
    assert.deepEqual(await deleteGuarded(readOnly, real, undefined, signal), {
      error: 'the filesystem is read-only',
    })
    assert.equal(existsSync(real), true, 'a read-only backend keeps its file')

    // 4. `writePolicy: 'session'` refuses the unlink bypass under a fence, and allows it
    // when the session has no fence at all. The provider's own removal is always preferred,
    // so this is the only path the flag governs.
    const fenced = { ...bare, sandboxMode: 'workspace-write' }
    assert.deepEqual(await deleteGuarded(fenced, real, undefined, signal, false), {
      error: 'the session sandbox policy (workspace-write) does not allow deleting outside its workspace',
    })
    assert.equal(existsSync(real), true, 'the refused delete did not touch the file')
    const unfenced = { ...bare, sandboxMode: 'danger-full-access' }
    assert.deepEqual(await deleteGuarded(unfenced, real, undefined, signal, false), {
      deleted: true,
      via: 'node:fs',
    })
    // Put it back for the cases below, which assert on an existing file.
    await writeFile(real, 'x')

    // 5. A file that changed since it was read is not deleted.
    const changed = { ...bare, async stat() { return { version: 'v2', type: 'file' } } }
    assert.deepEqual(await deleteGuarded(changed, real, 'v1', signal), {
      error: 'the file changed since it was read',
    })
    assert.equal(existsSync(real), true)

    // 6. Absent is absent, whatever the provider looks like.
    const missing = { ...bare, async stat() { return undefined } }
    assert.deepEqual(await deleteGuarded(missing, real, undefined, signal), { missing: true })

    // 7. No path to hand to the OS: refuse rather than guess.
    const opaque = { ...bare, processPath: undefined }
    assert.deepEqual(await deleteGuarded(opaque, real, undefined, signal), {
      error: 'the filesystem exposes no path to delete',
    })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a session pauses after three consecutive failures, and a success clears the count', () => {
  // Qoder's own arithmetic: `consecutiveFailureCount >= hFl` with `hFl = 3`, reset to 0
  // by every completed extraction.
  const limit = FAILURE_PAUSE_DEFAULT
  assert.equal(limit, 3, 'the threshold is Qoder\'s, not an invented one')

  let state = { failures: 0, paused: false }
  const step = (status, reason = 'boom') => {
    const next = advanceFailurePause(state, { status, reason }, limit)
    state = { failures: next.failures, paused: next.paused, pauseReason: next.reason }
    return next
  }
  assert.equal(step('failed').paused, false, 'one failure is not a pattern')
  assert.equal(step('failed').paused, false, 'two are not either')
  const armed = step('failed')
  assert.equal(armed.paused, true, 'the third arms the pause')
  assert.equal(armed.failures, 3)
  assert.equal(armed.pausedNow, true, 'the arming pass is the one that warns')
  assert.equal(advanceFailurePause({ failures: 3, paused: true }, { status: 'skipped' }, limit).paused, false,
    'any pass that did not fail clears it')
  // While paused the count stays put, so the reason keeps naming the real number.
  assert.equal(step('failed').pausedNow, false, 'an already-paused session does not re-warn')
  assert.equal(state.failures, 4)
})

test('a non-failing pass resets the count, and 0 disables the pause', () => {
  assert.deepEqual(advanceFailurePause({ failures: 2, paused: false }, { status: 'saved' }, 3), {
    failures: 0,
    paused: false,
    reason: '',
    pausedNow: false,
  })
  // `no_change` and `partial` are work that happened, not failures.
  assert.equal(advanceFailurePause({ failures: 2 }, { status: 'no_change' }, 3).failures, 0)
  assert.equal(advanceFailurePause({ failures: 2 }, { status: 'partial' }, 3).failures, 0)
  // The opt-out keeps retrying, which is what this plugin did before the pause existed.
  const kept = advanceFailurePause({ failures: 9 }, { status: 'failed', reason: 'boom' }, 0)
  assert.deepEqual(kept, { failures: 10, paused: false, reason: '', pausedNow: false })
})

test('a paused session reports a skip that names the pause, not a failure', () => {
  const outcome = pausedOutcome({ failures: 3, pauseReason: 'generation reached maxOutputTokens' }, 7, 4)
  assert.equal(outcome.status, 'skipped', 'nothing was attempted, so it is not a failure')
  assert.equal(outcome.turnIndex, 4)
  assert.match(outcome.reason, /paused after 3 consecutive failures/)
  assert.match(outcome.reason, /generation reached maxOutputTokens/, 'and it carries the cause')
  assert.deepEqual(outcome.writtenFiles, [])
})

test('resuming clears every armed session and the mirrored state', () => {
  const first = { paused: true, failures: 3, pauseReason: 'boom' }
  const second = { paused: true, failures: 5, pauseReason: 'bang' }
  const armed = new Set([first, second])
  const state = { generationPause: { failures: 3 } }
  assert.equal(resumePaused(armed, state), 2)
  assert.deepEqual([first, second], [
    { paused: false, failures: 0, pauseReason: '' },
    { paused: false, failures: 0, pauseReason: '' },
  ])
  assert.equal(armed.size, 0)
  assert.equal(state.generationPause, undefined, 'the panel stops showing the pause')
})

test('a mutation declares the memory directory as its sandbox workspace, unless told to follow the session', () => {
  // Memory lives under `$DSH_HOME`, outside every session workspace: without this the
  // harness's workspace-write fence denies every write ("file access denied under
  // workspace-write mode"), which is exactly what was reported.
  assert.deepEqual(memoryWritePolicy('C:\\home\\.dsh\\memory', true), {
    mode: 'workspace-write',
    workspaceRoot: 'C:\\home\\.dsh\\memory',
  })
  // `writePolicy: 'session'` hands the decision back: no policy means the session's applies.
  assert.equal(memoryWritePolicy('C:\\home\\.dsh\\memory', false), undefined)
  // Nothing to declare without a directory — never invent a root.
  assert.equal(memoryWritePolicy(undefined, true), undefined)
  assert.equal(memoryWritePolicy('', true), undefined)
})

test('resolveMemoryConfig defaults the write policy to the memory root', () => {
  const resolved = resolveMemoryConfig(accepted({}))
  assert.equal(resolved.writePolicy, 'memory-root')
})

console.log(`\n${passed} tests passed`)

