import test from 'node:test'
import assert from 'node:assert/strict'
import { mergeBridgeOutcomes, mapProviderPayload, parseToolEnvelope } from '../lib/bridge.js'

test('Python provider payload maps to native DSH citation sources', () => {
  const result = mapProviderPayload({
    providers: {
      ddgs: { results: [{ title: 'Page', url: 'https://example.org/a', description: 'Summary' }] },
    },
  }, 4)
  assert.deepEqual(result.sources, [{
    title: '【来源：DuckDuckGo】 Page', url: 'https://example.org/a', snippet: 'Summary',
  }])
})

test('bridge aggregation preserves maxResults and URL deduplication', () => {
  const result = mergeBridgeOutcomes([
    { sources: [{ title: 'A', url: 'https://example.org/a', provider: 'ddgs' }] },
    { sources: [{ title: 'duplicate', url: 'https://example.org/a/', provider: 'exa' }, { title: 'B', url: 'https://example.org/b', provider: 'exa' }] },
  ], 2, true)
  assert.deepEqual(result.sources.map(source => source.url), ['https://example.org/a', 'https://example.org/b'])
  assert.equal(result.sources.length, 2)
})

test('malformed and provider-error MCP results are sanitized', () => {
  assert.throws(() => parseToolEnvelope({ result: { content: [{ type: 'text', text: 'not-json' }] } }), error => error.code === 'malformed_result')
  assert.throws(() => parseToolEnvelope({ result: { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: { code: 'all_providers_failed', provider_errors: { ddgs: 'ddgs RuntimeError' } } }) }] } }), error => {
    assert.equal(error.code, 'all_providers_failed')
    assert.deepEqual(error.providerErrors, { ddgs: 'ddgs RuntimeError' })
    return true
  })
})

test('codex answers carry a readable provider label', () => {
  const result = mapProviderPayload({
    providers: {
      codex_alpha: { answer: 'Alpha says hi', results: [] },
    },
  }, 4)
  assert.equal(result.content, '【来源：Codex Alpha】\nAlpha says hi')
})
