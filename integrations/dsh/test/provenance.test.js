import test from 'node:test'
import assert from 'node:assert/strict'
import { mergeResults, runSearch } from '../lib/engine.js'

const hit = (url, title = 'Original page', description = 'Original summary') => ({ url, title, description })

test('final result titles name every contributing upstream without changing URL or summary', () => {
  const merged = mergeResults([
    { kind: 'exa', results: [hit('https://example.org/article')] },
    { kind: 'deepseek', results: [hit('https://example.org/article', 'Later title', 'Later summary')] },
    { kind: 'ddgs', results: [hit('https://example.org/other', 'Other page')] },
  ], true, 8)
  assert.equal(merged.sources.length, 2)
  assert.deepEqual(merged.sources[0].providers, ['exa', 'deepseek'])
  assert.equal(merged.sources[0].title, '【来源：Exa、DeepSeek】 Original page')
  assert.equal(merged.sources[0].url, 'https://example.org/article')
  assert.equal(merged.sources[0].snippet, 'Original summary')
  assert.equal(merged.sources[1].title, '【来源：DuckDuckGo】 Other page')
  assert.equal('sourceLabels' in merged.sources[0], false)
})

test('without deduplication, each copy keeps only its own source label', () => {
  const merged = mergeResults([
    { kind: 'exa', results: [hit('https://example.org/shared')] },
    { kind: 'deepseek', results: [hit('https://example.org/shared')] },
  ], false, 8)
  assert.deepEqual(merged.sources.map(source => source.title), [
    '【来源：Exa】 Original page', '【来源：DeepSeek】 Original page',
  ])
})

test('two MCP sources with the same URL retain separate trusted tool identities', () => {
  const merged = mergeResults([
    { kind: 'mcp', sourceId: 'mcp-first', toolName: 'webSearchPrime', results: [hit('https://example.org/shared', '')] },
    { kind: 'mcp', sourceId: 'mcp-second', toolName: 'webSearchPrime', results: [hit('https://example.org/shared')] },
  ], true, 8)
  assert.equal(merged.sources.length, 1)
  assert.equal(merged.sources[0].title, '【来源：MCP: webSearchPrime (mcp-first)、MCP: webSearchPrime (mcp-second)】')
})

test('answer-only upstream remains visibly attributed when it is the only answer', async () => {
  const result = await runSearch({
    mode: 'fallback', providers: [{ kind: 'deepseek', enabled: true }],
    adapters: new Map([['deepseek', { anonymousOk: true, credentialRef: null, defaultBaseURL: '', search: async () => ({ results: [], answer: 'Verified model answer.' }) }]]),
    query: 'question', maxResults: 3, resolveValue: async () => undefined,
    attemptTimeoutMs: 2000, totalTimeoutMs: 4000, dedupeByUrl: true, includeAnswer: true,
  })
  assert.equal(result.sources.length, 0)
  assert.equal(result.content, '【来源：DeepSeek】\nVerified model answer.')
})
