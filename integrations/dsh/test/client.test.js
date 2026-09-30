import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

const file = new URL('../lib/client.js', import.meta.url)
const React = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  useState: initial => [initial, () => {}],
  useEffect: () => {},
}
const all = node => Array.isArray(node) ? node.flatMap(all) : !node || typeof node !== 'object' ? [] : [node, ...(node.children ?? []).flatMap(all)]

function load(fetchImpl = () => { throw new Error('unexpected fetch') }) {
  let mod
  runInNewContext(readFileSync(file, 'utf8'), {
    window: { __ModuleLoader__: { load: definition => { mod = definition.factory(name => {
      assert.equal(name, 'react')
      return React
    }) } } },
    crypto: { randomUUID: () => '12345678-abcd-4def-8000-123456789012' },
    URL, Object, Set, Map, Promise, console, fetch: fetchImpl,
  }, { filename: 'client.js' })
  return mod
}

function mounted(fetchImpl, options = {}) {
  const requests = []
  const credentialsWrites = []
  const plugin = load(async (url, options) => {
    requests.push({ url, options })
    return fetchImpl ? fetchImpl(url, options) : Response.json({ tools: [{ name: 'webSearchPrime' }] })
  })
  const registrations = []
  const writes = []
  const value = {
    mode: 'fanout', maxResults: 8, attemptTimeoutMs: 12000, totalTimeoutMs: 30000,
    dedupeByUrl: true, includeAnswer: true,
    providers: options.providers ?? [{ kind: 'retired_source', enabled: true, baseURL: 'http://127.0.0.1:8045/v1beta' }],
  }
  const scope = {
    subscribe: () => () => {},
    getSnapshot: () => ({ value, writable: true, status: 'ready' }),
    set: async (name, next) => { writes.push([name, next]); value[name] = next; return true },
    unset: async () => true,
  }
  const ctx = {
    locale: { bind: () => key => key, register: () => () => {} },
    configForms: { get: () => scope, whileServed: (_, cb) => cb() },
    effect: cb => cb(),
    slots: { inject: (_, cb) => cb(), register: (definition, component) => {
      registrations.push({ definition, component })
      return () => {}
    } },
    remote: { $on: () => () => {}, credentials: {
      describe: async () => ({ ok: true, value: options.credentials ?? {} }),
      set: async (ref, text) => { credentialsWrites.push({ ref, text }); return { ok: options.rejectCredentials !== true } },
    } },
  }
  plugin.apply(ctx)
  return { registrations, injected: registrations[0].definition.inject(), writes, requests, credentialsWrites }
}

function view(registration, injected, tab, snapshot) {
  const original = React.useState
  React.useState = initial => [typeof initial === 'string' ? tab : typeof initial === 'boolean' ? true : initial, () => {}]
  try {
    return registration.component({ ...injected, t: key => key, useAgentWebSearch: selector => selector(snapshot) })
  } finally { React.useState = original }
}

function openRow(vnode) {
  const original = React.useState
  React.useState = initial => [typeof initial === 'boolean' ? true : initial, () => {}]
  try { return vnode.type(vnode.props) } finally { React.useState = original }
}

test('retired sources disappear and MCP drafts discover without saving or forwarding credentials', async () => {
  const { registrations, injected, writes, requests } = mounted()
  assert.deepEqual(registrations.map(item => item.definition.name), ['settings.section'])
  assert.equal(injected.hooks.agentWebSearch.getSnapshot().queue.some(item => item.kind === 'retired_source'), false)
  injected.addMcp()
  const id = injected.hooks.agentWebSearch.getSnapshot().queue.find(item => item.kind === 'mcp').id
  injected.setMcpField(id, 'baseURL', 'http://127.0.0.1:8045/mcp')
  injected.setMcpField(id, 'toolName', 'webSearchPrime')
  injected.setMcpField(id, 'inputTemplate', '{"q":"{{query}}"}')
  injected.setEnabled(id, true)
  const snapshot = injected.hooks.agentWebSearch.getSnapshot()
  assert.equal(snapshot.invalid, undefined)
  const draftTree = view(registrations[0], injected, 'mcp', snapshot)
  const rowVNode = all(draftTree).find(node => node.type?.name === 'McpRow')
  assert.equal(rowVNode.props.canDiscover, true)
  const row = openRow(rowVNode)
  const fields = all(row).filter(node => node.type?.name === 'McpField').map(node => node.props.label)
  assert.deepEqual(fields.slice(0, 2), ['mcpUrl', 'mcpToken'])
  const button = all(row).find(node => node.type === 'button' && node.children.includes('mcpDiscover'))
  assert.equal(button.props.disabled, false)
  await button.props.onClick()
  assert.equal(writes.length, 0)
  assert.equal(requests[0].url, '/api/agent-web-search/mcp-tools')
  assert.equal(requests[0].options.method, 'POST')
  assert.equal(JSON.parse(requests[0].options.body).baseURL, 'http://127.0.0.1:8045/mcp')
  assert.equal(JSON.parse(requests[0].options.body).token, undefined)
  assert.equal(all(row).some(node => node.type === 'details' && all(node).some(child => child.type === 'summary' && child.children.includes('mcpAdvanced'))), true)
  await injected.save()
  const saved = writes.find(([field]) => field === 'providers')[1]
  const savedMcp = saved.find(item => item.kind === 'mcp')
  assert.equal(savedMcp.toolName, 'webSearchPrime')
  assert.equal(savedMcp.inputTemplate, '{"q":"{{query}}"}')
  assert.equal(saved.some(item => item.kind === 'retired_source'), false)
  const sources = view(registrations[0], injected, 'sources', injected.hooks.agentWebSearch.getSnapshot())
  assert.equal(all(sources).some(node => node.type?.name === 'UpstreamRow' && node.props.entry.kind === 'retired_source'), false)
  assert.equal(sources.props.style.maxWidth, '920px')
})

