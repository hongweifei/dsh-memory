/**
 * Configuration: the Loader-facing schema, the SDK's option rules, and the plugin's own defaults —
 * one subject, in this order: `Config` (the schema the Loader validates and the Config inspector
 * projects), then `resolveMemoryConfig` (the plugin's defaults, applied to the sparse validated
 * config).
 *
 * `validateMemoryConfig` lives in `config-rules.js` rather than here. The write path also needs it,
 * to refuse a configuration before persisting it, and that path sits above this module in the
 * layering — so the rules live in their own leaf module and both read them from there. Two copies of
 * a rule is how a control comes to offer a value the plugin then rejects.
 *
 * @module @dsh-external/dsh-memory/config
 */

import { isAbsolute } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { CONSUMPTION_MIN_TOKENS } from '../core/constants.js'

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
 * and the vocabulary exactly, and maps the gate onto {@link Config.enabled},
 * because here the plugin *is* the memory implementation rather than a settings
 * surface beside it — see the README's divergence table.
 */
export const ENV_KEYS = Object.freeze({
  headless: 'DSH_MEMORY_HEADLESS',
  project: 'DSH_MEMORY_PROJECT',
  user: 'DSH_MEMORY_USER',
  dream: 'DSH_MEMORY_DREAM',
})

/** Defaults for the generation half. */
export const GENERATION_DEFAULTS = {
  enabled: true,
  // 0 = no cap: the adapter's default for the model applies (see the README §3 note).
  maxOutputTokens: 0,
  // Consecutive failed passes before a session's generation pauses (Qoder's `hFl = 3`);
  // 0 keeps retrying forever. See `lib/memory/failure-pause.js`.
  pauseAfterFailures: 3,
  provider: '',
  model: '',
  prompt: '',
}

/** Defaults for the per-turn automatic trigger. */
const TURN_COMPLETE_DEFAULTS = {
  enabled: true,
  minPromptChars: 40,
  timeoutMs: 10000,
  onGateError: 'skip',
}

/** Qoder's `extractionEveryNTurns`, normalized to one pass per turn by default. */
export const INCREMENTAL_DEFAULTS = {
  everyTurns: 1,
  /**
   * Also generate *during* a long turn, once per step that produced new messages.
   * Off by default: Qoder keeps its in-turn variant behind an experiment flag
   * (`auto_memory_incremental_generation`), and it spends model calls inside turns
   * that used to be free.
   */
  midTurn: false,
}
/**
 * Defaults for the consumption half.
 *
 * `maxTokens` is deliberately ABSENT, and that absence is the point: Qoder's own
 * default is NO LIMIT — its loader computes `maxTokens ?? Number.POSITIVE_INFINITY`
 * — so a budget exists only once an operator sets one. Do not "helpfully" fill in a
 * number here: it would silently cap a port that is supposed to behave like the
 * original, and it would be a value Qoder never has (the 2000 this port shipped was
 * exactly that mistake.
 */
export const CONSUMPTION_DEFAULTS = {
  enabled: true,
  overflow: 'truncate',
  failureMode: 'best_effort',
}

/**
 * Defaults for the dream (consolidation) pass.
 *
 * Off by default: it costs an extra model call, so enabling it is a deliberate
 * choice, which is why Qoder gates its own AutoDream behind a rollout flag too.
 */
export const DREAM_DEFAULTS = {
  enabled: false,
  minHours: 24,
}

/**
 * Defaults for the daily journal.
 *
 * Off, and for the same reason as the dream pass: it is a deliberate choice to spend the extra write.
 * Unlike dream it needs no scheduler — it rides along with the generation pass that is already
 * running, which is exactly what Qoder's "after the memory review above" says.
 *
 * The scope defaults to `project`: a journal is about the work done in one workspace, and a user-scope
 * journal would interleave every project's days into one file.
 */
export const JOURNAL_DEFAULTS = {
  enabled: false,
  scope: 'project',
}

/**
 * Defaults for the folder-trust gate.
 *
 * Qoder's constructor reads `this.folderTrust = A.folderTrust ?? false` and its
 * predicate is `isTrustedFolder() { return !this.folderTrust || (this.trustedFolder ?? false) }`
 * — so the switch defaults to OFF, and while it is off every folder counts as
 * trusted. Making it ON is what turns project-scope memory into something that
 * must be granted per folder.
 */
