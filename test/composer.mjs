/**
 * Render the COMPOSER control standalone, in a mock composer row.
 *
 * The settings preview shows the panel; the session control now lives in the conversation's tool
 * row, which no panel screenshot can show. This prints its exact label, `data-state` and title for
 * every mode, so the words a user reads can be checked rather than assumed.
 *
 * Run: node test/composer.mjs [auto|project|off]
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import React from 'react'
import TestRenderer from 'react-test-renderer'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8')

const MODE = process.argv[2] ?? 'auto'
const active = process.env.PREVIEW_LOCALE === 'zh' ? 'zh' : 'en'

let registration
new Function('window', 'require', 'fetch', source)(
  { __ModuleLoader__: { load: (next) => { registration = next } } },
  (specifier) => {
    if (specifier === 'react') return React
    throw new Error(`unexpected external ${specifier}`)
  },
  async () => ({ ok: true, json: async () => payload }),
)

const payload = { session: 'session-3f2a91c4', cwd: 'D:\\code\\demo', mode: MODE, modes: ['auto', 'project', 'off'], global: 'all' }
const plugin = registration.factory((specifier) => {
  if (specifier === 'react') return React
  throw new Error(`unexpected external ${specifier}`)
})

const dicts = new Map()
const locale = {
  register: (ns, tables) => {
    for (const [id, table] of Object.entries(tables)) dicts.set(`${ns}\u0000${id}`, table)
    return () => {}
  },
  bind: (ns) => (key, params) => {
    const template = (dicts.get(`${ns}\u0000${active}`) ?? dicts.get(`${ns}\u0000en`) ?? {})[key] ?? key
    return params ? template.replace(/\{(\w+)\}/g, (m, name) => (name in params ? String(params[name]) : m)) : template
  },
}

let component
plugin.apply({
  effect: (body) => {
    const dispose = body()
    return typeof dispose === 'function' ? dispose : () => {}
  },
  locale,
  slots: {
    inject: (_owner, callback) => callback(),
    register: (options, next) => {
      if (options.name === 'conversation.input.left') component = next
      return () => {}
    },
  },
})

let renderer
await TestRenderer.act(async () => {
  renderer = TestRenderer.create(React.createElement(component, { t: locale.bind('memory'), sessionId: payload.session }))
})
await TestRenderer.act(async () => {
  await Promise.resolve()
})

const found = renderer.root.findAll((node) => node.type === 'button')
const props = found[0] === undefined ? null : found[0].props
const t = locale.bind('memory')
const verb = (name) => t('mode' + name.charAt(0).toUpperCase() + name.slice(1))
const modes = ['auto', 'project', 'off']
const next = modes[(modes.indexOf(MODE) + 1) % modes.length]
console.log(`[${active}] mode=${MODE}`)
console.log(`  label   ${props === null ? '(no button)' : props['aria-label']}`)
console.log(`  text    ${found[0] === undefined ? '' : String(found[0].children.join(''))}`)
console.log(`  tone    ${props === null ? '' : props['data-state']}`)
console.log(`  title   ${props === null ? '' : props.title}`)
console.log(`  next    ${verb(next)}`)
renderer.unmount()
