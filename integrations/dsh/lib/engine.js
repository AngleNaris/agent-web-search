import { mcpCredentialRef, searchMcp } from './adapters/mcp.js'
import { mergeBridgeOutcomes } from './bridge.js'

function timeoutSignal(parent, milliseconds) {
  const timeout = AbortSignal.timeout(milliseconds)
  return parent ? AbortSignal.any([parent, timeout]) : timeout
}

function isCallerAbort(error, signal) {
  return signal?.aborted === true || (error?.name === 'AbortError' && signal?.aborted === true)
}

function reasonFor(error) {
  if (error?.code === 'skipped') return 'skipped'
  if (error?.code === 'timeout' || error?.name === 'TimeoutError') return 'timeout'
  if (error?.code === 'all_providers_failed') return 'all providers failed'
  if (error?.code === 'malformed_result') return 'malformed MCP result'
  if (error?.code === 'output_limit') return 'output limit exceeded'
  return 'failed'
}

async function runOne({ entry, query, maxResults, attemptTimeoutMs, signal, resolveValue, bridge, adapters }) {
  const startedAt = Date.now()
  const attemptSignal = timeoutSignal(signal, attemptTimeoutMs)
  try {
    if (entry.kind === 'mcp') {
      const token = await resolveValue(mcpCredentialRef(entry.id), attemptSignal)
      const search = adapters?.get('mcp')?.search ?? searchMcp
      const result = await search({ entry, query, maxResults, apiKey: token, signal: attemptSignal })
      return {
        result: {
          sources: result.sources ?? result.results ?? [],
          ...(result.content !== undefined ? { content: result.content } : result.answer ? { content: result.answer } : {}),
        },
        elapsedMs: Date.now() - startedAt,
      }
    }
    const adapter = adapters?.get(entry.kind)
    if (adapter) {
      if (adapter.anonymousOk === false && !(await resolveValue(adapter.credentialRef, attemptSignal))) {
        const error = new Error('provider credential is not configured')
        error.code = 'skipped'
        throw error
      }
      const result = await adapter.search({ entry, query, maxResults, signal: attemptSignal })
      return { result: { sources: result.sources ?? result.results ?? [], ...(result.content ? { content: result.content } : result.answer ? { content: result.answer } : {}) }, elapsedMs: Date.now() - startedAt }
    }
    const result = await bridge.search({
      query, maxResults, providers: [entry.kind], entries: [entry], resolveValue,
      timeoutMs: attemptTimeoutMs, signal: attemptSignal,
    })
    return { result, elapsedMs: Date.now() - startedAt }
  } catch (error) {
    if (isCallerAbort(error, signal)) throw error
    const wrapped = error instanceof Error ? error : new Error('provider unavailable')
    wrapped.elapsedMs = Date.now() - startedAt
    throw wrapped
  }
}

function entryLabel(entry) {
  return entry.kind === 'mcp' ? `mcp:${entry.id}` : entry.kind
}

function attemptKind(entry) {
  return entry.kind === 'mcp' ? 'mcp' : entry.kind
}

export async function runSearch({
  mode, providers, query, maxResults, attemptTimeoutMs, totalTimeoutMs, dedupeByUrl,
  includeAnswer, signal, resolveValue, bridge, adapters, onAttempt, logger,
}) {
  const totalSignal = timeoutSignal(signal, totalTimeoutMs)
  const outcomes = []
  const failures = []

  const observeFailure = (entry, error) => {
    const event = {
      kind: attemptKind(entry),
      ...(entry.kind === 'mcp' ? { sourceId: entry.id } : {}),
      status: reasonFor(error),
      durationMs: error?.elapsedMs ?? 0, resultCount: 0,
      ...(error?.status ? { httpStatus: error.status } : {}),
    }
    failures.push({ kind: entryLabel(entry), reason: event.status, providerErrors: error?.providerErrors })
    onAttempt?.(event)
    logger?.warn?.('agent-web-search: %s failed: %s', event.kind, event.status)
  }

  const observeSuccess = (entry, outcome, elapsedMs) => {
    const result = {
      ...outcome,
      sources: Array.isArray(outcome?.sources) ? outcome.sources : [],
      ...(includeAnswer ? {} : { content: undefined }),
    }
    outcomes.push(result)
    const status = result.sources.length > 0 || (includeAnswer && result.content) ? 'success' : 'empty'
    onAttempt?.({
      kind: attemptKind(entry),
      ...(entry.kind === 'mcp' ? { sourceId: entry.id } : {}),
      status,
      durationMs: elapsedMs,
      resultCount: result.sources.length,
    })
    logger?.info?.('agent-web-search: %s served the query in %d ms (%d rows)', entryLabel(entry), elapsedMs, result.sources.length)
    return status === 'success'
  }

  const runEntry = async entry => {
    try {
      const { result, elapsedMs } = await runOne({
        entry, query, maxResults, attemptTimeoutMs, signal: totalSignal, resolveValue, bridge, adapters,
      })
      return observeSuccess(entry, result, elapsedMs)
    } catch (error) {
      if (signal?.aborted) throw signal.reason ?? error
      if (totalSignal.aborted && !signal?.aborted) throw timeoutSignalError()
      observeFailure(entry, error)
      return false
    }
  }

  if (mode === 'fallback') {
    for (const entry of providers) {
      if (totalSignal.aborted) throw timeoutSignalError()
      if (await runEntry(entry)) break
    }
  } else {
    const jobs = providers.map(entry => runEntry(entry))
    await Promise.all(jobs)
  }

  if (signal?.aborted) throw signal.reason ?? new DOMException('search aborted', 'AbortError')
  if (totalSignal.aborted) throw timeoutSignalError()
  const merged = mergeBridgeOutcomes(outcomes, maxResults, dedupeByUrl)
  if (merged.sources.length === 0 && (!includeAnswer || !merged.content)) {
    const error = new Error('All configured search providers failed')
    error.code = 'all_providers_failed'
    error.providerErrors = Object.fromEntries(failures.map(item => [item.kind, item.reason]))
    throw error
  }
  return { ...merged, failures }
}

function timeoutSignalError() {
  const error = new Error('search timed out')
  error.name = 'TimeoutError'
  error.code = 'timeout'
  return error
}

export { mcpCredentialRef }

export function mergeResults(outcomes, dedupeByUrl, maxResults) {
  return mergeBridgeOutcomes(outcomes.map(item => ({
    sources: item.sources ?? item.results ?? [],
    ...(item.content !== undefined ? { content: item.content } : item.answer ? { content: item.answer } : {}),
  })), maxResults, dedupeByUrl)
}
