/**
 * Reading a conversation out of the session log.
 *
 * Split out of the generation pass because it is the one part of it that only
 * reads the log: which messages a pass gets to see, and where the cursor that
 * makes it incremental sits.
 *
 * The cursor is Qoder's:
 *
 * ```js
 * function MOl(messages, lastProcessedUuid) {
 *   if (!lastProcessedUuid) return [...messages]
 *   const at = messages.findIndex((m) => m.uuid === lastProcessedUuid)
 *   return at === -1 ? [...messages] : messages.slice(at + 1)
 * }
 * ```
 *
 * It exists because the pass is PACED: with an interval above one turn, or with a
 * pass that runs inside a turn, collecting only the turn that happens to trigger
 * the pass would silently drop everything before it.
 *
 * @module @dsh-external/dsh-memory/transcript
 */

/**
 * Cost guards for the pass transcript (2026-11-25).
 *
 * B1: the memory block this plugin injects at pre-step is itself a `user/message`
 * with `source.kind === 'memory'`. Counting it as the user's own words (a) billed the
 * whole snapshot (tens of KB) to every pass after an injection and (b) made
 * `generation.turnComplete.minPromptChars` meaningless — a 37 KB snapshot always
 * clears a 200-character gate. Such events are skipped; the pass still receives the
 * `MEMORY.md` indexes separately (see `memory-prompt.js`).
 *
 * B2: without a cap, one long answer turns the next pass into a huge prompt. The
 * joined transcript is capped and truncated from the head (recency wins) with a
 * marker line, so the model can tell that older text was dropped.
 */
export const MAX_TRANSCRIPT_CHARS = 24000
const MIN_SIDE_CHARS = 2000

/** True when an event carries a block this plugin itself injected. */
function isInjectedMemory(event) {
  const data = event !== null && typeof event === 'object' ? event.data : undefined
  for (const source of [data?.source, data?.message?.source]) {
    if (source !== null && typeof source === 'object' && source.kind === 'memory') return true
  }
  return false
}

/** Keep the tail of `text` inside `budget` characters, marking the loss. */
function clipToBudget(text, budget, side) {
  if (text.length <= budget) return text
  const dropped = text.length - budget
  return `[transcript truncated: ${dropped} characters dropped from the head of the ${side}]\n${text.slice(-budget)}`
}

/** Cap the joined transcript proportionally, keeping the most recent text. */
function capTranscript(prompt, response) {
  const total = prompt.length + response.length
  if (total <= MAX_TRANSCRIPT_CHARS) return { prompt, response }
  const ratio = MAX_TRANSCRIPT_CHARS / total
  const promptBudget = Math.max(MIN_SIDE_CHARS, Math.floor(prompt.length * ratio))
  const responseBudget = Math.max(MIN_SIDE_CHARS, MAX_TRANSCRIPT_CHARS - promptBudget)
  return {
    prompt: clipToBudget(prompt, promptBudget, 'user prompt'),
    response: clipToBudget(response, responseBudget, 'assistant response'),
  }
}

/**
 * Join the text blocks of one content array.
 *
 * @param content - a message `content` array.
 * @returns the concatenated text.
 */
export function textOf(content) {
  if (!Array.isArray(content)) return ''
  return content
    .filter(
      (block) => block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string',
    )
    .map((block) => block.text)
    .join('\n')
}

/**
 * Extract the prompt(s) and response(s) of one finished turn from the log.
 *
 * @param session - the live session.
 * @param turn - the turn number that just ended.
 * @returns `{ prompt, response }`.
 */
export function collectTurn(session, turn) {
  const events = session.snapshotEvents()
  let startIndex = 0
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index].type === 'turn/start' && events[index].data.turn === turn) {
      startIndex = index
      break
    }
  }
  return joinMessages(events.slice(startIndex))
}

/**
 * Extract every message since a cursor — Qoder's incremental transcript.
 *
 * The cursor is the event `seq`, the session log's own stable identity. An
 * unknown cursor means the whole transcript, as in the original: losing history
 * is worse than repeating it.
 *
 * @param session - the live session.
 * @param sinceSeq - the last event already sent to the model, if any.
 * @returns `{ prompt, response, lastSeq }`.
 */
export function collectTranscript(session, sinceSeq) {
  const events = session.snapshotEvents()
  const at = typeof sinceSeq === 'number' ? events.findIndex((event) => event.seq === sinceSeq) : -1
  const slice = at === -1 ? events : events.slice(at + 1)
  return { ...joinMessages(slice), lastSeq: events.at(-1)?.seq }
}

/**
 * The turn a session is currently in, or `0` when no turn is open.
 *
 * An in-turn pass needs to name the turn it ran inside, and the log is the only
 * place that knows: the newest `turn/start` without a matching `turn/end`.
 *
 * @param session - the live session.
 * @returns the turn number, or `0`.
 */
export function turnInProgress(session) {
  let turn = 0
  try {
    for (const event of session.snapshotEvents()) {
      if (event.type === 'turn/start') turn = event.data.turn
      if (event.type === 'turn/end') turn = 0
    }
  } catch {
    return 0
  }
  return turn
}

/** Join the user and assistant text of an event slice. */
function joinMessages(events) {
  const prompts = []
  const responses = []
  for (const event of events) {
    if (event.type === 'user/message') {
      // B1: never feed this plugin's own injection back in as the user's words.
      if (isInjectedMemory(event)) continue
      const text = textOf(event.data.content)
      if (text.length > 0) prompts.push(text)
    } else if (event.type === 'assistant/message') {
      const text = textOf(event.data.message?.content)
      if (text.length > 0) responses.push(text)
    }
  }
  // B2: cap the window so one long answer cannot inflate a single pass.
  return capTranscript(prompts.join('\n\n'), responses.join('\n\n'))
}