export const TRUST_DEFAULTS = {
  enabled: false,
  folders: [],
}

/**
 * Defaults for `@`-import expansion.
 *
 * Qoder's loader takes `importFormat` (default `'tree'`), an internal
 * `maxDepth: 5`, and an approval predicate `isExternalImportApproved() ||
 * sessionExternalImportApproved`. The settings behind that predicate are
 * "Automatically approve all external @import references … even when they point
 * outside the project root" and "Approved External Import Projects" — mirrored
 * here as `allowExternal` and `approvedProjects`.
 */
export const IMPORTS_DEFAULTS = {
  enabled: true,
  format: 'tree',
  maxDepth: 5,
  allowExternal: false,
  approvedProjects: [],
}

/**
 * Defaults for the load-exclusion patterns.
 *
 * Corresponds to Qoder's `agentsMdExcludes` SETTING (not an SDK option), which
 * is why it is a top-level key here: the SDK's `native` mode rule allows only
 * the two `onResult` callbacks inside the `generation` / `consumption` blocks,
 * and a top-level switch is the same shape as `userScope` / `projectScope`.
 */
export const EXCLUDES_DEFAULT = []

/**
 * Defaults for project identity.
 *
 * EMPTY is the DeepSeek Harness's own answer: a session's project is its working
 * directory, canonicalized — that is how the harness groups sessions under
 * project directories and how a Workspace owns a directory. Setting markers
 * (e.g. `['.git']`) instead makes one repository share ONE memory scope, using
 * the same marker vocabulary the harness's own instruction loader uses.
 */
export const PROJECT_ROOT_MARKERS_DEFAULT = []

/**
 * Custom roots mirror the SDK's `validateRoots`: a non-empty array, unique ids,
 * and an `indexFile` that stays inside its root. Validated here rather than in
 * the schema because schemastery's array refinements cannot express cross-field
 * uniqueness, and the SDK rejects these at option-preparation time.
 *
 * @param roots - untrusted `generation.roots`.
 * @returns the same list, or `[]` when omitted.
 * @throws when a root is malformed, duplicated, or escapes its root.
 */
export function validateRoots(roots) {
  if (roots === undefined) return []
  if (!Array.isArray(roots) || roots.length === 0) {
    throw new Error('memory: generation.roots must be a non-empty array')
  }
  const seen = new Set()
  for (const [index, root] of roots.entries()) {
    if (root === null || typeof root !== 'object') {
      throw new Error(`memory: generation.roots[${index}] must be an object`)
    }
    if (typeof root.id !== 'string' || root.id.trim().length === 0) {
      throw new Error(`memory: generation.roots[${index}].id must be a non-empty string`)
    }
    if (typeof root.path !== 'string' || root.path.trim().length === 0) {
      throw new Error(`memory: generation.roots[${index}].path must be a non-empty string`)
    }
    if (seen.has(root.id)) {
      throw new Error(`memory: generation.roots contains duplicate id "${root.id}"`)
    }
    seen.add(root.id)
    if (root.indexFile !== undefined) {
      if (typeof root.indexFile !== 'string' || root.indexFile.trim().length === 0) {
        throw new Error(`memory: generation.roots[${index}].indexFile must be a non-empty string`)
      }
      // Must stay within its root: no absolute path, no parent traversal.
      const normalized = root.indexFile.replaceAll('\\', '/')
      if (isAbsolute(root.indexFile) || normalized.split('/').includes('..')) {
        throw new Error(`memory: generation.roots[${index}].indexFile must stay within its root`)
      }
    }
  }
  return roots
}

/**
 * Explicit consumption files mirror the SDK's `validateConsumptionFiles`.
 *
 * @param files - untrusted `consumption.files`.
 * @returns the normalized list with `required` defaulted, or `undefined`.
 * @throws when the list is empty or a file is malformed or duplicated.
 */
