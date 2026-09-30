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
  const plugin = load(fetchImpl)
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

test('retired sources disappear from the queue and the sources tab', async () => {
  const { registrations, injected } = mounted()
  assert.deepEqual(registrations.map(item => item.definition.name), ['settings.section'])
  assert.equal(injected.hooks.agentWebSearch.getSnapshot().queue.some(item => item.kind === 'retired_source'), false)
  const sources = view(registrations[0], injected, 'sources', injected.hooks.agentWebSearch.getSnapshot())
  assert.equal(all(sources).some(node => node.type?.name === 'UpstreamRow' && node.props.entry.kind === 'retired_source'), false)
  assert.equal(sources.props.style.maxWidth, '920px')
})

test('activity renders exactly one table row per search call with inline attempts', () => {
  const { registrations, injected } = mounted()
  const activity = view(registrations[0], injected, 'activity', injected.hooks.agentWebSearch.getSnapshot())
  const panel = all(activity).find(node => node.type?.name === 'SearchHistoryPanel')
  const original = React.useState
  React.useState = initial => [initial && Array.isArray(initial.entries)
    ? { entries: [{ id: 1, at: '2026-09-29T12:00:00Z', mode: 'fanout', status: 'success', resultCount: 5, durationMs: 1234, attempts: [
      { kind: 'exa', status: 'success', resultCount: 5, durationMs: 700 },
      { kind: 'parallel', status: 'timeout', resultCount: 0, durationMs: 1200, httpStatus: 504 },
    ] }], selectedProvider: 'agent-web-search', loading: false, error: false }
    : initial, () => {}]
  try {
    const rendered = panel.type(panel.props)
    const rows = all(rendered).filter(node => node.type === 'tr')
    assert.equal(rows.length, 2) // one header row and one call row
    const cells = all(rows[1]).filter(node => node.type === 'td')
    assert.equal(cells.length, 5)
    assert.match(cells[4].children[0], /Exa.*Parallel.*HTTP 504/)
    assert.equal(all(rows[1]).filter(node => node.type === 'p').length, 0)
    assert.equal(cells[4].props.style.whiteSpace, 'nowrap')
    assert.equal(all(rendered).find(node => node.props?.role === 'region').props.style.overflow, 'auto')
  } finally { React.useState = original }
})
