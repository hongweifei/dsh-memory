/**
 * The configuration rules the SDK applies at option-preparation time.
 *
 * A leaf module, so the LOADER path and the WRITE path can share one expression of the rules. That
 * sharing is the point: a surface that writes this plugin's configuration must be able to ask
 * "would the plugin accept this?" BEFORE persisting it, because a configuration the plugin rejects
 * makes it fail to activate — the whole plugin disappears from the session, not just the setting.
 *
 * These are cross-field rules rather than schema refinements because they span sibling fields and
 * depend on which keys were explicitly written (see `config.js`, which owns the schema).
 *
 * @module @dsh-external/dsh-memory/config-rules
 */

import { CONSUMPTION_MIN_TOKENS } from './constants.js'

/**
 * The keys `native` mode accepts inside the `generation` / `consumption` blocks.
 *
 * Native delegates the memory POLICY to the runtime, so the only thing a caller may still supply is
 * the result callback — Qoder's own rule, ported verbatim.
 */
export const NATIVE_ALLOWED_KEYS = Object.freeze(['onResult'])

/**
 * Whether one field may be written in this mode.
 *
 * The single expression of the rule, read by the validator, by the write path's pre-flight check and
 * by the panel's status payload. A second copy is how a control comes to offer a value the plugin
 * then refuses — which is exactly the defect this module exists to prevent.
 *
 * @param mode - the resolved `mode` (`'native' | 'custom'`).
 * @param key - the field name inside its block, e.g. `'maxTokens'`.
 * @returns `true` when the mode accepts that field.
 */
export function isOverridable(mode, key) {
  return mode !== 'native' || NATIVE_ALLOWED_KEYS.includes(key)
}

/**
 * Mirror the SDK's `prepareMemoryOptions` cross-field rules.
 *
 * @param raw - the schema-validated (still sparse) configuration.
 * @throws on any violated SDK rule.
 */
export function validateMemoryConfig(raw) {
  if (raw === undefined || raw === null) return
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('memory: options.memory must be an object')

  /** Keys the caller actually wrote, ignoring blocks the schema materialized empty. */
  const writtenKeys = (block) => {
    if (block === undefined || block === null) return []
    return Object.entries(block)
      .filter(([, value]) => {
        if (value === undefined) return false
        // An absent nested block arrives as `{}`; treat that as "not written".
        if (value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0) {
          return false
        }
        return true
      })
      .map(([key]) => key)
  }

  if (raw.mode === 'native') {
    // Native delegates to built-in policy: only the scope switches are configurable.
    if (raw.projectScope === false && raw.userScope === false) {
      throw new Error('memory: native mode requires at least one enabled scope; use `enabled: false` to disable memory')
    }
    const refused = [...writtenKeys(raw.generation), ...writtenKeys(raw.consumption)].filter(
      (key) => !isOverridable('native', key),
    )
    if (refused.length > 0) {
      throw new Error(
        `memory: mode "native" only accepts generation.onResult and consumption.onResult — ` +
          `${refused.join(', ')} cannot be set here; switch the plugin to \`mode: custom\` to configure those`,
      )
    }
  }

  const generation = raw.generation
  if (generation !== undefined) {
    if (generation.enabled === false && generation.turnComplete?.enabled === true) {
      throw new Error('memory: generation.turnComplete cannot be enabled when generation.enabled is false')
    }
    const timeoutMs = generation.turnComplete?.timeoutMs
    if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
      throw new Error('memory: generation.turnComplete.timeoutMs must be a positive finite number')
    }
  }

  const consumption = raw.consumption
  if (consumption !== undefined) {
    const maxTokens = consumption.maxTokens
    if (maxTokens !== undefined && (!Number.isInteger(maxTokens) || maxTokens < CONSUMPTION_MIN_TOKENS)) {
      throw new Error(`memory: consumption.maxTokens must be an integer of at least ${CONSUMPTION_MIN_TOKENS}`)
    }
  }
}
