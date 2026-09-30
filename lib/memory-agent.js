/**
 * The memory agent: a bounded tool loop over one root set.
 *
 * Qoder's generation and consolidation passes are *agents*, not single calls.
 * Their prompt tells the model to orient with a listing, pick a few files to
 * read, then edit — across several rounds:
 *
 *   - Use Glob to list top-level memory Markdown files when needed.
 *   - Do not read every topic file. Use `MEMORY.md`, file names, and narrow
 *     Grep searches to choose only the files that are likely to need work.
 *   - Once the relevant files are clear, move to Write/Edit.
 *   - Never Read MEMORY.md.
 *
 * This module provides that shape: a small tool set (list / read / write /
 * delete) confined to the resolved roots, driven by `llm.stream` until the model
 * stops calling tools.
 *
 * @module @dsh-external/dsh-memory/memory-agent
 */

import { randomUUID } from 'node:crypto'
import { listRootFiles, readIfPresent } from './fs.js'
import { isIndexFile, parseMemoryFile } from './memory-file.js'
import { formatSearchResult, searchMemory } from './memory-search.js'
import { applyOneDelete, applyOneWrite, perPassBudgetNote, summarizeWrites } from './memory-pass.js'
import { joinRoot, safeRelativePath } from './paths.js'

/** Hard ceiling on rounds, so a looping model cannot run forever. */
export const MAX_AGENT_ROUNDS = 8

/** Largest file the agent will read into context in one call. */
const MAX_READ_BYTES = 16384

/** The tool set the model sees, in Qoder's spirit. */
export function memoryToolSchemas() {
  return [
    {
      name: 'memory_list',
      description:
        'List the files in one memory root. The index file is marked; every other .md is a content file shown with its declared kind and description.',
      parameters: {
        type: 'object',
        properties: { rootId: { type: 'string', description: 'Root id to list.' } },
        required: ['rootId'],
        additionalProperties: false,
      },
    },
    {
      name: 'memory_read',
      description: 'Read one memory file. Prefer the index and file names over reading everything.',
      parameters: {
        type: 'object',
        properties: {
          rootId: { type: 'string', description: 'Root id that holds the file.' },
          path: { type: 'string', description: 'File name relative to the root, ending in .md.' },
        },
        required: ['rootId', 'path'],
        additionalProperties: false,
      },
    },
    {
      name: 'memory_search',
      description:
        'Search every memory root for a literal, case-insensitive string. Use it before writing when duplication is likely, then update the existing file instead of creating a near-duplicate.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Literal text to find (at least two characters).' },
          rootId: { type: 'string', description: 'Optional: narrow the search to one root id.' },
        },
        required: ['query'],
        additionalProperties: false,
      },
    },
    {
      name: 'memory_write',
      description:
        'Write one memory file, replacing it completely (or appending with mode "append"). Creating a content file requires front-matter with name, description and type.',
      parameters: {
        type: 'object',
        properties: {
          rootId: { type: 'string', description: 'Root id to write into.' },
          path: { type: 'string', description: 'File name relative to the root, ending in .md.' },
          content: { type: 'string', description: 'The complete new file text.' },
          mode: { type: 'string', enum: ['replace', 'append'], description: 'Defaults to replace.' },
        },
        required: ['rootId', 'path', 'content'],
        additionalProperties: false,
      },
    },
    {
      name: 'memory_delete',
      description:
        'Delete one memory file that is stale, wrong, or superseded. Afterwards the index must be rewritten without its entry: a dangling pointer is worse than the file.',
      parameters: {
        type: 'object',
        properties: {
          rootId: { type: 'string', description: 'Root id to delete from.' },
          path: { type: 'string', description: 'File name relative to the root, ending in .md.' },
        },
        required: ['rootId', 'path'],
        additionalProperties: false,
      },
    },
  ]
}

/**
 * Why a delete is possible at all.
 *
 * The Harness `fs` service declares no delete, so this used to be a refusal: the
 * plugin would retire a memory by dropping its index entry and leave the orphan
 * on disk. That is a poor retirement — the file keeps being searched, keeps
 * counting against budgets, and can be re-pointed at by mistake. Deletion now
 * happens through {@link deleteGuarded}, which asks the provider for the target's
 * own `processPath` (the documented way to hand a target to an OS capability) and
 * unlinks exactly that.
 *
 * Kept as an exported string because the prompt and the docs quote it.
 */
export const DELETE_INDEX_NOTE =
  'After deleting a memory, rewrite the index without its entry — a dangling pointer is worse than the file.'

/**
 * Build the tool executor over one root set.
 *
 * Every path is resolved inside a root, so the agent cannot reach outside the
 * memory directories even though it chooses its own arguments.
 *
 * @param ctx - plugin context.
 * @param config - the resolved configuration.
 * @param roots - the resolved roots.
 * @param signal - cancellation.
 * @param session - the session this pass belongs to, when one exists.
 * @returns a toolkit recording what the agent did.
 */
