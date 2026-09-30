import test from 'node:test'
import assert from 'node:assert/strict'
import { mcpAdapter, mcpCredentialRef, searchMcp, discoverMcpTools } from '../lib/adapters/mcp.js'
import { runSearch } from '../lib/engine.js'
import { resolveConfig } from '../lib/config.js'
import { DEFAULT_QUEUE } from '../lib/defaults.js'

const entry = {
  kind: 'mcp', id: 'local-search', enabled: true, baseURL: 'http://127.0.0.1:8045/mcp',
  toolName: 'web_search_prime', inputTemplate: '{"request":{"text":"{{query}}","limit":"{{maxResults}}"}}',
  responseMode: 'structured', resultPath: '/data/items', urlPath: '/link', titlePath: '/name',
  snippetPath: '/summary', publishedAtPath: '/date',
}

function server({ available = true, toolError = false, textOnly = false, sse = false } = {}) {
  const calls = []
  const transport = async (url, init) => {
    assert.equal(url, entry.baseURL)
    assert.equal(init.redirect, 'error')
    if (init.method === 'DELETE') { assert.equal(init.headers['mcp-session-id'], 'session-1'); return new Response(null, { status: 200 }) }
    assert.match(init.headers.accept, /text\/event-stream/)
    const request = JSON.parse(init.body)
    calls.push({ ...request, headers: init.headers })
    if (request.method === 'notifications/initialized') return new Response(null, { status: 202 })
    let result
    if (request.method === 'initialize') result = { protocolVersion: '2025-06-18', capabilities: { tools: {} } }
    if (request.method === 'tools/list') result = { tools: available ? [{ name: entry.toolName, inputSchema: { type: 'object' } }] : [] }
    if (request.method === 'tools/call') result = toolError ? { isError: true, content: [{ type: 'text', text: 'PRIVATE_ERROR' }] }
      : textOnly ? { content: [{ type: 'text', text: 'Plain PRIVATE_ANSWER' }] }
        : { structuredContent: { data: { items: [{ link: 'https://example.org/a', name: 'A', summary: 'snippet', date: 'today' }, { link: 'javascript:alert(1)', name: 'bad' }] } } }
    const payload = JSON.stringify({ jsonrpc: '2.0', id: request.id, result })
    if (sse && request.method === 'tools/call') return new Response(`event: message\ndata: ${JSON.stringify({jsonrpc:'2.0',id:999,result:{ignore:true}})}\n\nevent: message\ndata: ${payload}\n\n`, { headers: { 'content-type': 'text/event-stream' } })
    return Response.json(JSON.parse(payload), { headers: request.method === 'initialize' ? { 'mcp-session-id': 'session-1' } : {} })
  }
  return { calls, transport }
}

test('MCP source completes initialization, exact tool discovery and mapped call', async () => {
  const mock = server({ sse: true })
  const result = await searchMcp({ entry, query: 'PRIVATE_QUERY', maxResults: 4, apiKey: 'PRIVATE_TOKEN', transport: mock.transport })
  assert.equal(result.results.length, 1)
  assert.equal(result.results[0].url, 'https://example.org/a')
  assert.deepEqual(mock.calls.map(call => call.method), ['initialize', 'notifications/initialized', 'tools/list', 'tools/call'])
  assert.equal(mock.calls[3].params.name, entry.toolName)
  assert.equal(mock.calls[3].params.arguments.request.text, 'PRIVATE_QUERY')
  assert.equal(mock.calls[3].params.arguments.request.limit, 4)
  assert.equal(mock.calls[3].headers['mcp-session-id'], 'session-1')
  assert.equal(mock.calls[3].headers.authorization, 'Bearer PRIVATE_TOKEN')
  assert.equal(mcpCredentialRef(entry.id), 'AGENT_WEB_SEARCH_MCP_LOCAL_SEARCH')
  assert.equal(JSON.stringify(result).includes('PRIVATE_TOKEN'), false)
})

test('read-only tool discovery lists names without invoking any tool', async () => {
  const mock = server()
  const tools = await discoverMcpTools({ entry, signal: AbortSignal.timeout(1000), transport: mock.transport })
  assert.deepEqual(tools.map(tool => tool.name), [entry.toolName])
  assert.equal(mock.calls.some(call => call.method === 'tools/call'), false)
})

