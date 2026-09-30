/**
 * The aggregation engine: one query in, a merged result set out.
 *
 * This is the part the upstream `agent-web-search` is actually built around.
 * Two modes exist because "ask many backends at once" and "walk backends until
 * one answers" are genuinely different behaviours:
 *
 *  - `fanout` (default) — every enabled upstream is queried concurrently and
 *    the answers are merged and de-duplicated. This is the cross-validation
 *    shape: one upstream's gap is another's coverage.
 *  - `fallback` — upstreams are walked in queue order and the first success
 *    wins. Cheaper and more predictable, but the later entries never run, so
 *    it is NOT a substitute for fanout.
 *
 * Failures never abort the whole search: in `fanout` every upstream is allowed
 * to fail, and in `fallback` the walk simply continues. Only caller
 * cancellation and "nothing produced anything" end a search in error.
 *
 * @module dsh-agent-web-search/engine
 */

import { UpstreamError } from './http.js'
import { urlKey } from './keys.js'
import { KIND_LABEL } from './defaults.js'

/**
 * Run one upstream attempt with its own timeout budget.
 *
 * @param {object} options - the attempt facts.
 * @param {object} options.adapter - the kind's adapter.
 * @param {string} options.kind - the kind name, for diagnostics.
 * @param {string} options.query - the user query.
 * @param {number} options.maxResults - how many rows to ask this upstream for.
 * @param {string | undefined} options.apiKey - the resolved credential, if any.
 * @param {string | undefined} options.baseURL - the endpoint override, if any.
 * @param {AbortSignal | undefined} options.signal - caller cancellation.
 * @param {number} options.attemptTimeoutMs - the per-attempt budget.
 * @returns {Promise<{ok: true, results: Array<object>, answer: string} | {ok: false, reason: string}>} the attempt outcome.
 */
