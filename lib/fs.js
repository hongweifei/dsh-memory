/**
 * Guarded access to the composed filesystem.
 *
 * Every memory write goes through {@link writeGuarded}, which uses the harness's
 * own freshness intents rather than blind overwrites: `createIfAbsent` for a new
 * file and `replaceIfVersion` for an existing one, retrying once when the file
 * changed underneath us. The one delete ({@link deleteGuarded}) follows the same
 * discipline: the provider deletes it when it can, and otherwise the provider's
 * own `processPath` is what gets unlinked.
 *
 * @module @dsh-external/dsh-memory/fs
 */

import { unlink } from 'node:fs/promises'

/** How many times to retry a write that lost a freshness race. */
const MAX_WRITE_ATTEMPTS = 2

/** Freshness error codes that a retry can resolve. */
const RETRYABLE_CODES = new Set(['FS_STALE_VERSION', 'FS_NOT_OBSERVED'])

/**
 * The sandbox policy a capability call runs under on behalf of one session.
 *
 * `ctx.sandboxPolicy.resolve()` is the harness's own resolver: the deployment default, or —
 * when a session is passed — that session's own mode and immutable `SessionHeader.cwd`. The
 * harness's tools call it exactly this way (`resolve(exec.agent === undefined ? {} : { session:
 * exec.agent.session })`) and hand the result to `writeText`. This matters because the
 * sandboxed backend resolves the DEPLOYMENT DEFAULT for a call with no policy, and does not
 * go looking for a session on its own:
 *
 *     const policy = sandboxPolicy ?? this.ctx.sandboxPolicy.resolve();   // fs-sandbox
 *
 * So a plugin that omits the argument is fenced by the deployment default (this deployment:
 * `workspace-write`, rooted at the harness's own working directory) no matter what the
 * session was switched to — which is why a memory write was denied under `workspace-write`
 * while the session itself ran with full access: the session was never asked.
 *
 * @param ctx - plugin context.
 * @param session - the calling session, when one exists.
 * @returns the resolved policy, or `undefined` when the deployment has no policy service.
 */
export function sessionSandboxPolicy(ctx, session) {
  const service = ctx?.get?.('sandboxPolicy')
  if (typeof service?.resolve !== 'function') return undefined
  try {
    return session === undefined ? service.resolve({}) : service.resolve({ session })
  } catch {
    /* a resolver that cannot answer leaves the call to the deployment default */
    return undefined
  }
}

/**
 * The guard one memory mutation runs under: the policy to declare, and the mode a delete
 * must obey.
 *
 * Memory lives under `$DSH_HOME` — **outside every session workspace**, because the contract
 * says a project's memory must not sit in the project. The two configuration values are two
 * honest answers to that:
 *
 *   - `memory-root` (the default): the plugin declares the directory it is writing as its own
 *     `workspace-write` root. The write still never leaves that directory (our own path
 *     validation runs first), and it works under every session mode.
 *   - `session`: the plugin declares the *session's* resolved policy, so memory follows the
 *     same fence as the session's own tools and is read-only under `read-only` or
 *     `workspace-write`. With no session to ask, the deployment default applies.
 *
 * @param ctx - plugin context.
 * @param config - the resolved configuration.
 * @param session - the calling session, when one exists.
 * @param directory - the directory this mutation happens in (a root, or `$DSH_HOME` for the
 * plugin's own files such as the dream lock).
 * @returns `{ policy, fenceMode }` — the per-call policy to declare, and the mode a delete
 * must obey (`undefined` when the plugin's own `workspace-write` root is the only fence).
 */
export function memoryGuard(ctx, config, session, directory) {
  if (config.writePolicy === 'session') {
    const policy = sessionSandboxPolicy(ctx, session)
    // An unresolvable policy is the deployment default, which this deployment sets to
    // `workspace-write`: assuming the strict value is the safe direction for a refusal.
    return { policy, fenceMode: policy?.mode ?? 'workspace-write' }
  }
  return {
    policy:
      typeof directory === 'string' && directory.length > 0
        ? { mode: 'workspace-write', workspaceRoot: directory }
        : undefined,
    fenceMode: undefined,
  }
}

/**
 * Read a memory file.
 *
 * @param fs - the composed filesystem.
 * @param absolutePath - the file to read.
 * @param signal - cancellation.
 * @returns `{ target, info, text }`, or `undefined` when absent.
 */
export async function readIfPresent(fs, absolutePath, signal) {
  const target = await fs.resolve(absolutePath, { signal })
  const info = await fs.stat(target, signal)
  if (info === undefined || info.type !== 'file') return undefined
  return { target, info, text: await fs.readText(target, signal) }
}

/**
 * Read a memory file, reusing a previously read body when its version is unchanged.
 *
 * Qoder's instruction loader keeps `InstructionVersionState { path, version,
 * digest, trimmedDigest }` and skips the read when the version matches; its
 * auto-memory manager keeps `loadedFileIdentities` the same way. The Harness
 * `fs` provider hands back an `FsVersion` on every `stat`, so the same fast path
 * is available here: memory is re-projected on every agent step, and a session
 * with dozens of steps should not re-read unchanged files dozens of times.
 *
 * @param fs - the composed filesystem.
 * @param absolutePath - the file to read.
 * @param cache - `Map<path, { version, text }>`, updated in place; optional.
 * @param signal - cancellation.
 * @returns `{ target, info, text, cached }`, or `undefined` when absent.
 */
