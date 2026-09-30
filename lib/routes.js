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

import { basename, dirname, join } from 'node:path'
import { deleteGuarded, listRootFiles, memoryWritePolicy, readIfPresent, writeGuarded } from './fs.js'
import { joinRoot, resolveDshHome, safeRelativePath, workspaceIndex } from './paths.js'
import { forgetTrustedFolder, rememberTrustedFolder, resolveEffectiveRoots, trustState } from './trust.js'

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
  refresh: '/api/memory/refresh',
  flush: '/api/memory/flush',
  trust: '/api/memory/trust',
}

/**
 * The folder the panel should speak about, and where that folder came from.
 *
 * A route has no agent of its own, and the host process's working directory is
 * often the harness home rather than the project the user is looking at. The
 * harness exposes the current initiator, which is the same seam the memory
 * service uses to resolve a refresh target — so the panel's trust verdict and
 * its trust button both act on the folder the session is actually in.
 *
 * @param ctx - plugin context.
 * @returns `{ cwd, source }` — `source` says whether a session answered.
 */
function activeFolder(ctx) {
  const agent = ctx.get('agents')?.currentInitiator?.()
  const cwd = agent?.session?.header?.cwd
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

/** JSON response with no caching: every value here is a live fact. */
function sendJson(status, payload) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

/**
 * A human byte size for a scope row: `1.2 KB`, `18 B`.
 *
 * @param bytes - the total, already summed by the listing.
 * @returns the formatted size.
 */
function describeBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  if (bytes < 1024) return `${bytes} B`
  return `${(bytes / 1024).toFixed(1)} KB`
}

/**
 * The `<DSH_HOME>/projects` directory: one child per project, each with a
 * `memory` directory. Names are the harness's own `projectKey` slugs.
 */
function projectsRoot() {
  return join(resolveDshHome(), 'projects')
}

/** Exactly what `projectKey` produces, so a slug cannot address anything else. */
const PROJECT_SLUG = /^--[A-Za-z0-9._~-]{1,251}--$/

/**
 * One project's memory root, addressed by its directory name.
 *
 * The panel is global settings, so it must be able to speak about a project other
 * than whichever session happens to be active. `projectKey` is lossy — a slug
 * cannot be decoded back into a path — but it needs no decoding to be *used*, and
 * the strict shape above is what keeps this from addressing arbitrary paths.
 *
 * @param slug - a projectKey-shaped directory name.
 * @returns a root record, or `undefined` when the name is not one.
 */
function projectRoot(slug) {
  if (typeof slug !== 'string' || !PROJECT_SLUG.test(slug)) return undefined
  return { id: slug, path: join(projectsRoot(), slug, 'memory'), access: 'read-write', indexFile: 'MEMORY.md' }
}

/** The slug of the project root a session resolved to, for comparison. */
function slugOf(root) {
  return root === undefined ? undefined : basename(dirname(root.path))
}

/**
 * Every project the panel may browse: the user scope, then the current session's
 * project, then every project that already has a memory directory.
 *
 * With the trust gate on, only the current session's project is offered: a slug
 * cannot be turned back into a folder, so trust cannot be evaluated for the
 * others, and listing memory the gate would refuse to load is worse than not
 * listing it.
 *
 * @param ctx - plugin context.
 * @param current - the current session's project root, when it resolves.
 * @param signal - cancellation.
 * @returns root records, newest project first.
 */