test('MCP discovery requires a valid endpoint and preserves manual tool entry', () => {
  const { registrations, injected } = mounted()
  injected.addMcp()
  const id = injected.hooks.agentWebSearch.getSnapshot().queue.find(item => item.kind === 'mcp').id
  injected.setMcpField(id, 'baseURL', 'http://example.org/mcp')
  const invalid = view(registrations[0], injected, 'mcp', injected.hooks.agentWebSearch.getSnapshot())
  const invalidRow = all(invalid).find(node => node.type?.name === 'McpRow')
  assert.equal(invalidRow.props.canDiscover, false)
  assert.equal(all(openRow(invalidRow)).some(node => node.type === 'button' && node.children.includes('mcpDiscover') && node.props.disabled), true)
  injected.setMcpField(id, 'baseURL', 'https://example.org/mcp')
  const valid = view(registrations[0], injected, 'mcp', injected.hooks.agentWebSearch.getSnapshot())
  const validRow = all(valid).find(node => node.type?.name === 'McpRow')
  assert.equal(validRow.props.canDiscover, true)
  assert.equal(all(openRow(validRow)).some(node => node.type?.name === 'McpField' && node.props.label === 'mcpName'), true)
})

test('MCP discovery shows exact HTTP status and never offers stale tools for a changed URL', () => {
  const { registrations, injected } = mounted()
  injected.addMcp()
  const id = injected.hooks.agentWebSearch.getSnapshot().queue.find(item => item.kind === 'mcp').id
  injected.setMcpField(id, 'baseURL', 'https://first.example/mcp')
  const first = view(registrations[0], injected, 'mcp', injected.hooks.agentWebSearch.getSnapshot())
  const firstVNode = all(first).find(node => node.type?.name === 'McpRow')
  const original = React.useState
  const render = (vnode, tools) => {
    React.useState = initial => [typeof initial === 'boolean' ? true : initial && Object.hasOwn(initial, 'forKey') ? tools : initial, () => {}]
    try { return vnode.type(vnode.props) } finally { React.useState = original }
  }
  const error = render(firstVNode, { forKey: 'https://first.example/mcp\n', list: [], loading: false, error: 'upstream-http', httpStatus: 400 })
  assert.equal(all(error).some(node => node.props?.role === 'alert' && node.children.some(text => String(text).includes('HTTP 400'))), true)
  const listed = render(firstVNode, { forKey: 'https://first.example/mcp\n', list: [{ name: 'firstTool' }], loading: false, error: null })
  assert.equal(all(listed).some(node => node.type === 'option' && node.props.value === 'firstTool'), true)
  injected.setMcpField(id, 'baseURL', 'https://second.example/mcp')
  const second = view(registrations[0], injected, 'mcp', injected.hooks.agentWebSearch.getSnapshot())
  const secondVNode = all(second).find(node => node.type?.name === 'McpRow')
  const stale = render(secondVNode, { forKey: 'https://first.example/mcp\n', list: [{ name: 'firstTool' }], loading: false, error: null })
  assert.equal(all(stale).some(node => node.type === 'option' && node.props.value === 'firstTool'), false)
})

