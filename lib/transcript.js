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
      const text = textOf(event.data.content)
      if (text.length > 0) prompts.push(text)
    } else if (event.type === 'assistant/message') {
      const text = textOf(event.data.message?.content)
      if (text.length > 0) responses.push(text)
    }
  }
  return { prompt: prompts.join('\n\n'), response: responses.join('\n\n') }
}
