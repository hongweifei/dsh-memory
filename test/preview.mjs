/**
 * Render the Memory settings panel to a self-contained HTML preview.
 *
 * The panel itself is real: the actual lib/client.js component is rendered with
 * React and the real theme-token styles, against a representative status
 * payload. This is a preview of the panel's content and layout, not a
 * substitute for the live page (which the harness serves inside its own
 * settings shell).
 *
 * Run: node test/preview.mjs   →  test/preview.html
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import React from 'react'
import TestRenderer from 'react-test-renderer'

const { act } = TestRenderer
const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8')

const STATUS = {
  enabled: true,
  mode: 'native',
  generationEnabled: true,
  consumptionEnabled: true,
  maxTokens: 2000,
  overflow: 'truncate',
  failureMode: 'best_effort',
  maxOutputTokens: 0,
  pauseAfterFailures: 3,
  gate: { kind: 'custom', timeoutMs: 10000, onGateError: 'skip' },
  trust: { enabled: true, trusted: true, folder: 'C:\\proj', declared: ['C:\\proj'], remembered: [], folders: ['C:\\proj'] },
  memoryChange: {
    fileCount: 2,
    largeFiles: [{ path: 'C:\\home\\.dsh\\projects\\--C-proj--\\memory\\dump.md', characterCount: 52410 }],
  },
  largeFileLimit: 40000,
  pendingGenerations: 1,
  lastGeneration: { status: 'saved', turnIndex: 4, writtenFiles: [], failedFiles: [] },
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
      files: ['MEMORY.md'],
    },
    // Every project with memory is listed, addressed by its projectKey name; the
    // active session's project comes first. The panel is global settings, so
    // following only the active session was the wrong shape.
    {
      id: '--D-code-demo--',
      path: 'C:\\home\\.dsh\\projects\\--D-code-demo--\\memory',
      access: 'read-write',
      indexFile: 'MEMORY.md',
      files: ['MEMORY.md', 'packaging.md'],
    },
    {
      id: '--D-code-renderer--',
      path: 'C:\\home\\.dsh\\projects\\--D-code-renderer--\\memory',
      access: 'read-write',
      indexFile: 'MEMORY.md',
      files: ['MEMORY.md', 'renderer-project.md'],
    },
  ],
  // Which folder the active session is in, so the note above the cards can name it.
  projectFolder: { cwd: 'D:\\code\\demo', source: 'session' },
}

let registration
new Function('window', 'require', 'fetch', source)(
  { __ModuleLoader__: { load: (next) => (registration = next) } },
  (specifier) => {
    if (specifier === 'react') return React
    throw new Error(`unexpected external ${specifier}`)
  },
  async (url) => ({ ok: true, json: async () => (String(url).includes('/status') ? STATUS : { ok: true }) }),
)

const plugin = registration.factory((specifier) => React)

/** A locale double matching the host service's register/bind contract. */
function makeLocale(active) {
  const dicts = new Map()
  const translate = (ns, key, params) => {
    const table = dicts.get(`${ns}\u0000${active}`) ?? dicts.get(`${ns}\u0000en`) ?? {}
    const template = table[key] ?? key
    return params ? template.replace(/\{(\w+)\}/g, (m, name) => (name in params ? String(params[name]) : m)) : template
  }
  return {
    register: (ns, localeOrDicts) => {
      for (const [locale, table] of Object.entries(localeOrDicts)) dicts.set(`${ns}\u0000${locale}`, table)
      return () => {}
    },
    bind: (ns) => (key, params) => translate(ns, key, params),
  }
}

const locale = makeLocale(process.env.PREVIEW_LOCALE === 'zh' ? 'zh' : 'en')
let component
let entryOptions
plugin.apply({
  effect: (body) => {
    const dispose = body()
    return typeof dispose === 'function' ? dispose : () => {}
  },
  locale,
  slots: {
    inject: (_owner, callback) => callback(),
    register: (options, next) => {
      component = next
      entryOptions = options
      return () => {}
    },
  },
})

let renderer
await act(async () => {
  renderer = TestRenderer.create(
    React.createElement(component, { t: locale.bind(entryOptions.locale) }),
  )
})
await act(async () => {
  await Promise.resolve()
})
const tree = renderer.toJSON()
renderer.unmount()

/**
 * Serialize the render tree to HTML.
 *
 * Emits `class`, `data-tone` and boolean control attributes too — the panel
 * styles itself through prefixed classes, so a serializer that only carried
 * inline `style` would produce an unstyled preview that looks like a CSS bug.
 */