export function validateConsumptionFiles(files) {
  if (files === undefined) return undefined
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error('memory: consumption.files must be a non-empty array')
  }
  const seen = new Set()
  for (const [index, file] of files.entries()) {
    if (file === null || typeof file !== 'object') {
      throw new Error(`memory: consumption.files[${index}] must be an object`)
    }
    if (typeof file.id !== 'string' || file.id.trim().length === 0) {
      throw new Error(`memory: consumption.files[${index}].id must be a non-empty string`)
    }
    if (typeof file.path !== 'string' || file.path.trim().length === 0) {
      throw new Error(`memory: consumption.files[${index}].path must be a non-empty string`)
    }
    if (seen.has(file.id)) {
      throw new Error(`memory: consumption.files contains duplicate id "${file.id}"`)
    }
    seen.add(file.id)
    if (file.required !== undefined && typeof file.required !== 'boolean') {
      throw new Error(`memory: consumption.files[${index}].required must be a boolean`)
    }
  }
  return files.map((file) => ({ ...file, required: file.required ?? false }))
}

/** The schema's own top-level defaults, restated so this resolver is total. */
const TOP_LEVEL_DEFAULTS = {
  enabled: true,
  mode: 'native',
  userScope: true,
  projectScope: true,
  /** Memory sits outside every session workspace, so writes declare the memory directory as
   * their own sandbox workspace; `'session'` hands that decision back to the session. */
  writePolicy: 'memory-root',
}

/**
 * The nested blocks declare NO field defaults: the SDK's rules depend on which keys were
 * actually written (native mode accepts only `onResult`; `turnComplete.enabled: true` beside
 * `generation.enabled: false` is rejected), and schemastery omits absent no-default fields, so
 * they arrive here exactly as written while `resolveMemoryConfig` applies the defaults.
 */