async function runAttempt({ adapter, entry, kind, query, maxResults, apiKey, baseURL, signal, attemptTimeoutMs }) {
  const timeout = new AbortController()
  const timer = setTimeout(() => {
    timeout.abort(new DOMException('upstream attempt timed out', 'TimeoutError'))
  }, attemptTimeoutMs)
  const composed = signal === undefined ? timeout.signal : AbortSignal.any([signal, timeout.signal])
  const startedAt = Date.now()
  try {
    const outcome = await adapter.search({
      query,
      maxResults,
      apiKey,
      entry,
      baseURL: baseURL ?? adapter.defaultBaseURL,
      signal: composed,
    })
    return {
      ok: true,
      results: Array.isArray(outcome?.results) ? outcome.results : [],
      answer: typeof outcome?.answer === 'string' ? outcome.answer : '',
      elapsedMs: Date.now() - startedAt,
    }
  } catch (error) {
    if (signal?.aborted === true) {
      return { ok: false, cancelled: true, elapsedMs: Date.now() - startedAt }
    }
    const reason = timeout.signal.aborted
      ? `timed out after ${String(attemptTimeoutMs)} ms`
      : error instanceof UpstreamError
        ? error.message
        : error instanceof Error ? error.message : String(error)
    return {
      ok: false, reason, elapsedMs: Date.now() - startedAt,
      diagnostic: timeout.signal.aborted ? 'timeout' : 'failed',
      httpStatus: error instanceof UpstreamError ? error.status : undefined,
    }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Resolve an entry's key pool through the credentials seam.
 *
 * @param {object} adapter - the kind's adapter.
 * @param {(ref: string) => Promise<string | undefined>} resolveValue - reads one credential reference.
 * @returns {Promise<string[]>} the key literals (empty when the kind is anonymous or unconfigured).
 */
async function resolveKeys(adapter, resolveValue, entry) {
  const ref = adapter.credentialRefOf?.(entry) ?? adapter.credentialRef
  if (ref === null || ref === undefined) return []
  const value = await resolveValue(ref)
  if (typeof value !== 'string' || value.trim().length === 0) return []
  if (entry.kind === 'mcp') return [value.trim()]
  return value.split(/[,\n]/).map(part => part.trim()).filter(part => part.length > 0)
}

/**
 * Merge result rows from several upstreams into one de-duplicated list.
 *
 * The first upstream to surface a URL owns its title and snippet; later
 * upstreams add their names to its provenance marker. `providers` remains a
 * machine-readable hint, but the DSH web seam only guarantees title/snippet/URL,
 * so the visible title carries provenance through the final search response.
 *
 * @param {Array<{kind: string, sourceId?: string, toolName?: string, results: Array<object>}>} batches - per-upstream rows.
 * @param {boolean} dedupeByUrl - whether to collapse rows sharing a URL.
 * @param {number} maxResults - the cap on returned rows.
 * @returns {{sources: Array<object>, truncated: boolean}} the merged rows.
 */
function sourceLabel(batch) {
  if (batch.kind !== 'mcp') return KIND_LABEL[batch.kind] ?? batch.kind
  const name = typeof batch.toolName === 'string' ? batch.toolName.replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 64) : ''
  const id = /^[a-z][a-z0-9-]{0,39}$/.test(batch.sourceId ?? '') ? batch.sourceId : ''
  return `MCP${name ? `: ${name}` : ''}${id ? ` (${id})` : ''}`
}

export function mergeResults(batches, dedupeByUrl, maxResults) {
  const rows = []
  const seen = new Map()
  for (const batch of batches) {
    for (const row of batch.results) {
      if (!row || typeof row.url !== 'string' || row.url.trim().length === 0) continue
      const normalized = urlKey(row.url)
      if (normalized.length === 0) continue
      const key = dedupeByUrl ? normalized : `${batch.kind}|${rows.length}`
      const label = sourceLabel(batch)
      const existing = seen.get(key)
      if (existing !== undefined) {
        if (!existing.providers.includes(batch.kind)) existing.providers.push(batch.kind)
        if (!existing.sourceLabels.includes(label)) existing.sourceLabels.push(label)
        if (existing.snippet.length === 0) existing.snippet = row.description ?? ''
        if (existing.publishedAt === undefined && row.publishedAt !== undefined) {
          existing.publishedAt = row.publishedAt
        }
        continue
      }
      const entry = {
        url: row.url.trim(),
        title: (row.title ?? '').trim(),
        snippet: (row.description ?? '').trim(),
        publishedAt: row.publishedAt,
        providers: [batch.kind],
        sourceLabels: [label],
      }
      seen.set(key, entry)
      rows.push(entry)
    }
  }
  // Prefer rows that carry a snippet: a bare URL is the least useful shape for
  // a model, so cross-validated rows should not be pushed out by bare ones.
  rows.sort((a, b) => Number(b.sourceLabels.length > 1) - Number(a.sourceLabels.length > 1)
    || Number(b.snippet.length > 0) - Number(a.snippet.length > 0)
    || b.sourceLabels.length - a.sourceLabels.length)
  const limited = rows.slice(0, maxResults)
  const sources = limited.map(({ sourceLabels, ...source }) => ({
    ...source,
    title: `【来源：${sourceLabels.join('、')}】${source.title ? ` ${source.title.replace(/\s+/g, ' ').slice(0, 300)}` : ''}`,
  }))
  return { sources, truncated: rows.length > limited.length }
}

/**
 * Run one query through the configured queue and merge whatever comes back.
 *
 * @param {object} options - the search facts.
 * @param {string} options.mode - `fanout` or `fallback`.
 * @param {Array<{kind: string, enabled?: boolean, baseURL?: string}>} options.providers - the resolved queue.
 * @param {Map<string, object>} options.adapters - kind → adapter.
 * @param {(ref: string) => Promise<string | undefined>} options.resolveValue - reads one credential reference.
 * @param {string} options.query - the user query.
 * @param {number} options.maxResults - the cap on returned rows.
 * @param {number} options.attemptTimeoutMs - per-upstream budget.
 * @param {number} options.totalTimeoutMs - whole-search budget.
 * @param {boolean} options.dedupeByUrl - collapse rows sharing a URL.
 * @param {boolean} options.includeAnswer - carry upstream prose answers through.
 * @param {AbortSignal | undefined} options.signal - caller cancellation.
 * @param {{info: Function, warn: Function}} [options.logger] - attempt logging.
 * @param {(event: {kind: string, status: string, durationMs: number, resultCount: number, httpStatus?: number}) => void} [options.onAttempt] - sanitized per-attempt observer.
 * @returns {Promise<{sources: Array<object>, truncated: boolean, content?: string, failures: Array<{kind: string, reason: string}>}>} the merged outcome.
 * @throws {UpstreamError} when nothing produced a result.
 */
export async function runSearch(options) {
  const {
    mode, providers, adapters, resolveValue, query, maxResults,
    attemptTimeoutMs, totalTimeoutMs, dedupeByUrl, includeAnswer, signal, logger, onAttempt,
  } = options

  const entries = providers.filter(entry => entry.enabled !== false && adapters.has(entry.kind))
  const failures = []
  const batches = []
  const answers = []

  // Per-upstream ask size: a fanout merges several small sets, so asking each
  // upstream for the full cap would over-fetch once they are combined.
  const perUpstream = mode === 'fanout'
    ? Math.max(3, Math.min(10, maxResults))
    : maxResults

  const total = new AbortController()
  const totalTimer = setTimeout(() => {
    total.abort(new DOMException('total search budget exhausted', 'TimeoutError'))
  }, totalTimeoutMs)
  const composed = signal === undefined ? total.signal : AbortSignal.any([signal, total.signal])

  const runOne = async (entry) => {
    const adapter = adapters.get(entry.kind)
    const observe = event => onAttempt?.({ kind: entry.kind, sourceId: entry.kind === 'mcp' ? entry.id : undefined, ...event })
    let keys = []
    try {
      keys = await resolveKeys(adapter, resolveValue, entry)
    } catch (error) {
      const reason = `credential resolution failed: ${error instanceof Error ? error.message : String(error)}`
      failures.push({ kind: entry.kind, reason })
      observe({ status: 'skipped', durationMs: 0, resultCount: 0 })
      logger?.warn('agent-web-search: %s credential unavailable: %s', entry.kind, reason)
      return
    }
    // One attempt per configured key, rotating across calls: a multi-key pool
    // spreads upstream quota instead of hammering one key.
    const attempts = keys.length > 0 ? keys : adapter.anonymousOk ? [undefined] : []
    if (attempts.length === 0) {
      const reason = `${adapter.credentialRef ?? 'credential'} is not set and this upstream needs a key`
      failures.push({ kind: entry.kind, reason })
      observe({ status: 'skipped', durationMs: 0, resultCount: 0 })
      return
    }
    for (const apiKey of attempts) {
      if (composed.aborted) throw new DOMException('search aborted', 'AbortError')
      const outcome = await runAttempt({
        adapter,
        entry,
        kind: entry.kind,
        query,
        maxResults: perUpstream,
        apiKey,
        baseURL: entry.baseURL,
        signal: composed,
        attemptTimeoutMs,
      })
      if (outcome.ok) {
        observe({ status: outcome.results.length > 0 || (includeAnswer && outcome.answer.trim()) ? 'success' : 'empty', durationMs: outcome.elapsedMs, resultCount: outcome.results.length })
        batches.push({ kind: entry.kind, sourceId: entry.id, toolName: entry.toolName, results: outcome.results })
        if (outcome.answer.trim().length > 0) answers.push({ kind: entry.kind, sourceId: entry.id, toolName: entry.toolName, answer: outcome.answer.trim() })
        logger?.info('agent-web-search: %s served the query in %d ms (%d rows)', entry.kind, outcome.elapsedMs, outcome.results.length)
        return outcome.results.length > 0 || (includeAnswer && outcome.answer.trim().length > 0)
      }
      if (outcome.cancelled) {
        observe({ status: 'cancelled', durationMs: outcome.elapsedMs, resultCount: 0 })
        throw new DOMException('search aborted', 'AbortError')
      }
      observe({ status: outcome.diagnostic, durationMs: outcome.elapsedMs, resultCount: 0, httpStatus: outcome.httpStatus })
      failures.push({ kind: entry.kind, reason: outcome.reason })
      logger?.warn('agent-web-search: %s attempt failed in %d ms: %s', entry.kind, outcome.elapsedMs, outcome.reason)
    }
    return false
  }

  try {
    if (mode === 'fallback') {
      for (const entry of entries) {
        if (composed.aborted) throw new DOMException('search aborted', 'AbortError')
        const served = await runOne(entry)
        if (served === true) break
      }
    } else {
      // Fanout: an upstream's failure must never cancel its siblings, so each
      // attempt owns its own rejection and `allSettled` never rejects.
      await Promise.allSettled(entries.map(async entry => await runOne(entry)))
    }
  } finally {
    clearTimeout(totalTimer)
  }

  if (signal?.aborted === true) throw new DOMException('search aborted', 'AbortError')

  const merged = mergeResults(batches, dedupeByUrl, maxResults)
  if (merged.sources.length === 0 && (!includeAnswer || answers.length === 0)) {
    const summary = failures.length === 0
      ? 'no upstream returned mapped results or an enabled text answer (see Settings → Web search)'
      : failures.map(failure => `${failure.kind}: ${failure.reason}`).join('; ')
    throw new UpstreamError(`agent-web-search: every attempt failed — ${summary}`, { kind: 'all-failed' })
  }

  const content = includeAnswer && answers.length > 0
    ? answers.map(item => `【来源：${sourceLabel(item)}】\n${item.answer}`).join('\n\n---\n\n')
    : undefined

  return {
    sources: merged.sources,
    truncated: merged.truncated,
    ...(content !== undefined ? { content } : {}),
    failures,
  }
}
