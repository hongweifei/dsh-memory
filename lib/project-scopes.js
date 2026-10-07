/**
 * Addressing projects by slug: which memory roots the panel may browse.
 *
 * The panel is GLOBAL settings, so it must be able to speak about a project other than
 * whichever session happens to be active — and the only name available for one is the
 * harness's own `projectKey` directory name under `<DSH_HOME>/projects`.
 *
 * That name is LOSSY: a slug cannot be decoded back into a path. It needs no decoding to be
 * *used* through the plugin's own addressing, which is why this works at all, and the strict
 * shape below is what keeps it from addressing an arbitrary path.
 *
 * Split out of `routes.js` when the route table outgrew its 500-line budget: this is the one
 * part of it that computes rather than serves, so it is the part that can stand alone.
 *
 * @module @dsh-external/dsh-memory/project-scopes
 */

import { basename, dirname, join } from 'node:path'
import { resolveDshHome } from './paths.js'

/**
 * The `<DSH_HOME>/projects` directory: one child per project, each with a `memory` directory.
 * Names are the harness's own `projectKey` slugs.
 */
export function projectsRoot() {
  return join(resolveDshHome(), 'projects')
}

/** Exactly what `projectKey` produces, so a slug cannot address anything else. */
const PROJECT_SLUG = /^--[A-Za-z0-9._~-]{1,251}--$/

/**
 * One project's memory root, addressed by its directory name.
 *
 * @param slug - a projectKey-shaped directory name.
 * @returns a root record, or `undefined` when the name is not one.
 */
export function projectRoot(slug) {
  if (typeof slug !== 'string' || !PROJECT_SLUG.test(slug)) return undefined
  return { id: slug, path: join(projectsRoot(), slug, 'memory'), access: 'read-write', indexFile: 'MEMORY.md' }
}

/** The slug of the project root a session resolved to, for comparison. */
export function slugOf(root) {
  return root === undefined ? undefined : basename(dirname(root.path))
}

/**
 * A human byte size for a scope row: `1.2 KB`, `18 B`.
 *
 * @param bytes - the total, already summed by the listing.
 * @returns the formatted size.
 */
export function describeBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  if (bytes < 1024) return `${bytes} B`
  return `${(bytes / 1024).toFixed(1)} KB`
}

/**
 * Every project the panel may browse: the current session's project, then every project that
 * already has a memory directory.
 *
 * With the trust gate on, only the current session's project is offered: a slug cannot be
 * turned back into a folder, so trust cannot be evaluated for the others, and listing memory
 * the gate would refuse to load is worse than not listing it.
 *
 * @param ctx - plugin context.
 * @param config - the resolved configuration.
 * @param current - the current session's project root, when it resolves.
 * @param signal - cancellation.
 * @returns root records, the session's own project first.
 */
export async function browsableProjects(ctx, config, current, signal) {
  // The session's project is addressed by its slug too, so one select value space covers
  // everything the panel can browse.
  const currentSlug = slugOf(current)
  const own = currentSlug === undefined ? undefined : { ...projectRoot(currentSlug), access: current.access }
  const found = []
  // With the gate ON the scan is skipped entirely: a slug cannot be turned back into a folder
  // to evaluate trust for, and letting the panel edit memory the gate refuses to load is a
  // hole. Only the session's own project is offered, and `resolveEffectiveRoots` already
  // decided whether it may be.
  if (config.trust?.enabled !== true) {
    try {
      const target = await ctx.get('fs').resolve(projectsRoot(), { signal })
      const entries = await ctx.get('fs').listDir(target, { signal })
      for (const entry of entries) {
        // The slug shape is the whole test that matters: `listRootFiles` decides whether it
        // actually holds memory, so a provider that omits entry types still lists everything.
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