export const Config = z.object({
  enabled: z.boolean().default(true),
  mode: z.union([z.const('native'), z.const('custom')]).default('native'),
  userScope: z.boolean().default(true),
  projectScope: z.boolean().default(true),
  /** `memory-root` (default): writes declare their own sandbox workspace, so they work under
   * `workspace-write`. `session`: follow the session's policy, which makes memory read-only
   * whenever that policy fences writes outside the workspace. */
  writePolicy: z.union([z.const('memory-root'), z.const('session')]).default('memory-root'),
  /**
   * Directory entries that make one repository share one memory scope, walked up
   * from the session cwd. Empty (the default) means the session's own directory
   * is the project, matching how the harness itself groups sessions and owns
   * workspaces. Same vocabulary as the harness's `projectRootMarkers`.
   */
  projectRootMarkers: z.array(z.string()).default([]),
  /**
   * Gitignore-flavoured globs (picomatch, the library Qoder itself uses) matched
   * against a memory file's absolute path. Applied to the PROJECT scope only,
   * never to the user scope — Qoder's own rule is that exclusions may not remove
   * its `global` layer.
   */
  excludes: z.array(z.string()).default([]),
  /**
   * `@`-import expansion for memory files. The format, the depth ceiling and the
   * refusal of out-of-root references are Qoder's; see `lib/memory/imports.js`.
   */
  imports: z
    .object({
      enabled: z.boolean().default(true),
      format: z.union([z.const('tree'), z.const('flat')]).default('tree'),
      maxDepth: z.natural().min(1).default(5),
      /** Auto-approve imports that point outside the allowed roots. */
      allowExternal: z.boolean().default(false),
      /** Project directories whose external imports are approved. */
      approvedProjects: z.array(z.string()).default([]),
    })
    .default({}),
  generation: z
    .object({
      enabled: z.boolean(),
      maxOutputTokens: z.natural(),
      /** Consecutive failed passes before pausing this session; 0 never pauses. */
      pauseAfterFailures: z.natural(),
      provider: z.string(),
      model: z.string(),
      prompt: z.string(),
      /** `(result) => void | Promise<void>`, called once per finished generation pass. */
      onResult: z.any(),
      /** Custom roots; each `{ id, path, access, indexFile? }`. */
      roots: z.any(),
      /** Qoder's per-turn generation policy block. */
      turnComplete: z.object({
        enabled: z.boolean(),
        minPromptChars: z.natural(),
        timeoutMs: z.natural().min(1),
        onGateError: z.union([z.const('skip'), z.const('report_failed')]),
        /** `async (input, { signal }) => ({ run, reason? })`; supply via `!!js` in YAML. */
        shouldGenerate: z.any(),
      }),
      /**
       * Qoder's background consolidation ("dream"). Off by default: it costs an
       * extra model call per interval.
       */
      dream: z.object({
        enabled: z.boolean(),
        /** Minimum hours between consolidation runs. */
        minHours: z.natural(),
      }),
      /**
       * Qoder's Daily Memory Journal — the `action: "add"`, `target: "daily"` surface.
       *
       * Off by default, like every other thing that spends a model call: it rides along with the
       * generation pass (the prompt says "after the memory review above"), so enabling it costs one
       * additional write in a pass that was already running, not a new pass. Files land in
       * `<root>/journal/<YYYY-MM-DD>.md`, which `listRootFiles` does not read — a journal is a record,
       * not knowledge to inject on every step.
       */
      journal: z.object({
        enabled: z.boolean(),
        /** Which scope a journal is filed into: the project's own, or the shared user scope. */
        scope: z.union([z.const('project'), z.const('user')]),
      }),
      /**
       * Pacing of the per-turn pass: one pass every N completed turns, Qoder's
       * `extractionEveryNTurns`.
       */
      incremental: z.object({
        everyTurns: z.natural().min(1),
        midTurn: z.boolean(),
      }),
    })
    .default({}),
  consumption: z
    .object({
      enabled: z.boolean(),
      /**
       * The shared token budget. OPTIONAL: absent means no limit, which is Qoder's own
       * contract (`maxTokens ?? Number.POSITIVE_INFINITY`). When it IS present the SDK
       * requires a positive integer, so `0` is refused rather than read as "inject nothing".
       */
      maxTokens: z.natural().min(CONSUMPTION_MIN_TOKENS),
      overflow: z.union([z.const('truncate'), z.const('fail_query')]),
      failureMode: z.union([z.const('best_effort'), z.const('fail_query')]),
      /** Explicit `{ id, path, required? }` list; replaces native auto discovery. */
      files: z.any(),
      /** `(result) => void | Promise<void>`, called once per finished consumption pass. */
      onResult: z.any(),
    })
    .default({}),
  /**
   * Qoder's `security.folderTrust.enabled` plus the user-level list of
   * explicitly trusted directories. With `enabled: false` (Qoder's own default)
   * the gate is inert and project memory behaves as before.
   */
  trust: z
    .object({
      enabled: z.boolean().default(false),
      /** Absolute paths, or paths relative to the session working directory. */
      folders: z.array(z.string()).default([]),
    })
    .default({}),
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

/**
 * Apply the plugin's defaults to the sparse validated config, then the
 * environment overrides.
 *
 * @param validated - the schema-validated configuration.
 * @param env - the environment mapping; defaults to the process environment.
 * @returns a configuration with every field populated.
 */
export function resolveMemoryConfig(validated, env = process.env) {
  const resolved = {
    ...TOP_LEVEL_DEFAULTS,
    ...validated,
    projectRootMarkers: validated.projectRootMarkers ?? [...PROJECT_ROOT_MARKERS_DEFAULT],
    excludes: validated.excludes ?? [...EXCLUDES_DEFAULT],
    imports: { ...IMPORTS_DEFAULTS, ...validated.imports },
    generation: {
      ...GENERATION_DEFAULTS,
      ...validated.generation,
      turnComplete: { ...TURN_COMPLETE_DEFAULTS, ...validated.generation?.turnComplete },
      dream: { ...DREAM_DEFAULTS, ...validated.generation?.dream },
      journal: { ...JOURNAL_DEFAULTS, ...validated.generation?.journal },
      incremental: { ...INCREMENTAL_DEFAULTS, ...validated.generation?.incremental },
    },
    consumption: { ...CONSUMPTION_DEFAULTS, ...validated.consumption },
    trust: { ...TRUST_DEFAULTS, ...validated.trust },
  }
  return applyEnvironmentOverrides(resolved, env)
}
