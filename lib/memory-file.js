/**
 * Memory files: the index/content split and the typed front-matter.
 *
 * Qoder's native model, reproduced from the installed qodercli
 * (`docs/qoder-memory-model.md`):
 *
 *   MEMORY.md          the INDEX — one line per memory, never content itself
 *   <topic>.md         a CONTENT file carrying front-matter
 *
 * A content file looks like:
 *
 *   ---
 *   name: Build commands
 *   description: How to build and test this repository
 *   type: project
 *   ---
 *
 *   The body.
 *
 * `type` is one of the four memory kinds and falls back to `project` when it is
 * missing or unrecognized; `name` falls back to the file name. Hidden files and
 * the index itself are never treated as content.
 *
 * @module @dsh-external/dsh-memory/memory-file
 */

import { DEFAULT_MEMORY_TYPE, MEMORY_INDEX_FILE, MEMORY_TYPES } from './constants.js'

export { DEFAULT_MEMORY_TYPE, MEMORY_INDEX_FILE, MEMORY_TYPES }

/** Exactly three `---`-delimited segments: prefix, front-matter, body. */
const FRONT_MATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/

/**
 * Whether a file is the root's index.
 *
 * @param fileName - a file name, not a path.
 * @returns `true` for the index file.
 */
export function isIndexFile(fileName) {
  return fileName === MEMORY_INDEX_FILE
}

/**
 * The index limits, as the numbers Qoder's own prompt states.
 *
 * Decoded verbatim from qodercli: "…lines and under about 25KB. It is an index,
 * not a dump. Each entry should be one line under about 150 characters" and
 * "if an index line is over about 200 characters, move that detail into the
 * topic file".
 */
export const INDEX_MAX_BYTES = 25 * 1024
export const INDEX_ENTRY_CHARS = 150
export const INDEX_LINE_DEMOTE_CHARS = 200

/**
 * Check an index against the limits the prompt teaches.
 *
 * **Advisory only.** Qoder states these in the PROMPT — the bundle carries the
 * wording and the numbers, but no rejection path — so this reports and never
 * refuses; a write is never blocked by it, which is what the prompt means by
 * "about".
 *
 * @param fileName - the file's base name.
 * @param text - the content being written.
 * @returns `[{ kind, message }]`; empty when the index is within its limits.
 */
export function indexWarnings(fileName, text) {
  if (isIndexFile(fileName) !== true) return []
  const warnings = []
  const bytes = Buffer.byteLength(String(text ?? ''), 'utf8')
  if (bytes > INDEX_MAX_BYTES) {
    warnings.push({ kind: 'size', message: `index is ${bytes} bytes, over about ${INDEX_MAX_BYTES}` })
  }
  const long = String(text ?? '')
    .split('\n')
    .filter((line) => line.length > INDEX_LINE_DEMOTE_CHARS).length
  if (long > 0) {
    warnings.push({
      kind: 'long_lines',
      message: `${long} index line(s) over about ${INDEX_LINE_DEMOTE_CHARS} characters — demote them into topic files`,
    })
  }
  return warnings
}

/**
 * Whether a directory entry is a memory content file.
 *
 * Mirrors qodercli: `.md`, not the index, and not a dotfile.
 *
 * @param fileName - a directory entry name.
 * @returns `true` when the entry is content.
 */
export function isContentFile(fileName) {
  return (
    typeof fileName === 'string' &&
    fileName.toLowerCase().endsWith('.md') &&
    !fileName.startsWith('.') &&
    !isIndexFile(fileName)
  )
}

/**
 * Parse a content file into its front-matter fields and body.
 *
 * @param fileName - the file's base name, used when `name` is absent.
 * @param text - the file's full text.
 * @returns `{ name, description, type, content, fields }` — `fields` is the raw
 *   front-matter map, which `jit.js` reads for `paths` and `trigger`.
 */
export function parseMemoryFile(fileName, text) {
  const source = String(text ?? '')
  const match = FRONT_MATTER.exec(source)
  const fallbackName = typeof fileName === 'string' ? fileName.replace(/\.md$/i, '') : 'unknown'
  if (match === null) {
    return { name: fallbackName, description: '', type: DEFAULT_MEMORY_TYPE, content: source.trim(), fields: {} }
  }

  const fields = {}
  for (const line of match[1].split(/\r?\n/)) {
    const separator = line.indexOf(':')
    if (separator <= 0) continue
    const key = line.slice(0, separator).trim()
    const value = line.slice(separator + 1).trim()
    if (key.length > 0) fields[key] = value
  }

  const declared = fields.type
  return {
    name: fields.name && fields.name.length > 0 ? fields.name : fallbackName,
    description: fields.description ?? '',
    type: MEMORY_TYPES.includes(declared) ? declared : DEFAULT_MEMORY_TYPE,
    content: match[2].trim(),
    fields,
  }
}

/**
 * Serialize a content file, writing only the fields that carry a value.
 *
 * @param entry - `{ name, description, type, content }`.
 * @returns the file text.
 */
export function serializeMemoryFile(entry) {
  const type = MEMORY_TYPES.includes(entry.type) ? entry.type : DEFAULT_MEMORY_TYPE
  const lines = ['---']
  if (entry.name) lines.push(`name: ${entry.name}`)
  if (entry.description) lines.push(`description: ${entry.description}`)
  lines.push(`type: ${type}`, '---', '')
  return `${lines.join('\n')}\n${String(entry.content ?? '').trim()}\n`
}


