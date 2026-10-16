/**
 * Host HTTP routes backing the Settings → Memory panel.
 *
 * The Client half fetches these same-origin through the shared `/api` channel,
 * which applies the connection trust fence (Host/Origin validation plus browser
 * authentication) before any handler here runs. Registration is optional: a
 * profile without `connection` (headless, ACP, SDK) simply gets no routes.
 *
 * @module @dsh-external/dsh-memory/routes
 */

import { basename, join } from 'node:path'
import { GLOBAL_SCOPE_CHOICES, describeGlobalScopes } from '../config/scopes.js'
import { MODES } from '../config/config-rules.js'
import { deleteGuarded, listRootFiles, memoryGuard, readIfPresent, writeGuarded } from '../core/fs.js'
import { SESSION_MODES, isSessionMode, resolveLiveAgent, resolveScopeAgent } from '../session/memory-switch.js'
import { joinRoot, resolveDshHome, safeRelativePath, workspaceIndex } from '../core/paths.js'
import { browsableProjects, describeBytes, projectRoot, slugOf } from '../session/project-scopes.js'
import { forgetTrustedFolder, rememberTrustedFolder, resolveEffectiveRoots, trustState } from '../session/trust.js'

/**
 * The exact route paths this module owns.
 *
 * Exported so a test can assert the Client half's literals match these: the
 * browser bundle cannot import them, so without that check a rename would fail
 * only at runtime in the browser.
 */
export const ROUTE_PATHS = {
  status: '/api/memory/status',
  file: '/api/memory/file',
  preview: '/api/memory/preview',
  refresh: '/api/memory/refresh',
  flush: '/api/memory/flush',
  trust: '/api/memory/trust',
  switch: '/api/memory/switch',
  budget: '/api/memory/budget',
  scope: '/api/memory/scope',
  mode: '/api/memory/mode',
  generation: '/api/memory/generation',
}

/**
 * The session this panel speaks for.
 *
 * A route has no agent of its own, and it is the session whose sandbox policy the panel must report
 * and whose fence memory writes must obey under `writePolicy: session`. Without it the deployment
 * default would be reported as if it were the session's, which is exactly the confusion this seam
 * removes.
 *
 * Resolved through `resolveScopeAgent`, NOT `currentInitiator()` directly: no HTTP request carries an
 * initiator boundary, so the strict form was ALWAYS `undefined` here — which made `projectFolder`
 * report the host's own working directory (usually the harness home, not the user's project) and made
 * the trust route's default folder that same wrong path. Trusting the harness home instead of the
 * project is a WRITE on the wrong target, so this is not cosmetic.
 *
 * @param ctx - plugin context.
 * @returns the live session, or `undefined` when none can be identified.
 */
function activeSession(ctx) {
  return resolveScopeAgent(ctx)?.session
}

/**
 * The folder the panel should speak about, and where that folder came from.
 *
 * A route has no agent of its own, and the host process's working directory is
 * often the harness home rather than the project the user is looking at. So the
 * folder comes from the session this panel speaks for (see `activeSession`), which
 * is the same seam the memory service uses to resolve a refresh target — the
 * panel's trust verdict and its trust button both act on the folder the session is
 * actually in. `source` says whether a session answered, so an unexplained path
 * cannot masquerade as the user's project.
 *
 * @param ctx - plugin context.
 * @returns `{ cwd, source }` — `source` says whether a session answered.
 */
function activeFolder(ctx) {
  const cwd = activeSession(ctx)?.header?.cwd
  if (typeof cwd === 'string' && cwd.length > 0) return { cwd, source: 'session' }
  return { cwd: process.cwd(), source: 'host' }
}

/**
 * The folder the panel should speak about.
 *
 * @param ctx - plugin context.
 * @returns the session's working directory, falling back to the host's.
 */
function activeCwd(ctx) {
  return activeFolder(ctx).cwd
}

/**
 * Read a JSON object body, or the error response to send instead.
 *
 * Every writing route needs the same refusals (unparseable, not an object — an array is not an
 * object here), and three copies of the preamble is how one of them silently diverges.
 *
 * @param request - the incoming request.
 * @returns `{ body }` or `{ error }`, a ready-to-send response.
 */
