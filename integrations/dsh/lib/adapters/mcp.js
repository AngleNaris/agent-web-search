import { UpstreamError } from '../http.js'

const VERSION = '2025-06-18'
const MAX_BODY = 1024 * 1024
const MAX_PAGES = 10
const MAX_TEXT = 6000
const REF = /^[a-z][a-z0-9-]{0,39}$/
const fail = (message, status) => { throw new UpstreamError(`mcp ${message}`, { kind: 'mcp', status }) }

export function mcpCredentialRef(id) {
  return REF.test(id ?? '') ? `AGENT_WEB_SEARCH_MCP_${id.toUpperCase().replaceAll('-', '_')}` : null
}

function endpointOf(raw) {
  let url
  try { url = new URL(raw) } catch { fail('endpoint must be an absolute HTTP URL') }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if (!(url.protocol === 'https:' || (url.protocol === 'http:' && loopback)) || url.username || url.password || url.hash) {
    fail('endpoint must use HTTPS, or HTTP on loopback, without embedded credentials or fragments')
  }
  return url.href
}

async function boundedText(response) {
  const reader = response.body?.getReader()
  if (!reader) return ''
  const chunks = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > MAX_BODY) fail('response exceeds 1 MiB')
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  return new TextDecoder().decode(bytes)
}

function parseResponse(text, contentType, id) {
  if (contentType.includes('text/event-stream')) {
    for (const event of text.split(/\r?\n\r?\n/)) {
      const data = event.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n')
      if (!data) continue
      try {
        const body = JSON.parse(data)
        if (body.id === id) return body
      } catch { /* unrelated SSE events are not a JSON-RPC reply */ }
    }
    fail('response stream did not contain the matching JSON-RPC reply')
  }
  try {
    const body = JSON.parse(text)
    if (body?.id === id) return body
  } catch { /* handled below */ }
  fail('response is not a matching JSON-RPC reply')
}

async function post(endpoint, method, params, state, signal, transport = fetch) {
  const id = method === 'notifications/initialized' ? undefined : ++state.nextId
  const body = { jsonrpc: '2.0', ...(id === undefined ? {} : { id }), method, ...(params === undefined ? {} : { params }) }
  const headers = {
    accept: 'application/json, text/event-stream',
    'content-type': 'application/json',
    ...(state.version ? { 'mcp-protocol-version': state.version } : {}),
    ...(state.session ? { 'mcp-session-id': state.session } : {}),
    ...(state.token ? { authorization: `Bearer ${state.token}` } : {}),
    'mcp-method': method,
  }
  let response
  try { response = await transport(endpoint, { method: 'POST', headers, body: JSON.stringify(body), redirect: 'error', signal }) }
  catch (error) {
    if (signal?.aborted) throw error
    fail('network request failed')
  }
  if (!response.ok) fail(`HTTP ${response.status}`, response.status)
  if (method === 'initialize') state.session = response.headers.get('mcp-session-id') ?? undefined
  if (id === undefined) {
    if (response.status !== 202 && response.status !== 200) fail('initialization notification was rejected')
    return undefined
  }
  const result = parseResponse(await boundedText(response), response.headers.get('content-type') ?? '', id)
  if (result.error) fail(`JSON-RPC error ${Number.isInteger(result.error.code) ? result.error.code : 'unknown'}`)
  if (!result.result || typeof result.result !== 'object') fail('response has no result')
  return result.result
}

function pointer(value, path) {
  if (path === '') return value
  if (typeof path !== 'string' || !path.startsWith('/')) fail('output mapping must use JSON Pointer paths')
  return path.slice(1).split('/').reduce((current, segment) => {
    const key = segment.replaceAll('~1', '/').replaceAll('~0', '~')
    return current !== null && typeof current === 'object' ? current[key] : undefined
  }, value)
}

function substitute(value, query, maxResults) {
  if (Array.isArray(value)) return value.map(item => substitute(item, query, maxResults))
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, substitute(item, query, maxResults)]))
  }
  if (typeof value !== 'string') return value
  if (value === '{{query}}') return query
  if (value === '{{maxResults}}') return maxResults
  return value.replaceAll('{{query}}', query).replaceAll('{{maxResults}}', String(maxResults))
}

function responseData(result, mode) {
  const text = Array.isArray(result.content)
    ? result.content.filter(part => part?.type === 'text' && typeof part.text === 'string').map(part => part.text).join('\n').slice(0, MAX_BODY)
    : ''
  if (mode === 'text') return { data: undefined, answer: text.slice(0, MAX_TEXT) }
  if (mode === 'structured' || (mode === 'auto' && result.structuredContent !== undefined)) {
    if (result.structuredContent === null || typeof result.structuredContent !== 'object') fail('structuredContent is not JSON data')
    return { data: result.structuredContent, answer: '' }
  }
  try { return { data: JSON.parse(text), answer: '' } }
  catch { if (mode === 'auto' && text.trim()) return { data: undefined, answer: text.slice(0, MAX_TEXT) }; fail('text content is not JSON') }
}

