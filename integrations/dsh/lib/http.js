/**
 * Minimal HTTP helpers for the adapters.
 *
 * Everything here runs on the Host's global `fetch` (Node 20+), so there is no
 * dependency to install. Timeouts are enforced with an `AbortController` and
 * composed with the caller's signal, so a plugin-level budget and the request's
 * own cancellation both bound one attempt.
 *
 * @module dsh-agent-web-search/http
 */

/** One attempt's failure, carrying enough detail for the all-failed summary. */
export class UpstreamError extends Error {
  /**
   * @param {string} message - short, credential-free description.
   * @param {{status?: number, kind?: string}} [details] - optional HTTP facts.
   */
  constructor(message, details = {}) {
    super(message)
    this.name = 'UpstreamError'
    this.status = details.status
    this.upstream = details.kind
  }
}

/**
 * Compose a per-attempt timeout with the caller's cancellation.
 *
 * @param {number} timeoutMs - the per-attempt budget.
 * @param {AbortSignal | undefined} signal - the caller's signal, if any.
 * @returns {{signal: AbortSignal, cleanup: () => void}} the composed signal.
 */
export function attemptSignal(timeoutMs, signal) {
  const controller = new AbortController()
  const timer = setTimeout(() => {
    controller.abort(new DOMException(`attempt timed out after ${String(timeoutMs)} ms`, 'TimeoutError'))
  }, timeoutMs)
  const composed = signal === undefined
    ? controller.signal
    : AbortSignal.any([signal, controller.signal])
  return { signal: composed, cleanup: () => { clearTimeout(timer) } }
}

/**
 * `fetch` a JSON API and return the parsed body.
 *
 * @param {string} url - absolute request URL.
 * @param {{method?: string, headers?: Record<string, string>, body?: unknown, signal: AbortSignal, timeoutMs: number, what: string}} options - request facts.
 * @returns {Promise<unknown>} the parsed JSON body.
 * @throws {UpstreamError} on a non-2xx status, unparseable body, or network failure.
 */
export async function fetchJson(url, options) {
  const { status, text } = await fetchText(url, options)
  if (status < 200 || status >= 300) {
    throw new UpstreamError(`${options.what} HTTP ${String(status)}`, { status, kind: options.what })
  }
  try {
    return JSON.parse(text)
  } catch {
    throw new UpstreamError(`${options.what} returned invalid JSON`, { kind: options.what })
  }
}

/**
 * `fetch` a response and return its status with the raw text body.
 *
 * @param {string} url - absolute request URL.
 * @param {{method?: string, headers?: Record<string, string>, body?: unknown, signal: AbortSignal, timeoutMs: number, what: string}} options - request facts.
 * @returns {Promise<{status: number, text: string}>} the response facts.
 * @throws {UpstreamError} on network failure or timeout.
 */
export async function fetchText(url, options) {
  const method = options.method ?? (options.body === undefined ? 'GET' : 'POST')
  const headers = { ...options.headers }
  if (options.body !== undefined) headers['content-type'] = 'application/json'
  try {
    const response = await fetch(url, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: options.signal,
    })
    return { status: response.status, text: await response.text() }
  } catch (error) {
    if (options.signal.aborted) throw error
    throw new UpstreamError(
      `${options.what} network error: ${error instanceof Error ? error.message : String(error)}`,
      { kind: options.what },
    )
  }
}

/**
 * POST a JSON-RPC 2.0 envelope the way both MCP-over-HTTP upstreams expect.
 *
 * The two free endpoints (Exa, Parallel) speak stateless Streamable HTTP, so a
 * single `tools/call` works; the text may arrive either as a JSON body or as an
 * SSE stream carrying `data:` lines.
 *
 * @param {string} url - the MCP endpoint.
 * @param {object} payload - the JSON-RPC envelope.
 * @param {{signal: AbortSignal, timeoutMs: number, what: string, sessionId?: string, headers?: Record<string, string>}} options - request facts.
 * @returns {Promise<{status: number, body: string, sessionId: string | null}>} the response.
 */
export async function postJsonRpc(url, payload, options) {
  const headers = {
    accept: 'application/json, text/event-stream',
    // Both free MCP endpoints answer 415 without this: `fetch` only infers a
    // content type for a few body shapes, and a JSON string is not one of them.
    'content-type': 'application/json',
    ...options.headers,
  }
  if (options.sessionId !== undefined && options.sessionId !== null) {
    headers['mcp-session-id'] = options.sessionId
  }
  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
    signal: options.signal,
  })
  const body = await response.text()
  return { status: response.status, body, sessionId: response.headers.get('mcp-session-id') }
}

/**
 * Read the JSON-RPC result out of either a plain body or an SSE stream.
 *
 * @param {string} body - the raw response text.
 * @returns {unknown} the first parsed message carrying `result` or `error`, or undefined.
 */
export function readJsonRpc(body) {
  const trimmed = (body ?? '').trim()
  if (trimmed.length === 0) return undefined
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed)
      return Array.isArray(parsed) ? parsed.find(m => m?.result !== undefined || m?.error !== undefined) : parsed
    } catch {
      return undefined
    }
  }
  for (const line of trimmed.split('\n')) {
    if (!line.startsWith('data:')) continue
    const payload = line.slice(5).trim()
    if (payload.length === 0) continue
    try {
      const parsed = JSON.parse(payload)
      if (parsed?.result !== undefined || parsed?.error !== undefined) return parsed
    } catch {
      continue
    }
  }
  return undefined
}
