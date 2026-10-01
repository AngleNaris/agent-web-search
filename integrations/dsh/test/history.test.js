import test from 'node:test'
import assert from 'node:assert/strict'
import { SearchHistory } from '../lib/history.js'
import { runSearch } from '../lib/engine.js'
import { AgentWebSearchProvider } from '../lib/provider.js'
import { UpstreamError } from '../lib/http.js'
import { apply } from '../lib/index.js'

const adapter = (search, anonymousOk = true) => ({ search, anonymousOk, credentialRef: anonymousOk ? null : 'TEST_KEY' })
const result = url => ({ url, title: url, description: 'result body must not appear in history' })

function config(providers, mode = 'fanout') {
  const wrap = value => ({ get: () => value })
  return {
    mode: wrap(mode), providers: wrap(providers),
    attemptTimeoutMs: wrap(2000), totalTimeoutMs: wrap(5000),
    dedupeByUrl: wrap(true), includeAnswer: wrap(false),
  }
}

test('history retains 50 sanitized calls without queries, keys, URLs or error messages', () => {
  const history = new SearchHistory()
  for (let index = 0; index < 53; index++) history.record({
    mode: 'fanout', status: 'success', resultCount: 1, durationMs: 20,
    query: 'PRIVATE_QUERY', apiKey: 'PRIVATE_KEY', url: 'https://private.test',
    attempts: [{ kind: 'ddgs', status: 'success', durationMs: 12, resultCount: 1, reason: 'PRIVATE_REASON' }],
  })
  const snapshot = history.snapshot()
  assert.equal(snapshot.entries.length, 50)
  assert.equal(snapshot.entries[0].id, 53)
  assert.equal(snapshot.entries.at(-1).id, 4)
  assert.equal(JSON.stringify(snapshot).includes('PRIVATE_'), false)
  assert.equal(JSON.stringify(snapshot).includes('private.test'), false)
  snapshot.entries[0].attempts[0].kind = 'modified'
  assert.equal(history.snapshot().entries[0].attempts[0].kind, 'ddgs')
})

test('known source stays visible in sanitized history and removed kinds are hidden', () => {
  const history = new SearchHistory()
  history.record({ mode: 'fanout', status: 'success', resultCount: 1, durationMs: 13, attempts: [
    { kind: 'gemini', status: 'failed', httpStatus: 400, durationMs: 12, resultCount: 0, token: 'PRIVATE_TOKEN', error: 'PRIVATE_ERROR' },
    { kind: 'retired_source', status: 'success', resultCount: 4 },
    { kind: 'unknown_private_source', status: 'success', resultCount: 4 },
  ] })
  const attempts = history.snapshot().entries[0].attempts
  assert.deepEqual(attempts, [{ kind: 'gemini', status: 'failed', durationMs: 12, resultCount: 0, httpStatus: 400 }])
  assert.equal(JSON.stringify(history.snapshot()).includes('PRIVATE_'), false)
})

test('fanout records successes, empty results and missing credential without leaking query', async () => {
  const attempts = []
  const outcome = await runSearch({
    mode: 'fanout', query: 'PRIVATE_QUERY', maxResults: 8,
    providers: [{ kind: 'ddgs' }, { kind: 'exa' }, { kind: 'gemini' }],
    adapters: new Map([
      ['ddgs', adapter(async () => ({ results: [result('https://example.org')] }))],
      ['exa', adapter(async () => ({ results: [] }))],
      ['gemini', adapter(async () => { throw new Error('PRIVATE_ERROR') }, false)],
    ]),
    resolveValue: async () => undefined, attemptTimeoutMs: 2000, totalTimeoutMs: 5000,
    dedupeByUrl: true, includeAnswer: false, onAttempt: event => attempts.push(event),
  })
  assert.equal(outcome.sources.length, 1)
  assert.deepEqual(Object.fromEntries(attempts.map(item => [item.kind, item.status])), {
    ddgs: 'success', exa: 'empty', gemini: 'skipped',
  })
  assert.equal(JSON.stringify(attempts).includes('PRIVATE_'), false)
})

test('failed upstream reports HTTP status but never exposes its raw error', async () => {
  const attempts = []
  await assert.rejects(runSearch({
    mode: 'fanout', query: 'PRIVATE_QUERY', maxResults: 8,
    providers: [{ kind: 'ddgs' }],
    adapters: new Map([['ddgs', adapter(async () => { throw new UpstreamError('PRIVATE_ERROR', { status: 429 }) })]]),
    resolveValue: async () => undefined, attemptTimeoutMs: 2000, totalTimeoutMs: 5000,
    dedupeByUrl: true, includeAnswer: false, onAttempt: event => attempts.push(event),
  }))
  assert.equal(attempts[0].status, 'failed')
  assert.equal(attempts[0].httpStatus, 429)
  assert.equal(JSON.stringify(attempts).includes('PRIVATE_'), false)
})

test('fallback records only routes actually tried', async () => {
  const attempts = []
  await runSearch({
    mode: 'fallback', query: 'test', maxResults: 8,
    providers: [{ kind: 'ddgs' }, { kind: 'exa' }],
    adapters: new Map([
      ['ddgs', adapter(async () => ({ results: [result('https://example.org')] }))],
      ['exa', adapter(async () => { throw new Error('must not run') })],
    ]),
    resolveValue: async () => undefined, attemptTimeoutMs: 2000, totalTimeoutMs: 5000,
    dedupeByUrl: true, includeAnswer: false, onAttempt: event => attempts.push(event),
  })
  assert.deepEqual(attempts.map(item => item.kind), ['ddgs'])
})

test('authenticated connection route reports current selected provider and calls', async () => {
  let provider
  const routes = []
  const current = { searchProvider: 'agent-web-search' }
  apply({
    web: { registerSearchProvider: value => { provider = value } },
    tools: { get: () => ({}), register: () => () => {} },
    systemPrompt: { section: () => {}, getSectionOrder: () => 0 },
    get: () => undefined,
    loader: { entries: () => [{ options: { id: 'web' }, fiber: { config: current } }] },
    inject: (_names, callback) => callback({
      effect: register => register(),
      connection: { fetch: { register: value => { routes.push(value) } } },
    }),
  }, config([{ kind: 'ddgs', enabled: true }]))
  const route = routes.find(item => item.path === '/api/agent-web-search/history')
  assert.ok(route)
  assert.deepEqual(route.methods, ['GET'])
  const before = await (await route.fetch()).json()
  assert.equal(before.selectedProvider, 'agent-web-search')
  const abort = new AbortController()
  abort.abort()
  await assert.rejects(provider.search({ query: 'PRIVATE_QUERY' }, abort.signal))
  current.searchProvider = 'codex-subscription'
  const after = await (await route.fetch()).json()
  assert.equal(after.selectedProvider, 'codex-subscription')
  assert.equal(after.entries.length, 1)
  assert.equal(after.entries[0].status, 'aborted')
  assert.equal(JSON.stringify(after).includes('PRIVATE_QUERY'), false)
})

test('provider records a failed search and strips upstream error details', async () => {
  const history = new SearchHistory()
  const provider = new AgentWebSearchProvider({
    config: () => config([{ kind: 'ddgs', enabled: true }]),
    resolveValue: async () => undefined,
    record: event => history.record(event),
  })
  // Force an already-aborted signal; no external HTTP request may be issued.
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(provider.search({ query: 'PRIVATE_QUERY' }, controller.signal), /search aborted/)
  const [entry] = history.snapshot().entries
  assert.equal(entry.status, 'aborted')
  assert.equal(JSON.stringify(entry).includes('PRIVATE_QUERY'), false)
})
