import { WebError } from '@deepseek-ai/dsh-web'
import { KIND_CREDENTIAL_REF, PROVIDER_KINDS, AGENT_WEB_SEARCH_PROVIDER_ID } from './defaults.js'
import { resolveConfig, snapshotsOf } from './config.js'
import { PythonSearchBridge } from './bridge.js'
import { runSearch } from './engine.js'

export class AgentWebSearchProvider {
  id = AGENT_WEB_SEARCH_PROVIDER_ID

  constructor(options = {}) {
    this.options = options
    this.bridge = options.bridge ?? new PythonSearchBridge(options.bridgeOptions)
  }

  available() {
    const config = resolveConfig(snapshotsOf(this.options.config()))
    return config.providers.some(entry => entry.enabled !== false && PROVIDER_KINDS.includes(entry.kind))
  }

  async search(request, signal) {
    const config = resolveConfig(snapshotsOf(this.options.config()))
    const entries = config.providers
      .filter(entry => entry.enabled !== false && PROVIDER_KINDS.includes(entry.kind))
      .map(entry => ({
        ...entry,
        credentialRef: KIND_CREDENTIAL_REF[entry.kind],
      }))
    const startedAt = Date.now()
    const attempts = []
    const finish = (status, resultCount = 0) => {
      try {
        this.options.record?.({
          mode: config.mode,
          status,
          resultCount,
          durationMs: Date.now() - startedAt,
          attempts,
        })
      } catch {}
    }
    if (entries.length === 0) {
      finish('failed')
      throw new WebError('agent-web-search has no enabled sources', 'WEB_PROVIDER_UNAVAILABLE')
    }
    const maxResults = Number.isFinite(request?.maxResults) && request.maxResults > 0
      ? Math.min(20, Math.floor(request.maxResults))
      : config.maxResults
    const resolveValue = async (ref, childSignal) => {
      if (!ref || typeof this.options.resolveValue !== 'function') return undefined
      const promise = this.options.resolveValue(ref)
      if (!childSignal) return promise
      return Promise.race([
        promise,
        new Promise((_, reject) => childSignal.addEventListener('abort', () => reject(childSignal.reason), { once: true })),
      ])
    }
    try {
      const outcome = await runSearch({
        mode: config.mode,
        providers: entries,
        query: request?.query,
        maxResults,
        attemptTimeoutMs: config.attemptTimeoutMs,
        totalTimeoutMs: config.totalTimeoutMs,
        dedupeByUrl: config.dedupeByUrl,
        includeAnswer: config.includeAnswer,
        signal,
        resolveValue,
        bridge: this.bridge,
        onAttempt: event => attempts.push(event),
        logger: this.options.logger,
      })
      finish('success', outcome.sources.length)
      return {
        sources: outcome.sources,
        truncated: outcome.truncated,
        ...(outcome.content !== undefined ? { content: outcome.content } : {}),
      }
    } catch (error) {
      if (signal?.aborted || error?.name === 'AbortError') {
        finish('aborted')
        throw new WebError('agent-web-search: search aborted', 'WEB_ABORTED')
      }
      if (error?.name === 'TimeoutError' || error?.code === 'timeout') {
        finish('timeout')
        throw new WebError('agent-web-search: search timed out', 'WEB_PROVIDER_ERROR')
      }
      finish('failed')
      throw new WebError('agent-web-search: all configured sources failed', 'WEB_PROVIDER_ERROR')
    }
  }
}
