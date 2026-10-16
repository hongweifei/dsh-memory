/**
 * Client-half test for dsh-memory's settings panel.
 *
 * Renders the REAL registered component with React's server renderer against a
 * stubbed fetch, so slot registration, data loading, rendering, and the
 * light/dark token usage are all exercised for real rather than against a
 * hand-rolled React double.
 *
 * Run: node test/client.test.mjs
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import React from 'react'
import TestRenderer from 'react-test-renderer'
import { resolveInstalled, runningHarnessBundle } from './support/harness-env.mjs'

const { act } = TestRenderer

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8')

/** The Harness's own stylesheets, when this session has them installed: the token oracle. */
const primitivesPackage = resolveInstalled('@deepseek-ai/dsh-client-ui-primitives/package.json')

/** The harness the user is actually running, when it is a desktop install. */
const runningBundle = runningHarnessBundle()

let passed = 0
let skipped = 0
const test = async (label, fn) => {
  await fn()
  passed += 1
  console.log(`  ok  ${label}`)
}

/** Run a test only when its precondition holds; say so when it does not. */
const testIf = async (condition, label, why, fn) => {
  if (condition) {
    await test(label, fn)
    return
  }
  skipped += 1
  console.log(`  --  ${label} (skipped: ${why})`)
}

console.log('dsh-memory client tests')

/**
 * React reports structural mistakes (a missing `key`, an invalid prop, a bad
 * hook order) through console.error rather than throwing — and it dedupes each
 * message globally, so a capture installed around ONE render would miss a
 * warning an earlier render already emitted. Capture for the whole run and
 * assert emptiness at the end.
 */
const reactWarnings = []
const originalConsoleError = console.error
console.error = (...args) => {
  reactWarnings.push(args.map(String).join(' '))
}

/* ---------------- load the real bundle ---------------- */

/** Evaluate the client bundle against globals and return its registration. */
function loadBundle(fetchImpl) {
  let registration
  const windowDouble = {
    __ModuleLoader__: {
      load(next) {
        registration = next
      },
    },
  }
  const requireDouble = (specifier) => {
    if (specifier === 'react') return React
    throw new Error(`unexpected external ${specifier}`)
  }
  new Function('window', 'require', 'fetch', source)(windowDouble, requireDouble, fetchImpl)
  assert.ok(registration, 'window.__ModuleLoader__.load must be called')
  return registration
}

/** A locale-service double that resolves against the registered dictionaries. */
function makeLocale() {
  const dicts = new Map()
  let active = 'en'
  const translate = (ns, key, params) => {
    const table = dicts.get(`${ns}\u0000${active}`) ?? dicts.get(`${ns}\u0000en`) ?? {}
    const template = table[key] ?? key
    if (!params) return template
    return template.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match))
  }
  return {
    dicts,
    setActive(id) {
      active = id
    },
    get active() {
      return active
    },
    register(ns, localeOrDicts) {
      if (typeof localeOrDicts === 'string') throw new Error('this double only takes the dicts form')
      for (const [locale, table] of Object.entries(localeOrDicts)) dicts.set(`${ns}\u0000${locale}`, table)
      return () => {}
    },
    bind(ns) {
      return (key, params) => translate(ns, key, params)
    },
  }
}

/**
 * Register the plugin against slots + locale doubles.
 * The slot layer injects a bound `t` derived from the declared `locale` namespace.
 */