export async function readVersioned(fs, absolutePath, cache, signal) {
  const target = await fs.resolve(absolutePath, { signal })
  const info = await fs.stat(target, signal)
  if (info === undefined || info.type !== 'file') return undefined
  const key = String(absolutePath)
  const known = cache === undefined || cache === null ? undefined : cache.get(key)
  if (known !== undefined && known.version !== undefined && known.version === info.version) {
    return { target, info, text: known.text, cached: true }
  }
  const text = await fs.readText(target, signal)
  if (cache !== undefined && cache !== null && info.version !== undefined) {
    cache.set(key, { version: info.version, text })
  }
  return { target, info, text, cached: false }
}

/**
 * Delete one file, preferring the provider's own delete.
 *
 * The Harness `fs` service declares no delete, and reaching around it with
 * `node:fs` is normally the wrong move because it skips whatever the provider
 * enforces. Two facts make a correct delete possible anyway:
 *
 *   1. A provider may still offer one (`remove`); when it does, it is used and
 *      nothing at all is bypassed.
 *   2. `processPath(target)` exists precisely so a resolved target can be handed
 *      to another OS capability — the base class documents it as "the canonical
 *      absolute path a subprocess in this filesystem's execution world can open".
 *
 * So the fallback is not a workaround around the provider: it asks the provider
 * for the path and then deletes that. What it *cannot* honour is a confining
 * backend's interception of this call, because the plugin does not run inside
 * that interception — so a backend that declares itself read-only is refused
 * outright rather than quietly disobeyed.
 *
 * @param fs - the composed filesystem.
 * @param absolutePath - the file to delete.
 * @param expectedVersion - the `FsVersion` the caller saw, if it read the file.
 * @param signal - cancellation.
 * @param fenceMode - the sandbox mode this delete must obey, when the configuration follows
 * the session (`memoryGuard` supplies it); `undefined` when the plugin's own memory root is
 * the declared workspace.
 * @returns `{ deleted }`, `{ missing: true }`, or `{ error }`.
 */
export async function deleteGuarded(fs, absolutePath, expectedVersion, signal, fenceMode) {
  const target = await fs.resolve(absolutePath, { signal })
  const info = await fs.stat(target, signal)
  if (info === undefined || info.type !== 'file') return { missing: true }
  // Delete the file the caller decided about, not whatever replaced it since.
  if (expectedVersion !== undefined && info.version !== undefined && info.version !== expectedVersion) {
    return { error: 'the file changed since it was read' }
  }
  if (typeof fs.remove === 'function') {
    await fs.remove(target, signal)
    return { deleted: true, via: 'provider' }
  }
  if (fs.sandboxMode === 'read-only') return { error: 'the filesystem is read-only' }
  // The provider's own removal is fenced by this call's policy; an unlink through
  // `processPath` is NOT. Following the session means refusing this one instead of reaching
  // around a fence the session asked for.
  if (fenceMode !== undefined && fenceMode !== 'danger-full-access') {
    return { error: `the session sandbox policy (${fenceMode}) does not allow deleting outside its workspace` }
  }
  const hostPath = typeof fs.processPath === 'function' ? fs.processPath(target) : undefined
  if (typeof hostPath !== 'string' || hostPath.length === 0) {
    return { error: 'the filesystem exposes no path to delete' }
  }
  await unlink(hostPath)
  return { deleted: true, via: 'node:fs' }
}

/**
 * List the `*.md` files in one root, index file first.
 *
 * @param fs - the composed filesystem.
 * @param root - the root to list.
 * @param signal - cancellation.
 * @param sizes - when given, filled with `name → bytes` from the same listing (the panel's
 * scope rows show how much memory a scope holds; the entries already carry the size, so
 * this costs nothing extra).
 * @returns file names in load order.
 */
export async function listRootFiles(fs, root, signal, sizes) {
  const target = await fs.resolve(root.path, { signal })
  const info = await fs.stat(target, signal)
  if (info === undefined || info.type !== 'directory') return []
  const entries = await fs.listDir(target, signal)
  const files = entries
    .filter(
      (entry) =>
        entry.type === 'file' &&
        entry.name.toLowerCase().endsWith('.md') &&
        // Hidden files are never memory content (qodercli skips them too), and a
        // nested directory of notes is not part of the root's flat file set.
        !entry.name.startsWith('.'),
    )
    .map((entry) => entry.name)
    .sort()
  if (sizes !== undefined) {
    for (const entry of entries) {
      if (typeof entry.size === 'number') sizes.set(entry.name, entry.size)
    }
  }
  // The declared index file leads, so a root's own summary is injected first.
  if (root.indexFile !== undefined && files.includes(root.indexFile)) {
    return [root.indexFile, ...files.filter((candidate) => candidate !== root.indexFile)]
  }
  return files
}

/**
 * Write one file under a freshness guard, retrying once on a stale version.
 *
 * @param fs - the composed filesystem.
 * @param absolutePath - the file to write.
 * @param content - the full new content.
 * @param signal - cancellation.
 * @throws the underlying filesystem error when the retry also fails.
 */
export async function writeGuarded(fs, absolutePath, content, signal, policy) {
  for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt += 1) {
    const target = await fs.resolve(absolutePath, { signal })
    const info = await fs.stat(target, signal)
    try {
      if (info === undefined) return await fs.writeText(target, content, { kind: 'createIfAbsent' }, signal, policy)
      return await fs.writeText(target, content, { kind: 'replaceIfVersion', version: info.version }, signal, policy)
    } catch (error) {
      const code = error !== null && typeof error === 'object' ? error.code : undefined
      if (attempt === 0 && RETRYABLE_CODES.has(code)) continue
      throw error
    }
  }
  return undefined
}