export async function readJsonBody(request) {
  let body
  try {
    body = await request.json()
  } catch {
    return { error: sendJson(400, { error: 'body must be JSON' }) }
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { error: sendJson(400, { error: 'body must be a JSON object' }) }
  }
  return { body }
}

/** JSON response with no caching: every value here is a live fact. */
export function sendJson(status, payload) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

/**
 * Register the panel's routes.
 *
 * @param ctx - plugin context (must expose `connection`).
 * @param config - the resolved configuration.
 * @param customRoots - the validated `generation.roots` list.
 * @param lifecycle - the plugin's lifetime signal.
 * @param status - a snapshot provider for the status route.
 * @param memorySwitch - the per-session switch, for the panel's toggle.
 */
export function registerRoutes(ctx, config, customRoots, lifecycle, status, memorySwitch) {
  const connection = ctx.get('connection')

  /** Resolve one scope root by id: a built-in scope, a custom root, or a project. */
  const rootFor = async (scopeId, signal) => {
    // A projectKey-shaped id addresses that project's memory directory. The gate
    // decides whether it may be touched at all.
    const project = projectRoot(scopeId)
    if (project !== undefined) {
      if (config.trust?.enabled !== true) return project
      const roots = await resolveEffectiveRoots(ctx, config, customRoots, activeCwd(ctx), signal)
      return slugOf(roots.find((candidate) => candidate.id === 'project')) === scopeId ? project : undefined
    }
    // Look the id up rather than remapping everything to user/project: a custom
    // root is a real scope, and the read-only branch below must be reachable.
    const roots = await resolveEffectiveRoots(ctx, config, customRoots, activeCwd(ctx), signal)
    return roots.find((candidate) => candidate.id === scopeId)
  }

  ctx.effect(
    () =>
      connection.fetch.register({
        path: ROUTE_PATHS.status,
        methods: ['GET'],
        requestBody: 'buffered',
        async fetch() {
          const cwd = activeCwd(ctx)
          const roots = await resolveEffectiveRoots(ctx, config, customRoots, cwd, lifecycle.signal).catch(() => [])
          // The panel browses EVERY project with memory, not only the active
          // session's: it is global settings, and "the current session's folder" is
          // whatever the user happened to click last.
          const scopes = []
          const userRoot = roots.find((root) => root.id === 'user')
          // Slugs are what the panel ADDRESSES a scope by; the workspace name is what a
          // person recognises. Keyed forward from the registry, since a slug cannot be
          // decoded back into a path.
          const workspaces = await workspaceIndex(ctx)
          const browsable = [
            ...(userRoot === undefined ? [] : [userRoot]),
            ...(await browsableProjects(ctx, config, roots.find((root) => root.id === 'project'), lifecycle.signal)),
          ]
          for (const root of browsable) {
            const sizes = new Map()
            let names = []
            try {
              names = await listRootFiles(ctx.get('fs'), root, lifecycle.signal, sizes)
            } catch {
              names = []
            }
            const known = workspaces.get(root.id)
            scopes.push({
              id: root.id,
              // The row title: the workspace's own name, else the slug it is addressed by.
              label: known === undefined ? undefined : (known.title ?? basename(known.path)),
              path: root.path,
              access: root.access,
              indexFile: root.indexFile ?? null,
              files: names,
              // The listing already carries each entry's size, so the row can say how
              // much memory a scope holds without a second round-trip. (The harness's
              // `FsInfo` exposes no modification time, so a truthful "updated at" is
              // not available and the row does not pretend to have one.)
              size: describeBytes(names.reduce((total, name) => total + (sizes.get(name) ?? 0), 0)),
            })
          }
          // The gate's own snapshot, so the panel can say WHY a scope is absent.
          const trust = await trustState(ctx, config, customRoots, cwd, lifecycle.signal)
          // `ready()` BEFORE the mode is read: `modeOf` is the synchronous already-read variant, so
          // without this await the panel would report `auto` for a session the store has muted.
          await memorySwitch?.ready?.()
          // `resolveScopeAgent`, not `activeSession` (which is `currentInitiator()`): a browser request
          // has no initiator boundary, so the strict form reported `memoryMode: undefined` for EVERY
          // panel load — and the panel renders that as "follows the global configuration", i.e. it
          // told a muted session it was following the configuration. A read may use the sole live
          // session; a WRITE still may not (the switch route names its session and 409s on unknown).
          const active = resolveScopeAgent(ctx)?.session
          // Which folder the project scope speaks about, and why. A global settings
          // page has no single obvious "project", so without this the path looks
          // wrong rather than explained.
          return sendJson(200, {
            ...status({ session: active }),
            // Named `memoryMode`, not `sessionMode`: the status payload already uses
            // `sessionMode` for the SANDBOX mode the session resolves to, and a spread that
            // silently overwrote one with the other would have the panel report the wrong fact.
            memoryMode: active === undefined ? undefined : memorySwitch?.modeOf?.(active) ?? 'auto',
            // The GLOBAL layer, which is what a per-session `auto` follows, so the panel can name it
            // instead of leaving the composer's "Auto" undefined.
            globalScopes: describeGlobalScopes(config),
            // And the states a control may OFFER, from the same module the writing route uses. The
            // browser bundle cannot import a Host module, so the list rides with the payload — the
            // same reason `minTokens` does.
            globalScopeChoices: [...GLOBAL_SCOPE_CHOICES],
            // The plugin modes, from the same list the mode route validates against: a control may
            // not invent a mode the plugin does not implement.
            modeChoices: [...MODES],
            // Whether a control can be SAVED here at all. The panel must not render a Save whose only
            // possible answer is 501: a control that cannot work is worse than a read-only row. The
            // panel cannot work this out for itself, because `configEditor` is a Host service.
            configWritable: typeof ctx.get('configEditor')?.edit === 'function',
            trust,
            roots: scopes,
            projectFolder: activeFolder(ctx),
            memorySwitch: { available: memorySwitch !== undefined },
          })
        },
      }),
    `memory: GET ${ROUTE_PATHS.status}`,
  )

  ctx.effect(
    () =>
      connection.fetch.register({
        path: ROUTE_PATHS.switch,
        // GET is what the composer reads: one session, its mode, and the two facts a button
        // needs to say what the next click will do. POST is the panel's settings list.
        methods: ['GET', 'POST'],
        requestBody: 'buffered',
        async fetch(request) {
          if (memorySwitch === undefined) return sendJson(501, { error: 'this build has no session switch' })
          await memorySwitch.ready()
          if (request.method === 'GET') {
            const wanted = new URL(request.url, 'http://localhost').searchParams.get('session')
            const agent = resolveLiveAgent(ctx, wanted ?? undefined)
            if (agent === undefined) {
              const reason = wanted === null || wanted.length === 0
                ? 'session is required: a route cannot resolve the current session'
                : 'no live session has that id'
              return sendJson(409, { error: reason })
            }
            return sendJson(200, {
              session: agent.session.id,
              cwd: agent.session.header?.cwd,
              mode: memorySwitch.modeOf(agent.session),
              modes: SESSION_MODES,
              // What `auto` resolves to right now, so the composer can say what the session is
              // actually following instead of leaving "Auto" as a word with nothing behind it.
              global: describeGlobalScopes(config),
            })
          }
          const read = await readJsonBody(request)
          if (read.error !== undefined) return read.error
          const body = read.body
          if (!isSessionMode(body.mode)) {
            return sendJson(400, { error: `mode must be one of ${SESSION_MODES.join(', ')}` })
          }
          // A route has no initiator (no HTTP path establishes one), so the session
          // MUST be named. `resolveLiveAgent` refuses an unknown id instead of
          // falling back to whatever session happens to be active, which would switch
          // the wrong one.
          const agent = resolveLiveAgent(ctx, body.session)
          if (agent === undefined) {
            const reason = typeof body.session === 'string' && body.session.length > 0
              ? 'no live session has that id'
              : 'session is required: a route cannot resolve the current session'
            return sendJson(409, { error: reason })
          }
          try {
            const service = ctx.get('memory')
            const result = await service.setMemorySwitch(agent.session, body.mode)
            // The reply carries the global layer too, so the composer can re-render its title
            // without a second round-trip.
            return sendJson(200, { ...result, global: describeGlobalScopes(config) })
          } catch (error) {
            return sendJson(500, { error: error instanceof Error ? error.message : String(error) })
          }
        },
      }),
    `memory: POST ${ROUTE_PATHS.switch}`,
  )

  ctx.effect(
    () =>
      connection.fetch.register({
        path: ROUTE_PATHS.trust,
        methods: ['POST'],
        requestBody: 'buffered',
        async fetch(request) {
          const read = await readJsonBody(request)
          if (read.error !== undefined) return read.error
          const body = read.body
          const action = body.action
          if (action !== 'allow' && action !== 'deny') {
            return sendJson(400, { error: 'action must be "allow" or "deny"' })
          }
          const cwd = activeCwd(ctx)
          const folder = typeof body.folder === 'string' && body.folder.length > 0 ? body.folder : cwd
          try {
            // The trust store is plugin storage under `$DSH_HOME`, outside every workspace.
            const trustPolicy = memoryGuard(ctx, config, activeSession(ctx), resolveDshHome()).policy
            if (action === 'allow') await rememberTrustedFolder(ctx, folder, lifecycle.signal, trustPolicy)
            else await forgetTrustedFolder(ctx, folder, lifecycle.signal, trustPolicy)
          } catch (error) {
            return sendJson(500, { error: error instanceof Error ? error.message : String(error) })
          }
          // Qoder's `setTrustedFolder` refreshes the memory context; here the
          // next agent step re-projects memory anyway (P1-4), so replying with
          // the new decision is enough — and the panel reloads its status. The
          // reply speaks about the folder that was acted on.
          const trust = await trustState(ctx, config, customRoots, folder, lifecycle.signal)
          return sendJson(200, { ok: true, action, folder, trust })
        },
      }),
    `memory: POST ${ROUTE_PATHS.trust}`,
  )

  ctx.effect(
    () =>
      connection.fetch.register({
        path: ROUTE_PATHS.file,
        methods: ['GET', 'POST', 'DELETE'],
        requestBody: 'buffered',
        async fetch(request) {
          if (request.method === 'GET') {
            const url = new URL(request.url)
            const scope = url.searchParams.get('scope') ?? 'project'
            const safe = safeRelativePath(url.searchParams.get('path') ?? '')
            if (safe === undefined) {
              return sendJson(400, { error: 'path must be a relative .md path inside the scope root' })
            }
            const root = await rootFor(scope, lifecycle.signal)
            if (root === undefined) return sendJson(404, { error: `scope "${scope}" is not enabled` })
            try {
              const found = await readIfPresent(ctx.get('fs'), joinRoot(root.path, safe), lifecycle.signal)
              if (found === undefined) return sendJson(404, { error: `memory: ${scope}:${safe} does not exist` })
              return sendJson(200, {
                scope,
                path: safe,
                text: found.text,
                bytes: Buffer.byteLength(found.text, 'utf8'),
              })
            } catch (error) {
              return sendJson(500, { error: error instanceof Error ? error.message : String(error) })
            }
          }

          // DELETE — remove one memory file. The panel's per-file action, and the
          // same allow-list the write path enforces.
          if (request.method === 'DELETE') {
            const url = new URL(request.url)
            const scope = url.searchParams.get('scope') ?? 'project'
            const safe = safeRelativePath(url.searchParams.get('path') ?? '')
            if (safe === undefined) {
              return sendJson(400, { error: 'path must be a relative .md path inside the scope root' })
            }
            const root = await rootFor(scope, lifecycle.signal)
            if (root === undefined) return sendJson(404, { error: `scope "${scope}" is not enabled` })
            if (root.access !== 'read-write') return sendJson(403, { error: `scope ${scope} is read-only` })
            const fenceMode = memoryGuard(ctx, config, activeSession(ctx), root.path).fenceMode
            const outcome = await deleteGuarded(ctx.get('fs'), joinRoot(root.path, safe), undefined, lifecycle.signal, fenceMode)
            if (outcome.missing === true) return sendJson(404, { error: `memory: ${scope}:${safe} does not exist` })
            if (outcome.error !== undefined) return sendJson(500, { error: outcome.error })
            return sendJson(200, { ok: true, scope, path: safe, deleted: true })
          }

          // POST — write one memory file.
          const read = await readJsonBody(request)
          if (read.error !== undefined) return read.error
          const body = read.body
          const scope = typeof body.scope === 'string' ? body.scope : 'project'
          const safe = safeRelativePath(body.path)
          if (safe === undefined) {
            return sendJson(400, { error: 'path must be a relative .md path inside the scope root' })
          }
          if (typeof body.content !== 'string' || body.content.trim().length === 0) {
            return sendJson(400, { error: 'content must be a non-empty string' })
          }
          const root = await rootFor(scope, lifecycle.signal)
          if (root === undefined) return sendJson(404, { error: `scope "${scope}" is not enabled` })
          if (root.access !== 'read-write') return sendJson(403, { error: `scope ${scope} is read-only` })
          try {
            const policy = memoryGuard(ctx, config, activeSession(ctx), root.path).policy
            await writeGuarded(ctx.get('fs'), joinRoot(root.path, safe), body.content, lifecycle.signal, policy)
            return sendJson(200, { ok: true, scope, path: safe, bytes: Buffer.byteLength(body.content, 'utf8') })
          } catch (error) {
            return sendJson(500, { error: error instanceof Error ? error.message : String(error) })
          }
        },
      }),
    `memory: GET/POST/DELETE ${ROUTE_PATHS.file}`,
  )

  ctx.effect(
    () =>
      connection.fetch.register({
        path: ROUTE_PATHS.preview,
        methods: ['GET'],
        requestBody: 'buffered',
        async fetch(request) {
          try {
            const service = ctx.get('memory')
            // WHICH session to speak for: `resolveScopeAgent` owns that order (named id → initiator →
            // the sole TOP-LEVEL live agent → nothing), so this route and `/status` cannot come to
            // disagree about which session is in scope. The reasoning is documented there once.
            //
            // Nothing resolved is NOT an error here: the preview then describes the GLOBAL
            // configuration — what a session starting now would receive — and the panel says so
            // (`scope: 'global'`). Requiring a session is what made this button fail EVERY time in
            // production: no HTTP request carries an initiator boundary.
            //
            // What is deliberately NOT done: enumerating live sessions and picking one when there are
            // several (that code exists in this repo's history and was removed). With more than one
            // candidate the route cannot know which, and inventing an answer for the wrong session is
            // worse than reporting the global one.
            const wanted = new URL(request.url, 'http://localhost').searchParams.get('session')
            const agent = resolveScopeAgent(ctx, wanted ?? undefined)
            if (wanted !== null && wanted.length > 0 && agent === undefined) {
              // A NAMED session that is not live is an error, not a reason to fall back: silently
              // previewing a different session than the one asked for would be the bug this whole
              // resolution order exists to avoid.
              return sendJson(409, { error: `no live session with id ${wanted}` })
            }
            const result =
              service !== undefined && typeof service.previewMemory === 'function'
                ? await service.previewMemory(agent)
                : { available: false, reason: 'the memory service does not support previews' }
            return sendJson(200, result)
          } catch (error) {
            return sendJson(500, { error: error instanceof Error ? error.message : String(error) })
          }
        },
      }),
    `memory: GET ${ROUTE_PATHS.preview}`,
  )

  ctx.effect(
    () =>
      connection.fetch.register({
        path: ROUTE_PATHS.refresh,
        methods: ['POST'],
        requestBody: 'buffered',
        async fetch() {
          try {
            const result = await ctx.get('memory')?.refreshMemory()
            return sendJson(200, result ?? { injected: false, reason: 'memory service unavailable' })
          } catch (error) {
            return sendJson(500, { error: error instanceof Error ? error.message : String(error) })
          }
        },
      }),
    `memory: POST ${ROUTE_PATHS.refresh}`,
  )

  ctx.effect(
    () =>
      connection.fetch.register({
        path: ROUTE_PATHS.flush,
        methods: ['POST'],
        requestBody: 'buffered',
        async fetch() {
          try {
            const result = await ctx.get('memory')?.flushMemory()
            return sendJson(200, result ?? { flushed: 0 })
          } catch (error) {
            return sendJson(500, { error: error instanceof Error ? error.message : String(error) })
          }
        },
      }),
    `memory: POST ${ROUTE_PATHS.flush}`,
  )
}
