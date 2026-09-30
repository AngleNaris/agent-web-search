import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { PythonSearchBridge } from '../lib/bridge.js'

class FakeChild extends EventEmitter {
  constructor(handler) {
    super()
    this.stdout = new PassThrough()
    this.stderr = new PassThrough()
    this.stdin = new PassThrough()
    this.killed = false
    this.calls = []
    this.stdin.on('data', chunk => {
      for (const line of chunk.toString().split('\n').filter(Boolean)) handler(JSON.parse(line), this)
    })
  }

  reply(message) {
    this.stdout.write(`${JSON.stringify(message)}\n`)
  }

  kill() {
    this.killed = true
    this.emit('exit', 0, 'SIGTERM')
    return true
  }
}

function spawnFor(handler, state) {
  return () => {
    const child = new FakeChild(handler)
    state.child = child
    return child
  }
}

function replyToCalls(payload, calls) {
  return (message, child) => {
    calls.push(message)
    if (message.method === 'initialize') {
      child.reply({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-06-18' } })
    } else if (message.method === 'tools/call') {
      child.reply({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: JSON.stringify(payload) }] } })
    }
  }
}

test('bridge calls only web_search, propagates maxResults, maps citations, and cleans up', async () => {
  const state = {}
  const calls = []
  let childEnvironment
  const bridge = new PythonSearchBridge({
    command: 'fake-agent-web-search-mcp',
    spawn: (command, args, options) => {
      childEnvironment = options.env
      return spawnFor(replyToCalls({ providers: { exa: { results: [{ title: 'A', url: 'https://example.org/a', description: 'summary' }] } } }, calls), state)(command, args, options)
    },
    env: { PATH: '/bin' }, lineMode: true,
  })
  const result = await bridge.search({
    query: 'latest question', maxResults: 2, providers: ['exa'],
    entries: [{ kind: 'exa', credentialRef: 'EXA_API_KEY' }],
    resolveValue: async () => 'PRIVATE_KEY', timeoutMs: 1000,
  })
  assert.equal(calls.filter(call => call.method === 'tools/call').length, 1)
  assert.equal(childEnvironment.AGENT_WEB_SEARCH_PROVIDERS, 'exa')
  assert.equal(childEnvironment.AGENT_WEB_SEARCH_MCP_TRANSPORT, 'stdio')
  assert.equal(childEnvironment.EXA_API_KEY, 'PRIVATE_KEY')
  assert.equal(JSON.stringify(calls).includes('PRIVATE_KEY'), false)
  assert.deepEqual(calls.find(call => call.method === 'tools/call').params, {
    name: 'web_search', arguments: { query: 'latest question', max_results: 2, providers: ['exa'] },
  })
  assert.equal(result.sources[0].url, 'https://example.org/a')
  assert.equal(result.sources[0].title, '【来源：Exa】 A')
  assert.equal(state.child.killed, true)
})

test('bridge propagates structured all-provider failure without raw bodies', async () => {
  const state = {}
  const bridge = new PythonSearchBridge({
    spawn: spawnFor(replyToCalls({ error: { code: 'all_providers_failed', provider_errors: { ddgs: 'ddgs RuntimeError' } } }, []), state),
    env: {}, lineMode: true,
  })
  await assert.rejects(bridge.search({
    query: 'q', maxResults: 4, providers: ['ddgs'], entries: [{ kind: 'ddgs' }],
    resolveValue: async () => undefined, timeoutMs: 1000,
  }), error => {
    assert.equal(error.code, 'all_providers_failed')
    assert.deepEqual(error.providerErrors, { ddgs: 'ddgs RuntimeError' })
    assert.equal(error.message.includes('RuntimeError'), false)
    return true
  })
})

test('bridge rejects malformed MCP results and bounds process output', async () => {
  const childState = {}
  const child = new PythonSearchBridge({
    spawn: spawnFor((message, process) => {
      if (message.method === 'initialize') process.reply({ jsonrpc: '2.0', id: message.id, result: {} })
      if (message.method === 'tools/call') process.stdout.write('{not-json}\n')
    }, childState), env: {}, lineMode: true,
  })
  await assert.rejects(child.search({ query: 'q', maxResults: 1, providers: ['ddgs'], entries: [{ kind: 'ddgs' }], resolveValue: async () => undefined, timeoutMs: 1000 }), error => error.code === 'malformed_result')

  const largeState = {}
  const large = new PythonSearchBridge({
    spawn: spawnFor((_message, process) => process.stdout.write('x'.repeat(1024 * 1024 + 1)), largeState), env: {}, lineMode: true,
  })
  await assert.rejects(large.search({ query: 'q', maxResults: 1, providers: ['ddgs'], entries: [{ kind: 'ddgs' }], resolveValue: async () => undefined, timeoutMs: 1000 }), error => error.code === 'output_limit')
  assert.equal(largeState.child.killed, true)
})

test('bridge cancellation and timeout terminate the child process', async () => {
  const cancellationState = {}
  const cancellation = new PythonSearchBridge({
    spawn: spawnFor(() => {}, cancellationState), env: {}, lineMode: true,
  })
  const controller = new AbortController()
  const pending = cancellation.search({ query: 'q', maxResults: 1, providers: ['ddgs'], entries: [{ kind: 'ddgs' }], resolveValue: async () => undefined, timeoutMs: 5000, signal: controller.signal })
  controller.abort()
  await assert.rejects(pending, error => error.name === 'AbortError')
  assert.equal(cancellationState.child.killed, true)

  const timeoutState = {}
  const timeout = new PythonSearchBridge({ spawn: spawnFor(() => {}, timeoutState), env: {}, lineMode: true })
  await assert.rejects(timeout.search({ query: 'q', maxResults: 1, providers: ['ddgs'], entries: [{ kind: 'ddgs' }], resolveValue: async () => undefined, timeoutMs: 10 }), error => error.name === 'TimeoutError')
  assert.equal(timeoutState.child.killed, true)
})