export function createMemoryToolkit(ctx, config, roots, signal, session) {
  const fs = ctx.get('fs')
  const rootById = new Map(roots.map((root) => [root.id, root]))
  const writtenFiles = []
  const failedFiles = []
  const deferredFiles = []
  const deletedFiles = []
  let attemptedDeletes = 0
  let attempted = 0

  /** Resolve a root id and a file path, refusing anything outside the root. */
  const locate = (args) => {
    const root = rootById.get(String(args?.rootId))
    if (root === undefined) return { error: `unknown root "${String(args?.rootId)}"` }
    const safe = safeRelativePath(args?.path)
    if (safe === undefined) return { error: 'path must be a relative .md path inside the root' }
    return { root, safe, absolute: joinRoot(root.path, safe) }
  }

  return {
    /** Run one tool call and return the text the model should see. */
    async execute(name, args) {
      if (name === 'memory_list') {
        const root = rootById.get(String(args?.rootId))
        if (root === undefined) return { text: `unknown root "${String(args?.rootId)}"`, isError: true }
        const names = await listRootFiles(fs, root, signal)
        if (names.length === 0) return { text: `${root.id} (${root.path}) is empty.` }
        const lines = [`${root.id} (${root.path}):`]
        for (const fileName of names) {
          if (isIndexFile(fileName)) {
            lines.push(`  ${fileName}  [index]`)
            continue
          }
          let kind = ''
          try {
            const found = await readIfPresent(fs, joinRoot(root.path, fileName), signal)
            if (found !== undefined) {
              const parsed = parseMemoryFile(fileName, found.text)
              kind = `  [${parsed.type}]${parsed.description ? ` ${parsed.description}` : ''}`
            }
          } catch {
            /* an unreadable file still lists */
          }
          lines.push(`  ${fileName}${kind}`)
        }
        return { text: lines.join('\n') }
      }

      if (name === 'memory_read') {
        const at = locate(args)
        if (at.error !== undefined) return { text: at.error, isError: true }
        if (isIndexFile(at.safe)) return { text: 'The index contents are already provided. Do not read it.', isError: true }
        const found = await readIfPresent(fs, at.absolute, signal).catch(() => undefined)
        if (found === undefined) return { text: `${at.root.id}:${at.safe} does not exist.`, isError: true }
        if (Buffer.byteLength(found.text, 'utf8') > MAX_READ_BYTES) {
          return { text: `${at.root.id}:${at.safe} is too large to read; work from its description.`, isError: true }
        }
        return { text: found.text }
      }

      if (name === 'memory_search') {
        const result = await searchMemory(ctx, roots, args?.query, { rootId: args?.rootId }, signal)
        return { text: formatSearchResult(result), isError: result.error !== undefined }
      }

      if (name === 'memory_write') {
        const ceiling = config.generation.maxWrites
        const refused = (path, error) => {
          failedFiles.push({ rootId: String(args?.rootId), path: String(path ?? args?.path), error })
          return { text: `refused: ${error}`, isError: true }
        }
        // The per-pass budget is a bound, not a rule the model broke: the write is not
        // attempted, so it is recorded as deferred and the pass stays a success, and the model
        // is told why so it can wrap up instead of hammering the same write.
        if (ceiling > 0 && attempted >= ceiling) {
          const note = perPassBudgetNote(ceiling)
          deferredFiles.push({ rootId: String(args?.rootId), path: String(args?.path), error: note })
          return { text: `not attempted: ${note}` }
        }
        attempted += 1
        const outcome = await applyOneWrite(ctx, config, rootById, args ?? {}, signal, session)
        if (outcome.file !== undefined) {
          writtenFiles.push(outcome.file)
          return { text: `wrote ${outcome.file.rootId}:${outcome.file.path} (${outcome.file.bytes} bytes)` }
        }
        return refused(outcome.path, outcome.error)
      }

      if (name === 'memory_delete') {
        attemptedDeletes += 1
        const outcome = await applyOneDelete(ctx, config, rootById, args ?? {}, signal, session)
        if (outcome.file !== undefined) {
          deletedFiles.push(outcome.file)
          return { text: `deleted ${outcome.file.rootId}:${outcome.file.path}. ${DELETE_INDEX_NOTE}` }
        }
        // A refused delete is recorded like a refused write: the pass must not
        // look clean when the model asked for something that did not happen.
        failedFiles.push({ rootId: String(args?.rootId), path: String(outcome.path ?? args?.path), error: String(outcome.error) })
        return { text: `refused: ${outcome.error}`, isError: true }
      }

      return { text: `unknown tool "${String(name)}"`, isError: true }
    },

    /** The generation result implied by what the agent did. */
    result(reason) {
      return summarizeWrites(
        attempted,
        writtenFiles,
        failedFiles,
        roots,
        reason,
        deletedFiles,
        attemptedDeletes,
        deferredFiles,
      )
    },
  }
}

