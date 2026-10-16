/**
 * The environment overrides, with Qoder's own names and vocabulary.
 *
 * Decoded from the installed `qodercli`, where the names are built by prefixing
 * the brand (`Pr(name) => `${prefix}${name}``):
 *
 * ```js
 * function DZe(name) {                       // the boolean vocabulary
 *   const value = process.env[name]?.trim().toLowerCase()
 *   if (value !== undefined && value !== '') {
 *     if (value === '1' || value === 'true' || value === 'yes' || value === 'on') return true
 *     if (value === '0' || value === 'false' || value === 'no' || value === 'off') return false
 *   }
 * }
 * lvt = Pr('MEMORY_HEADLESS'); uvt = Pr('MEMORY_PROJECT'); dvt = Pr('MEMORY_USER'); gvt = Pr('DREAM')
 * ```
 *
 * and where the headless gate is what lets the non-interactive path run at all:
 *
 * ```js
 * isAutoMemoryEnabled() {
 *   …
 *   if (!this.interactive && !lRe()) return false
 *   if (!this.interactive) { const project = yZe() ?? true, user = PZe() ?? true; return project || user }
 *   …
 * }
 * ```
 *
 * The port keeps the names' shape (`DSH_` instead of the `QODER_` brand prefix)
 * and the vocabulary exactly, and maps the gate onto `Config.enabled`, because here
 * the plugin *is* the memory implementation rather than a settings surface beside it
 * — see the README's divergence table.
 *
 * This lives in its own module, below the schema, because BOTH the schema's resolver
 * and the status payload read the same four names: a second copy of `DSH_MEMORY_*`
 * would be a second answer to "which environment wins".
 *
 * @module @dsh-external/dsh-memory/env
 */

/** The four environment variables, by the knob they override. */
export const ENV_KEYS = Object.freeze({
  headless: 'DSH_MEMORY_HEADLESS',
  project: 'DSH_MEMORY_PROJECT',
  user: 'DSH_MEMORY_USER',
  dream: 'DSH_MEMORY_DREAM',
})

/**
 * Read one boolean environment override, using Qoder's vocabulary.
 *
 * @param env - the environment mapping to read.
 * @param name - the variable name.
 * @returns `true`, `false`, or `undefined` when unset or unrecognized.
 */
export function readBooleanEnv(env, name) {
  const raw = env === undefined || env === null ? undefined : env[name]
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : undefined
  if (value === undefined || value === '') return undefined
  if (value === '1' || value === 'true' || value === 'yes' || value === 'on') return true
  if (value === '0' || value === 'false' || value === 'no' || value === 'off') return false
  return undefined
}

/**
 * Apply the environment overrides to a resolved configuration.
 *
 * Precedence is "environment wins", which is Qoder's: its headless path reads
 * these in place of the settings. Only these four knobs are reachable from the
 * environment; nothing else about the configuration can be changed this way.
 *
 * @param config - a configuration with every field populated.
 * @param env - the environment mapping; defaults to the process environment.
 * @returns the configuration with the overrides applied.
 */
export function applyEnvironmentOverrides(config, env = process.env) {
  const headless = readBooleanEnv(env, ENV_KEYS.headless)
  const project = readBooleanEnv(env, ENV_KEYS.project)
  const user = readBooleanEnv(env, ENV_KEYS.user)
  const dream = readBooleanEnv(env, ENV_KEYS.dream)
  return {
    ...config,
    // The gate is a precondition in Qoder; here it is the plugin's own switch.
    ...(headless === false ? { enabled: false } : {}),
    ...(user === undefined ? {} : { userScope: user }),
    ...(project === undefined ? {} : { projectScope: project }),
    generation: {
      ...config.generation,
      ...(dream === undefined ? {} : { dream: { ...config.generation.dream, enabled: dream } }),
    },
  }
}
