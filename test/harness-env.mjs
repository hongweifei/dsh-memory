/**
 * Where the harness and this plugin live — discovered, never hardcoded.
 *
 * The harness exports `DSH_HOME`, `DSH_PROFILE` and `DSH_PROFILE_DIR` into every session,
 * so the packaging checks and the theme oracle can resolve packages exactly the way the
 * Loader does without naming anybody's home directory. Outside a harness session there is
 * no installation to check against: these helpers return `undefined` and the tests that
 * need one report themselves as skipped rather than failing on a path that exists on
 * exactly one machine.
 *
 * Run from a checkout: `node test/<name>.test.mjs`.
 */
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** This checkout's root (the directory holding `package.json`). */
export const checkoutRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

/** The harness home, by the harness's own rule: `$DSH_HOME`, else `<home>/.dsh`. */
export const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')

/** The directory of the profile this session runs in, when a session exists. */
export const profileDir = process.env.DSH_PROFILE_DIR ?? undefined

/** The manifest of that profile, when there is one. */
export const profilePackageJson = profileDir === undefined ? undefined : join(profileDir, 'package.json')

/**
 * A `require` anchored in the profile, so resolution walks the same chain the Loader does.
 *
 * @returns the anchored require, or `undefined` outside a harness session.
 */
export function installRequire() {
  if (profileDir === undefined || !existsSync(profileDir)) return undefined
  return createRequire(join(profileDir, 'package.json'))
}

/**
 * Resolve a package as installed, when an installation exists.
 *
 * @param specifier - anything `require.resolve` accepts.
 * @returns the resolved path, or `undefined` when it is not installed here.
 */
export function resolveInstalled(specifier) {
  const require = installRequire()
  if (require === undefined) return undefined
  try {
    return require.resolve(specifier)
  } catch {
    return undefined
  }
}

/**
 * This package's manifest: through the installation when there is one, else the checkout.
 *
 * @returns the absolute path of the plugin's `package.json`.
 */
export function packageJsonPath() {
  return resolveInstalled('@dsh-external/dsh-memory/package.json') ?? join(checkoutRoot, 'package.json')
}

/**
 * The harness that is actually RUNNING, when it can be found.
 *
 * A desktop install bundles the harness into one `app.asar`, so the profile's Node
 * resolution can keep pointing at an older npm install while the app runs something else
 * — which is exactly how a version bump slips past a green suite (verified the hard way:
 * the suite checked 0.1.7-rc.2 while the desktop app ran 0.2.0-rc.2). A check that can
 * look at the running bundle should, and say which oracle it used.
 *
 * @returns the bundle path, or `undefined` when no desktop bundle is installed.
 */
export function runningHarnessBundle() {
  const candidates = [
    process.env.DSH_HARNESS_BUNDLE,
    process.env.LOCALAPPDATA === undefined
      ? undefined
      : join(process.env.LOCALAPPDATA, 'Programs', 'DeepSeek Harness', 'resources', 'app.asar'),
    join(homedir(), 'Applications', 'DeepSeek Harness.app', 'Contents', 'Resources', 'app.asar'),
  ]
  for (const candidate of candidates) {
    if (candidate !== undefined && existsSync(candidate)) return candidate
  }
  return undefined
}