/** One assistant message carrying the model's tool calls. */
function assistantToolCallMessage(route, calls) {
  return {
    id: randomUUID(),
    role: 'assistant',
    content: calls.map((call) => ({
      type: 'tool-call',
      id: call.id,
      name: call.name,
      arguments: call.arguments,
    })),
    source: { kind: 'model', provider: route.provider, model: route.model },
  }
}

/** One tool result message answering a call. */
function toolResultMessage(callId, text, isError) {
  return {
    id: randomUUID(),
    role: 'tool',
    source: { kind: 'tool', callId },
    toolCallId: callId,
    content: [{ type: 'text', text }],
    ...(isError === true ? { isError: true } : {}),
  }
}

/** Accumulate one streamed response into text and complete tool calls. */
async function collectStream(stream) {
  let text = ''
  let finish
  const pending = new Map()
  for await (const chunk of stream) {
    if (chunk.type === 'text-delta') text += chunk.text
    else if (chunk.type === 'tool-call-delta') {
      const entry = pending.get(chunk.index) ?? { id: chunk.id, name: '', arguments: '' }
      if (typeof chunk.name === 'string' && chunk.name.length > 0) entry.name = chunk.name
      entry.arguments += chunk.argumentsDelta
      pending.set(chunk.index, entry)
    } else if (chunk.type === 'block-end' && chunk.block?.type === 'tool-call') {
      pending.set(chunk.index, {
        id: chunk.block.id,
        name: chunk.block.name,
        arguments: chunk.block.arguments,
      })
    } else if (chunk.type === 'block-end' && chunk.block?.type === 'text' && text.length === 0) {
      text += chunk.block.text
    } else if (chunk.type === 'finish') {
      finish = chunk.reason
    }
  }
  return { text, finish, calls: [...pending.values()].filter((call) => call.name.length > 0) }
}

/**
 * Run the memory agent to completion.
 *
 * @param ctx - plugin context (needs `llm`).
 * @param config - the resolved configuration.
 * @param route - the resolved model route.
 * @param system - the system instruction.
 * @param userText - the opening user message.
 * @param toolkit - the executor from {@link createMemoryToolkit}.
 * @param signal - cancellation.
 * @returns `{ outcome, text, rounds }`, where outcome is the toolkit result.
 * @throws when the model call itself fails.
 */
export async function runMemoryAgent(ctx, config, route, system, userText, toolkit, signal) {
  const llm = ctx.get('llm')
  if (llm === undefined) throw new Error('the llm service is unavailable')

  const messages = [{ role: 'user', content: [{ type: 'text', text: userText }] }]
  const tools = memoryToolSchemas()
  let text = ''
  let rounds = 0

  const options = {
    provider: route.provider,
    model: route.model,
    system,
    tools,
    signal,
  }
  // Zero means "no cap": omitting the option lets the adapter apply the model's own
  // default, which is the only budget that fits every model.
  if (config.generation.maxOutputTokens > 0) options.maxTokens = config.generation.maxOutputTokens
  if (route.reasoningEffort !== undefined) options.reasoningEffort = route.reasoningEffort
  if (route.sessionId !== undefined) options.sessionId = route.sessionId

  for (let round = 0; round < MAX_AGENT_ROUNDS; round += 1) {
    rounds = round + 1
    const collected = await collectStream(llm.stream({ ...options, messages }))
    text += collected.text

    if (collected.finish !== undefined && collected.finish.kind === 'aborted') {
      throw new Error(collected.finish.failure?.message ?? 'aborted')
    }
    // A round the provider cut short can still carry COMPLETE tool calls — the model
    // ran out of output budget after asking for a write, not before. Discarding the
    // round threw that work away and reported the whole pass as failed, so the calls
    // are applied and the loop stops: the model stopped mid-thought, and asking again
    // would only spend another budget repeating it.
    const cut = collected.finish !== undefined && collected.finish.kind !== 'stop' && collected.finish.kind !== 'tool-calls'
    if (cut && collected.calls.length === 0) {
      if (collected.finish.kind === 'max-tokens') {
        throw new Error('generation reached maxOutputTokens; raise generation.maxOutputTokens or narrow the pass')
      }
      throw new Error(collected.finish.failure?.message ?? `generation ended with "${String(collected.finish.kind)}"`)
    }
    if (collected.calls.length === 0) break

    messages.push(assistantToolCallMessage(route, collected.calls))
    for (const call of collected.calls) {
      let args
      try {
        args = call.arguments.trim().length > 0 ? JSON.parse(call.arguments) : {}
      } catch {
        messages.push(toolResultMessage(call.id, 'arguments must be a JSON object', true))
        continue
      }
      const outcome = await toolkit.execute(call.name, args)
      messages.push(toolResultMessage(call.id, outcome.text, outcome.isError === true))
    }
    if (cut) break
  }

  return { outcome: toolkit.result(''), text, rounds }
}