test('MCP HTTP errors are classified without echoing arbitrary remote bodies', async () => {
  await assert.rejects(discoverMcpTools({ entry, transport: async () => new Response('PRIVATE_REMOTE_ERROR', { status: 400 }) }), error => {
    assert.equal(error.message, 'mcp HTTP 400')
    assert.equal(error.status, 400)
    return true
  })
})

test('missing exact tool never falls through to another tool', async () => {
  const mock = server({ available: false })
  await assert.rejects(searchMcp({ entry, query: 'x', maxResults: 2, transport: mock.transport }), /configured tool was not found/)
  assert.equal(mock.calls.some(call => call.method === 'tools/call'), false)
})

test('tool errors are sanitized and rejected as search results', async () => {
  const mock = server({ toolError: true })
  await assert.rejects(searchMcp({ entry, query: 'x', maxResults: 2, transport: mock.transport }), error => {
    assert.equal(error.message.includes('PRIVATE_ERROR'), false)
    return true
  })
})

test('plain text tools can provide answer-only results when answer is enabled', async () => {
  const mock = server({ textOnly: true })
  const mode = { ...entry, responseMode: 'text' }
  const result = await runSearch({ mode: 'fallback', providers: [mode], adapters: new Map([['mcp', { ...mcpAdapter, search: args => searchMcp({ ...args, transport: mock.transport }) }]]),
    query: 'x', maxResults: 4, resolveValue: async () => undefined, attemptTimeoutMs: 2000, totalTimeoutMs: 5000, dedupeByUrl: true, includeAnswer: true })
  assert.equal(result.sources.length, 0)
  assert.match(result.content, /PRIVATE_ANSWER/)
})

test('JSON text tools support a root result array and declarative field pointers', async () => {
  const mock = server()
  const transport = (url, init) => {
    if (init.method === 'POST' && JSON.parse(init.body).method === 'tools/call') {
      const id = JSON.parse(init.body).id
      return Response.json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify([{ link: 'https://example.net/source', name: 'Name' }]) }] } })
    }
    return mock.transport(url, init)
  }
  const result = await searchMcp({ entry: { ...entry, responseMode: 'text-json', resultPath: '' }, query: 'x', maxResults: 2, transport })
  assert.equal(result.results[0].url, 'https://example.net/source')
})

test('caller cancellation stops MCP discovery and a large response is rejected', async () => {
  const cancel = new AbortController()
  const mock = server()
  const abortedTransport = (url, init) => {
    if (init.method === 'POST' && JSON.parse(init.body).method === 'tools/list') {
      cancel.abort()
      return Promise.reject(new DOMException('cancelled', 'AbortError'))
    }
    return mock.transport(url, init)
  }
  await assert.rejects(searchMcp({ entry, query: 'x', maxResults: 2, signal: cancel.signal, transport: abortedTransport }), /cancelled/)
  const tooLarge = (url, init) => init.method === 'POST' && JSON.parse(init.body).method === 'tools/call'
    ? new Response('x'.repeat(1024 * 1024 + 1), { headers: { 'content-type': 'application/json' } })
    : mock.transport(url, init)
  await assert.rejects(searchMcp({ entry, query: 'x', maxResults: 2, transport: tooLarge }), /exceeds 1 MiB/)
})

test('configuration preserves independent MCP instances and rejects insecure endpoints', async () => {
  const providers = resolveConfig({ providers: [entry, { ...entry, id: 'second' }] }).providers
  assert.equal(providers.length, 2)
  assert.equal(DEFAULT_QUEUE.length, 15)
  assert.equal(DEFAULT_QUEUE.some(item => item.kind === 'gemini'), true)
  assert.equal(DEFAULT_QUEUE.some(item => item.kind === 'mcp'), false)
  assert.deepEqual(resolveConfig({ providers: [{ kind: 'retired_source', enabled: true, baseURL: 'http://127.0.0.1:9999' }, entry] }).providers.map(item => item.kind), ['mcp'])
  assert.equal(resolveConfig({ providers: [entry, entry] }).providers.length, 1)
  await assert.rejects(searchMcp({ entry: { ...entry, baseURL: 'http://example.org/mcp' }, query: 'x', maxResults: 2, transport: () => { throw new Error('must not fetch') } }), /HTTPS/)
  await assert.rejects(searchMcp({ entry: { ...entry, baseURL: 'https://user:pass@example.org/mcp' }, query: 'x', maxResults: 2, transport: () => { throw new Error('must not fetch') } }), /credentials/)
})
