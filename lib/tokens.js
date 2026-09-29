/**
 * Token accounting.
 *
 * The numbers this plugin reports must agree with the rest of the Harness, so
 * pricing defers to `ctx.tokenMeter` when that service is mounted and otherwise
 * reproduces `dsh-token-meter`'s own heuristic exactly (4 characters per token,
 * a per-block overhead, and 4 tokens of role framing). No third estimator.
 *
 * @module @dsh-external/dsh-memory/tokens
 */

/**
 * Characters per token in the harness's heuristic. Exported so every module
 * that converts between bytes and tokens uses ONE ratio instead of copies that
 * can silently diverge.
 */
export const CHARS_PER_TOKEN = 4

const BLOCK_OVERHEAD = 4
const ROLE_FRAMING = 4

/**
 * Price one content block the way dsh-token-meter's `estimate` does.
 *
 * @param block - a model-facing content block.
 * @returns the block's token estimate.
 */
export function estimateBlock(block) {
  if (block === null || typeof block !== 'object') return 0
  if (block.type === 'text' || block.type === 'reasoning') {
    return Math.ceil(String(block.text ?? '').length / CHARS_PER_TOKEN) + BLOCK_OVERHEAD
  }
  if (block.type === 'tool-call') {
    return (
      Math.ceil(String(block.name ?? '').length / CHARS_PER_TOKEN) +
      Math.ceil(String(block.arguments ?? '').length / CHARS_PER_TOKEN) +
      BLOCK_OVERHEAD
    )
  }
  try {
    return BLOCK_OVERHEAD + Math.ceil(JSON.stringify(block).length / CHARS_PER_TOKEN)
  } catch {
    return BLOCK_OVERHEAD
  }
}

/**
 * Price one message: content blocks plus the harness's role framing.
 *
 * @param message - a message with a `content` array.
 * @returns the message's token estimate.
 */
export function estimateMessage(message) {
  const content = Array.isArray(message?.content) ? message.content : []
  let tokens = 0
  for (const block of content) tokens += estimateBlock(block)
  return tokens + ROLE_FRAMING
}

/**
 * Price one message through the mounted token meter when available, so this
 * plugin reports the same numbers the rest of the Harness shows.
 *
 * @param ctx - plugin context, used to look up the optional `tokenMeter`.
 * @param message - the message to price.
 * @returns the token estimate.
 */
function measureMessage(ctx, message) {
  const meter = ctx.get('tokenMeter')
  if (meter !== undefined && typeof meter.estimateMessage === 'function') {
    try {
      return meter.estimateMessage(message)
    } catch {
      /* fall through to the mirrored heuristic */
    }
  }
  return estimateMessage(message)
}

/**
 * Build a measure function over a list of messages, bound to one context.
 *
 * @param ctx - plugin context.
 * @returns a function pricing a whole message list.
 */
export function createMeasure(ctx) {
  return (messages) => messages.reduce((total, message) => total + measureMessage(ctx, message), 0)
}
