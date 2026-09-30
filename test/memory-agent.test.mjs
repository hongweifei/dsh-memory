/**
 * Tests for the memory agent: the bounded tool loop.
 *
 * Qoder's generation and consolidation passes are agents — they list, read, then
 * write across several rounds. This exercises that shape with a scripted model so
 * the loop's behaviour is pinned without a live provider.
 *
 * Run: node test/memory-agent.test.mjs
 */
import assert from 'node:assert/strict'

import { createMemoryToolkit, memoryToolSchemas, runMemoryAgent, MAX_AGENT_ROUNDS } from '../lib/memory-agent.js'
import { perPassBudgetNote } from '../lib/memory-pass.js'

let passed = 0
const test = async (label, fn) => {
  await fn()
  passed += 1
  console.log(`  ok  ${label}`)
}

console.log('dsh-memory agent tests')

/* ---------------- doubles ---------------- */

/** An in-memory fs matching the harness contract used by the agent. */
function makeFs(initial = {}) {
  const files = new Map(Object.entries(initial))
  const dirs = new Set()
  for (const path of files.keys()) {
    const parts = path.split(/[\\/]/)
    for (let index = 1; index < parts.length; index += 1) dirs.add(parts.slice(0, index).join('\\'))
  }
  let version = 0
  const normalize = (path) => String(path).replace(/\//g, '\\').replace(/\\+$/, '')
  return {
    files,
    /**
     * A provider that CAN delete, which is the branch `deleteGuarded` prefers.
     * The node:fs fallback is covered in the unit suite against a real temp file.
     */
    async remove(target) {
      const key = normalize(target.targetKey)
      if (!files.has(key)) throw new Error(`ENOENT ${key}`)
      files.delete(key)
    },
    async resolve(path) {
      return { targetKey: normalize(path), displayPath: normalize(path) }
    },
    async stat(target) {
      const key = normalize(target.targetKey)
      if (files.has(key)) return { version: `v0`, type: 'file' }
      if (dirs.has(key)) return { version: `v0`, type: 'directory' }
      return undefined
    },
    async readText(target) {
      return files.get(normalize(target.targetKey))
    },
    async listDir(target) {
      const key = normalize(target.targetKey)
      const prefix = `${key}\\`
      const names = new Set()
      for (const path of files.keys()) {
        if (!path.startsWith(prefix)) continue
        const rest = path.slice(prefix.length)
        if (!rest.includes('\\')) names.add(rest)
      }
      return [...names].map((name) => ({ name, type: 'file', target: { targetKey: `${key}\\${name}`, displayPath: name } }))
    },
    async writeText(target, content) {
      files.set(normalize(target.targetKey), content)
      version += 1
      return { operation: 'create', version: `v${version}` }
    },
  }
}

/**
 * A scripted model: each entry is one response, and a response may carry tool
 * calls. Records the options it was called with so the loop can be inspected.
 *
 * Once the script is exhausted the model answers without tool calls, which is
 * what ends the loop — pass `{ repeatLast: true }` to model a model that keeps
 * calling tools forever (used to test the round ceiling).
 */
function makeScriptedLlm(script, options = {}) {
  const calls = []
  return {
    calls,
    stream(options_) {
      calls.push(options_)
      const step =
        calls.length <= script.length
          ? script[calls.length - 1]
          : options.repeatLast === true
            ? script[script.length - 1]
            : { text: '' }
      return (async function* () {
        // Each content block gets its OWN stream index, exactly as the real
        // stream does; sharing one index would make the loop merge the calls.
        let index = 0
        for (const call of step.calls ?? []) {
          yield { type: 'tool-call-delta', index, id: call.id, name: call.name, argumentsDelta: call.arguments }
          yield {
            type: 'block-end',
            index,
            block: { type: 'tool-call', id: call.id, name: call.name, arguments: call.arguments },
          }
          index += 1
        }
        if (step.text !== undefined) {
          yield { type: 'block-end', index, block: { type: 'text', text: step.text } }
        }
        // A step may declare how the round ended: a provider that stops at the output
        // cap is the case that matters (the model ran out of budget mid-answer).
        const kind = step.finish ?? ((step.calls ?? []).length > 0 ? 'tool-calls' : 'stop')
        yield { type: 'finish', reason: { kind } }
      })()
    },
  }
}

const config = { generation: { maxWrites: 4, maxWriteBytes: 16384, maxOutputTokens: 1000, provider: '', model: '' } }
const ROOT = { id: 'user', path: 'C:\\home\\.dsh\\memory', access: 'read-write', indexFile: 'MEMORY.md' }
const ctxWith = (fs, llm) => ({ logger: { info() {}, warn() {} }, get: (name) => (name === 'fs' ? fs : name === 'llm' ? llm : undefined) })
const route = { provider: 'p', model: 'm' }
const signal = new AbortController().signal

/* ---------------- the tool schema ---------------- */

await test('the agent is offered list, read, search, write and delete', () => {
  const names = memoryToolSchemas().map((tool) => tool.name)
  // Qoder's family is `memory` / `memory_search` / `memory_get`; the search verb
  // matches it exactly, the others are this plugin's.
  assert.deepEqual(names, ['memory_list', 'memory_read', 'memory_search', 'memory_write', 'memory_delete'])
  // Delete is offered because it is really performed: see `deleteGuarded`.
  const del = memoryToolSchemas().find((tool) => tool.name === 'memory_delete')
  assert.deepEqual(del.parameters.required, ['rootId', 'path'])
  assert.match(del.description, /the index must be rewritten/)
  for (const tool of memoryToolSchemas()) {
    assert.equal(tool.parameters.type, 'object')
    assert.ok(tool.description.length > 20, `${tool.name} needs a real description`)
  }
})

/* ---------------- the loop ---------------- */

await test('the agent lists, reads, then writes across rounds', async () => {
  const fs = makeFs({
    'C:\\home\\.dsh\\memory\\MEMORY.md': '# Index\n',
    'C:\\home\\.dsh\\memory\\build.md': '---\nname: Build\ntype: project\n---\n\nold',
  })
  const script = [
    { calls: [{ id: 'c1', name: 'memory_list', arguments: JSON.stringify({ rootId: 'user' }) }] },
    { calls: [{ id: 'c2', name: 'memory_read', arguments: JSON.stringify({ rootId: 'user', path: 'build.md' }) }] },
    {
      calls: [
        {
          id: 'c3',
          name: 'memory_write',
          arguments: JSON.stringify({ rootId: 'user', path: 'build.md', content: '---\nname: Build\ntype: project\n---\n\nnew' }),
        },
        {
          id: 'c4',
          name: 'memory_write',
          arguments: JSON.stringify({ rootId: 'user', path: 'MEMORY.md', content: '# Index\n\n- [Build](build.md) - how to build' }),
        },
      ],
    },
    // The model stops calling tools; the scripted double repeats its last entry,
    // so a terminal entry is required or the loop runs to the ceiling.
    { text: 'Recorded the build commands.' },
  ]
  const llm = makeScriptedLlm(script)
  const toolkit = createMemoryToolkit(ctxWith(fs, llm), config, [ROOT], signal)
  const { outcome, rounds } = await runMemoryAgent(ctxWith(fs, llm), config, route, 'sys', 'go', toolkit, signal)

  assert.equal(rounds, 4, 'three tool rounds plus the closing round')
  assert.equal(outcome.status, 'saved')
  assert.deepEqual(outcome.writtenFiles.map((file) => file.path).sort(), ['MEMORY.md', 'build.md'])
  assert.equal(outcome.indexUpdated, true)
  assert.equal(outcome.contentUpdated, true)
  assert.match(fs.files.get('C:\\home\\.dsh\\memory\\build.md'), /new/)
  // The transcript grew: one user message, then per round an assistant call
  // message and one tool result per call (list, read, write, write).
  assert.equal(llm.calls.length, 4)
  const lastMessages = llm.calls[3].messages
  assert.equal(lastMessages.filter((message) => message.role === 'tool').length, 4)
  const firstToolResult = lastMessages.find((message) => message.role === 'tool')
  assert.equal(firstToolResult.toolCallId, 'c1')
  assert.equal(firstToolResult.source.kind, 'tool')
})

await test('the agent is given the tools on every round', async () => {
  const fs = makeFs({})
  const llm = makeScriptedLlm([{ text: 'nothing to do' }])
  const toolkit = createMemoryToolkit(ctxWith(fs, llm), config, [ROOT], signal)
  await runMemoryAgent(ctxWith(fs, llm), config, route, 'sys', 'go', toolkit, signal)
  assert.equal(llm.calls.length, 1)
  assert.equal(llm.calls[0].tools.length, memoryToolSchemas().length, 'every round gets the whole family')
  assert.equal(llm.calls[0].system, 'sys')
})

await test('a text-only answer ends the loop and still allows the JSON fallback', async () => {
  const fs = makeFs({})
  const plan = JSON.stringify({ writes: [{ rootId: 'user', path: 'x.md', content: 'body' }] })
  const llm = makeScriptedLlm([{ text: plan }])
  const toolkit = createMemoryToolkit(ctxWith(fs, llm), config, [ROOT], signal)
  const { outcome, text, rounds } = await runMemoryAgent(ctxWith(fs, llm), config, route, 'sys', 'go', toolkit, signal)
  assert.equal(rounds, 1)
  assert.equal(outcome.status, 'no_change', 'no tool wrote anything')
  assert.match(text, /"writes"/, 'the caller can fall back to parsing this')
})

await test('a refused write with no stated reason still explains the failure', async () => {
  // This is the shape a reader actually hits: the pass says `failed` and there is no
  // reason anywhere, because a tool-driven pass never states one. The refusal is the
  // only explanation that exists, so it becomes the reason.
  const fs = makeFs({})
  const llm = makeScriptedLlm([
    {
      calls: [
        { id: 'c', name: 'memory_write', arguments: JSON.stringify({ rootId: 'user', path: '../escape.md', content: 'x' }) },
      ],
    },
  ])
  const toolkit = createMemoryToolkit(ctxWith(fs, llm), config, [ROOT], signal)
  const { outcome } = await runMemoryAgent(ctxWith(fs, llm), config, route, 'sys', 'go', toolkit, signal)
  assert.equal(outcome.status, 'failed', 'one attempt, nothing landed')
  assert.equal(outcome.writtenFiles.length, 0)
  assert.deepEqual(outcome.failedFiles.map((file) => file.path), ['../escape.md'])
  assert.match(outcome.reason, /every attempt was refused/)
  assert.match(outcome.reason, /relative \.md path/, 'the reason carries the refusal itself')
})

await test('a round cut short by the output cap still lands its tool calls', async () => {
  // The model hit its output budget AFTER asking for a write. Discarding the round made
  // every such pass report `failed` even though the write was complete — the exact
  // "最近一次生成总是 failed" this was found from.
  const fs = makeFs({})
  const llm = makeScriptedLlm([
    {
      calls: [
        { id: 'c', name: 'memory_write', arguments: JSON.stringify({ rootId: 'user', path: 'saved.md', content: 'body' }) },
      ],
      finish: 'max-tokens',
    },
  ])
  const toolkit = createMemoryToolkit(ctxWith(fs, llm), config, [ROOT], signal)
  const { outcome, rounds } = await runMemoryAgent(ctxWith(fs, llm), config, route, 'sys', 'go', toolkit, signal)
  assert.equal(outcome.status, 'saved', 'the write it did ask for landed')
  assert.deepEqual(outcome.writtenFiles.map((file) => file.path), ['saved.md'])
  assert.equal(rounds, 1, 'a cut-short round ends the loop: asking again would repeat it')
  assert.equal(fs.files.get('C:\\home\\.dsh\\memory\\saved.md'), 'body')
})

await test('a round cut short with nothing usable fails and names the cap', async () => {
  // The other half: the budget was spent before any tool call arrived, so there is
  // nothing to land and the reason must say which knob to turn.
  const fs = makeFs({})
  const llm = makeScriptedLlm([{ text: 'thinking out loud…', finish: 'max-tokens' }])
  const toolkit = createMemoryToolkit(ctxWith(fs, llm), config, [ROOT], signal)
  await assert.rejects(
    () => runMemoryAgent(ctxWith(fs, llm), config, route, 'sys', 'go', toolkit, signal),
    /generation reached maxOutputTokens/,
  )
})

await test('the reply is left uncapped unless the operator sets a cap', async () => {
  // The original's memory options have no token field, so the default is this port's
  // choice: omitting `maxTokens` lets the adapter apply the model's own default, which
  // is the only budget that fits a model writing file bodies through tool calls.
  const fs = makeFs({})
  const llm = makeScriptedLlm([{ text: 'nothing to save' }])
  const uncapped = { generation: { ...config.generation, maxOutputTokens: 0 } }
  await runMemoryAgent(ctxWith(fs, llm), uncapped, route, 'sys', 'go', createMemoryToolkit(ctxWith(fs, llm), uncapped, [ROOT], signal), signal)
  assert.equal('maxTokens' in llm.calls[0], false, 'no cap is sent when the default is 0')

  const cappedLlm = makeScriptedLlm([{ text: 'nothing to save' }])
  const capped = { generation: { ...config.generation, maxOutputTokens: 4096 } }
  await runMemoryAgent(ctxWith(fs, cappedLlm), capped, route, 'sys', 'go', createMemoryToolkit(ctxWith(fs, cappedLlm), capped, [ROOT], signal), signal)
  assert.equal(cappedLlm.calls[0].maxTokens, 4096, 'an explicit cap is sent as given')
})

await test('the loop stops at the round ceiling', async () => {
  const fs = makeFs({})
  // A model that lists forever must not run forever.
  const llm = makeScriptedLlm([{ calls: [{ id: 'c', name: 'memory_list', arguments: '{"rootId":"user"}' }] }], {
    repeatLast: true,
  })
  const toolkit = createMemoryToolkit(ctxWith(fs, llm), config, [ROOT], signal)
  const { rounds } = await runMemoryAgent(ctxWith(fs, llm), config, route, 'sys', 'go', toolkit, signal)
  assert.equal(rounds, MAX_AGENT_ROUNDS)
})

/* ---------------- search ---------------- */

await test('memory_search finds existing knowledge before a write', async () => {
  const fs = makeFs({
    'C:\\home\\.dsh\\memory\\MEMORY.md': '# Index\n\n- [Build](build.md) - commands',
    'C:\\home\\.dsh\\memory\\build.md': '---\nname: Build\ndescription: build\ntype: project\n---\n\nRun pnpm test.',
    'C:\\home\\.dsh\\memory\\other.md': '---\nname: Other\ntype: reference\n---\n\nunrelated',
  })
  const script = [
    { calls: [{ id: 'c1', name: 'memory_search', arguments: JSON.stringify({ query: 'pnpm' }) }] },
    {
      calls: [
        {
          id: 'c2',
          name: 'memory_write',
          arguments: JSON.stringify({
            rootId: 'user',
            path: 'build.md',
            content: '---\nname: Build\ndescription: build\ntype: project\n---\n\nRun pnpm test, then pnpm lint.',
          }),
        },
      ],
    },
  ]
  const llm = makeScriptedLlm(script)
  const toolkit = createMemoryToolkit(ctxWith(fs, llm), config, [ROOT], signal)
  const { outcome } = await runMemoryAgent(ctxWith(fs, llm), config, route, 'sys', 'go', toolkit, signal)

  // The search result the model saw names the file, the line and the kind.
  const afterSearch = llm.calls[1].messages.find((message) => message.role === 'tool')
  assert.match(afterSearch.content[0].text, /user:build\.md:7 \[project\] Run pnpm test\./)
  assert.match(afterSearch.content[0].text, /1 match\(es\) in 1 file\(s\)/)
  assert.ok(!afterSearch.content[0].text.includes('other.md'), 'a file without the needle is not reported')
  // And the pass updated the existing file rather than creating a new topic.
  assert.deepEqual(outcome.writtenFiles.map((file) => file.path), ['build.md'])
  assert.equal(outcome.status, 'saved')
})

await test('memory_search narrows to one root and reports a bad one', async () => {
  const fs = makeFs({ 'C:\\home\\.dsh\\memory\\build.md': 'run pnpm test' })
  const toolkit = createMemoryToolkit(ctxWith(fs, makeScriptedLlm([])), config, [ROOT], signal)

  const narrowed = await toolkit.execute('memory_search', { query: 'pnpm', rootId: 'user' })
  assert.equal(narrowed.isError, false)
  assert.match(narrowed.text, /build\.md/)

  const unknown = await toolkit.execute('memory_search', { query: 'pnpm', rootId: 'nope' })
  assert.equal(unknown.isError, true)
  assert.match(unknown.text, /unknown root "nope"/)

  const tooShort = await toolkit.execute('memory_search', { query: 'p' })
  assert.equal(tooShort.isError, true)
  assert.match(tooShort.text, /query is too short/)
})

/* ---------------- confinement ---------------- */

await test('the agent cannot write outside a root', async () => {
  const fs = makeFs({})
  const llm = makeScriptedLlm([
    {
      calls: [
        { id: 'c1', name: 'memory_write', arguments: JSON.stringify({ rootId: 'user', path: '../escape.md', content: 'x' }) },
        { id: 'c2', name: 'memory_write', arguments: JSON.stringify({ rootId: 'nope', path: 'a.md', content: 'x' }) },
        { id: 'c3', name: 'memory_write', arguments: JSON.stringify({ rootId: 'user', path: 'notes.txt', content: 'x' }) },
      ],
    },
  ])
  const toolkit = createMemoryToolkit(ctxWith(fs, llm), config, [ROOT], signal)
  const { outcome } = await runMemoryAgent(ctxWith(fs, llm), config, route, 'sys', 'go', toolkit, signal)
  assert.equal(outcome.status, 'failed')
  assert.equal(outcome.writtenFiles.length, 0)
  assert.equal(outcome.failedFiles.length, 3)
  assert.ok(![...fs.files.keys()].some((key) => key.includes('escape')))
})

await test('the agent will not read the index (it is already supplied)', async () => {
  const fs = makeFs({ 'C:\\home\\.dsh\\memory\\MEMORY.md': '# Index' })
  const llm = makeScriptedLlm([
    { calls: [{ id: 'c1', name: 'memory_read', arguments: JSON.stringify({ rootId: 'user', path: 'MEMORY.md' }) }] },
  ])
  const toolkit = createMemoryToolkit(ctxWith(fs, llm), config, [ROOT], signal)
  await runMemoryAgent(ctxWith(fs, llm), config, route, 'sys', 'go', toolkit, signal)
  const result = llm.calls[1]?.messages?.find((message) => message.role === 'tool')
  assert.match(result.content[0].text, /already provided/)
  assert.equal(result.isError, true)
})

await test('a read-only root refuses writes', async () => {
  const fs = makeFs({})
  const readOnly = { ...ROOT, access: 'read' }
  const llm = makeScriptedLlm([
    { calls: [{ id: 'c1', name: 'memory_write', arguments: JSON.stringify({ rootId: 'user', path: 'a.md', content: 'x' }) }] },
  ])
  const toolkit = createMemoryToolkit(ctxWith(fs, llm), config, [readOnly], signal)
  const { outcome } = await runMemoryAgent(ctxWith(fs, llm), config, route, 'sys', 'go', toolkit, signal)
  assert.equal(outcome.status, 'failed')
  assert.match(outcome.failedFiles[0].error, /read-only/)
})

await test('malformed tool arguments are reported, not thrown', async () => {
  const fs = makeFs({})
  const llm = makeScriptedLlm([{ calls: [{ id: 'c1', name: 'memory_write', arguments: 'not json' }] }])
  const toolkit = createMemoryToolkit(ctxWith(fs, llm), config, [ROOT], signal)
  const { outcome } = await runMemoryAgent(ctxWith(fs, llm), config, route, 'sys', 'go', toolkit, signal)
  assert.equal(outcome.status, 'no_change')
  const result = llm.calls[1].messages.find((message) => message.role === 'tool')
  assert.match(result.content[0].text, /JSON/)
  assert.equal(result.isError, true)
})

await test('a write past the per-pass budget is deferred, not refused', async () => {
  // Reported live in the panel as `写入被拒 status.md：at most 4 files may be written per pass`
  // — a pass that had simply finished its budget read as a broken one. The budget is this
  // plugin's own runaway guard (Qoder states no such cap), so nothing failed: the write was
  // not attempted, and the next pass continues from the index.
  const fs = makeFs({})
  const narrow = { generation: { ...config.generation, maxWrites: 1 } }
  const llm = makeScriptedLlm([
    {
      calls: [
        { id: 'c1', name: 'memory_write', arguments: JSON.stringify({ rootId: 'user', path: 'a.md', content: 'x' }) },
        { id: 'c2', name: 'memory_write', arguments: JSON.stringify({ rootId: 'user', path: 'b.md', content: 'x' }) },
      ],
    },
  ])
  const toolkit = createMemoryToolkit(ctxWith(fs, llm), narrow, [ROOT], signal)
  const { outcome } = await runMemoryAgent(ctxWith(fs, llm), narrow, route, 'sys', 'go', toolkit, signal)
  assert.equal(outcome.writtenFiles.length, 1, 'only the first write lands')
  assert.equal(outcome.status, 'saved', 'nothing failed — the budget ran out')
  assert.deepEqual(outcome.failedFiles, [], 'a deferred write is not a failure')
  assert.deepEqual(outcome.deferredFiles, [{ rootId: 'user', path: 'b.md', error: perPassBudgetNote(1) }])
  assert.match(outcome.reason, /per-pass write budget \(1\) is spent/)
  // The model is told too, so it wraps up instead of retrying the same write.
  const toolMessages = llm.calls[1].messages.filter((message) => message.role === 'tool')
  assert.match(toolMessages.at(-1).content[0].text, /not attempted: the per-pass write budget \(1\) is spent/)
})

await test('a budget of 0 means no cap, so every write lands', async () => {
  // The README's convention for these knobs is `0 = no cap` (`maxOutputTokens` works that way);
  // a 0 that forbade every write contradicted it.
  const fs = makeFs({})
  const uncapped = { generation: { ...config.generation, maxWrites: 0 } }
  const calls = ['a.md', 'b.md', 'c.md'].map((path, index) => ({
    id: `c${index}`,
    name: 'memory_write',
    arguments: JSON.stringify({ rootId: 'user', path, content: 'x' }),
  }))
  const llm = makeScriptedLlm([{ calls }])
  const toolkit = createMemoryToolkit(ctxWith(fs, llm), uncapped, [ROOT], signal)
  const { outcome } = await runMemoryAgent(ctxWith(fs, llm), uncapped, route, 'sys', 'go', toolkit, signal)
  assert.deepEqual(outcome.writtenFiles.map((file) => file.path), ['a.md', 'b.md', 'c.md'])
  assert.deepEqual(outcome.deferredFiles, [])
  assert.equal(outcome.status, 'saved')
})

await test('deleting removes the file and says to fix the index', async () => {
  const fs = makeFs({ 'C:\\home\\.dsh\\memory\\a.md': 'x', 'C:\\home\\.dsh\\memory\\MEMORY.md': '# Index' })
  const llm = makeScriptedLlm([
    { calls: [{ id: 'c1', name: 'memory_delete', arguments: JSON.stringify({ rootId: 'user', path: 'a.md' }) }] },
  ])
  const toolkit = createMemoryToolkit(ctxWith(fs, llm), config, [ROOT], signal)
  const { outcome } = await runMemoryAgent(ctxWith(fs, llm), config, route, 'sys', 'go', toolkit, signal)
  const result = llm.calls[1].messages.find((message) => message.role === 'tool')
  assert.equal(result.isError, undefined)
  assert.match(result.content[0].text, /deleted user:a\.md/)
  assert.match(result.content[0].text, /rewrite the index without its entry/)
  assert.equal(fs.files.has('C:\\home\\.dsh\\memory\\a.md'), false, 'the file is really gone')
  // A delete is a change, and it is reported as one rather than as a write.
  assert.equal(outcome.status, 'saved')
  assert.deepEqual(outcome.deletedFiles, [{ rootId: 'user', path: 'a.md', bytes: 0, deleted: true }])
  assert.equal(outcome.contentUpdated, true, 'the content file it pointed at is gone')
})

await test('a delete outside the allow-list is refused and recorded', async () => {
  const fs = makeFs({ 'C:\\home\\.dsh\\memory\\a.md': 'x' })
  const llm = makeScriptedLlm([
    { calls: [{ id: 'c1', name: 'memory_delete', arguments: JSON.stringify({ rootId: 'user', path: '../escape.md' }) }] },
    { calls: [{ id: 'c2', name: 'memory_delete', arguments: JSON.stringify({ rootId: 'nope', path: 'a.md' }) }] },
  ])
  const toolkit = createMemoryToolkit(ctxWith(fs, llm), config, [ROOT], signal)
  const { outcome } = await runMemoryAgent(ctxWith(fs, llm), config, route, 'sys', 'go', toolkit, signal)
  assert.equal(outcome.status, 'failed', 'two refusals and nothing deleted')
  assert.equal(outcome.failedFiles.length, 2)
  assert.match(outcome.failedFiles[0].error, /relative \.md path/)
  assert.match(outcome.failedFiles[1].error, /unknown root/)
  assert.equal(fs.files.get('C:\\home\\.dsh\\memory\\a.md'), 'x', 'the file survives')
})

console.log(`\n${passed} agent tests passed`)
