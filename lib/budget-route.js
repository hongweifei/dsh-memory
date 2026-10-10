/**
 * The injection-budget route: the one configuration value the panel can change.
 *
 * Kept apart from `routes.js` (which serves the panel's VIEW of memory) because it writes the
 * plugin's own configuration, and it has to agree with `test/architecture.test.mjs`'s 500-line
 * budget for that file — a focused route module is the honest way to make room.
 *
 * The path arrives as an argument rather than being imported from `routes.js`: both are layer-5
 * modules, so a same-layer import would fail the layering check, and `index.js` wires both.
 *
 * @module @dsh-external/dsh-memory/budget-route
 */

import { writeConfig } from './config-write.js'
import { CONSUMPTION_MIN_TOKENS } from './constants.js'

/**
 * Register the route.
 *
 * @param ctx - plugin context (must expose `connection`).
 * @param options - `{ path, readJsonBody, sendJson }`, injected by the route table's owner.
 * @returns the disposer the caller should hand to `ctx.effect`.
 */
export function registerBudgetRoute(ctx, options) {
  const { path, readJsonBody, sendJson } = options
  return ctx.get('connection').fetch.register({
    path,
    methods: ['POST'],
    requestBody: 'buffered',
    async fetch(request) {
      const read = await readJsonBody(request)
      if (read.error !== undefined) return read.error
      // One field, one value, and no guessing: a form sends a string, so an integer is either a
      // number or a digits-only string. `Number('')` is 0 and `Number(true)` is 1, which is exactly
      // how a typo becomes a silent configuration change.
      const raw = read.body.maxTokens
      const tokens = typeof raw === 'number' ? raw : /^\d+$/.test(String(raw).trim()) ? Number(raw) : Number.NaN
      if (!Number.isInteger(tokens)) return sendJson(400, { error: 'maxTokens must be an integer' })
      if (tokens < CONSUMPTION_MIN_TOKENS) {
        // The floor is the SDK's rule. `consumption.enabled: false` is how a caller asks for no
        // injection at all — 0 is not a legal budget anywhere in this plugin.
        return sendJson(400, { error: `maxTokens must be at least ${CONSUMPTION_MIN_TOKENS}; to inject nothing, turn consumption off` })
      }
      const written = await writeConfig(ctx, { consumption: { maxTokens: tokens } })
      // 501, not 400: the request is well-formed and the value is legal — this COMPOSITION cannot
      // write config. Reporting it as a client error would blame the caller for a deployment
      // difference.
      if (written.ok !== true) return sendJson(501, { error: written.reason })
      return sendJson(200, { ok: true, maxTokens: tokens })
    },
  })
}