function toHtml(node) {
  if (node === null || node === undefined) return ''
  if (typeof node === 'string') return escapeHtml(node)
  if (typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(toHtml).join('')
  const tag = node.type
  const props = node.props ?? {}
  const attrs = []
  if (props.className) attrs.push(`class="${escapeHtml(String(props.className))}"`)
  for (const [key, value] of Object.entries(props)) {
    if (key.startsWith('data-') && value !== undefined) attrs.push(`${key}="${escapeHtml(String(value))}"`)
  }
  if (props.disabled === true) attrs.push('disabled')
  if (tag === 'select' && props.value !== undefined) attrs.push(`data-value="${escapeHtml(String(props.value))}"`)
  if (tag === 'textarea') attrs.push('rows="8"')
  const style = props.style
  if (style) {
    attrs.push(
      `style="${Object.entries(style)
        .map(([key, value]) => `${camelToKebab(key)}:${String(value).replace(/"/g, '&quot;')}`)
        .join(';')}"`,
    )
  }
  return `<${tag}${attrs.length > 0 ? ` ${attrs.join(' ')}` : ''}>${(node.children ?? []).map(toHtml).join('')}</${tag}>`
}

const escapeHtml = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const camelToKebab = (name) => name.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`)

/**
 * Standalone stand-ins for the Harness theme.
 *
 * The token NAMES are the real ones — the plugin asserts them against the
 * shipped primitives stylesheets. The values approximate the host's neutral
 * palette so this preview shows the panel's own layout and the stylesheet it
 * ships. `PREVIEW_THEME=dark` pins the dark set directly (a headless
 * screenshot cannot drive `prefers-color-scheme`).
 */
const LIGHT_TOKENS = `
    --dsw-alias-bg-base: #ffffff;
    --dsw-alias-bg-layer-2: #f7f7f8;
    --dsw-alias-bg-layer-3: #ffffff;
    --dsw-alias-border-l2: #ececec;
    --dsw-alias-border-l3: #dcdcdc;
    --dsw-alias-border-l4: #d0d0d0;
    --dsw-alias-interactive-bg-hover: #f0f0f1;
    --dsw-alias-interactive-bg-active: #e6e6e8;
    --dsw-alias-label-primary: #1a1a1a;
    --dsw-alias-label-secondary: #5c5c5c;
    --dsw-alias-label-tertiary: #8a8a8a;
    --dsw-alias-label-error: #d33;
    --dsw-alias-state-business-primary: #2f6feb;
    --dsw-alias-state-success-primary: #1a7f45;
    --dsw-alias-state-warn-primary: #a86500;`

const DARK_TOKENS = `
    --dsw-alias-bg-base: #171717;
    --dsw-alias-bg-layer-2: #1f1f1f;
    --dsw-alias-bg-layer-3: #232323;
    --dsw-alias-border-l2: #2e2e2e;
    --dsw-alias-border-l3: #3a3a3a;
    --dsw-alias-border-l4: #454545;
    --dsw-alias-interactive-bg-hover: #2a2a2a;
    --dsw-alias-interactive-bg-active: #333333;
    --dsw-alias-label-primary: #ededed;
    --dsw-alias-label-secondary: #b0b0b0;
    --dsw-alias-label-tertiary: #8a8a8a;
    --dsw-alias-label-error: #ff6b6b;
    --dsw-alias-state-business-primary: #6f9dff;
    --dsw-alias-state-success-primary: #4ec27a;
    --dsw-alias-state-warn-primary: #e0a458;`

/** Shared tokens whose values do not change between themes. */
const FIXED_TOKENS = `
    --dsw-radius-sm: 6px;
    --dsw-radius-md: 8px;
    --dsw-font-family: system-ui, -apple-system, 'Segoe UI', sans-serif;
    --dsw-font-markdown-code-font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    --dsw-focus-ring-width: 2px;
    --dsw-focus-ring-color: #2f6feb;`

/**
 * `PREVIEW_THEME` pins one palette; unset emits both and follows the viewer.
 *
 * A headless screenshot cannot be trusted to follow the viewer: Edge headless
 * reports `prefers-color-scheme: dark`, so an unpinned preview renders dark and
 * a "light" screenshot silently shows the dark palette. Pin the theme to
 * capture either one.
 */
const pinned = process.env.PREVIEW_THEME
const themeCss =
  pinned === 'dark'
    ? `:root {${DARK_TOKENS}${FIXED_TOKENS}
  }`
    : pinned === 'light'
      ? `:root {${LIGHT_TOKENS}${FIXED_TOKENS}
  }`
      : `:root {${LIGHT_TOKENS}${FIXED_TOKENS}
  }
  @media (prefers-color-scheme: dark) {
    :root {${DARK_TOKENS}
    }
  }`

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Memory settings panel — preview</title>
<style>
${themeCss}
  body { margin: 0; background: var(--dsw-alias-bg-base); }
  .frame { max-width: 760px; margin: 0 auto; padding: 24px; }
  .caption {
    font: 12px/1.5 var(--dsw-font-markdown-code-font-family);
    color: var(--dsw-alias-label-secondary);
    border-bottom: 0.5px solid var(--dsw-alias-border-l2);
    padding-bottom: 12px; margin-bottom: 20px;
  }
</style>
</head>
<body>
<div class="frame">
  <div class="caption">
    Preview of the registered <code>settings.section</code> entry “Memory” (order 60).<br>
    Rendered from the real lib/client.js with React against a representative status payload.<br>
    The live page appears inside the harness settings shell; this shows its content and layout.
  </div>
  ${toHtml(tree)}
</div>
</body>
</html>
`

const out = join(here, 'preview.html')
writeFileSync(out, html)
console.log(`wrote ${out} (${html.length} bytes)`)
