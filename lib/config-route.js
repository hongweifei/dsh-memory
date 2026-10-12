/**
 * The configuration routes: the values the panel itself can change.
 *
 * One module for both, because both do the same three things in the same order — narrow a string
 * from a form, refuse anything the schema would refuse, and write through `configEditor` — and a
 * second copy of that preamble is how the two drift apart.
 *
 * Kept apart from `routes.js` (which serves the panel's VIEW of memory) because it writes the
 * plugin's own configuration, and it has to agree with `test/architecture.test.mjs`'s 500-line
 * budget for that file — a focused route module is the honest way to make room.
 *
 * The paths arrive as an argument rather than being imported from `routes.js`: both are layer-5
 * modules, so a same-layer import would fail the layering check, and `index.js` wires both.
 *
 * @module @dsh-external/dsh-memory/config-route
 */

import { GLOBAL_SCOPE_CHOICES, scopeFields, writeConfig } from './config-write.js'
import { CONSUMPTION_MIN_TOKENS } from './constants.js'

/**
 * Register the routes.
 *
 * @param ctx - plugin context (must expose `connection`).
 * @param options - `{ paths, readJsonBody, sendJson }`, injected by the route table's owner.
 * @returns one disposer that unregisters every route, for the caller to hand to `ctx.effect`.
 */
export function registerConfigRoutes(ctx, options) {
  const { paths, readJsonBody, sendJson } = options
  const connection = ctx.get('connection')

  /** The one place a refusal is turned into a response, so both routes report alike. */
  const commit = async (patch, body) => {
    const written = await writeConfig(ctx, patch)
    // 501, not 400: the request is well-formed and the value is legal — this COMPOSITION cannot
    // write config. Reporting it as a client error would blame the caller for a deployment
    // difference.
    if (written.ok !== true) return sendJson(501, { error: written.reason })
    return sendJson(200, { ok: true, ...body })
  }

  const budget = () =>
    connection.fetch.register({
      path: paths.budget,
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
        return commit({ consumption: { maxTokens: tokens } }, { maxTokens: tokens })
      },
    })

  const scope = () =>
    connection.fetch.register({
      path: paths.scope,
      methods: ['POST'],
      requestBody: 'buffered',
      async fetch(request) {
        const read = await readJsonBody(request)
        if (read.error !== undefined) return read.error
        // A lowercase string only. `scopeFields` is the same function `/memory-scope` uses, so the
        // panel and the command cannot disagree about what `user` means — and an unknown state is
        // refused rather than mapped onto whatever it looks closest to.
        const wanted = typeof read.body.scopes === 'string' ? read.body.scopes.trim().toLowerCase() : ''
        const fields = scopeFields(wanted)
        if (fields === undefined) {
          return sendJson(400, { error: `scopes must be one of ${GLOBAL_SCOPE_CHOICES.join(', ')}` })
        }
        return commit(fields, { scopes: wanted, ...fields })
      },
    })

  // One disposer, not an array of them: `ctx.effect` wants a teardown FUNCTION, and handing it a
  // list is the kind of thing that looks fine until the plugin is reloaded.
  const disposers = [budget(), scope()]
  return () => {
    for (const dispose of disposers) dispose()
  }
}