test('editing an MCP endpoint rotates its credential id and cannot send the saved token to the new server', async () => {
  const saved = { kind: 'mcp', id: 'saved', enabled: true, baseURL: 'https://old.example/mcp', toolName: 'search', inputTemplate: '{"query":"{{query}}"}', responseMode: 'auto', resultPath: '/results', urlPath: '/url', titlePath: '/title', snippetPath: '/snippet', publishedAtPath: '/publishedAt' }
  const { registrations, injected, writes, credentialsWrites } = mounted(undefined, { providers: [saved], credentials: { AGENT_WEB_SEARCH_MCP_SAVED: { configured: true } } })
  injected.setMcpField('saved', 'baseURL', 'https://new.example/mcp')
  const changed = injected.hooks.agentWebSearch.getSnapshot()
  assert.equal(changed.queue.find(item => item.id === 'saved').endpointChanged, true)
  const pane = view(registrations[0], injected, 'mcp', changed)
  const row = all(pane).find(node => node.type?.name === 'McpRow')
  assert.equal(all(openRow(row)).some(node => node.type === 'p' && node.children.includes('mcpCredentialScope')), true)
  injected.setKeyDraft('saved', 'NEW_DRAFT_TOKEN')
  await injected.save()
  const result = writes.find(([key]) => key === 'providers')[1].find(entry => entry.kind === 'mcp')
  assert.notEqual(result.id, 'saved')
  assert.equal(result.baseURL, 'https://new.example/mcp')
  assert.equal(credentialsWrites[0].ref, `AGENT_WEB_SEARCH_MCP_${result.id.toUpperCase().replaceAll('-', '_')}`)
  assert.equal(credentialsWrites.some(write => write.ref === 'AGENT_WEB_SEARCH_MCP_SAVED'), false)
  const withoutNewToken = mounted(undefined, { providers: [saved] })
  withoutNewToken.injected.setMcpField('saved', 'baseURL', 'https://new.example/mcp')
  await withoutNewToken.injected.save()
  assert.notEqual(withoutNewToken.writes.find(([key]) => key === 'providers')[1].find(entry => entry.kind === 'mcp').id, 'saved')
  assert.equal(withoutNewToken.credentialsWrites.length, 0)
})

test('failed credential write cannot update an MCP endpoint or expose the old key', async () => {
  const saved = { kind: 'mcp', id: 'saved', enabled: true, baseURL: 'https://old.example/mcp', toolName: 'search', inputTemplate: '{"query":"{{query}}"}', responseMode: 'auto', resultPath: '/results', urlPath: '/url', titlePath: '/title', snippetPath: '/snippet', publishedAtPath: '/publishedAt' }
  const { injected, writes, credentialsWrites } = mounted(undefined, { providers: [saved], rejectCredentials: true })
  injected.setMcpField('saved', 'baseURL', 'https://new.example/mcp')
  injected.setKeyDraft('saved', 'NEW_DRAFT_TOKEN')
  await injected.save()
  assert.equal(credentialsWrites.length, 1)
  assert.equal(writes.some(([name]) => name === 'providers'), false)
  assert.equal(injected.hooks.agentWebSearch.getSnapshot().failed, true)
})

test('activity renders exactly one table row per search call with inline attempts', () => {
  const { registrations, injected } = mounted()
  const activity = view(registrations[0], injected, 'activity', injected.hooks.agentWebSearch.getSnapshot())
  const panel = all(activity).find(node => node.type?.name === 'SearchHistoryPanel')
  const original = React.useState
  React.useState = initial => [initial && Array.isArray(initial.entries)
    ? { entries: [{ id: 1, at: '2026-09-29T12:00:00Z', mode: 'fanout', status: 'success', resultCount: 5, durationMs: 1234, attempts: [
      { kind: 'exa', status: 'success', resultCount: 5, durationMs: 700 },
      { kind: 'mcp', sourceId: 'local-search', status: 'timeout', resultCount: 0, durationMs: 1200, httpStatus: 504 },
    ] }], selectedProvider: 'agent-web-search', loading: false, error: false }
    : initial, () => {}]
  try {
    const rendered = panel.type(panel.props)
    const rows = all(rendered).filter(node => node.type === 'tr')
    assert.equal(rows.length, 2) // one header row and one call row
    const cells = all(rows[1]).filter(node => node.type === 'td')
    assert.equal(cells.length, 5)
    assert.match(cells[4].children[0], /Exa.*MCP tool.*HTTP 504/)
    assert.equal(all(rows[1]).filter(node => node.type === 'p').length, 0)
    assert.equal(cells[4].props.style.whiteSpace, 'nowrap')
    assert.equal(all(rendered).find(node => node.props?.role === 'region').props.style.overflow, 'auto')
  } finally { React.useState = original }
})
