/**
 * `AgentWebSearchProvider`: the single provider this plugin registers into the
 * `ctx.web` search seam, backed by a configurable queue of upstreams.
 *
 * Registering exactly ONE provider is a hard requirement, not a preference: a
 * deployment that registers several available providers with no `searchProvider`
 * pinned raises `WEB_PROVIDER_AMBIGUOUS`. Aggregation is therefore this
 * plugin's internal business — the seam sees one provider, and the fan-out
 * happens behind it.
 *
 * Config is projected per request (`resolveConfig(snapshotsOf(config))`), so a
 * queue edited on the settings page reaches the very next search without a
 * restart or a re-registration.
 *
 * @module dsh-agent-web-search/provider
 */

import { WebError } from '@deepseek-ai/dsh-web'
import { ADAPTERS } from './adapters/index.js'
import { AGENT_WEB_SEARCH_PROVIDER_ID } from './defaults.js'
import { resolveConfig, snapshotsOf } from './config.js'
import { runSearch } from './engine.js'

/**
 * The provider handed to `ctx.web.registerSearchProvider`.
 */
export class AgentWebSearchProvider {
  /** Registry key. */
  id = AGENT_WEB_SEARCH_PROVIDER_ID

  /**
   * @param {object} options - the plugin's live services.
   * @param {() => object} options.config - reads the current config snapshots.
   * @param {(ref: string) => Promise<string | undefined>} options.resolveValue - reads one credential reference.
   * @param {{info: Function, warn: Function}} [options.logger] - attempt logging.
   */
  constructor(options) {
    this.options = options
  }

  /**
   * Cheap local check the seam calls before choosing this provider.
   *
   * It must not touch the network, so it only asks whether the queue has at
   * least one enabled upstream. A queue whose entries are enabled but keyless
   * still counts as available while it contains an anonymous kind — that is
   * precisely how a zero-configuration install serves searches.
   *
   * @returns {boolean} whether this provider should be considered usable.
   */
  available() {
    const config = resolveConfig(snapshotsOf(this.options.config()))
    return config.providers.some(entry => entry.enabled !== false && ADAPTERS.has(entry.kind))
  }

  /**
   * Run one search through the queue.
   *
   * @param {{query: string, maxResults?: number}} request - the seam's request; only these two fields exist.
   * @param {AbortSignal} [signal] - caller cancellation.
   * @returns {Promise<{sources: Array<object>, truncated: boolean, content?: string}>} the seam's result shape.
   * @throws {WebError} `WEB_ABORTED` on cancellation, `WEB_PROVIDER_UNAVAILABLE` when the queue is empty, `WEB_PROVIDER_ERROR` when every attempt failed.
   */
  async search(request, signal) {
    const config = resolveConfig(snapshotsOf(this.options.config()))
    const enabled = config.providers.filter(entry => entry.enabled !== false && ADAPTERS.has(entry.kind))
    const startedAt = Date.now()
    const attempts = []
    // Recording is diagnostic only; it must never cause or mask a search failure.
    const finish = (status, resultCount = 0) => {
      try {
        this.options.record?.({ mode: config.mode, status, resultCount, durationMs: Date.now() - startedAt, attempts })
      } catch { /* a broken observer cannot change search results */ }
    }
    if (enabled.length === 0) {
      finish('failed')
      throw new WebError(
        'agent-web-search: the queue is empty — enable at least one source under Settings → Web search',
        'WEB_PROVIDER_UNAVAILABLE',
      )
    }
    const maxResults = Number.isFinite(request?.maxResults) && request.maxResults > 0
      ? Math.min(20, Math.floor(request.maxResults))
      : config.maxResults
    try {
      const outcome = await runSearch({
        mode: config.mode,
        providers: enabled,
        adapters: ADAPTERS,
        resolveValue: ref => this.options.resolveValue(ref),
        query: request.query,
        maxResults,
        attemptTimeoutMs: config.attemptTimeoutMs,
        totalTimeoutMs: config.totalTimeoutMs,
        dedupeByUrl: config.dedupeByUrl,
        includeAnswer: config.includeAnswer,
        signal,
        logger: this.options.logger,
        onAttempt: event => { attempts.push(event) },
      })
      finish('success', outcome.sources.length)
      return {
        sources: outcome.sources,
        truncated: outcome.truncated,
        ...(outcome.content !== undefined ? { content: outcome.content } : {}),
      }
    } catch (error) {
      if (signal?.aborted === true || error?.name === 'AbortError') {
        finish('aborted')
        throw new WebError('agent-web-search: search aborted', 'WEB_ABORTED')
      }
      finish('failed')
      throw new WebError(
        error instanceof Error ? error.message : String(error),
        'WEB_PROVIDER_ERROR',
      )
    }
  }
}