async function browsableProjects(ctx, config, current, signal) {
  // The session's project is addressed by its slug too, so one select value space
  // covers everything the panel can browse.
  const currentSlug = slugOf(current)
  const own = currentSlug === undefined ? undefined : { ...projectRoot(currentSlug), access: current.access }
  const found = []
  // With the gate ON the scan is skipped entirely: `projectKey` is lossy, so a
  // slug cannot be turned back into a folder to evaluate trust for, and listing
  // (or letting the panel edit) memory the gate refuses to load is a hole. Only
  // the session's own project is offered, and `resolveEffectiveRoots` already
  // decided whether it may be.
  if (config.trust?.enabled !== true) {
    try {
      const target = await ctx.get('fs').resolve(projectsRoot(), { signal })
      const entries = await ctx.get('fs').listDir(target, { signal })
      for (const entry of entries) {
        // The slug shape is the whole test that matters: listRootFiles decides
        // whether it actually holds memory, so a provider that omits entry types
        // still lists every project.
        const root = projectRoot(entry.name)
        if (root !== undefined) found.push(root)
      }
    } catch {
      /* no projects directory yet: the current session is still offered */
    }
  }
  const listed = found.filter((root) => root.id !== currentSlug)
  return own === undefined || own.path === undefined ? listed : [own, ...listed]
}

/**
 * Register the panel's routes.
 *
 * @param ctx - plugin context (must expose `connection`).
 * @param config - the resolved configuration.
 * @param customRoots - the validated `generation.roots` list.
 * @param lifecycle - the plugin's lifetime signal.
 * @param status - a snapshot provider for the status route.
 */
export function registerRoutes(ctx, config, customRoots, lifecycle, status) {
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
          // Which folder the project scope speaks about, and why. A global settings
          // page has no single obvious "project", so without this the path looks
          // wrong rather than explained.
          return sendJson(200, { ...status(), trust, roots: scopes, projectFolder: activeFolder(ctx) })
        },
      }),
    `memory: GET ${ROUTE_PATHS.status}`,
  )

  ctx.effect(
    () =>
      connection.fetch.register({
        path: ROUTE_PATHS.trust,
        methods: ['POST'],
        requestBody: 'buffered',
        async fetch(request) {
          let body
          try {
            body = await request.json()
          } catch {
            return sendJson(400, { error: 'body must be JSON' })
          }
          const action = body === null || typeof body !== 'object' ? undefined : body.action
          if (action !== 'allow' && action !== 'deny') {
            return sendJson(400, { error: 'action must be "allow" or "deny"' })
          }
          const cwd = activeCwd(ctx)
          const folder = typeof body.folder === 'string' && body.folder.length > 0 ? body.folder : cwd
          try {
            // The trust store is plugin storage under `$DSH_HOME`, outside every workspace.
            const trustPolicy = memoryWritePolicy(resolveDshHome(), config.writePolicy !== 'session')
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
            const outcome = await deleteGuarded(ctx.get('fs'), joinRoot(root.path, safe), undefined, lifecycle.signal, config.writePolicy !== 'session')
            if (outcome.missing === true) return sendJson(404, { error: `memory: ${scope}:${safe} does not exist` })
            if (outcome.error !== undefined) return sendJson(500, { error: outcome.error })
            return sendJson(200, { ok: true, scope, path: safe, deleted: true })
          }

          // POST — write one memory file.
          let body
          try {
            body = await request.json()
          } catch {
            return sendJson(400, { error: 'body must be JSON' })
          }
          if (body === null || typeof body !== 'object') return sendJson(400, { error: 'body must be a JSON object' })
          const scope = typeof body.scope === 'string' ? body.scope : 'project'
          const safe = safeRelativePath(body.path)
          if (safe === undefined) {
            return sendJson(400, { error: 'path must be a relative .md path inside the scope root' })
          }
          if (typeof body.content !== 'string' || body.content.trim().length === 0) {
            return sendJson(400, { error: 'content must be a non-empty string' })
          }
          if (Buffer.byteLength(body.content, 'utf8') > config.generation.maxWriteBytes) {
            return sendJson(400, { error: `content exceeds maxWriteBytes ${config.generation.maxWriteBytes}` })
          }
          const root = await rootFor(scope, lifecycle.signal)
          if (root === undefined) return sendJson(404, { error: `scope "${scope}" is not enabled` })
          if (root.access !== 'read-write') return sendJson(403, { error: `scope ${scope} is read-only` })
          try {
            await writeGuarded(ctx.get('fs'), joinRoot(root.path, safe), body.content, lifecycle.signal, memoryWritePolicy(root.path, config.writePolicy !== 'session'))
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