function registerComponent(plugin, locale = makeLocale()) {
  const registrations = []
  const injected = []
  plugin.apply({
    effect: (body) => {
      const dispose = body()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    locale,
    slots: {
      inject(owner, callback) {
        injected.push(owner)
        return callback()
      },
      register(options, component) {
        registrations.push({ options, component })
        return () => {}
      },
    },
  })
  return { registrations, injected, locale }
}

/** The props the slot layer would hand the component for its declared locale. */
function slotProps(locale, options) {
  return { t: locale.bind(options.locale) }
}

const neverFetch = async () => {
  throw new Error('fetch must not run during registration')
}

await test('the bundle registers one module under the package id', () => {
  const registration = loadBundle(neverFetch)
  assert.equal(registration.id, '@dsh-external/dsh-memory')
  assert.equal(typeof registration.factory, 'function')
})

const plugin = loadBundle(neverFetch).factory((specifier) => {
  if (specifier === 'react') return React
  throw new Error(`unexpected external ${specifier}`)
})

await test('the plugin exports a name, an inject list, and an apply function', () => {
  assert.equal(typeof plugin.name, 'string')
  // `locale` is required so the slot layer injects the bound `t` prop.
  assert.deepEqual(plugin.inject, ['slots', 'locale'])
  assert.equal(typeof plugin.apply, 'function')
})

await test('apply registers the settings section and the composer control', () => {
  const { registrations, injected } = registerComponent(plugin)
  // Two seams: the global settings page, and the per-session control in the conversation. The
  // session switch has to live in the composer because only that slot supplies a `sessionId`.
  assert.deepEqual(injected, ['settings.section', 'conversation.input.left'])
  assert.equal(registrations.length, 2)
  const { options, component } = registrations[0]
  assert.equal(options.name, 'settings.section')
  assert.equal(options.id, 'memory')
  assert.equal(typeof options.order, 'number')
  assert.equal(options.locale, 'memory', 'the entry must declare its locale namespace')
  assert.equal(options.label(), 'Memory')
  assert.equal(typeof component, 'function')

  const composer = registrations.find((entry) => entry.options.name === 'conversation.input.left')
  assert.ok(composer, 'the composer control must be registered')
  assert.equal(composer.options.id, 'memory-toggle')
  assert.equal(composer.options.locale, 'memory')
  // It must not collide with the shipped prompt toggle (order 40) or displace it.
  assert.ok(composer.options.order > 40, 'the control sits after the shipped composer entries')
  assert.equal(composer.options.label(), 'Memory in this session')
  assert.equal(typeof composer.component, 'function')
})

/* ---------------- real server rendering ---------------- */

const STATUS = {
  enabled: true,
  mode: 'native',
  generationEnabled: true,
  consumptionEnabled: true,
  dreamEnabled: true,
  maxTokens: 2000,
  // The legal floor for the cap, from the status payload so the client needs no Host import.
  minTokens: 1,
  // Whether `consumption.*` may be written here at all: `mode: native` refuses every override, so the
  // panel must report the value without offering an edit. The real status route always sends this.
  consumptionWritable: true,
  overflow: 'truncate',
  failureMode: 'best_effort',
  maxOutputTokens: 0,
  pauseAfterFailures: 3,
  gate: { kind: 'minPromptChars', minPromptChars: 40 },
  // The real status route always sends these; a fixture missing one renders "undefined"
  // and reads like a product bug (this exact trap was paid for once already).
  writePolicy: 'memory-root',
  projectFolder: { cwd: 'C:\\proj', source: 'session' },
  trust: { enabled: true, trusted: true, folder: 'C:\\proj', declared: [], remembered: [], folders: [] },
  memoryChange: { fileCount: 2 },
  largeFileLimit: 40000,
  pendingGenerations: 2,
  // The GLOBAL layer the panel reports, and which a session set to `Auto` follows.
  globalScopes: 'all',
  // The states a control may offer, and whether this composition can write config at all. Both come
  // from the Host: the bundle cannot import its vocabulary, and it must not render a Save whose only
  // possible answer is 501. The real status route always sends both.
  globalScopeChoices: ['all', 'user', 'project'],
  configWritable: true,
  // The plugin modes a control may offer, and whether the cap is writable here. Both are Host facts:
  // `consumptionWritable` is false in `native`, where the SDK refuses every consumption override.
  modeChoices: ['native', 'custom'],
  // The WRITE budget as the Host reports it: `0` = no limit, which is the default for both. A fixture
  // that omitted these rendered "undefined" and read like a product bug — the trap this file's other
  // comment warns about, so they are stated rather than left out.
  maxWrites: 0,
  maxWriteBytes: 0,
  // Which of the two policy switches an environment variable overrides. Empty here, so both are
  // editable. The real route always sends an array.
  envPinned: [],
  // The daily journal: off, filed into the project scope. The real route always sends all three.
  journalEnabled: false,
  journalScope: 'project',
  journalDir: 'journal',
  // The session's own mode, which the panel reports read-only (the control is in the composer).
  memoryMode: 'auto',
  lastGeneration: { status: 'saved', turnIndex: 3, writtenFiles: [], failedFiles: [] },
  lastDream: { status: 'saved', reason: 'merged duplicates' },
  lastConsumption: {
    status: 'success',
    files: [
      { id: 'user:MEMORY.md', status: 'loaded' },
      { id: 'project:MEMORY.md', status: 'missing' },
    ],
  },
  roots: [
    {
      id: 'user',
      path: 'C:\\home\\.dsh\\memory',
      access: 'read-write',
      indexFile: 'MEMORY.md',
      files: ['MEMORY.md', 'NOTES.md'],
      size: '2.0 KB',
    },
    {
      id: 'project',
      // The host labels a project scope with its workspace name; `user` has none.
      label: 'Demo project',
      path: 'C:\\proj\\.dsh\\memory',
      access: 'read',
      indexFile: 'MEMORY.md',
      files: [],
      size: '0 B',
    },
  ],
}

/**
 * Render the component with effects flushed and return the rendered text.
 * `react-test-renderer` runs useEffect inside act(), which a server render
 * does not, so the panel's data load actually completes here.
 *
 * @param status - the status payload the fake /status route returns.
 * @param localeId - the active locale (`en` or `zh`).
 * @param options - `{ keep }` returns the live renderer instead of unmounting it,
 *   which a test needs in order to click something; `{ calls }` records every
 *   request URL the panel issues.
 */
async function renderWithStatus(status, localeId = 'en', options = {}) {
  const calls = options.calls ?? []
  const registration = loadBundle(async (url) => {
    calls.push(String(url))
    return {
      ok: true,
      json: async () => (String(url).includes('/status') ? status : { ok: true }),
    }
  })
  const clientPlugin = registration.factory((specifier) => {
    if (specifier === 'react') return React
    throw new Error(`unexpected external ${specifier}`)
  })
  const { registrations, locale } = registerComponent(clientPlugin)
  locale.setActive(localeId)
  const { options: slotOptions, component } = registrations[0]
  let renderer
  await act(async () => {
    renderer = TestRenderer.create(React.createElement(component, slotProps(locale, slotOptions)))
  })
  // Flush the pending status promise and the resulting re-render.
  await act(async () => {
    await Promise.resolve()
  })
  const text = collectText(renderer.toJSON())
  const json = JSON.stringify(renderer.toJSON())
  if (options.keep !== true) renderer.unmount()
  return { text, json, locale, options: slotOptions, renderer, calls }
}

/** Concatenate every rendered string, plus a tag name for each element. */
function collectText(node) {
  if (node === null || node === undefined) return ''
  if (typeof node === 'string' || typeof node === 'number') return `${node}\n`
  if (Array.isArray(node)) return node.map(collectText).join('')
  const own = typeof node.type === 'string' ? `<${node.type}>` : ''
  return `${own}${collectText(node.children)}`
}
await test('the scopes section comes LAST, after every control and the editor', async () => {
  // The owner asked for this explicitly: "将作用域区放到下面去". The section is the only one that grows
  // without bound (one row per project that has memory), so while it sat above the controls it pushed
  // the settings somebody opened this page to change off the first screen.
  //
  // Nothing else pinned the order, which is exactly why this test exists: every other assertion in this
  // file is order-INDEPENDENT, so moving the section back would leave the whole suite green.
  const { text } = await renderWithStatus(STATUS)
  const at = (label) => {
    const index = text.indexOf(label)
    assert.ok(index >= 0, `the panel must render "${label}"`)
    return index
  }
  // The SECTION is located by its note, not by the word "Scopes": the status section contains a
  // `Global scopes` control, so `indexOf('Scopes')` matches THAT and would report the wrong position —
  // a verification script of mine did exactly this and "found" the section in the middle of the page.
  const scopes = at('Every project keeps its own memory')
  for (const label of ['Status', 'Injection budget (consumption)', 'Latest activity', 'Edit memory file']) {
    assert.ok(at(label) < scopes, `"${label}" must come before the scopes section`)
  }
  // The project rows really are inside the section, so the assertions above are about the section and
  // not a stray mention of the word somewhere else on the page.
  assert.match(text.slice(scopes), /Demo project/, 'the scope rows follow the heading')
})

await test('the panel renders the full status, scopes, budget, and activity', async () => {
  const { text, json } = await renderWithStatus(STATUS)
  // Header and description.
  assert.match(text, /Memory/)
  assert.match(text, /Qoder Agent SDK/)
  // Status rows.
  assert.match(text, /enabled/)
  assert.match(text, /minPromptChars=40/)
  // The global layer is EDITABLE in the panel: it is what a session set to `Auto` follows, so the row
  // that explains "Auto" is also where it is changed. It renders as a select of the Host's choices
  // plus a Save, with the current value selected.
  assert.match(text, /Global scopes\n<select>/)
  // (collectText renders tag NAMES only, and no closing tags — so the option run is asserted without
  // one, and the select's own attributes are checked in the JSON projection below.)
  assert.match(text, /<option>user \+ project\n<option>user\n<option>project\n<button>Save\n/)
  assert.match(text, /<button>Save\n/, 'the scope row offers a Save')  // And THIS session's own mode, read-only here: the control is in the composer, but a settings page
  // that omitted it would leave a scoped session looking broken.
  assert.match(text, /Memory in this session\n<span>Auto/)
  assert.match(text, /In-flight generations\n<span>2\n/, 'in-flight generation count must render')
  // Both scopes, their access, their paths, and their files.
  assert.match(text, /C:\\home\\\.dsh\\memory/)
  assert.match(text, /read-write/)
  assert.match(text, /C:\\proj\\\.dsh\\memory/)
  assert.match(text, /MEMORY\.md/)
  assert.match(text, /NOTES\.md/)
  assert.match(text, /<span>read-only\n/, 'the read-only scope access must render localized')
  assert.match(text, /No memory files yet\./)
  // Budget: the labels say WHAT is capped and WHICH enum values exist, because the raw
  // identifiers (`truncate`, `best_effort`) explain nothing on their own.
  //
  // The injection cap is the ONE editable control, so it renders an input holding the current value
  // plus a save button — attributes live in the JSON projection, since `collectText` renders tag
  // NAMES only. The old read-only row claimed "0 = inject nothing", which the configuration never
  // allowed; the hint now says how to really inject nothing.
  assert.match(text, /Injection cap \(tokens\)\n<input><button>Save/)
  assert.match(text, /How much memory may enter the context/)
  // Attribute order follows the object literal, so match the attributes themselves rather than a
  // whole run: the row is now rendered by the shared `Editor` and its props were regrouped.
  assert.match(json, /"type":"number"/)
  assert.match(json, /"className":"dshmem-input dshmem-number"/)
  assert.match(json, /"min":1/)
  assert.match(json, /"value":"2000"/)
  assert.match(text, /If it does not fit \(truncate \| fail_query\)\n<span>truncate\n/)
  assert.match(text, /If a file fails to load \(best_effort \| fail_query\)\n<span>best_effort\n/)
  // The generation side belongs in the same section: one budget without the other is how
  // a spent output budget went unnoticed.
  assert.match(text, /Generation output cap \(0 = model default\)\n<span>0\n/)
  assert.match(text, /Pause after N consecutive failures \(0 = never\)\n<span>3\n/)
  // Latest activity. The per-file consumption list used to live here as an
  // AFTER-THE-FACT row; the injection preview replaced it, because "what will be
  // injected next" answers the same question before it is asked and can say why.
  assert.match(text, /saved \(turn 3\)/)
  assert.match(text, /Last consolidation/)
  // The preview offers to run, and while it has not been run it says what it is.
  assert.match(text, /<button>Preview\n/)
  assert.match(text, /What the next step actually sends/)
  assert.doesNotMatch(text, /Last consumption/, 'the after-the-fact row must be gone, not duplicated')
  // Editor controls.
  assert.match(text, /Edit memory file/)
  assert.match(text, /<textarea>/)
  assert.match(text, /<button>Save\n/)
  assert.match(text, /<button>Reload into session\n/)
  assert.match(text, /<button>Flush generations\n/)
})

await test('the panel degrades the scope control to read-only when this composition cannot write config', async () => {
  // A control whose Save could only ever answer 501 is worse than a read-only row: it invites an
  // action that cannot work. The Host publishes whether a writer exists, and the panel obeys.
  const { text, json } = await renderWithStatus({ ...STATUS, configWritable: false })
  assert.doesNotMatch(text, /Global scopes\n<select>/, 'no select when it could not be saved')
  assert.match(text, /Global scopes\n<span>user \+ project/, 'the value is still REPORTED, just not editable')

  // And when the configuration is in the one state the control may not offer, the panel says so —
  // and MUST NOT display its first option instead. A `<select>` whose value matches no option shows
  // the first one, which would report "user + project" while the truth is "no scope at all": the
  // panel lying about the very thing it exists to explain. The unofferable state becomes its own
  // option, so the control keeps showing the truth and the user can still leave it.
  const none = await renderWithStatus({ ...STATUS, globalScopes: 'none' })
  assert.match(none.text, /No scope is enabled\./, 'a reported-only state is explained')
  assert.match(none.text, /<select><option>no scopes are on\n<option>user \+ project\n/, 'the current state leads the list, so the value it displays is true')
  assert.match(none.json, /"value":"none"/, 'and it is the selected value, not a blank that falls back to option one')
  assert.match(none.text, /<button>Save\n/, 'the state is still writable, so it can be left')
})

await test('the panel says it cannot tell which session it is about, instead of guessing', async () => {
  // With several sessions open and none named, the Host reports no session rather than picking one.
  // The panel must not turn that into "follows the global configuration" — that would be asserting a
  // fact it does not have, which is the exact class of bug this row just had (it reported `auto` for
  // every session, because the route resolved through an initiator a browser request never has).
  const known = await renderWithStatus({ ...STATUS, memoryMode: 'off' })
  assert.match(known.text, /Memory in this session\n<span>Off\n/, 'a real mode is still reported')

  const unknown = await renderWithStatus({ ...STATUS, memoryMode: undefined })
  assert.match(unknown.text, /Memory in this session\n<span>not determinable \(several sessions are open\)\n/)
  assert.doesNotMatch(unknown.text, /Memory in this session\n<span>Auto/, 'must NOT default to Auto')

  const zh = await renderWithStatus({ ...STATUS, memoryMode: undefined }, 'zh')
  assert.match(zh.text, /无法确定（当前打开了多个会话）/, 'and it is translated')
})

/**
 * Render the panel against a canned `/preview` payload, CLICK the preview button, and return the
 * rendered text. Shared by every preview test: the body ships collapsed, so a test that never clicks
 * asserts against the resting card and passes for the wrong reason.
 */
async function clickPreview(previewPayload, status = STATUS) {
  const registration = loadBundle(async (url) => {
    if (String(url).includes('/preview')) return { ok: true, json: async () => previewPayload }
    return { ok: true, json: async () => (String(url).includes('/status') ? status : { ok: true }) }
  })
  const clientPlugin = registration.factory((specifier) => React)
  const { registrations, locale } = registerComponent(clientPlugin)
  const { options, component } = registrations[0]
  locale.setActive('en')
  let renderer
  await act(async () => {
    renderer = TestRenderer.create(React.createElement(component, slotProps(locale, options)))
  })
  await act(async () => {
    await Promise.resolve()
  })
  const button = renderer.root.findAll((node) => node.type === 'button' && String(node.children.join('')) === 'Preview')[0]
  await act(async () => {
    button.props.onClick()
    await Promise.resolve()
  })
  const text = collectText(renderer.toJSON())
  renderer.unmount()
  return text
}

await test('the preview says WHICH question it answered when no session is in scope', async () => {
  // The settings page is a global surface. When the Host had no session to speak for, the preview
  // describes what a session starting NOW would receive — a different claim from "your next step".
  // Both are useful; showing an error instead is what made the button useless, and conflating the two
  // would be a panel that lies about what it read.
  const block = { text: 'BLOCK', status: 'loaded', tokens: 12, maxTokens: 2000, included: [], omitted: [], truncated: [], overflowed: false }
  const global = await clickPreview({
    available: true, mode: 'auto', scope: 'global', session: { cwd: 'D:\\proj' },
    step: { action: 'snapshot', reason: 'no baseline', tokens: 12, text: 'BLOCK', changed: [], removed: [] },
    snapshot: block, files: [],
  })
  assert.match(global, /No session is open, so this is what a session starting now would receive\./)
  assert.match(global, /BLOCK/, 'the block itself still renders')

  // A LIVE preview must NOT carry that note — it answers a different question.
  const live = await clickPreview({
    available: true, mode: 'auto', scope: 'session', session: { id: 'session-aaaa', cwd: 'D:\\proj' },
    step: { action: 'silent', reason: 'unchanged', tokens: 0, text: '', changed: [], removed: [] },
    snapshot: block, files: [],
  })
  assert.doesNotMatch(live, /No session is open/)
})

await test('a MUTED session previews the verdict without crashing the panel', async () => {
  // `previewMemory` answers a muted session with the verdict ALONE — `{ available: true, switchedOff:
  // true, step: { action: 'silent', reason } }` — and deliberately no `snapshot`, because running the
  // pass would describe a step that will not happen. The card read `preview.snapshot.maxTokens` for
  // its note, so the panel THREW while rendering on exactly the state where the preview is most
  // useful. (The integration suite covered the payload; nothing covered the client reading it.)
  const muted = await clickPreview({
    available: true, mode: 'off', switchedOff: true, scope: 'session',
    step: { action: 'silent', reason: 'memory is switched off for this session' },
  })
  // It must render the verdict, and say what it costs without inventing a budget it was not given.
  assert.match(muted, /Next step/)
  assert.match(muted, /nothing \(unchanged\)/, 'the verdict is stated, in the panel language')
  assert.match(muted, /0 tokens/, 'no block was sent, so no budget to report either')
  assert.doesNotMatch(muted, /undefined/, 'and nothing renders as undefined')
  assert.doesNotMatch(muted, /NaN/)
  // There is no block to fold out for a muted session — that IS the answer.
  assert.doesNotMatch(muted, /Full block for a fresh session/)
})

await test('the preview translates the Host verdict instead of printing its code', async () => {
  // A Chinese panel reading "snapshot" is the half-English panel this project refuses. The raw code
  // stays in the tooltip, with the machine reason.
  const block = { text: 'BLOCK', status: 'loaded', tokens: 12, maxTokens: 2000, included: [], omitted: [], truncated: [], overflowed: false }
  for (const [action, want] of [
    ['silent', /nothing \(unchanged\)/],
    ['snapshot', /the full block/],
    ['delta', /only what changed/],
    ['none', /nothing \(nothing to inject\)/],
  ]) {
    const text = await clickPreview({
      available: true, mode: 'auto', scope: 'session', session: { id: 's', cwd: 'D:\\proj' },
      step: { action, reason: 'machine reason', tokens: 1, text: 'BLOCK', changed: [], removed: [] },
      snapshot: block, files: [],
    })
    assert.match(text, want, `${action} must be shown in words`)
    assert.doesNotMatch(text, new RegExp(`>${action}<`), `${action} must not be printed raw`)
  }
  // An action this build does not know is admitted rather than echoed.
  const unknown = await clickPreview({
    available: true, mode: 'auto', scope: 'session', session: { id: 's', cwd: 'D:\\proj' },
    step: { action: 'something-new', reason: 'r', tokens: 1, text: 'BLOCK', changed: [], removed: [] },
    snapshot: block, files: [],
  })
  assert.match(unknown, /an action this panel does not know/)
})

await test('the preview reports the SNAPSHOT’s cost, not zero', async () => {
  // `planInjection` only set `tokens` for a delta (where the delta's cost differs from the block's), so
  // a snapshot reported `0` — the panel said "0 of 10000 tokens used" while showing a full block
  // underneath it. The block's own cost is the honest number for a snapshot.
  const block = { text: 'BLOCK', status: 'loaded', tokens: 1234, maxTokens: 10000, included: [], omitted: [], truncated: [], overflowed: false }
  const text = await clickPreview({
    available: true, mode: 'auto', scope: 'session', session: { id: 's', cwd: 'D:\\proj' },
    step: { action: 'snapshot', reason: 'no baseline', tokens: 1234, text: 'BLOCK', changed: [], removed: [] },
    snapshot: block, files: [],
  })
  assert.match(text, /1234 of 10000 tokens used/, 'the real cost is reported')

  // And with the Host sending no per-step count (an older build), the block's own number is used
  // rather than a zero that would contradict the text below it.
  const fallback = await clickPreview({
    available: true, mode: 'auto', scope: 'session', session: { id: 's', cwd: 'D:\\proj' },
    step: { action: 'snapshot', reason: 'no baseline', text: 'BLOCK', changed: [], removed: [] },
    snapshot: block, files: [],
  })
  assert.match(fallback, /1234 of 10000 tokens used/)
  assert.doesNotMatch(fallback, /^0 of/)
})

await test('the injected block WRAPS instead of clipping long lines', async () => {
  // `<pre>` defaults to `white-space: pre`, so a long memory line ran off the right edge and was cut
  // mid-word with no way to read it — visible in the committed screenshots. Memory is prose plus file
  // paths, so this is the normal case, not an edge one. Asserted from the REAL rendered component, so
  // dropping the rule fails here.
  const { text } = await renderWithStatus(STATUS)
  assert.match(text, /\.dshmem-pre\{[^}]*white-space:pre-wrap/, 'the block must wrap')
  assert.match(text, /\.dshmem-pre\{[^}]*overflow-wrap:break-word/, 'and must break an unbroken path')
})

await test('the panel offers the WRITE budget, and says "no limit" instead of a bare 0', async () => {
  // The write budgets default to `0` = NO LIMIT. A bare `0` in a row labelled with a number reads as
  // the strictest possible setting when it is in fact the loosest, so the read-only form says it in
  // words — and the hint teaches what 0 means, because a control whose zero means "unlimited" is a
  // trap otherwise.
  const { text, json } = await renderWithStatus(STATUS)
  assert.match(text, /Write budget/)
  // Both fields are LABELLED, not two anonymous number boxes: "0 = unlimited" is useless if you cannot
  // tell which box is files and which is bytes.
  assert.match(text, /Files per pass/)
  assert.match(text, /Bytes per file/)
  assert.match(text, /0 = no limit \(the default\)/)
  // Two editable number inputs, both with the floor at 0 — `0` is LEGAL here, unlike the injection cap,
  // whose floor is 1. Asserted on the render tree (which carries props), because `collectText` emits
  // tag names only and would match nothing.
  const numbers = [...json.matchAll(/"min":0/g)]
  assert.equal(numbers.length, 2, `both write-budget fields must accept 0: ${numbers.length}`)
  assert.doesNotMatch(text, /undefined/)
})

await test('the panel reports the write budget read-only where the plugin would refuse the write', async () => {
  // `generation.*` is refused in `mode: native` exactly like the injection cap, so the control must
  // not be offered there — and the values must still be REPORTED, with 0 spelled out.
  const { json, text } = await renderWithStatus({ ...STATUS, consumptionWritable: false, maxWrites: 0, maxWriteBytes: 16384 })
  assert.doesNotMatch(json, /aria-label|Files per pass/, 'the editable fields must not be offered')
  assert.match(text, /no limit/, 'the 0 budget is reported as "no limit"')
  assert.match(text, /16384/, 'and a real limit is reported as its number')
})

await test('the panel offers the two policy switches, and reports an env-pinned one', async () => {
  // Qoder's `auto_memory_policy` / `auto_dream`, editable. They are two toggles but ONE write, so the
  // Save is offered whenever either moved.
  const { text, json } = await renderWithStatus(STATUS)
  assert.match(text, /Automatic/, 'the first switch is labelled')
  assert.match(text, /Consolidation/, 'and the second keeps its existing term')
  assert.match(json, /dshmem-policy-enabled/, 'the pass toggle renders')
  assert.match(json, /dshmem-policy-dream/, 'the dream toggle renders')
  assert.match(text, /Turning the pass off also disables its per-turn trigger/)

  // An env-pinned switch is SAID OUT LOUD: `DSH_MEMORY_DREAM=false` overrides the config, so the
  // toggle would silently do nothing. A switch that cannot take effect is worse than an absent one.
  const pinned = await renderWithStatus({ ...STATUS, envPinned: ['dream'] })
  assert.match(pinned.text, /pinned by an environment variable/)
  assert.match(pinned.text, /dream/, 'and it names which one')

  // Under `native` the whole `generation.*` block is refused, so the controls degrade to read-only
  // rows showing the same values — never a dead control. (`Tag` renders a real `<span>`, and `OnOff`
  // inside it prints the `on`/`off` badge, so the row reads `Generation` then that badge.)
  const native = await renderWithStatus({ ...STATUS, consumptionWritable: false })
  assert.doesNotMatch(native.json, /dshmem-policy-enabled/, 'no dead control under native')
  assert.doesNotMatch(native.json, /dshmem-policy-dream/, 'and no dead dream toggle either')
  assert.match(native.text, /Generation\n<span>on/, 'the value is still reported')
  assert.match(native.text, /Consolidation\n<span>on/, 'both switches are reported')
})

await test('the panel offers the daily-journal switch, and says where entries land', async () => {
  // Qoder's `action: "add"`, `target: "daily"`. It is a third toggle in the same row and the same
  // write — three halves of one decision, so one Save cannot leave two of them behind.
  const { text, json } = await renderWithStatus(STATUS)
  assert.match(text, /Daily journal/, 'the switch is labelled')
  assert.match(json, /dshmem-policy-journal/, 'the toggle renders')
  assert.match(text, /automatic pass, consolidation, and the daily journal/, 'the hint covers all three')
  // With the journal OFF there is nothing to explain about where it would go.
  assert.doesNotMatch(text, /Journal entries go to/)

  // ON: the panel says which scope and which subdirectory, because "on" without knowing WHERE leaves
  // somebody hunting for the file.
  const on = await renderWithStatus({ ...STATUS, journalEnabled: true, journalScope: 'project' })
  assert.match(on.text, /Journal entries go to the project scope/)
  assert.match(on.text, /journal\/ subdirectory/)
  assert.match(on.text, /never injected into the context/)
  const user = await renderWithStatus({ ...STATUS, journalEnabled: true, journalScope: 'user' })
  assert.match(user.text, /Journal entries go to the user scope/)
})

await test('the panel reports the journal read-only where the plugin would refuse the write', async () => {
  // `generation.*` is refused under `native`, so the whole row degrades — journal included.
  const native = await renderWithStatus({ ...STATUS, consumptionWritable: false, journalEnabled: true })
  assert.doesNotMatch(native.json, /dshmem-policy-journal/, 'no dead control under native')
  assert.match(native.text, /Daily journal\n<span>on/, 'the value is still reported')
})

await test('the panel offers the MODE, which is the way back in from a locked cap', async () => {
  // Without this row, a user whose plugin runs `native` cannot change the injection cap from the panel
  // at all — they would have to hand-edit YAML and restart. So the mode is not a decoration: it is the
  // escape hatch. The choice list comes from the Host, never invented here.
  const { text, json } = await renderWithStatus(STATUS)
  assert.match(text, /Mode\n<select>/)
  assert.match(text, /<option>native \(runtime decides\)\n<option>custom \(you decide\)\n/)
  // The selected value is the CURRENT mode, so the control cannot display a mode the plugin is not in.
  assert.match(json, /"className":"dshmem-select dshmem-mode","value":"native"/, 'fixture mode is native')
  assert.match(text, /Which contract this plugin runs under/)

  // The hint points at this row from the locked cap, so the two must name the same thing.
  const locked = await renderWithStatus({ ...STATUS, consumptionWritable: false })
  assert.match(locked.text, /Read-only in mode "native"/)
  assert.match(locked.text, /custom/, 'the locked note tells the user which mode unlocks it')

  // With no writer at all, the mode degrades to the read-only row like every other control.
  const bare = await renderWithStatus({ ...STATUS, configWritable: false })
  assert.doesNotMatch(bare.text, /Mode\n<select>/)
  assert.match(bare.text, /Mode\n<span>native/, 'the value is still reported, just not editable')
})

await test('the panel POSTs the mode it was asked to switch to', async () => {
  const posted = []
  const registration = loadBundle(async (url, init) => {
    if (init !== undefined) posted.push({ url: String(url), body: init.body })
    return { ok: true, json: async () => (String(url).includes('/status') ? STATUS : { ok: true, mode: 'custom', dropped: [] }) }
  })
  const clientPlugin = registration.factory((specifier) => React)
  const { registrations, locale } = registerComponent(clientPlugin)
  const { options, component } = registrations[0]
  let renderer
  await act(async () => {
    renderer = React.createElement(component, slotProps(locale, options))
    renderer = TestRenderer.create(renderer)
  })
  await act(async () => {
    await Promise.resolve()
  })
  const select = renderer.root.findAll((node) => node.type === 'select' && String(node.props.className).includes('dshmem-mode'))[0]
  await act(async () => {
    select.props.onChange({ target: { value: 'custom' } })
  })
  // Click the Save in THIS row: the panel renders several, so "the first button" is the wrong one.
  const saveButton = select.parent.findAll((node) => node.type === 'button')[0]
  await act(async () => {
    saveButton.props.onClick()
    await Promise.resolve()
  })
  renderer.unmount()

  assert.equal(posted.length, 1, 'exactly one write')
  assert.equal(posted[0].url, '/api/memory/mode')
  assert.deepEqual(JSON.parse(posted[0].body), { mode: 'custom' })
})

await test('the panel reports the settings a switch to native removed', async () => {
  // A `custom -> native` switch has to DROP what native refuses (that is what handing the policy back
  // means). Dropping a prompt in silence would be the panel editing somebody's configuration behind
  // their back, so the reply's `dropped` list has to reach the message.
  const registration = loadBundle(async (url, init) => {
    if (init !== undefined) return { ok: true, json: async () => ({ ok: true, mode: 'native', dropped: ['generation.prompt', 'consumption.maxTokens'] }) }
    return { ok: true, json: async () => (String(url).includes('/status') ? STATUS : { ok: true }) }
  })
  const clientPlugin = registration.factory((specifier) => React)
  const { registrations, locale } = registerComponent(clientPlugin)
  const { options, component } = registrations[0]
  let renderer
  await act(async () => {
    renderer = TestRenderer.create(React.createElement(component, slotProps(locale, options)))
  })
  await act(async () => {
    await Promise.resolve()
  })
  const select = renderer.root.findAll((node) => node.type === 'select' && String(node.props.className).includes('dshmem-mode'))[0]
  await act(async () => {
    select.props.onChange({ target: { value: 'custom' } })
  })
  await act(async () => {
    select.parent.findAll((node) => node.type === 'button')[0].props.onClick()
    await Promise.resolve()
  })
  const text = collectText(renderer.toJSON())
  renderer.unmount()
  assert.match(text, /Removed so native accepts it: generation\.prompt, consumption\.maxTokens/)
})

await test('the panel reports the cap without offering an edit `native` mode would refuse', async () => {
  // The defect this pins, reported from a live profile: the panel offered an editable cap in
  // `mode: native`, where the SDK accepts only the two `onResult` callbacks. Saving wrote a
  // configuration the plugin rejects, and a rejected configuration does not merely fail to apply —
  // `validateMemoryConfig` runs inside `apply()`, so the plugin FAILED TO ACTIVATE and memory
  // vanished from every session. The value is still reported; only the edit is withheld.
  const { text, json } = await renderWithStatus({ ...STATUS, mode: 'native', consumptionWritable: false })
  assert.match(text, /Injection cap \(tokens\)\n<span>2000/, 'the value must still be REPORTED')
  // Precisely: the CAP's editable box is gone. (The scope row has its own Save, so "no Save anywhere"
  // would be the wrong assertion — and would have been a test that passes for the wrong reason.)
  assert.doesNotMatch(json, /"type":"number"/, 'no editable box at all')
  assert.doesNotMatch(json, /dshmem-number/, 'and not the number-input class either')
  // The note names the way out, so "why is this grey" has an answer on the page.
  assert.match(text, /Read-only in mode "native"/)
  assert.match(text, /mode: custom/, 'and it says which mode unlocks it')

  const zh = await renderWithStatus({ ...STATUS, mode: 'native', consumptionWritable: false }, 'zh')
  assert.match(zh.text, /「native」模式下这一项是只读的/, 'the explanation must be translated')
})

await test('the panel keeps the cap editable wherever the plugin accepts it', async () => {
  // The counterpart: in `custom` mode the cap is writable, so the control must be there. Without this
  // the test above would pass on a panel that never offered the edit at all.
  const { json } = await renderWithStatus({ ...STATUS, mode: 'custom', consumptionWritable: true })
  assert.match(json, /"type":"number"/)
  assert.doesNotMatch(json, /Read-only in mode/)
})

await test('the panel saves the global scopes through the scope route', async () => {
  // The write path, driven for real: pick a different state, click Save, and assert the exact body.
  const calls = []
  const posted = []
  const registration = loadBundle(async (url, init) => {
    calls.push(String(url))
    if (init !== undefined) posted.push({ url: String(url), body: init.body })
    return { ok: true, json: async () => (String(url).includes('/status') ? STATUS : { ok: true, scopes: 'project' }) }
  })
  const clientPlugin = registration.factory((specifier) => React)
  const { registrations, locale } = registerComponent(clientPlugin)
  const { options, component } = registrations[0]
  let renderer
  await act(async () => {
    renderer = TestRenderer.create(React.createElement(component, slotProps(locale, options)))
  })
  await act(async () => {
    await Promise.resolve()
  })
  // Change the controlled select's value, then Save. Select BY CLASS, and click the Save in the SAME
  // row: the panel now renders several Save buttons (mode, scopes, cap), so "the first one" silently
  // clicked a different row's control — the same positional-lookingup trap this suite hit twice before.
  const select = renderer.root.findAll((node) => node.type === 'select' && String(node.props.className).includes('dshmem-global'))[0]
  await act(async () => {
    select.props.onChange({ target: { value: 'project' } })
  })
  const saveButton = select.parent.findAll((node) => node.type === 'button')[0]
  await act(async () => {
    saveButton.props.onClick()
    await Promise.resolve()
  })
  renderer.unmount()

  assert.equal(posted.length, 1, 'exactly one write')
  assert.equal(posted[0].url, '/api/memory/scope')
  assert.deepEqual(JSON.parse(posted[0].body), { scopes: 'project' })
})

await test('the panel renders the custom-gate shape', async () => {
  const { text } = await renderWithStatus({
    ...STATUS,
    gate: { kind: 'custom', timeoutMs: 2500, onGateError: 'report_failed' },
  })
  assert.match(text, /custom shouldGenerate/)
  assert.match(text, /2500ms/)
  assert.match(text, /report_failed/)
})

await test('the panel degrades honestly when status is unavailable', async () => {
  const registration = loadBundle(async () => ({ ok: false, status: 500, json: async () => ({}) }))
  const clientPlugin = registration.factory((specifier) => React)
  const { registrations, locale } = registerComponent(clientPlugin)
  const { options, component } = registrations[0]
  let renderer
  await act(async () => {
    renderer = TestRenderer.create(React.createElement(component, slotProps(locale, options)))
  })
  await act(async () => {
    await Promise.resolve()
  })
  const html = JSON.stringify(renderer.toJSON())
  renderer.unmount()
  assert.match(html, /unavailable/)
})

await test('styling is class-based and carries the stylesheet', async () => {
  const { json } = await renderWithStatus(STATUS)
  // The component owns its stylesheet, so unmounting removes it.
  assert.match(json, /dshmem-page/, 'the stylesheet must reach the render tree')
  assert.match(json, /--dsw-alias-label-primary/, 'the stylesheet must use real theme tokens')
  // Controls must be addressed by the plugin's prefixed classes, not inline
  // styles: inline styles cannot express the host's hover/active/focus states.
  const inline = [...json.matchAll(/"style":/g)]
  assert.deepEqual(inline, [], 'the panel must not fall back to inline styles')
  const classes = new Set([...json.matchAll(/dshmem-[a-z-]+/g)].map((match) => match[0]))
  assert.ok(classes.size >= 8, `expected the panel to use its class vocabulary, saw ${[...classes].join(', ')}`)
  // No literal colour anywhere in the rendered output.
  const hex = json.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []
  assert.deepEqual(hex, [], `rendered output must not contain literal colors, found ${hex.join(', ')}`)
})

await test('a label/value row cannot squeeze its label into a column', () => {
  // A layout bug that no behavioural test can see: the row is `label` + `value`,
  // and with `flex:1;min-width:0` on the label a long value shrank it to almost
  // nothing. CJK labels have no spaces to break at, so they collapsed into one
  // character per line — the settings panel's "last consumption" row did exactly
  // that once the file list grew.
  const rule = (selector) => {
    const match = new RegExp(`\\${selector}\\{([^}]*)\\}`).exec(source)
    assert.ok(match, `${selector} must be defined`)
    return match[1]
  }
  const label = rule('.dshmem-label')
  assert.match(label, /min-width:max-content/, 'the label must not be shrinkable below its text')
  assert.ok(!/min-width:0/.test(label), 'min-width:0 is exactly what let the label be squeezed away')
  assert.match(label, /word-break:keep-all/, 'and must not break between CJK characters')

  const value = rule('.dshmem-value')
  assert.match(value, /min-width:0/, 'the value is the half that shrinks and wraps')
  assert.match(value, /text-align:right/, 'values stay right-aligned, as the rest of the panel is')
})

await test('the panel escapes host-supplied text', async () => {
  const { text, json } = await renderWithStatus({
    ...STATUS,
    roots: [
      {
        id: 'user',
        path: '<img src=x onerror=alert(1)>',
        access: 'read-write',
        indexFile: 'MEMORY.md',
        files: ['<script>alert(1)</script>.md'],
      },
    ],
  })
  // Ask the render tree itself which element types exist: host-supplied text
  // must never create an img or script element.
  const parsed = JSON.parse(json)
  const elementNames = new Set()
  const walk = (node) => {
    if (node === null || typeof node !== 'object') return
    if (Array.isArray(node)) return node.forEach(walk)
    if (typeof node.type === 'string') elementNames.add(node.type)
    if (node.children) node.children.forEach(walk)
  }
  walk(parsed)
  assert.ok(!elementNames.has('img'), `host text must not become an img element; saw ${[...elementNames].join(', ')}`)
  assert.ok(!elementNames.has('script'), `host text must not become a script element; saw ${[...elementNames].join(', ')}`)
  // The text itself is preserved verbatim as data.
  assert.ok(text.includes('<img src=x onerror=alert(1)>'), 'the text itself is preserved as data')
  assert.ok(text.includes('<script>alert(1)</script>.md'), 'the file name is preserved as data')
})

await test('no React warning was emitted across every render in this suite', () => {
  // Structural mistakes (an array child without keys, an invalid prop) surface
  // as console.error warnings, never throws. This runs last, after every render.
  assert.deepEqual(reactWarnings, [], `React warned: ${reactWarnings.join(' | ')}`)
})

await test('the panel exposes the index/content model and the dream pass', async () => {
  const en = await renderWithStatus(STATUS, 'en')
  // The consolidation switch and its last result are both visible.
  assert.match(en.text, /Consolidation/)
  assert.match(en.text, /Last consolidation/)
  assert.match(en.text, /merged duplicates/)
  const zh = await renderWithStatus(STATUS, 'zh')
  assert.match(zh.text, /记忆巩固/)
  assert.match(zh.text, /最近一次巩固/)
  assert.ok(!zh.text.includes('Last consolidation'), 'a label leaked untranslated')
})

/* ---------------- localization ---------------- */

await test('the plugin registers zh and en dictionaries for its namespace', () => {
  const { locale } = registerComponent(plugin)
  assert.ok(locale.dicts.has('memory\u0000en'), 'the English dictionary must be registered')
  assert.ok(locale.dicts.has('memory\u0000zh'), 'the Chinese dictionary must be registered')
})

await test('every English key has a Chinese translation (no untranslated string)', () => {
  const { locale } = registerComponent(plugin)
  const en = locale.dicts.get('memory\u0000en')
  const zh = locale.dicts.get('memory\u0000zh')
  const missing = Object.keys(en).filter((key) => !(key in zh))
  assert.deepEqual(missing, [], `Chinese dictionary is missing: ${missing.join(', ')}`)
  const extra = Object.keys(zh).filter((key) => !(key in en))
  assert.deepEqual(extra, [], `Chinese dictionary has keys English lacks: ${extra.join(', ')}`)

  /**
   * Identifiers, not prose: these stay identical by design, because translating
   * them would stop the UI matching what the user types. Each one is pinned to the
   * SHAPE it is allowed to have, so this list cannot hide real prose.
   */
  const IDENTIFIERS = new Map([
    ['gateBuiltin', /^minPromptChars=\{minPromptChars\}$/], // a config field name
    ['filenamePlaceholder', /^MEMORY\.md$/], // a real file name
    // The command list: only slash-command names, separated by `·`. Pinned this
    // tightly because it is the one identifier that carries punctuation.
    ['commands', /^\/[\w-]+(?: · \/[\w-]+)*$/],
  ])
  const untranslated = Object.keys(zh).filter(
    (key) => !IDENTIFIERS.has(key) && zh[key] === en[key] && /[a-zA-Z]{4,}/.test(en[key]),
  )
  assert.deepEqual(untranslated, [], `these keys are still English: ${untranslated.join(', ')}`)
  // Every identifier must still be one, so this list cannot hide real prose.
  for (const [key, shape] of IDENTIFIERS) {
    assert.ok(key in en, `${key} is allowlisted but missing from the English dictionary`)
    assert.match(en[key], shape, `${key} is allowlisted as an identifier but reads as prose`)
  }
})

await test('the two dictionaries interpolate the same parameters', () => {
  const { locale } = registerComponent(plugin)
  const en = locale.dicts.get('memory\u0000en')
  const zh = locale.dicts.get('memory\u0000zh')
  const params = (text) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort()
  for (const key of Object.keys(en)) {
    assert.deepEqual(
      params(zh[key]),
      params(en[key]),
      `key "${key}" interpolates different parameters in zh vs en`,
    )
  }
})

await test('the trust row states the decision, not just the switch', async () => {
  // `text` carries element names only, so the tone assertion reads the JSON.
  const trusted = await renderWithStatus(STATUS)
  assert.match(trusted.text, /Folder trust\n<span><span>trusted/)
  assert.match(trusted.json, /"data-tone":"success"/)
  // Scoped to the trust row: the session switch has rows of its own, and a muted
  // session draws a warning tone there (see the switch test below).
  assert.match(trusted.text, /Folder trust\n<span><span>trusted[\s\S]*?<button>Stop trusting/)
  // A trusted folder offers to revoke, and names the folder it means.
  assert.match(trusted.text, /Stop trusting/)
  assert.match(trusted.text, /C:\\proj/)

  const untrustedStatus = {
    ...STATUS,
    trust: { enabled: true, trusted: false, folder: 'C:\\proj', declared: [], remembered: [], folders: [] },
  }
  const untrusted = await renderWithStatus(untrustedStatus)
  assert.match(untrusted.text, /Folder trust\n<span><span>not trusted — project scope is skipped/)
  assert.match(untrusted.json, /"data-tone":"warning"/, 'an untrusted folder must be called out')
  assert.match(untrusted.text, /Trust this folder/, 'an untrusted folder offers the grant')

  const zh = await renderWithStatus(untrustedStatus, 'zh')
  assert.match(zh.text, /目录信任\n<span><span>未信任——跳过项目作用域/)
  assert.ok(!zh.text.includes('not trusted'), 'the consequence text must be translated too')
  assert.match(zh.text, /信任此目录/, 'the button is translated as well')

  // With the gate off there is nothing to grant, so no button appears.
  const inert = await renderWithStatus({ ...STATUS, trust: { enabled: false, trusted: true, folder: 'C:\\proj' } })
  assert.doesNotMatch(inert.text, /Stop trusting|Trust this folder/)
})

await test('the trust button posts the decision and reloads', async () => {
  const calls = []
  const untrustedStatus = {
    ...STATUS,
    trust: { enabled: true, trusted: false, folder: 'C:\\proj', declared: [], remembered: [], folders: [] },
  }
  const { renderer } = await renderWithStatus(untrustedStatus, 'en', { keep: true, calls })
  const button = renderer.root.findAll((node) => node.type === 'button' && collectText(node.props.children).includes('Trust'))
  assert.equal(button.length, 1, 'exactly one trust button')
  await act(async () => {
    button[0].props.onClick()
    await Promise.resolve()
  })
  renderer.unmount()

  const trustCall = calls.find((url) => url.includes('/api/memory/trust'))
  assert.ok(trustCall, `the button must call the trust route (saw ${calls.join(', ')})`)
  // And the panel reloads its status afterwards, so the row reflects the decision.
  assert.ok(calls.filter((url) => url.includes('/status')).length >= 2)
})

/**
 * Render the COMPOSER control with effects flushed.
 *
 * The composer control is a separate slot registration with a different prop contract — the slot
 * layer supplies `sessionId` — so it needs its own harness. The fake fetch answers the switch
 * route with `payload`, and records every request.
 */
async function renderComposer(payload, localeId = 'en', options = {}) {
  const calls = options.calls ?? []
  const registration = loadBundle(async (url) => {
    calls.push(String(url))
    if (String(url).includes('/api/memory/switch')) {
      if (options.mode !== undefined && String(url).startsWith('http') === false && options.posted === true) {
        return { ok: true, json: async () => ({ ...payload, mode: options.mode }) }
      }
      return { ok: options.fail === true ? false : true, json: async () => (options.fail === true ? { error: 'boom' } : payload) }
    }
    return { ok: true, json: async () => ({ ok: true }) }
  })
  const clientPlugin = registration.factory((specifier) => {
    if (specifier === 'react') return React
    throw new Error(`unexpected external ${specifier}`)
  })
  const { registrations, locale } = registerComponent(clientPlugin)
  locale.setActive(localeId)
  const { options: slotOptions, component } = registrations.find((entry) => entry.options.name === 'conversation.input.left')
  let renderer
  await act(async () => {
    renderer = TestRenderer.create(
      React.createElement(component, { ...slotProps(locale, slotOptions), sessionId: options.sessionId ?? 'session-aaaa' }),
    )
  })
  await act(async () => {
    await Promise.resolve()
  })
  const text = collectText(renderer.toJSON())
  const json = JSON.stringify(renderer.toJSON())
  if (options.keep !== true) renderer.unmount()
  return { text, json, renderer, locale, options: slotOptions, calls }
}

const TOGGLE = { session: 'session-aaaa', cwd: 'C:\\proj', mode: 'auto', modes: ['auto', 'all', 'user', 'project', 'off'], global: 'all' }

await test('the composer control cycles all FIVE states, each saying what it does', async () => {
  // The button's own text and `data-state` are the contract: the label says the CURRENT state, and
  // the dot's tone makes it readable at a glance in a busy composer row.
  const auto = await renderComposer(TOGGLE)
  assert.match(auto.text, /<button><span>Auto\n/)
  assert.match(auto.json, /"data-state":"auto"/)
  // The tooltip answers all three questions a user has, not just the next click: what is in effect,
  // what it means, and what clicking does.
  assert.match(auto.json, /"title":"Now: Auto · follows the global scopes: user \+ project · Click for User \+ project"/)
  // The accessible name is the whole sentence, so a screen reader is not left with one label.
  assert.match(auto.json, /"aria-label":"Memory in this session: Auto — follows the global scopes: user \+ project"/)

  // Each of the three scope states says what it DOES. Without that the five would be distinguishable
  // only by name, which is the defect the tooltip was rewritten to fix.
  const all = await renderComposer({ ...TOGGLE, mode: 'all' })
  assert.match(all.text, /<button><span>User \+ project\n/)
  assert.match(all.json, /"data-state":"all"/)
  assert.match(all.json, /both scopes for this session, whatever the global layer says/)
  assert.match(all.json, /Click for User only/)

  const user = await renderComposer({ ...TOGGLE, mode: 'user' })
  assert.match(user.text, /<button><span>User only\n/)
  assert.match(user.json, /"data-state":"user"/)
  assert.match(user.json, /cross-project \(user\) memory only — this project’s memory is neither loaded nor recorded/)
  assert.match(user.json, /Click for Project only/)

  const project = await renderComposer({ ...TOGGLE, mode: 'project' })
  assert.match(project.text, /<button><span>Project only\n/)
  assert.match(project.json, /"data-state":"project"/)
  assert.match(project.json, /project memory only — cross-project knowledge is neither loaded nor recorded/)
  assert.match(project.json, /Click for Off/)

  const off = await renderComposer({ ...TOGGLE, mode: 'off' })
  assert.match(off.text, /<button><span>Off\n/)
  assert.match(off.json, /"data-state":"off"/)
  assert.match(off.json, /nothing is injected into this session, and nothing from it is recorded/)
  // From `off` the cycle wraps to `auto`, so one button covers all five with no menu.
  assert.match(off.json, /Click for Auto/)

  // The global layer is stated as what `auto` actually follows, so "Auto" is not a word with nothing
  // behind it: with the global user scope off, Auto names the project scope alone.
  const scoped = await renderComposer({ ...TOGGLE, mode: 'auto', global: 'project' })
  assert.match(scoped.json, /follows the global scopes: project/)
})

await test('every composer state has its own dot colour', async () => {
  // The dot is the at-a-glance signal, and a state with no rule falls back to the neutral default,
  // which reads as "nothing is set". Adding a state and forgetting its colour would therefore make
  // the button quietly LESS informative than before it existed.
  //
  // Read the CSS out of a REAL render rather than the source text: the stylesheet is a JS string
  // with escaped quotes, so a source-level regex can miss the very rules a browser would apply.
  const { SESSION_MODES } = await import('../lib/session/memory-switch.js')
  const { renderer } = await renderComposer(TOGGLE, 'en', { keep: true })
  const style = renderer.root.findAll((node) => node.type === 'style')[0]
  const css = String(style.children.join(''))
  renderer.unmount()

  const selectors = new Set([...css.matchAll(/dshmem-quick\[data-state='(\w+)'\] +\.dshmem-quick-dot/g)].map((m) => m[1]))
  assert.ok(selectors.size >= SESSION_MODES.length, `expected a rule per state, found ${[...selectors].join(', ')}`)
  for (const mode of SESSION_MODES) {
    assert.ok(selectors.has(mode), `mode "${mode}" has no dot colour, so it renders as "nothing is set"`)
  }
  // The tone is meant to GROUP the states, not merely exist: the three scope states share the
  // "pinned for this session" colour, so a glance says "overridden" without reading the label.
  // They are written as ONE rule with a comma-separated selector list, so match that shape and
  // require the single declaration it ends with.
  const pinned = css.match(/(\.dshmem-quick\[data-state='(?:all|user|project)'\] +\.dshmem-quick-dot,?)+\{([^}]*)\}/)
  assert.ok(pinned, 'the three pinned scope states must share one dot colour')
  assert.deepEqual(
    [...new Set([...pinned[2].matchAll(/background:var\((--[\w-]+)/g)].map((m) => m[1]))],
    ['--dsw-alias-state-business-primary'],
    'the pinned group must resolve to exactly one colour',
  )
  // And it must be a DIFFERENT colour from `auto` and from `off`, or the dot stops distinguishing
  // "following the configuration" from "pinned" — the one thing it is there for.
  const colorOf = (state) => {
    const rule = css.match(new RegExp(`dshmem-quick\\[data-state='${state}'\\] +\\.dshmem-quick-dot\\{([^}]*)\\}`))
    return rule === null ? undefined : rule[1].match(/var\((--[\w-]+)/)[1]
  }
  assert.notEqual(colorOf('auto'), colorOf('project'), 'auto and a pinned state must not share a tone')
  assert.notEqual(colorOf('off'), colorOf('auto'), 'off and auto must not share a tone')
})

await test('the composer’s offline cycle matches the modes the Host publishes', async () => {
  // The button has a built-in cycle for the moment before the first read lands. If it disagreed with
  // `SESSION_MODES`, a user could click a state this build does not implement — and the request would
  // be refused only after the poll arrived. Pin the two lists to each other.
  const { SESSION_MODES } = await import('../lib/session/memory-switch.js')
  const source = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8')
  const match = source.match(/var fallback = \[([^\]]*)\]/)
  assert.ok(match, 'the composer control must keep a fallback cycle')
  const fallback = [...match[1].matchAll(/'([a-z]+)'/g)].map((m) => m[1])
  assert.deepEqual(fallback, [...SESSION_MODES], 'the offline cycle must be exactly the Host’s mode list')
})

await test('the composer control says which of the three reasons it cannot answer', async () => {
  // Three distinct situations, kept apart: no session id yet (nothing was ever requested), a poll
  // that has not landed, and a real failure. Blaming all three on "could not change it" — as an
  // earlier version did — made a not-yet-loaded button look like a broken one.
  const noSession = await renderComposer(TOGGLE, 'en', { sessionId: '' })
  assert.match(noSession.json, /"title":"This session has no id yet, so memory cannot be switched from here\."/)
  assert.equal(noSession.json.includes('"disabled":true'), true, 'with no id the control is disabled, not a lie')
  assert.doesNotMatch(noSession.json, /Click for/, 'it must not promise a click that cannot happen')
})

await test('the composer control posts the CYCLE, naming its own session', async () => {
  const calls = []
  const posted = []
  const registration = loadBundle(async (url, init) => {
    calls.push(String(url))
    if (init !== undefined) posted.push({ url: String(url), body: init.body })
    return { ok: true, json: async () => TOGGLE }
  })
  const clientPlugin = registration.factory((specifier) => {
    if (specifier === 'react') return React
    throw new Error(`unexpected external ${specifier}`)
  })
  const { registrations, locale } = registerComponent(clientPlugin)
  const entry = registrations.find((item) => item.options.name === 'conversation.input.left')
  let renderer
  await act(async () => {
    renderer = TestRenderer.create(React.createElement(entry.component, { ...slotProps(locale, entry.options), sessionId: 'session-aaaa' }))
  })
  await act(async () => {
    await Promise.resolve()
  })
  const button = renderer.root.findAll((node) => node.type === 'button')
  assert.equal(button.length, 1, 'the control is one button')
  await act(async () => {
    button[0].props.onClick()
    await Promise.resolve()
  })
  renderer.unmount()

  // It READ its own session (the slot supplied the id)...
  assert.ok(calls.some((url) => url.includes('/api/memory/switch?session=session-aaaa')), `must name its session (saw ${calls.join(', ')})`)
  // ...and the click POSTed the NEXT state in the cycle, to that same named session.
  assert.equal(posted.length, 1, 'exactly one write')
  assert.equal(posted[0].url, '/api/memory/switch')
  assert.deepEqual(JSON.parse(posted[0].body), { session: 'session-aaaa', mode: 'all' })
})

await test('the composer control keeps a failure on the button instead of throwing', async () => {
  // This control lives in the composer row: an exception here would take the tool row down, so a
  // refusal (an unknown session is a 409) must be reported, not thrown.
  const { text, json } = await renderComposer(TOGGLE, 'en', { fail: true })
  assert.match(json, /"data-state":"error"/, 'a failure is shown as an error state')
  assert.match(text, /<button><span>/, 'the button still renders')
  // The reason rides on the title rather than being swallowed.
  assert.match(json, /"title":"boom"/)
})

await test('the panel explains a jit-skipped file and an index warning', async () => {
  const withIssues = {
    ...STATUS,
    memoryChange: { fileCount: 1, jitSkipped: [{ path: 'C:\\home\\.dsh\\memory\\ts.md', reason: 'no match' }] },
    lastGeneration: {
      status: 'saved',
      turnIndex: 1,
      writtenFiles: [
        { rootId: 'user', path: 'MEMORY.md', bytes: 300, warnings: [{ kind: 'long_lines', message: '1 index line(s) over about 200 characters' }] },
      ],
    },
  }
  const { text } = await renderWithStatus(withIssues)
  // "My memory is missing" needs a visible answer, and the reason is the glob.
  assert.match(text, /1 file\(s\) not loaded yet: no path this session touched matched C:\\home\\\.dsh\\memory\\ts\.md/)
  assert.match(text, /Index MEMORY\.md: 1 index line\(s\) over about 200 characters/)

  const zh = await renderWithStatus(withIssues, 'zh')
  assert.match(zh.text, /有 1 个文件尚未加载/)
  assert.match(zh.text, /索引 MEMORY\.md：/)
  assert.ok(!zh.text.includes('not loaded yet'), 'the notice must be translated too')

  // Nothing pending and nothing warned: no extra lines.
  const clean = await renderWithStatus({ ...STATUS, memoryChange: { fileCount: 2 }, lastGeneration: { status: 'no_change', turnIndex: 1, writtenFiles: [] } })
  assert.doesNotMatch(clean.text, /not loaded yet/)
  assert.doesNotMatch(clean.text, /Index MEMORY\.md/)
})

await test('the panel says which sandbox policy memory writes declare', async () => {
  // Memory sits outside every workspace, so under `writePolicy: session` a workspace-write
  // session makes memory read-only; the panel has to be able to say that up front.
  const writing = await renderWithStatus({ ...STATUS, writePolicy: 'memory-root', sandboxMode: 'workspace-write' }, 'en')
  assert.match(writing.text, /Memory writes \(memory-root/, 'the row names the choice')
  assert.match(writing.text, /memory-root · workspace-write/, 'and the session mode beside it')

  const following = await renderWithStatus({ ...STATUS, writePolicy: 'session', sandboxMode: 'workspace-write' }, 'zh')
  assert.match(following.text, /记忆写入（memory-root/)
  assert.match(following.text, /session · workspace-write/)

  // A deployment with no fence at all shows the policy alone, with no dangling separator.
  const bare = await renderWithStatus({ ...STATUS, writePolicy: 'memory-root' }, 'en')
  assert.match(bare.text, /memory-root\n/)
  assert.doesNotMatch(bare.text, /memory-root ·/)

  // `memory-root` writes while the session itself is fenced: both modes are shown, so the
  // row cannot be read as "the session allows this".
  const both = await renderWithStatus(
    { ...STATUS, writePolicy: 'memory-root', sandboxMode: 'workspace-write', sessionMode: 'read-only' },
    'en',
  )
  assert.match(both.text, /memory-root · workspace-write · session read-only/)
  // The same mode on both sides is said once.
  const same = await renderWithStatus(
    { ...STATUS, writePolicy: 'session', sandboxMode: 'read-only', sessionMode: 'read-only' },
    'en',
  )
  assert.match(same.text, /session · read-only/)
  assert.doesNotMatch(same.text, /read-only · session/)
})

await test('a read-write scope offers delete per file, and a read-only one does not', async () => {
  const calls = []
  // No sessions in the fixture: this test is about the SCOPE list's rows, and the
  // session switch deliberately reuses the same `dshmem-file`/`dshmem-actions` classes.
  const { text, renderer } = await renderWithStatus({ ...STATUS, sessions: [] }, 'en', { keep: true, calls })
  // Two files in the read-write user scope, none in the read-only project scope.
  assert.equal((text.match(/Delete/g) || []).length, 2, 'one delete per file in the writable scope')
  // Counted by button text: the scope row has no buttons of its own.
  const openPerFile = renderer.root.findAll(
    (node) => node.type === 'button' && collectText(node.props.children).trim() === 'Open',
  )
  assert.equal(openPerFile.length, 2, 'one open per file in the writable scope')

  const buttons = renderer.root.findAll(
    (node) => node.type === 'button' && collectText(node.props.children).trim() === 'Delete',
  )
  assert.equal(buttons.length, 2)
  // The row is [name][action group], not three `space-between` children: with the
  // filename in the same row, `space-between` pushes Open and Delete apart.
  const actions = renderer.root.findAll(
    (node) => node.type === 'span' && String(node.props.className).includes('dshmem-actions'),
  )
  assert.equal(actions.length, 2, 'one action group per file row')
  assert.equal(actions[0].children.length, 2, 'both buttons live in that group')
  assert.equal(
    renderer.root.findAll((node) => node.type === 'span' && String(node.props.className).includes('dshmem-name'))
      .length,
    2,
    'the filename is its own flex item, so it can shrink instead of shoving buttons',
  )
  await act(async () => {
    buttons[0].props.onClick()
    await Promise.resolve()
  })
  renderer.unmount()

  const call = calls.find((url) => url.includes('/api/memory/file'))
  assert.ok(call, `the button must call the file route (saw ${calls.join(', ')})`)
  assert.match(call, /scope=user/)
  assert.match(call, /path=MEMORY\.md/)

  // The read-only project scope renders no delete button at all.
  const readOnly = await renderWithStatus(
    { ...STATUS, roots: [{ ...STATUS.roots[1], files: ['MEMORY.md'] }] },
  )
  assert.match(readOnly.text, /Open/)
  assert.ok(!readOnly.text.includes('Delete'), 'a read-only scope must not offer a delete it would refuse')
})

await test('the scope list is a row per scope, each able to open its directory', async () => {
  // The section must read as a LIST of scopes: one row per scope, with its size, and its
  // files folded away underneath — not a wall of file names.
  const calls = []
  const { text, json, renderer } = await renderWithStatus(STATUS, 'en', { keep: true, calls })

  const rows = renderer.root.findAll((node) => node.type === 'summary')
  assert.equal(rows.length, STATUS.roots.length, 'one summary row per scope')
  assert.match(text, /2 memory file\(s\) · 2\.0 KB/, 'the row states how much memory the scope holds')
  // A host that sends no size gets no separator either: a missing value is omitted rather
  // than replaced by a dash (which reads as "there is a value here, it is just odd").
  const sizeless = await renderWithStatus(
    { ...STATUS, roots: STATUS.roots.map(({ size, ...root }) => root) },
    'en',
  )
  assert.match(sizeless.text, /2 memory file\(s\)/)
  assert.doesNotMatch(
    sizeless.text,
    /memory file\(s\)[^\n]*[·—]/,
    'the missing size is left out, not replaced by a separator or a dash',
  )
  // The note above the list explains which folder the project scope means; the list needs
  // to breathe, or the two read as one paragraph.
  assert.match(source, /\.dshmem-list\{[^}]*margin-top:/, 'the list needs a gap below that note')
  // A row shows the workspace NAME; the addressable slug stays as the tooltip, because
  // that is what a scope is addressed by (and what `user` has instead of a name).
  assert.match(text, /Demo project/)
  const named = renderer.root.findAll((node) => node.type === 'span' && node.props.title === 'project')[0]
  assert.equal(collectText(named.props.children).trim(), 'Demo project')
  assert.match(text, /\buser\b/, 'a scope without a workspace still shows its id')

  // Each row lives inside a `<details>`, so the files are one click away and hidden until
  // then — the difference between a scope list and a file dump. (Opening a directory in the
  // file manager was removed: the harness has no such capability, and the spawn path could
  // not be made to work here.)
  const scopes = renderer.root.findAll((node) => node.type === 'details')
  assert.equal(scopes.length, STATUS.roots.length)
  assert.ok(!scopes[0].props.open, 'the files start folded')
  renderer.unmount()
  assert.match(json, /dshmem-scope/, 'the row keeps its own class')
  assert.ok(!calls.some((url) => url.includes('/reveal')), 'no directory-opening request is made')
})

await test('a failed generation explains itself instead of just saying "failed"', async () => {
  // The status vocabulary is cryptic on its own: `failed` means the pass asked for
  // writes and landed none, or the pass threw. Both carry the reason, and a refused
  // write carries the only explanation of WHY it was refused — so neither may be
  // swallowed by the panel. (The dream row already showed its reason; generation did
  // not, which is exactly how "always failed" stayed unexplained.)
  const failed = {
    ...STATUS,
    lastGeneration: {
      status: 'failed',
      turnIndex: 3,
      writtenFiles: [],
      failedFiles: [{ rootId: 'user', path: 'MEMORY.md', error: 'content exceeds maxWriteBytes 16384' }],
      reason: 'every write was refused',
    },
  }
  const { text } = await renderWithStatus(failed, 'en')
  assert.match(text, /failed/, 'the status itself still shows')
  assert.match(text, /every write was refused/, 'the reason must reach the activity row')
  assert.match(text, /Refused to write MEMORY\.md/, 'the refused write must be listed')
  assert.match(text, /content exceeds maxWriteBytes 16384/, 'and the refusal must say why')
  // A skip explains itself too: that is the other status a bare word cannot convey.
  const skipped = { ...STATUS, lastGeneration: { status: 'skipped', turnIndex: 2, writtenFiles: [], failedFiles: [], reason: 'prompt shorter than 40 characters' } }
  const short = await renderWithStatus(skipped, 'en')
  assert.match(short.text, /prompt shorter than 40 characters/)
})

await test('the panel offers the resume command, and shows a paused generation', async () => {
  // A pause is the answer to "why did memory stop?": the panel must name it and say how
  // to clear it, or the only visible symptom is that no new result ever appears.
  const paused = { ...STATUS, generationPause: { failures: 3, reason: 'provider exploded', since: 1, sessionId: 'session-1' } }
  const { text } = await renderWithStatus(paused, 'en')
  assert.match(text, /\/memory-resume/, 'the command is discoverable from the panel')
  // The pause itself arrives as a recorded skip, so the reason is what carries it.
  const skipped = {
    ...STATUS,
    lastGeneration: {
      status: 'skipped',
      turnIndex: 4,
      writtenFiles: [],
      failedFiles: [],
      reason: 'paused after 3 consecutive failures: provider exploded',
    },
  }
  const shown = await renderWithStatus(skipped, 'en')
  assert.match(shown.text, /paused after 3 consecutive failures: provider exploded/)
})

await test('the editor select is styled as a select, and shows what it will load', async () => {
  // It was styled with the button class: 28px against the input's 34px, a
  // transparent background (so the OS picked the text colour), and no room for the
  // native arrow. None of that fails a behavioural test.
  const rule = (selector) => {
    const match = new RegExp(`\\${selector}\\{([^}]*)\\}`).exec(source)
    assert.ok(match, `${selector} must be defined`)
    return match[1]
  }
  const select = rule('.dshmem-select')
  assert.match(select, /height:34px/, 'the select must match the input height, or the toolbar is ragged')
  assert.match(select, /background:var\(--dsw-alias-bg-layer-3\)/, 'a transparent select lets the OS pick the text colour')
  assert.match(select, /padding:0 24px 0 10px/, 'the native arrow needs room, or it overlaps the label')
  assert.match(rule('.dshmem-select option'), /color:var\(/, 'the OS-drawn popup needs themed options')

  // The option list must contain the value the select displays — otherwise the
  // browser shows the first option while the state says something else. Select BY CLASS: the panel
  // now renders two `dshmem-select`s (the global scope control and this one), so a positional lookup
  // silently checked the wrong element — the same trap the panel fixture hit before.
  const { renderer } = await renderWithStatus(STATUS, 'en', { keep: true })
  const element = renderer.root.findAll((node) => node.type === 'select' && String(node.props.className).includes('dshmem-scope-select'))[0]
  assert.ok(element, 'the editor must render a select')
  assert.ok(element.props.className.includes('dshmem-select'), 'the select must not borrow the button class')
  const values = element.children.map((child) => child.props.value)
  assert.ok(values.includes(element.props.value), `value ${element.props.value} is not among ${values.join(', ')}`)
  renderer.unmount()

  const userOnly = await renderWithStatus({ ...STATUS, roots: [STATUS.roots[0]] }, 'en', { keep: true })
  const narrow = userOnly.renderer.root.findAll((node) => node.type === 'select' && String(node.props.className).includes('dshmem-scope-select'))[0]
  assert.equal(narrow.props.value, 'user', 'with project disabled the select must fall back to an enabled scope')
  userOnly.renderer.unmount()
})

await test('the panel raises the load-quality warnings Qoder raises', async () => {
  const withIssues = {
    ...STATUS,
    memoryChange: {
      fileCount: 1,
      largeFiles: [{ path: 'C:\\proj\\huge.md', characterCount: 52000 }],
      failedFiles: [{ path: 'C:\\proj\\broken.md', error: 'EACCES' }],
      excludedFiles: ['C:\\proj\\draft.md'],
      pendingExternalImports: [{ importPath: 'C:/secrets/keys.md', resolvedPath: 'C:\\secrets\\keys.md' }],
    },
  }
  const { text, json } = await renderWithStatus(withIssues)
  // Worded as Qoder's own UI words it.
  assert.match(text, /Large C:\\proj\\huge\.md will impact performance \(52000 chars > 40000\)/)
  assert.match(text, /Failed to load C:\\proj\\broken\.md: EACCES/)
  assert.match(text, /1 file\(s\) skipped by the exclusion patterns\./)
  assert.match(text, /1 external @import\(s\) blocked: outside the allowed roots\./)
  assert.match(json, /dshmem-note-warn/)
  assert.match(json, /dshmem-note-error/)

  const zh = await renderWithStatus(withIssues, 'zh')
  assert.match(zh.text, /记忆文件过大，会影响性能/)
  assert.match(zh.text, /载入失败 C:\\proj\\broken\.md：EACCES/)
  assert.ok(!zh.text.includes('will impact performance'), 'the warning must be translated too')

  // A clean load renders no warnings at all.
  const clean = await renderWithStatus({ ...STATUS, memoryChange: { fileCount: 2 } })
  assert.doesNotMatch(clean.text, /will impact performance/)
})

await test('the panel renders Chinese when zh is active', async () => {
  const { text } = await renderWithStatus(STATUS, 'zh')
  assert.match(text, /记忆/)
  assert.match(text, /状态/)
  assert.match(text, /作用域/)
  assert.match(text, /注入预算（消费半）/)
  assert.match(text, /最近活动/)
  assert.match(text, /编辑记忆文件/)
  assert.match(text, /已启用/)
  // No English UI label may survive a switch to Chinese.
  assert.ok(!text.includes('Latest activity'), 'an English label leaked into the Chinese render')
  assert.ok(!text.includes('Edit memory file'), 'an English label leaked into the Chinese render')
})

await test('the panel renders English when en is active', async () => {
  const { text } = await renderWithStatus(STATUS, 'en')
  assert.match(text, /Memory/)
  assert.match(text, /Status/)
  assert.match(text, /Scopes/)
  assert.match(text, /Injection budget \(consumption\)/)
  assert.match(text, /Latest activity/)
  assert.match(text, /Edit memory file/)
})

await test('interpolated values appear in the localized sentence', async () => {
  const { text } = await renderWithStatus(STATUS, 'zh')
  // The built-in gate sentence carries minPromptChars from the status payload.
  assert.match(text, /minPromptChars=40/)
  // The turn counter is interpolated into the localized label.
  assert.match(text, /第 3 轮/)
})

await test('the nav label follows the active locale', async () => {
  const en = await renderWithStatus(STATUS, 'en')
  assert.equal(en.options.label(), 'Memory')
  const zh = await renderWithStatus(STATUS, 'zh')
  assert.equal(zh.options.label(), '记忆')
})

await testIf(
  runningBundle !== undefined,
  'every style token exists in the harness the user is RUNNING',
  'no desktop bundle was found, so only the resolved install can be checked',
  () => {
    // The install the profile resolves can be older than the app the user runs (a desktop
    // install keeps the harness inside one `app.asar`), and a bumped harness is exactly
    // when a token may be renamed. Its contents are stored uncompressed, so a byte search
    // answers existence — weaker than reading a CSS rule, stronger than a stale oracle.
    const bundle = readFileSync(runningBundle)
    const used = [...new Set([...source.matchAll(/var\((--dsw-[a-z0-9-]+)/g)].map((match) => match[1]))]
    const missing = used.filter((token) => bundle.indexOf(Buffer.from(token, 'utf8')) === -1)
    console.log(`  --  oracle: ${runningBundle} (${used.length} tokens)`)
    assert.deepEqual(missing, [], `these tokens are absent from the running harness: ${missing.join(', ')}`)
  },
)

await testIf(
  primitivesPackage !== undefined,
  'every style token exists in the shipped Harness stylesheets',
  'the Harness UI primitives are not installed in this session',
  () => {
  // The real oracle: the tokens the Harness UI primitives actually use. A
  // self-invented token (e.g. --dsw-alias-text-primary) silently renders an
  // invalid declaration and the panel loses its theming, so validate names
  // rather than just the --dsw-alias- shape.
  const primitivesDir = join(dirname(primitivesPackage), 'lib')
  if (!existsSync(primitivesDir)) {
    // Never silently pass: a missing oracle would make this check meaningless.
    throw new Error(`token oracle missing at ${primitivesDir}`)
  }
  const shipped = new Set()
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name.endsWith('.css')) {
        for (const match of readFileSync(full, 'utf8').matchAll(/--dsw-[a-z0-9-]+/g)) shipped.add(match[0])
      }
    }
  }
  walk(primitivesDir)
  assert.ok(shipped.size > 50, `expected a substantial token set, found ${shipped.size}`)

  const used = new Set([...source.matchAll(/var\((--dsw-[a-z0-9-]+)/g)].map((match) => match[1]))
  assert.ok(used.size > 10, `expected the panel to reference theme tokens, found ${used.size}`)
  const unknown = [...used].filter((token) => !shipped.has(token)).sort()
  assert.deepEqual(unknown, [], `these tokens do not exist in the Harness theme: ${unknown.join(', ')}`)
  },
)

await test('the panel uses no literal colour', () => {
  // Artwork may use its own colours; a settings page may not. Every colour must
  // arrive through a token so light and dark both work.
  const literals = [...source.matchAll(/#[0-9a-fA-F]{3,8}\b|rgb\(|rgba\(|hsl\(/g)].map((match) => match[0])
  assert.deepEqual(literals, [], `literal colours found: ${literals.join(', ')}`)
})

await test('the stylesheet is prefixed and self-injected', () => {
  // Copied host rules must not collide with host class names, and the block has
  // to be rendered by the component so unmounting removes it.
  const classes = new Set([...source.matchAll(/\.([a-zA-Z][\w-]*)\s*\{/g)].map((match) => match[1]))
  assert.ok(classes.size > 15, `expected a real stylesheet, found ${classes.size} class rules`)
  const unprefixed = [...classes].filter((name) => !name.startsWith('dshmem-'))
  assert.deepEqual(unprefixed, [], `stylesheet classes must be prefixed: ${unprefixed.join(', ')}`)
  assert.match(source, /h\('style', null, CSS\)/, 'the component must render its stylesheet')
})

await test('the preview harness defines the same real token names', () => {
  // The invented-token bug originated here: the preview declared its own
  // `:root` with made-up names, and the panel copied them. Check both sides.
  const preview = readFileSync(join(here, '..', 'tools', 'preview.mjs'), 'utf8')
  const declared = new Set([...preview.matchAll(/^\s*(--dsw-[a-z0-9-]+):/gm)].map((match) => match[1]))
  assert.ok(declared.size > 15, `the preview must define the theme, found ${declared.size} tokens`)
  const used = new Set([...source.matchAll(/var\((--dsw-[a-z0-9-]+)/g)].map((match) => match[1]))
  const missing = [...used].filter((token) => !declared.has(token)).sort()
  assert.deepEqual(missing, [], `the preview does not define: ${missing.join(', ')}`)
})

await test('both preview themes define every token the panel uses', () => {
  // A token defined only in the light set would leave dark mode unstyled. Both
  // palettes must cover the whole vocabulary the panel references.
  const preview = readFileSync(join(here, '..', 'tools', 'preview.mjs'), 'utf8')
  const block = (name) => {
    const match = preview.match(new RegExp(`const ${name} = \`([\\s\\S]*?)\``))
    assert.ok(match, `${name} must exist in preview.mjs`)
    return new Set([...match[1].matchAll(/(--dsw-[a-z0-9-]+):/g)].map((m) => m[1]))
  }
  const light = block('LIGHT_TOKENS')
  const dark = block('DARK_TOKENS')
  const fixed = block('FIXED_TOKENS')
  const used = new Set([...source.matchAll(/var\((--dsw-[a-z0-9-]+)/g)].map((m) => m[1]))

  // Colour tokens must be themed; geometry/typography tokens need only one set.
  const themed = [...used].filter((token) => !fixed.has(token))
  const missingDark = themed.filter((token) => !dark.has(token)).sort()
  const missingLight = themed.filter((token) => !light.has(token)).sort()
  assert.deepEqual(missingLight, [], `the light palette is missing: ${missingLight.join(', ')}`)
  assert.deepEqual(missingDark, [], `the dark palette is missing: ${missingDark.join(', ')}`)
  assert.ok(themed.length >= 8, `expected colour tokens to be themed, found ${themed.length}`)
})

/* ---------------- static contracts ---------------- */

await test('no Harness Client package is imported', () => {
  // Rules out a real load. Naming a package in a comment (to record where the
  // copied styles came from) is fine; requiring or importing it is not.
  assert.ok(!/require\(\s*['"]@deepseek-ai\//.test(source), 'must not require a Harness Client package')
  assert.ok(!/^\s*import\s[^\n]*['"]@deepseek-ai\//m.test(source), 'must not import a Harness Client package')
  // React is the only external the module loader supplies.
  const requires = [...source.matchAll(/require\(\s*['"]([^'"]+)['"]/g)].map((match) => match[1])
  assert.deepEqual([...new Set(requires)], ['react'], `unexpected externals: ${requires.join(', ')}`)
})

await test('no user-visible string is hardcoded in the component body', () => {
  // Every label must come from `t(...)`. Look only for a string literal passed
  // as a createElement CHILD — an attribute object's own keys are not text.
  const patterns = [
    /h\(\s*'[a-z]+',\s*(?:null|\{[^{}]*\}),\s*'([^']{3,})'/g, // h(tag, props, 'text')
    /h\(\s*'[a-z]+',\s*'([^']{3,})'/g, // h(tag, 'text')
  ]
  const hardcoded = []
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) hardcoded.push(match[1])
  }
  assert.deepEqual(hardcoded, [], `hardcoded UI text found: ${hardcoded.join(' | ')}`)
})

await test('the panel talks only to the /api/memory routes', () => {
  // `[a-z-]+`, not `[a-z]+`: a hyphenated path like `/api/memory/write-budget` was silently truncated
  // to `/api/memory/write` and reported as an unknown route — the guard was right to fire, but on its
  // own truncation rather than on a stray path.
  const paths = [...source.matchAll(/['"](\/api\/memory\/[a-z-]+)/g)].map((match) => match[1])
  assert.ok(paths.length > 0)
  const known = ['/api/memory/status', '/api/memory/file', '/api/memory/preview', '/api/memory/refresh', '/api/memory/flush', '/api/memory/trust', '/api/memory/switch', '/api/memory/budget', '/api/memory/scope', '/api/memory/mode', '/api/memory/write-budget', '/api/memory/generation']
  for (const path of paths) {
    assert.ok(known.includes(path), `unexpected route ${path}`)
  }
  // Every known route is actually reachable from the panel, not just allowlisted.
  for (const path of known) {
    assert.ok(paths.includes(path), `${path} is allowlisted but never called`)
  }
})

console.log(`\n${passed} client tests passed`)
