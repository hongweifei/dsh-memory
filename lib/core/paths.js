/**
 * Memory paths: where memory lives, and how a file inside a root is named.
 *
 * Two rules shape everything here:
 *   - a memory file is always a relative `.md` path that stays INSIDE its root;
 *   - the built-in roots follow DeepSeek Harness's own layout for per-project
 *     data, not Qoder's (see {@link projectKey}): *
 *       <DSH_HOME>/memory                        user scope (cross-project)
 *       <DSH_HOME>/projects/<projectKey>/memory  project scope
 *
 *     Both scopes live under ONE harness root, and the project directory name is
 *     the SAME name the harness itself uses for that project's sessions, so a
 *     user browsing `$DSH_HOME` sees one project spelled one way.
 *
 * @module @dsh-external/dsh-memory/paths
 */

import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { MEMORY_INDEX_FILE } from './constants.js'

/** How far up the tree a configured root-marker search will walk. */
const MAX_ROOT_SEARCH_DEPTH = 64

export { MEMORY_INDEX_FILE }

/** Resolve the harness home directory, matching dsh-home-paths. */
export function resolveDshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv
  return join(homedir(), '.dsh')
}

/**
 * Encode one directory as the harness encodes a project directory.
 *
 * This is `projectKey` from `dsh-session-persistence-jsonl` verbatim: `\`, `/`
 * and `:` collapse to a single `-` per run; `[A-Za-z0-9._-]` is kept; every
 * other character (including `~`, which is the escape lead) becomes `~` plus
 * four uppercase hex digits; leading dashes are stripped; the result is capped
 * at 251 characters and wrapped in `--`. An empty path becomes `root`, and
 * `undefined` becomes the harness's own `_no-cwd` marker at the directory level.
 *
 * The harness documents its own choice as "lossy, following the common
 * human-navigable project-directory convention" — and it is still strictly
 * better than Qoder's `[^a-zA-Z0-9] -> '-'`, which cannot tell `D:\a-b` from
 * `D:\a\b`.
 *
 * @param cwd - the project directory.
 * @returns one filesystem-safe directory name.
 */
export function projectKey(cwd) {
  const text = String(cwd ?? '')
  if (text.length === 0) throw new Error('cannot encode an empty project path')
  let readable = ''
  let separatorRun = false
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    const character = String.fromCharCode(code)
    if (character === '/' || character === '\\' || character === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else if (character !== '~' && /^[A-Za-z0-9._-]$/.test(character)) {
      readable += character
      separatorRun = false
    } else {
      readable += `~${code.toString(16).toUpperCase().padStart(4, '0')}`
      separatorRun = false
    }
  }
  return `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`
}

/**
 * The user-scope memory directory: one directory shared by every project.
 *
 * @returns the absolute path.
 */
export function userMemoryDir() {
  return join(resolveDshHome(), 'memory')
}

/**
 * The project-scope memory directory for one project directory.
 *
 * @param projectPath - a canonical project directory (see {@link resolveProjectIdentity}).
 * @returns the absolute path under the harness home.
 */
export function projectMemoryDir(projectPath) {
  return join(resolveDshHome(), 'projects', projectKey(projectPath), 'memory')
}

/**
 * Accept only relative `.md` paths that stay inside a root.
 *
 * @param path - untrusted model- or caller-supplied path.
 * @returns the normalized forward-slash path, or `undefined` when unsafe.
 */
export function safeRelativePath(path) {
  if (typeof path !== 'string' || path.length === 0) return undefined
  if (isAbsolute(path)) return undefined
  const segments = path.split(/[\\/]+/).filter((segment) => segment.length > 0)
  if (segments.length === 0) return undefined
  if (segments.some((segment) => segment === '.' || segment === '..')) return undefined
  const joined = segments.join('/')
  if (!joined.toLowerCase().endsWith('.md')) return undefined
  return joined
}

/**
 * Join a validated relative memory path onto a root directory.
 *
 * @param rootPath - the root directory.
 * @param relativePath - a path already accepted by {@link safeRelativePath}.
 * @returns the absolute path inside the root.
 */
export function joinRoot(rootPath, relativePath) {
  return join(rootPath, ...relativePath.split('/'))
}

/** Windows compares paths case-insensitively; other platforms do not. */
const CASE_INSENSITIVE = process.platform === 'win32'

