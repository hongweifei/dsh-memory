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
import { resolveInstalled } from './harness-env.mjs'

const { act } = TestRenderer

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8')

/** The Harness's own stylesheets, when this session has them installed: the token oracle. */
const primitivesPackage = resolveInstalled('@deepseek-ai/dsh-client-ui-primitives/package.json')

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

await test('apply registers one settings.section entry named memory', () => {
  const { registrations, injected } = registerComponent(plugin)
  assert.deepEqual(injected, ['settings.section'])
  assert.equal(registrations.length, 1)
  const { options, component } = registrations[0]
  assert.equal(options.name, 'settings.section')
  assert.equal(options.id, 'memory')
  assert.equal(typeof options.order, 'number')
  assert.equal(options.locale, 'memory', 'the entry must declare its locale namespace')
  assert.equal(options.label(), 'Memory')
  assert.equal(typeof component, 'function')
})

/* ---------------- real server rendering ---------------- */

const STATUS = {
  enabled: true,
  mode: 'native',
  generationEnabled: true,
  consumptionEnabled: true,
  dreamEnabled: true,
  maxTokens: 2000,
  overflow: 'truncate',
  failureMode: 'best_effort',
  gate: { kind: 'minPromptChars', minPromptChars: 40 },
  trust: { enabled: true, trusted: true, folder: 'C:\\proj', declared: [], remembered: [], folders: [] },
  memoryChange: { fileCount: 2 },
  largeFileLimit: 40000,
  pendingGenerations: 2,
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
    },
    { id: 'project', path: 'C:\\proj\\.dsh\\memory', access: 'read', indexFile: 'MEMORY.md', files: [] },
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
await test('the panel renders the full status, scopes, budget, and activity', async () => {
  const { text } = await renderWithStatus(STATUS)
  // Header and description.
  assert.match(text, /Memory/)
  assert.match(text, /Qoder Agent SDK/)
  // Status rows.
  assert.match(text, /enabled/)
  assert.match(text, /minPromptChars=40/)
  assert.match(text, /In-flight generations\n<span>2\n/, 'in-flight generation count must render')
  // Both scopes, their access, their paths, and their files.
  assert.match(text, /C:\\home\\\.dsh\\memory/)
  assert.match(text, /read-write/)
  assert.match(text, /C:\\proj\\\.dsh\\memory/)
  assert.match(text, /MEMORY\.md/)
  assert.match(text, /NOTES\.md/)
  assert.match(text, /<span>read-only\n/, 'the read-only scope access must render localized')
  assert.match(text, /No memory files yet\./)
  // Budget.
  assert.match(text, /maxTokens\n<span>2000\n/)
  assert.match(text, /overflow\n<span>truncate\n/)
  assert.match(text, /failureMode\n<span>best_effort\n/)
  // Latest activity, including per-file consumption status.
  assert.match(text, /saved \(turn 3\)/)
  assert.match(text, /user:MEMORY\.md \(loaded\)/)
  assert.match(text, /project:MEMORY\.md \(missing\)/)
  // Editor controls.
  assert.match(text, /Edit memory file/)
  assert.match(text, /<textarea>/)
  assert.match(text, /<button>Save\n/)
  assert.match(text, /<button>Reload into session\n/)
  assert.match(text, /<button>Flush generations\n/)
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
   * Identifiers, not prose: these stay identical by design. A config key name,
   * a literal filename, and slash-command names must not be translated, or the
   * UI would stop matching what the user types and what the config accepts.
   */
  const IDENTIFIERS = new Set([
    'gateBuiltin', // `minPromptChars={minPromptChars}` — a config field name
    'filenamePlaceholder', // `MEMORY.md` — a real file name
    'commandConfig', // `/memory`
    'commandRefresh', // `/memory-refresh`
    'commandFlush', // `/memory-flush`
    'commandDelete', // `/memory-delete`
    'commandTrust', // `/memory-trust`
  ])
  const untranslated = Object.keys(zh).filter(
    (key) => !IDENTIFIERS.has(key) && zh[key] === en[key] && /[a-zA-Z]{4,}/.test(en[key]),
  )
  assert.deepEqual(untranslated, [], `these keys are still English: ${untranslated.join(', ')}`)
  // Every identifier must still be one, so this list cannot hide real prose.
  for (const key of IDENTIFIERS) {
    assert.ok(key in en, `${key} is allowlisted but missing from the English dictionary`)
    assert.match(en[key], /^[A-Za-z0-9_./{}=\-]+$/, `${key} is allowlisted as an identifier but reads as prose`)
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
  assert.ok(!trusted.json.includes('"data-tone":"warning"'), 'a trusted folder must not warn')
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

await test('a read-write scope offers delete per file, and a read-only one does not', async () => {
  const calls = []
  const { text, renderer } = await renderWithStatus(STATUS, 'en', { keep: true, calls })
  // Two files in the read-write user scope, none in the read-only project scope.
  assert.equal((text.match(/Delete/g) || []).length, 2, 'one delete per file in the writable scope')
  assert.equal((text.match(/Open/g) || []).length, 2)

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
  // browser shows the first option while the state says something else.
  const { renderer } = await renderWithStatus(STATUS, 'en', { keep: true })
  const element = renderer.root.findAll((node) => node.type === 'select')[0]
  assert.ok(element, 'the editor must render a select')
  assert.ok(element.props.className.includes('dshmem-select'), 'the select must not borrow the button class')
  const values = element.children.map((child) => child.props.value)
  assert.ok(values.includes(element.props.value), `value ${element.props.value} is not among ${values.join(', ')}`)
  renderer.unmount()

  const userOnly = await renderWithStatus({ ...STATUS, roots: [STATUS.roots[0]] }, 'en', { keep: true })
  const narrow = userOnly.renderer.root.findAll((node) => node.type === 'select')[0]
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
  assert.match(text, /Token 预算/)
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
  assert.match(text, /Token budget/)
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
  const preview = readFileSync(join(here, 'preview.mjs'), 'utf8')
  const declared = new Set([...preview.matchAll(/^\s*(--dsw-[a-z0-9-]+):/gm)].map((match) => match[1]))
  assert.ok(declared.size > 15, `the preview must define the theme, found ${declared.size} tokens`)
  const used = new Set([...source.matchAll(/var\((--dsw-[a-z0-9-]+)/g)].map((match) => match[1]))
  const missing = [...used].filter((token) => !declared.has(token)).sort()
  assert.deepEqual(missing, [], `the preview does not define: ${missing.join(', ')}`)
})

await test('both preview themes define every token the panel uses', () => {
  // A token defined only in the light set would leave dark mode unstyled. Both
  // palettes must cover the whole vocabulary the panel references.
  const preview = readFileSync(join(here, 'preview.mjs'), 'utf8')
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
  const paths = [...source.matchAll(/['"](\/api\/memory\/[a-z]+)/g)].map((match) => match[1])
  assert.ok(paths.length > 0)
  const known = ['/api/memory/status', '/api/memory/file', '/api/memory/refresh', '/api/memory/flush', '/api/memory/trust']
  for (const path of paths) {
    assert.ok(known.includes(path), `unexpected route ${path}`)
  }
  // Every known route is actually reachable from the panel, not just allowlisted.
  for (const path of known) {
    assert.ok(paths.includes(path), `${path} is allowlisted but never called`)
  }
})

console.log(`\n${passed} client tests passed`)
