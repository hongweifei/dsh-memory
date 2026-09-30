/**
 * The model-facing `memory` tool.
 *
 * Gives the model deliberate access to its own memory: list what exists, read
 * one file, or write one. Every path goes through the same root confinement as
 * the background pass, so the tool cannot reach outside a scope root.
 *
 * @module @dsh-external/dsh-memory/tools
 */

import { deleteGuarded, listRootFiles, memoryWritePolicy, readIfPresent, writeGuarded } from './fs.js'
import { DELETE_INDEX_NOTE } from './memory-agent.js'
import { isIndexFile, parseMemoryFile } from './memory-file.js'
import { formatSearchResult, searchMemory } from './memory-search.js'
import { joinRoot, safeRelativePath } from './paths.js'
import { resolveEffectiveRoots } from './trust.js'

/** The tool's name, as the model sees it. */
const MEMORY_TOOL_NAME = 'memory'

const TOOL_DESCRIPTION = [
  "Read, search or write this session's persistent memory files.",
  "Scope 'user' is cross-project knowledge; 'project' belongs to this working directory only.",
  'Each scope holds an index (MEMORY.md) plus one content file per topic.',
  'A content file starts with front-matter carrying name, description and type',
  '(user | feedback | project | reference). Use the tool to recall recorded',
  'knowledge or to record a durable fact deliberately; search before writing, so',
  'an existing memory is updated instead of duplicated.',
].join(' ')

/**
 * Register the `memory` tool on the calling context.
 *
 * @param ctx - plugin context (must expose `tools`).
 * @param config - the resolved configuration.
 * @param customRoots - the validated `generation.roots` list.
 */
export function registerMemoryTool(ctx, config, customRoots) {
  ctx.tools.register({
    name: MEMORY_TOOL_NAME,
    description: TOOL_DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'read', 'search', 'write', 'delete'],
          description: 'Operation to perform.',
        },
        scope: {
          type: 'string',
          enum: ['user', 'project'],
          description: 'Memory scope; defaults to project. Ignored by "search", which covers every scope.',
        },
        path: { type: 'string', description: 'Memory file name relative to the scope root, ending in .md.' },
        content: { type: 'string', description: 'Full replacement text; required for action "write".' },
        query: {
          type: 'string',
          description: 'Literal, case-insensitive text to find; required for action "search".',
        },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          message: { type: 'string' },
          files: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                rootId: { type: 'string' },
                path: { type: 'string' },
                bytes: { type: 'number' },
              },
              required: ['rootId', 'path', 'bytes'],
              additionalProperties: false,
            },
          },
        },
        required: ['ok', 'message', 'files'],
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: value.message }],
    },

    async execute(args, exec) {
      const fs = ctx.get('fs')
      const cwd = exec.agent?.session.header?.cwd ?? process.cwd()
      const roots = await resolveEffectiveRoots(ctx, config, customRoots, cwd, exec.signal)

      // Search is scope-independent, so it runs BEFORE the scope is resolved:
      // otherwise an untrusted (absent) project root would refuse the call
      // outright instead of searching the roots that do exist.
      if (args.action === 'search') {
        if (typeof args.query !== 'string' || args.query.trim().length === 0) {
          return { ok: false, message: 'memory: query is required for action "search"', files: [] }
        }
        // Every resolved root, not just one scope: a memory search that silently
        // skipped user-scope knowledge would hide exactly the entries that are
        // shared across projects.
        const result = await searchMemory(ctx, roots, args.query, {}, exec.signal)
        const matches = result.hits.map((hit) => ({ rootId: hit.rootId, path: hit.path, bytes: 0 }))
        return {
          ok: result.error === undefined,
          message: formatSearchResult(result).replace(/^memory_search:/, 'memory:'),
          files: result.error === undefined ? matches : [],
        }
      }

      const scopeId = args.scope === 'user' ? 'user' : 'project'
      const root = roots.find((candidate) => candidate.id === scopeId)
      if (root === undefined) {
        return { ok: false, message: `memory: scope "${scopeId}" is not enabled in this configuration`, files: [] }
      }

      if (args.action === 'list') {
        const names = await listRootFiles(fs, root, exec.signal)
        if (names.length === 0) {
          return { ok: true, message: `memory: no files in ${scopeId} scope (${root.path})`, files: [] }
        }
        // Report the index apart from content, and label each content file with
        // its declared kind so the model can see the shape it is maintaining.
        const lines = [`memory ${scopeId} scope (${root.path}):`]
        for (const fileName of names) {
          if (isIndexFile(fileName)) {
            lines.push(`  ${fileName}  (index)`)
            continue
          }
          let kind = ''
          try {
            const found = await readIfPresent(fs, joinRoot(root.path, fileName), exec.signal)
            if (found !== undefined) {
              const parsed = parseMemoryFile(fileName, found.text)
              kind = `  (${parsed.type}${parsed.description ? `: ${parsed.description}` : ''})`
            }
          } catch {
            /* an unreadable file still lists */
          }
          lines.push(`  ${fileName}${kind}`)
        }
        return { ok: true, message: lines.join('\n'), files: [] }
      }

      const safe = safeRelativePath(args.path)
      if (safe === undefined) {
        return { ok: false, message: 'memory: path must be a relative .md path inside the scope root', files: [] }
      }
      const absolute = joinRoot(root.path, safe)

      if (args.action === 'read') {
        const found = await readIfPresent(fs, absolute, exec.signal)
        if (found === undefined) return { ok: false, message: `memory: ${scopeId}:${safe} does not exist`, files: [] }
        return {
          ok: true,
          message: `${scopeId}:${safe}\n\n${found.text}`,
          files: [{ rootId: root.id, path: safe, bytes: Buffer.byteLength(found.text, 'utf8') }],
        }
      }

      if (args.action === 'write') {
        if (root.access !== 'read-write') return { ok: false, message: `memory: scope ${scopeId} is read-only`, files: [] }
        if (typeof args.content !== 'string' || args.content.trim().length === 0) {
          return { ok: false, message: 'memory: content must be a non-empty string', files: [] }
        }
        if (Buffer.byteLength(args.content, 'utf8') > config.generation.maxWriteBytes) {
          return {
            ok: false,
            message: `memory: content exceeds maxWriteBytes ${config.generation.maxWriteBytes}`,
            files: [],
          }
        }
        await writeGuarded(fs, absolute, args.content, exec.signal, memoryWritePolicy(root.path, config.writePolicy !== 'session'))
        const bytes = Buffer.byteLength(args.content, 'utf8')
        return {
          ok: true,
          message: `memory: wrote ${scopeId}:${safe} (${bytes} bytes)`,
          files: [{ rootId: root.id, path: safe, bytes }],
        }
      }

      if (args.action === 'delete') {
        if (root.access !== 'read-write') return { ok: false, message: `memory: scope ${scopeId} is read-only`, files: [] }
        const outcome = await deleteGuarded(fs, absolute, undefined, exec.signal, config.writePolicy !== 'session')
        if (outcome.missing === true) return { ok: false, message: `memory: ${scopeId}:${safe} does not exist`, files: [] }
        if (outcome.error !== undefined) return { ok: false, message: `memory: ${outcome.error}`, files: [] }
        return {
          ok: true,
          message: `memory: deleted ${scopeId}:${safe}. ${DELETE_INDEX_NOTE}`,
          files: [{ rootId: root.id, path: safe, bytes: 0, deleted: true }],
        }
      }

      return { ok: false, message: `memory: unsupported action "${String(args.action)}"`, files: [] }
    },
  })
}