/**
 * Resolve a directory to an absolute, comparison-stable form.
 *
 * @param folder - a configured directory.
 * @param cwd - the base for a relative entry.
 * @returns the normalized path.
 */
export function normalizeFolder(folder, cwd = process.cwd()) {
  const raw = String(folder)
  const absolute = resolve(isAbsolute(raw) ? raw : resolve(cwd, raw))
  return CASE_INSENSITIVE ? absolute.toLowerCase() : absolute
}

/**
 * Whether `folder` is `outerDir` itself or lies inside it.
 *
 * Containment, not equality: trusting a repository trusts the packages inside
 * it, and an import from a file inside a memory root stays inside that root.
 *
 * @param outerDir - the containing directory.
 * @param folder - the path being asked about.
 * @param cwd - the base for a relative entry.
 * @returns `true` when the folder is covered.
 */
export function folderContains(outerDir, folder, cwd = process.cwd()) {
  const outer = normalizeFolder(outerDir, cwd)
  const inner = normalizeFolder(folder, cwd)
  if (outer === inner) return true
  const rest = relative(outer, inner)
  return rest.length > 0 && !rest.startsWith('..') && !isAbsolute(rest)
}

/**
 * Ask the provider for a directory's canonical spelling.
 *
 * The harness's own uniqueness canon for a project is `fs.realpath` of its
 * directory — "trailing slashes, `..` segments, and symlinks are all resolved".
 * `ctx.fs.processPath` is the provider's canonical absolute path, so two
 * spellings of one directory produce ONE project.
 *
 * @param fs - the composed filesystem service.
 * @param directory - the directory to canonicalize.
 * @param signal - cancellation.
 * @returns the canonical path, falling back to the resolved input.
 */
async function canonicalDirectory(fs, directory, signal) {
  const fallback = resolve(directory)
  try {
    const target = await fs.resolve(fallback, { signal })
    if (typeof fs.processPath !== 'function') return fallback
    const canonical = fs.processPath(target)
    return typeof canonical === 'string' && canonical.length > 0 ? canonical : fallback
  } catch {
    return fallback
  }
}

/**
 * Walk up from `cwd` to the first directory containing one of `markers`.
 *
 * The walk exists to support the OPT-IN `projectRootMarkers` setting, which
 * mirrors the harness's own instruction-discovery vocabulary: with markers
 * configured, one repository shares one memory scope; with none (the default),
 * the session's own directory is the project, exactly as the harness groups
 * sessions and owns workspaces.
 *
 * @param fs - the composed filesystem service.
 * @param cwd - the session working directory.
 * @param markers - directory entries that identify a project root.
 * @param signal - cancellation.
 * @returns the project root, falling back to `cwd`.
 */
async function findMarkerRoot(fs, cwd, markers, signal) {
  let current = resolve(cwd)
  for (let depth = 0; depth < MAX_ROOT_SEARCH_DEPTH; depth += 1) {
    for (const marker of markers) {
      const info = await fs.stat(await fs.resolve(join(current, marker), { signal }), signal).catch(() => undefined)
      if (info !== undefined) return current
    }
    const parent = dirname(current)
    if (parent === current) return resolve(cwd)
    current = parent
  }
  return resolve(cwd)
}

/**
 * The harness Workspace that owns a directory, when the registry is mounted.
 *
 * A Workspace is the harness's own project record: a generated uuid id over a
 * canonical `fs.realpath` path, deliberately NOT keyed by the path because
 * "path normalization rewrites paths, and a reference anchor must stay stable".
 * Resolving it gives the canonical path for free and lets memory report which
 * harness project it belongs to.
 *
 * @param ctx - plugin context.
 * @param cwd - the session working directory.
 * @returns `{ id, path, title? }`, or `undefined` when unavailable or unowned.
 */
export async function resolveWorkspace(ctx, cwd) {
  const registry = typeof ctx.get === 'function' ? ctx.get('workspaceRegistry') : undefined
  if (registry === undefined || typeof registry.resolveByPath !== 'function') return undefined
  try {
    const workspace = await registry.resolveByPath(resolve(cwd))
    if (workspace === undefined || workspace === null) return undefined
    return {
      id: String(workspace.id),
      path: String(workspace.path),
      title: typeof workspace.title === 'string' ? workspace.title : undefined,
    }
  } catch {
    return undefined
  }
}

