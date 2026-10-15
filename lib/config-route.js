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

import { writeConfig } from './config-write.js'
import { isPluginMode, MODES, pruneForNative } from './config-rules.js'
import { GLOBAL_SCOPE_CHOICES, scopeFields } from './scopes.js'
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

  /** The one place a write outcome becomes a response, so all three routes report alike.
   *
   * The two failures are NOT the same thing and must not share a status:
   *
   *   - `refused`   — the plugin would reject this configuration, so it was never persisted. That is
   *                   the CALLER's request (400), and the reason says what to do instead. Writing it
   *                   anyway is how the panel used to break the installation: `validateMemoryConfig`
   *                   runs inside `apply()`, so the reload throws and the plugin FAILS TO ACTIVATE.
   *   - `unwritable` — the request and the value are both fine; this COMPOSITION has no writer
   *                   (headless, ACP, SDK). Blaming the caller for a deployment difference would be
   *                   wrong, so this is 501.
   *
   * @param run - a thunk returning a `writeConfig` outcome, with any extra reply fields.
   * @returns the response. */
  const commit = async (run) => {
    const { result, body } = await run()
    if (result.ok !== true) return sendJson(result.kind === 'refused' ? 400 : 501, { error: result.reason })
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
        return commit(async () => ({ result: await writeConfig(ctx, { consumption: { maxTokens: tokens } }), body: { maxTokens: tokens } }))
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
        return commit(async () => ({ result: await writeConfig(ctx, fields), body: { scopes: wanted, ...fields } }))
      },
    })

  const mode = () =>
    connection.fetch.register({
      path: paths.mode,
      methods: ['POST'],
      requestBody: 'buffered',
      async fetch(request) {
        const read = await readJsonBody(request)
        if (read.error !== undefined) return read.error
        const wanted = typeof read.body.mode === 'string' ? read.body.mode.trim().toLowerCase() : ''
        if (!isPluginMode(wanted)) {
          return sendJson(400, { error: `mode must be one of ${MODES.join(', ')}` })
        }
        // Switching TO native cannot succeed while the entry still carries settings native refuses —
        // the rules would reject the write, which is exactly the "control that cannot work" this
        // module exists to avoid. So the switch PRUNES them (that is what handing the policy back to
        // the runtime means) and reports what it removed, and the reply carries the list so the panel
        // can say so rather than dropping somebody's prompt in silence.
        //
        // The pruning has to read the RAW config, not a patch: what to remove depends on what the
        // entry already holds. `writeConfig`'s callback is the only place that can see it, so the
        // prune runs there and its report is collected out of the closure.
        let dropped = []
        return commit(async () => ({
          result: await writeConfig(ctx, {}, {
            mutation: (current) => {
              if (wanted !== 'native') return { ...current, mode: wanted }
              const pruned = pruneForNative(current)
              dropped = pruned.dropped
              return { ...pruned.config, mode: wanted }
            },
          }),
          body: { mode: wanted, dropped },
        }))
      },
    })

  const writeBudget = () =>
    connection.fetch.register({
      path: paths.writeBudget,
      methods: ['POST'],
      requestBody: 'buffered',
      async fetch(request) {
        const read = await readJsonBody(request)
        if (read.error !== undefined) return read.error
        // Both fields are `natural` in the schema and BOTH accept `0`, which means "no cap" — the
        // default. So unlike the injection cap there is no floor to enforce here: a digits-only
        // string is the only accepted form, and anything else is refused rather than coerced, because
        // `Number('')` is 0 and `Number(true)` is 1 (the same reasoning as the cap route).
        const fields = {}
        for (const key of ['maxWrites', 'maxWriteBytes']) {
          const raw = read.body[key]
          if (raw === undefined) continue
          const value = typeof raw === 'number' ? raw : /^\d+$/.test(String(raw).trim()) ? Number(raw) : Number.NaN
          if (!Number.isInteger(value) || value < 0) {
            return sendJson(400, { error: `${key} must be a non-negative integer (0 = no limit)` })
          }
          fields[key] = value
        }
        if (Object.keys(fields).length === 0) {
          return sendJson(400, { error: 'send maxWrites and/or maxWriteBytes' })
        }
        return commit(async () => ({
          result: await writeConfig(ctx, { generation: fields }),
          body: fields,
        }))
      },
    })

  // One disposer, not an array of them: `ctx.effect` wants a teardown FUNCTION, and handing it a
  // list is the kind of thing that looks fine until the plugin is reloaded.
  const disposers = [budget(), scope(), mode(), writeBudget()]
  return () => {
    for (const dispose of disposers) dispose()
  }
}
