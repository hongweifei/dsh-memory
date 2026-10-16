/**
 * The one string operation behind the `memory` tool's `edit` action.
 *
 * A pure function on purpose: the interesting part of an edit is not the I/O but the three ways it can
 * be ambiguous, and each of those deserves a test that needs no filesystem. `tools.js` supplies the
 * text and persists the result.
 *
 * The semantics mirror the Harness's OWN `edit` tool exactly — `old_string` must be unique unless
 * `replace_all` is set, and the replacement is LITERAL. Matching the host matters: a model that has
 * learned the shipped tool's habits should not have to learn a second dialect for memory, and the
 * refusal messages say the same things in the same words.
 *
 * @module @dsh-external/dsh-memory/memory-edit
 */

/**
 * Replace one occurrence of `oldString` with `newString`.
 *
 * @param text - the file's current contents.
 * @param oldString - the text to find. Must be non-empty, and unique unless `replaceAll`.
 * @param newString - the replacement. May be empty (that is how a deletion of a passage reads).
 * @param replaceAll - when `true`, replace every occurrence instead of requiring a unique match.
 * @returns `{ ok: true, text, replacements }`, or `{ ok: false, reason }` where `reason` is a phrase
 *   that fits after `memory: ` and names what the caller must fix.
 */
export function applyEdit(text, oldString, newString, replaceAll) {
  if (typeof oldString !== 'string' || oldString.length === 0) {
    // An empty `old_string` is not "insert at the start": it matches at every position, so the count
    // would be meaningless and the replacement arbitrary. The Harness refuses it for the same reason.
    return { ok: false, reason: 'old_string must be a non-empty string' }
  }
  if (typeof newString !== 'string') return { ok: false, reason: 'new_string must be a string' }

  const count = text.split(oldString).length - 1
  if (count === 0) return { ok: false, reason: 'old_string not found' }
  if (count > 1 && replaceAll !== true) {
    // Ambiguity is the failure mode worth refusing: picking the first match would edit a passage the
    // caller never saw, and in a memory file the same sentence legitimately appears twice.
    return {
      ok: false,
      reason: `old_string appears ${count} times (must be unique; pass replace_all to replace every occurrence)`,
    }
  }

  // LITERAL replacement, both paths. `String.prototype.replace` expands `$&`, `$1` and `` $` `` inside
  // the replacement, so a memory body containing those sequences would be silently rewritten — and
  // memory bodies DO contain code samples. The callback form inserts the text verbatim; `split`/`join`
  // never expands anything.
  const next = replaceAll === true ? text.split(oldString).join(newString) : text.replace(oldString, () => newString)
  return { ok: true, text: next, replacements: replaceAll === true ? count : 1 }
}
