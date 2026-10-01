import test from 'node:test'
import assert from 'node:assert/strict'
import { parseToolArgs, registerWebSearchTool } from '../lib/tool.js'
import { AgentWebSearchProvider } from '../lib/provider.js'

const BASE_PROVIDERS = [
  { kind: 'ddgs', enabled: true, baseURL: '' },
  { kind: 'exa', enabled: true, baseURL: '' },
  { kind: 'grok', enabled: false, baseURL: '' },
]

function config(overrides = {}) {
  const wrap = value => ({ get: () => value })
  return {
    mode: wrap('fanout'), providers: wrap(BASE_PROVIDERS), maxResults: wrap(8),
    attemptTimeoutMs: wrap(2000), totalTimeoutMs: wrap(5000),
    dedupeByUrl: wrap(true), includeAnswer: wrap(false),
    ...overrides,
  }
}

const okPayload = () => ({
  sources: [{ title: 'A', url: 'https://example.org/a', snippet: 'summary' }],
  truncated: false,
})

function fakeBridge(impl = okPayload) {
  const calls = []
  return {
    calls,
    bridge: { async search(args) { calls.push(args); return impl(args) } },
  }
}

function setup({ existingTool, cfg, impl } = {}) {
  const stages = { tool: undefined, sections: [] }
  const { calls, bridge } = fakeBridge(impl)
  const ctx = {
    tools: {
      get: name => (name === 'web_search' ? existingTool : undefined),
      register: definition => { stages.tool = definition; return () => {} },
    },
    systemPrompt: {
      section: definition => stages.sections.push(definition),
      getSectionOrder: () => 0,
    },
    logger: { warn: () => {}, info: () => {} },
  }
  const provider = new AgentWebSearchProvider({
    config: () => cfg ?? config(),
    resolveValue: async () => undefined,
    record: () => {},
    bridge,
  })
  registerWebSearchTool(ctx, { config: () => cfg ?? config(), provider })
  return { stages, calls }
}

test('registers web_search with the MCP-consistent schema', () => {
  const { stages } = setup()
  assert.equal(stages.tool.name, 'web_search')
  const params = stages.tool.parameters
  const props = params.properties
  // grok is disabled here, so grok_search_mode stays out of the schema,
  // exactly like the Python operation builds it.
  assert.deepEqual(Object.keys(props).sort(), ['max_results', 'providers', 'query', 'time_range'])
  assert.deepEqual(params.required, ['query'])
  assert.deepEqual(props.time_range.enum, ['d', 'w', 'm', 'y'])
  assert.deepEqual(props.providers.items.enum, ['ddgs', 'exa'])
  assert.equal(stages.sections.map(section => section.name).includes('tool:web_search'), true)
})

test('schema gains grok_search_mode only when grok is enabled', () => {
  const wrap = value => ({ get: () => value })
  const grokOn = config({
    providers: wrap([
      { kind: 'ddgs', enabled: true, baseURL: '' },
      { kind: 'grok', enabled: true, baseURL: '' },
    ]),
  })
  const { stages } = setup({ cfg: grokOn })
  const props = stages.tool.parameters.properties
  assert.deepEqual(props.grok_search_mode.enum, ['web_search', 'x_search', 'both'])
  assert.deepEqual(props.providers.items.enum, ['ddgs', 'grok'])
})

test('skips registration when a web_search tool already exists', () => {
  const { stages } = setup({ existingTool: { name: 'web_search' } })
  assert.equal(stages.tool, undefined)
})

test('executes with per-call args and projects sources', async () => {
  const { stages, calls } = setup()
  const result = await stages.tool.execute(
    { query: 'latest news', max_results: 3, time_range: 'w' },
    { signal: undefined },
  )
  assert.equal(calls.length, 2)
  assert.deepEqual(calls.map(call => call.providers), [['ddgs'], ['exa']])
  assert.ok(calls.every(call => call.timeRange === 'w'))
  assert.equal(result.sources.length, 1) // same URL from both upstreams is deduplicated
  assert.equal(result.sources[0].url, 'https://example.org/a')
  assert.equal(result.truncated, false)
})

test('honors provider subsets and falls back to card defaults', async () => {
  const { stages, calls } = setup()
  await stages.tool.execute({ query: 'q', providers: ['exa'] }, { signal: undefined })
  assert.deepEqual(calls.map(call => call.providers), [['exa']])
  assert.equal(calls[0].timeRange, undefined)
  assert.equal(calls[0].grokMode, undefined)
})

test('rejects MCP-inconsistent arguments like the Python operation', async () => {
  const { stages } = setup()
  await assert.rejects(stages.tool.execute({ query: 'q', max_results: 99 }, {}), /max_results must be an integer between 1 and 20/)
  await assert.rejects(stages.tool.execute({ query: 'q', time_range: 'x' }, {}), /time_range/)
  await assert.rejects(stages.tool.execute({ query: 'q', providers: ['nope'] }, {}), /providers/)
  await assert.rejects(stages.tool.execute({ query: 'q', grok_search_mode: 'both' }, {}), /grok_search_mode is only available when grok is enabled/)
  await assert.rejects(stages.tool.execute({ query: '  ' }, {}), /query must be a non-empty string/)
})

test('passes grok_search_mode through on grok attempts', async () => {
  const wrap = value => ({ get: () => value })
  const cfg = config({ providers: wrap([{ kind: 'grok', enabled: true, baseURL: '' }]) })
  const { stages, calls } = setup({ cfg })
  await stages.tool.execute({ query: 'q', grok_search_mode: 'x_search' }, { signal: undefined })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].grokMode, 'x_search')
})

test('parseToolArgs mirrors the same contract without a registry', () => {
  assert.deepEqual(parseToolArgs({ query: 'q' }, ['ddgs']), { query: 'q' })
  assert.deepEqual(
    parseToolArgs({ query: 'q', max_results: 2, time_range: 'd', providers: ['exa'], grok_search_mode: 'web_search' }, ['exa', 'grok']),
    { query: 'q', maxResults: 2, timeRange: 'd', providers: ['exa'], grokMode: 'web_search' },
  )
})

test('presenters title cards by query and carry structured sources', () => {
  const { stages } = setup()
  const call = stages.tool.presentCall({ query: 'hello' })
  assert.equal(call.title, 'hello')
  assert.equal(call.kind, 'search')
  const shown = stages.tool.presentResult({ query: 'hello' }, {
    isError: false,
    meta: { sources: [{ url: 'https://example.org/a' }], truncated: false },
  })
  assert.equal(shown.card, 'web')
  assert.deepEqual(shown.sources, [{ url: 'https://example.org/a' }])
})
