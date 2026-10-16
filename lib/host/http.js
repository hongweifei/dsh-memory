/**
 * The two HTTP primitives every route module shares.
 *
 * They live here, below both route modules, because the writing routes all need the
 * same refusals (unparseable, not an object — an array is not an object here) and the
 * same response shape; three copies of that preamble is how one of them silently
 * diverges. `routes.js` and `config-route.js` are at the same layer and may not import
 * each other, so the shared part is its own leaf.
 *
 * @module @dsh-external/dsh-memory/host/http
 */

/**
 * Read a JSON object body, or the error response to send instead.
 *
 * @param request - the incoming request.
 * @returns `{ body }` or `{ error }`, a ready-to-send response.
 */
export async function readJsonBody(request) {
  let body
  try {
    body = await request.json()
  } catch {
    return { error: sendJson(400, { error: 'body must be JSON' }) }
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { error: sendJson(400, { error: 'body must be a JSON object' }) }
  }
  return { body }
}

/** JSON response with no caching: every value here is a live fact. */
export function sendJson(status, payload) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}