/**
 * Every known Workspace, keyed by the `projectKey` its path produces.
 *
 * A project scope is addressed by slug, and a slug cannot be decoded back into a path —
 * but the registry holds the real paths, so keying FORWARD turns
 * `--D-Projects-EasyGit--` into the name a person recognises ("EasyGit"). This is the one
 * direction that works, and it is why the panel can label a scope without guessing.
 *
 * @param ctx - plugin context.
 * @returns a Map of slug → `{ id, path, title }`; empty when no registry is mounted.
 */
export async function workspaceIndex(ctx) {
  const index = new Map()
  const registry = typeof ctx.get === 'function' ? ctx.get('workspaceRegistry') : undefined
  if (registry === undefined || typeof registry.list !== 'function') return index
  try {
    for (const workspace of (await registry.list()) ?? []) {
      if (workspace === null || typeof workspace !== 'object' || typeof workspace.path !== 'string') continue
      index.set(projectKey(workspace.path), {
        id: workspace.id === undefined ? undefined : String(workspace.id),
        path: workspace.path,
        title: typeof workspace.title === 'string' && workspace.title.length > 0 ? workspace.title : undefined,
      })
    }
  } catch {
    /* A registry that cannot be read simply yields no names; the slug stays the label. */
  }
  return index
}

/**
 * Resolve the project identity memory is scoped to.
 *
 * The path is the harness's project directory for this session — the Workspace
 * path when the registry knows it, otherwise the canonical session cwd. With
 * `projectRootMarkers` configured the identity moves up to the marker root
 * first, which is the opt-in way to make one repository share one memory scope.
 *
 * @param ctx - plugin context.
 * @param cwd - the session working directory.
 * @param markers - configured `projectRootMarkers`; empty means "cwd is the project".
 * @param signal - cancellation.
 * @returns `{ path, key, workspaceId? }`.
 */
export async function resolveProjectIdentity(ctx, cwd, markers, signal) {
  const fs = ctx.get('fs')
  const workspace = await resolveWorkspace(ctx, cwd)
  const configured = Array.isArray(markers) ? markers.filter((marker) => typeof marker === 'string' && marker.length > 0) : []

  let path
  if (configured.length > 0) {
    path = await canonicalDirectory(fs, await findMarkerRoot(fs, cwd, configured, signal), signal)
  } else if (workspace !== undefined) {
    path = await canonicalDirectory(fs, workspace.path, signal)
  } else {
    path = await canonicalDirectory(fs, cwd, signal)
  }
  return { path, key: projectKey(path), workspaceId: workspace?.id }
}

/**
 * Resolve the effective roots.
 *
 * In `custom` mode an explicit `generation.roots` list replaces the built-in
 * user/project roots; otherwise the built-ins follow their scope toggles.
 *
 * @param ctx - plugin context, used for `fs`.
 * @param config - the resolved configuration.
 * @param customRoots - the validated `generation.roots` list.
 * @param cwd - the session working directory.
 * @param signal - cancellation.
 * @returns the roots in load order.
 */
export async function resolveRoots(ctx, config, customRoots, cwd, signal) {
  if (config.mode === 'custom' && customRoots.length > 0) {
    return customRoots.map((root) => ({
      id: String(root.id),
      path: isAbsolute(String(root.path)) ? String(root.path) : resolve(cwd, String(root.path)),
      access: root.access === 'read' ? 'read' : 'read-write',
      indexFile: typeof root.indexFile === 'string' && root.indexFile.length > 0 ? root.indexFile : undefined,
    }))
  }
  const roots = []
  if (config.userScope) {
    roots.push({ id: 'user', path: userMemoryDir(), access: 'read-write', indexFile: MEMORY_INDEX_FILE })
  }
  if (config.projectScope) {
    const identity = await resolveProjectIdentity(ctx, cwd, config.projectRootMarkers, signal)
    roots.push({
      id: 'project',
      path: projectMemoryDir(identity.path),
      access: 'read-write',
      indexFile: MEMORY_INDEX_FILE,
      // The directory the trust gate asks about, and an identity the panel and
      // `/memory` can show.
      projectRoot: identity.path,
      projectKey: identity.key,
      workspaceId: identity.workspaceId,
    })
  }
  return roots
}
