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
 * modules, so a same-layer import would fail the layering check, and `index.js` wires both. The
 * two HTTP primitives it shares with `routes.js` do NOT: they live in `./http.js`, one layer down.
 *
 * @module @dsh-external/dsh-memory/config-route
 */

import { writeConfig } from '../config/config-write.js'
import { isPluginMode, MODES, pruneForNative } from '../config/config-rules.js'
import { GLOBAL_SCOPE_CHOICES, scopeFields } from '../config/scopes.js'
import { CONSUMPTION_MIN_TOKENS, CONSUMPTION_UNLIMITED } from '../core/constants.js'
import { readJsonBody, sendJson } from './http.js'

/**
 * Register the routes.
 *
 * @param ctx - plugin context (must expose `connection`).
 * @param options - `{ paths }`, injected by the route table's owner.
 * @returns one disposer that unregisters every route, for the caller to hand to `ctx.effect`.
 */
export function registerConfigRoutes(ctx, options) {
  const { paths } = options
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
        // Three request shapes, and no guessing:
        //   a positive integer sets the cap;
        //   the string "unlimited" removes the cap — the ONE spelling of "no limit", and the same
        //     one the configuration uses (a `null` would be erased by the Loader's configuration
        //     write-back, which drops a null value inside an object);
        //   anything else is refused.
        // A form sends a string, so an integer is either a number or a digits-only string.
        // `Number('')` is 0 and `Number(true)` is 1, which is exactly how a typo becomes a silent
        // configuration change.
        const raw = read.body.maxTokens
        if (raw === CONSUMPTION_UNLIMITED) {
          return commit(async () => ({
            result: await writeConfig(ctx, { consumption: { maxTokens: CONSUMPTION_UNLIMITED } }),
            body: { maxTokens: CONSUMPTION_UNLIMITED },
          }))
        }
        const tokens = typeof raw === 'number' ? raw : /^\d+$/.test(String(raw).trim()) ? Number(raw) : Number.NaN
        if (!Number.isInteger(tokens)) {
          return sendJson(400, { error: `maxTokens must be an integer, or "${CONSUMPTION_UNLIMITED}" for no limit` })
        }
        if (tokens < CONSUMPTION_MIN_TOKENS) {
          // The floor is the SDK's rule for a cap that IS present. `consumption.enabled: false` is how
          // a caller asks for no injection at all — 0 is not a legal budget anywhere in this plugin.
          return sendJson(400, { error: `maxTokens must be at least ${CONSUMPTION_MIN_TOKENS}, or "${CONSUMPTION_UNLIMITED}" for no limit; to inject nothing, turn consumption off` })
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

  const generation = () =>
    connection.fetch.register({
      path: paths.generation,
      methods: ['POST'],
      requestBody: 'buffered',
      async fetch(request) {
        const read = await readJsonBody(request)
        if (read.error !== undefined) return read.error
        // Qoder's three policy switches, under this port's names: `enabled` is
        // `auto_memory_policy.enabled` (the automatic per-turn pass), `dream` is `auto_dream.enabled`,
        // and `journal` is the Daily Memory Journal. Booleans only — never "truthy": a `<select>` may
        // send `"false"`, the string most likely to be mistaken for `true`.
        const fields = {}
        for (const key of ['enabled', 'dream', 'journal']) {
          const raw = read.body[key]
          if (raw === undefined) continue
          if (raw !== true && raw !== false && raw !== 'true' && raw !== 'false') {
            return sendJson(400, { error: `${key} must be true or false` })
          }
          fields[key] = raw === true || raw === 'true'
        }
        if (Object.keys(fields).length === 0) {
          return sendJson(400, { error: 'send enabled, dream and/or journal' })
        }
        // The per-turn TRIGGER is not independent of the master switch: the SDK refuses
        // `generation.enabled: false` beside `turnComplete.enabled: true`. So turning the master off must
        // carry the trigger with it, or the write is declined and the switch looks broken. Turning it on
        // restores the trigger, so "on" means automatic memory actually runs again. Either way the touched
        // key is reported, because a switch that silently rewrites a neighbour is how a panel loses trust.
        //
        // This reads the RAW config (whether `turnComplete` is explicitly `true` depends on what the entry
        // already holds), so it runs inside `writeConfig`'s mutation callback. It only touches the trigger
        // when it is EXPLICITLY in the way: asserting it when it was never written would add a key the user
        // never set, and an absent `turnComplete` is not `enabled: true`.
        const implied = []
        return commit(async () => ({
          result: await writeConfig(ctx, {}, {
            mutation: (current) => {
              const next = { ...(current.generation ?? {}) }
              const turnComplete = next.turnComplete
              if (fields.enabled !== undefined) {
                if (fields.enabled === false && turnComplete?.enabled === true) {
                  next.turnComplete = { ...turnComplete, enabled: false }
                  implied.push('generation.turnComplete.enabled')
                } else if (fields.enabled === true && turnComplete?.enabled === false) {
                  next.turnComplete = { ...turnComplete, enabled: true }
                  implied.push('generation.turnComplete.enabled')
                }
                next.enabled = fields.enabled
              }
              if (fields.dream !== undefined) next.dream = { ...(next.dream ?? {}), enabled: fields.dream }
              if (fields.journal !== undefined) next.journal = { ...(next.journal ?? {}), enabled: fields.journal }
              return { ...current, generation: next }
            },
          }),
          body: { ...fields, implied },
        }))
      },
    })

  // One disposer, not an array of them: `ctx.effect` wants a teardown FUNCTION, and handing it a
  // list is the kind of thing that looks fine until the plugin is reloaded.
  const disposers = [budget(), scope(), mode(), generation()]
  return () => {
    for (const dispose of disposers) dispose()
  }
}