function extractRows(data, entry, maxResults) {
  if (data === undefined) return []
  const list = pointer(data, entry.resultPath ?? '/results')
  if (!Array.isArray(list)) fail('mapped result path is not an array')
  const results = []
  for (const item of list.slice(0, Math.min(100, maxResults * 4))) {
    const raw = pointer(item, entry.urlPath || '/url')
    if (typeof raw !== 'string' || raw.length > 2048) continue
    let url
    try { url = new URL(raw) } catch { continue }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) continue
    const field = (path, cap) => {
      const value = pointer(item, path)
      return typeof value === 'string' ? value.slice(0, cap) : ''
    }
    results.push({
      url: url.href,
      title: field(entry.titlePath || '/title', 300),
      description: field(entry.snippetPath || '/snippet', 1000),
      publishedAt: field(entry.publishedAtPath || '/publishedAt', 100) || undefined,
    })
  }
  return results
}

async function initializeMcp(endpoint, state, signal, transport) {
  const hello = await post(endpoint, 'initialize', {
    protocolVersion: VERSION, capabilities: {}, clientInfo: { name: 'dsh-agent-web-search', version: '0.3.0' },
  }, state, signal, transport)
  if (typeof hello.protocolVersion !== 'string' || !/^20\d\d-\d\d-\d\d$/.test(hello.protocolVersion) || !hello.capabilities?.tools) fail('server does not support MCP tools')
  state.version = hello.protocolVersion
  await post(endpoint, 'notifications/initialized', undefined, state, signal, transport)
}

async function listMcpTools(endpoint, state, signal, transport, targetName) {
  let cursor
  const tools = []
  for (let page = 0; page < MAX_PAGES; page++) {
    const list = await post(endpoint, 'tools/list', cursor ? { cursor } : {}, state, signal, transport)
    if (!Array.isArray(list.tools)) fail('server returned an invalid tool list')
    for (const tool of list.tools) {
      if (typeof tool?.name !== 'string' || tool.name.length > 128) continue
      tools.push({ name: tool.name, description: typeof tool.description === 'string' ? tool.description.slice(0, 180) : '' })
      if (tools.length >= 200 || tool.name === targetName) return tools
    }
    cursor = list.nextCursor
    if (!cursor) break
  }
  return tools
}

async function closeMcp(endpoint, state, transport) {
  if (!state.session) return
  try {
    await transport(endpoint, { method: 'DELETE', redirect: 'error', signal: AbortSignal.timeout(1500), headers: {
      'mcp-session-id': state.session,
      'mcp-protocol-version': state.version,
      ...(state.token ? { authorization: `Bearer ${state.token}` } : {}),
    } })
  } catch { /* session termination is best effort */ }
}

/** Discover tool names only; this operation never invokes tools/call. */
export async function discoverMcpTools({ entry, apiKey, signal, transport = fetch }) {
  const endpoint = endpointOf(entry?.baseURL)
  const state = { nextId: 0, version: VERSION, session: undefined, token: apiKey }
  try {
    await initializeMcp(endpoint, state, signal, transport)
    return await listMcpTools(endpoint, state, signal, transport)
  } finally { await closeMcp(endpoint, state, transport) }
}

/** A configured exact Streamable HTTP tool, never a fuzzy tool auto-selector. */
export async function searchMcp({ query, maxResults, apiKey, entry, signal, transport = fetch }) {
  if (!REF.test(entry?.id ?? '') || typeof entry?.toolName !== 'string' || !entry.toolName.trim()) fail('id and exact tool name are required')
  const endpoint = endpointOf(entry.baseURL)
  let template
  try { template = JSON.parse(entry.inputTemplate || '{"query":"{{query}}"}') }
  catch { fail('input template is not JSON') }
  if (template === null || typeof template !== 'object' || Array.isArray(template)) fail('input template must be a JSON object')
  const state = { nextId: 0, version: VERSION, session: undefined, token: apiKey }
  try {
    await initializeMcp(endpoint, state, signal, transport)
    const tools = await listMcpTools(endpoint, state, signal, transport, entry.toolName)
    if (!tools.some(tool => tool.name === entry.toolName)) fail('configured tool was not found in the MCP server')
    const args = substitute(template, query, maxResults)
    const output = await post(endpoint, 'tools/call', { name: entry.toolName, arguments: args }, state, signal, transport)
    if (output.isError === true) fail('configured tool returned an error')
    const { data, answer } = responseData(output, entry.responseMode || 'auto')
    const results = extractRows(data, entry, maxResults)
    if (results.length === 0 && !answer) fail('tool returned no mapped web URLs or text answer')
    return { results, answer, searched: true }
  } finally { await closeMcp(endpoint, state, transport) }
}

export const mcpAdapter = {
  kind: 'mcp', label: 'MCP tool (Streamable HTTP)', credentialRef: null,
  credentialRefOf: entry => mcpCredentialRef(entry.id), anonymousOk: true, defaultBaseURL: '',
  search: searchMcp,
}
