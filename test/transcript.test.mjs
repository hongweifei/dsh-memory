/**
 * Regression tests for the transcript readers.
 *
 * Two properties matter for cost and for the `minPromptChars` gate:
 *   1. the block this plugin injects at pre-step (`source.kind === 'memory'`) must not be
 *      counted as the user's prompt;
 *   2. a pass transcript must stay inside `MAX_TRANSCRIPT_CHARS`.
 *
 * Run: node test/transcript.test.mjs
 */
import assert from 'node:assert/strict'
import { MAX_TRANSCRIPT_CHARS, collectTranscript } from '../lib/memory/transcript.js'

const SNAPSHOT = '# Memory index\n' + '- entry\n'.repeat(4000)

const events = [
  { seq: 1, type: 'turn/start', data: {} },
  {
    seq: 2,
    type: 'user/message',
    data: {
      content: [{ type: 'text', text: SNAPSHOT }],
      source: { kind: 'memory', identity: 'snapshot' },
    },
  },
  { seq: 3, type: 'user/message', data: { content: [{ type: 'text', text: '\u597d' }] } },
  {
    seq: 4,
    type: 'assistant/message',
    data: { message: { content: [{ type: 'text', text: 'A'.repeat(80000) }] } },
  },
  { seq: 5, type: 'tool/result', data: { content: [{ type: 'text', text: 'B'.repeat(20000) }] } },
]

const session = { snapshotEvents: () => events, id: 'test-session' }

let passed = 0
function test(name, body) {
  body()
  passed += 1
  console.log(`  ok ${name}`)
}

test('the injected memory block is not counted as the user prompt', () => {
  const transcript = collectTranscript(session, 0)
  assert.equal(transcript.prompt.includes('Memory index'), false)
  // A one-character user message must stay one character, otherwise any
  // `minPromptChars` gate up to the snapshot size passes silently.
  assert.equal(transcript.prompt, '\u597d')
})

test('the joined transcript is capped and truncated from the head', () => {
  const transcript = collectTranscript(session, 0)
  assert.ok(transcript.response.length <= MAX_TRANSCRIPT_CHARS)
  assert.match(transcript.response, /^\[transcript truncated: \d+ characters dropped from the head of the assistant response\]\n/)
  // Recency wins: the tail of the answer survives.
  assert.ok(transcript.response.endsWith('AAAA'))
})

test('tool results never enter the transcript', () => {
  const transcript = collectTranscript(session, 0)
  assert.equal(transcript.response.includes('BBBB'), false)
  assert.equal(transcript.prompt.includes('BBBB'), false)
})

test('the cursor still advances to the last event seq', () => {
  assert.equal(collectTranscript(session, 0).lastSeq, 5)
})

test('short transcripts are left untouched', () => {
  const small = [{ seq: 1, type: 'user/message', data: { content: [{ type: 'text', text: 'hi' }] } }]
  const transcript = collectTranscript({ snapshotEvents: () => small, id: 'small' }, 0)
  assert.equal(transcript.prompt, 'hi')
  assert.equal(transcript.response, '')
})

console.log(`\n${passed} tests passed`)
