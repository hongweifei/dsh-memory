/**
 * The daily journal: Qoder's `action: "add"`, `target: "daily"` surface.
 *
 * Decoded verbatim from the installed `qodercli`:
 *
 *     **Daily Memory Journal**: After the memory review above, write a daily memory entry if this
 *     conversation produced information useful beyond this session.
 *     Use the memory tool with:
 *     - action: "add"
 *     - target: "daily"
 *     - chat_id:
 *
 *     - content: Bullet-point list, max 8 bullets, each <=120 chars
 *     ...
 *     Write all daily memory items in a single tool call. If nothing qualifies, skip daily memory.
 *
 * Three consequences shape this module:
 *
 *   - **It runs AFTER the memory review**, i.e. inside the background generation pass, not in the
 *     interactive path. So the journal costs the user no extra turn and is written by the same agent
 *     that just reviewed memory.
 *   - **The date and the scope are the PLUGIN's job, not the model's.** Qoder's prompt carries
 *     `chat_id: ` as an interpolated runtime value, so the framework supplies the identity and the
 *     model echoes it back. Here the session is already known to the caller, and a model computing
 *     today's date is a model that can get it wrong — so neither travels through the tool call.
 *   - **The bullet limits are prose, not a gate.** Qoder has no rejection path for them anywhere in
 *     the bundle, exactly like the index's "about 25KB". So they are the prompt's job, this module
 *     only *reports* a violation, and a write is never refused for being too long.
 *
 * This module is pure: no filesystem, no clock of its own (every function takes the time it needs).
 *
 * @module @dsh-external/dsh-memory/journal
 */

/** The subdirectory a journal lives in, under a memory root. */
export const JOURNAL_DIR = 'journal'
/** Qoder's wording: "max 8 bullets". */
export const JOURNAL_MAX_BULLETS = 8

/** Qoder's wording: "each <=120 chars". */
export const JOURNAL_BULLET_CHARS = 120

/**
 * The local calendar date, as `YYYY-MM-DD`.
 *
 * Deliberately the LOCAL date and not `toISOString().slice(0, 10)`. Qoder's other date helpers use
 * the UTC form, but a journal is "what did I do today" as the person writing it experiences the day:
 * in UTC+8 a UTC-derived name rolls over at 08:00 local, so an evening's work would be filed under
 * tomorrow. The file that has to make sense is the one a human opens.
 *
 * @param now - the instant to name; defaults to the current time.
 * @returns the local date.
 */
export function journalDate(now = new Date()) {
  const year = String(now.getFullYear()).padStart(4, '0')
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/**
 * The root-relative path of one day's journal.
 *
 * It sits in a SUBDIRECTORY on purpose. `listRootFiles` reads a root's top level only, so a nested
 * file is invisible to injection: the journal is a record of what happened, not knowledge to put in
 * front of the model on every step. It also means the journal cannot grow the context as days
 * accumulate — a root-level `2026-10-15.md` would be injected like any other content file, and a
 * month of them would crowd out the memory they are meant to complement.
 *
 * @param date - a `YYYY-MM-DD` date, from {@link journalDate}.
 * @returns a path already acceptable to `safeRelativePath`.
 */
export function journalRelativePath(date) {
  return `${JOURNAL_DIR}/${date}.md`
}

/**
 * One entry's markdown block.
 *
 * A time-stamped `##` heading, because a day accumulates several passes and several sessions into
 * ONE file — the append has to be legible without reading the surrounding text. The short session id
 * is the honest mapping of Qoder's `chat_id`: it is provenance, so a later reader can tell which
 * conversation a line came from, and it is truncated because a full id is noise in a file a person
 * reads.
 *
 * @param options - `{ content, sessionId, now }`.
 * @returns the block, without a trailing newline.
 */
export function journalEntry(options) {
  const now = options?.now ?? new Date()
  const time = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
  const session = typeof options?.sessionId === 'string' && options.sessionId.length > 0
    ? options.sessionId.slice(0, 8)
    : undefined
  const heading = session === undefined ? `## ${time}` : `## ${time} · ${session}`
  const body = String(options?.content ?? '').trim()
  return `${heading}\n\n${body}`
}

/**
 * What is wrong with an entry, in Qoder's own numbers — advisory only.
 *
 * Returns prose rather than a boolean so the model is told *what* to change, and the caller can put
 * it in the tool's reply where the next pass will read it. Nothing here refuses a write: Qoder states
 * the limits in the prompt and has no rejection path for them, and a journal that silently stops
 * recording because a bullet ran long would be worse than a slightly verbose one.
 *
 * @param content - the entry text the model supplied.
 * @returns one sentence, or `undefined` when the entry is within the stated shape.
 */
export function journalWarnings(content) {
  const text = String(content ?? '')
  const bullets = text.split(/\r?\n/).filter((line) => /^\s*[-*]\s+\S/.test(line))
  const parts = []
  if (bullets.length > JOURNAL_MAX_BULLETS) {
    parts.push(`${bullets.length} bullets (the stated maximum is ${JOURNAL_MAX_BULLETS})`)
  }
  const longest = bullets.reduce((max, line) => Math.max(max, line.replace(/^\s*[-*]\s+/, '').length), 0)
  if (longest > JOURNAL_BULLET_CHARS) {
    parts.push(`the longest bullet is ${longest} characters (the stated maximum is ${JOURNAL_BULLET_CHARS})`)
  }
  return parts.length === 0 ? undefined : `note: ${parts.join('; ')} — kept as written`
}

/**
 * Whether a journal entry carries a date heading this day already has.
 *
 * Not a de-duplication gate; a day is *supposed* to accumulate entries. It exists so a caller can
 * tell "the file was already there" from "this is the first entry of the day" for reporting.
 *
 * @param existing - the file's current text, or undefined when it does not exist yet.
 * @param now - the instant the entry is being written at.
 * @returns `true` when the current hour has already been written to.
 */
export function journalHasEntryFor(existing, now = new Date()) {
  if (typeof existing !== 'string' || existing.length === 0) return false
  const time = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
  return existing.split(/\r?\n/).some((line) => line.startsWith(`## ${time}`))
}
