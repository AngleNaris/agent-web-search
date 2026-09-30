import { spawn as defaultSpawn } from 'node:child_process'

const DEFAULT_COMMAND = 'agent-web-search-mcp'
const DEFAULT_PROTOCOL_VERSION = '2025-06-18'
const MAX_OUTPUT_BYTES = 1024 * 1024
const MAX_RESULTS = 20

const CREDENTIAL_ENV = {
  ark: 'ARK_API_KEY',
  brave: 'BRAVE_SEARCH_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
  exa: 'EXA_API_KEY',
  gemini: 'GEMINI_API_KEY',
  grok: 'XAI_API_KEY',
  messages: 'AGENT_WEB_SEARCH_MESSAGES_API_KEY',
  parallel: 'PARALLEL_API_KEY',
  perplexity: 'PERPLEXITY_API_KEY',
  responses: 'AGENT_WEB_SEARCH_RESPONSES_API_KEY',
  tavily: 'TAVILY_API_KEY',
  you: 'YDC_API_KEY',
  zhipu_web_search: 'ZHIPU_WEB_SEARCH_API_KEY',
  zhipu_chat_search: 'ZHIPU_CHAT_SEARCH_API_KEY',
}

const ENDPOINT_ENV = {
  ark: 'AGENT_WEB_SEARCH_ARK_ENDPOINT',
  brave: 'AGENT_WEB_SEARCH_BRAVE_ENDPOINT',
  ddgs: 'AGENT_WEB_SEARCH_DDGS_ENDPOINT',
  exa: 'EXA_MCP_URL',
  gemini: 'AGENT_WEB_SEARCH_GEMINI_ENDPOINT',
  grok: 'AGENT_WEB_SEARCH_GROK_ENDPOINT',
  parallel: 'AGENT_WEB_SEARCH_PARALLEL_ENDPOINT',
  perplexity: 'AGENT_WEB_SEARCH_PERPLEXITY_ENDPOINT',
  tavily: 'AGENT_WEB_SEARCH_TAVILY_ENDPOINT',
  you: 'AGENT_WEB_SEARCH_YOU_ENDPOINT',
}

const BASE_URL_ENV = {
  deepseek: 'AGENT_WEB_SEARCH_DEEPSEEK_BASE_URL',
  messages: 'AGENT_WEB_SEARCH_MESSAGES_BASE_URL',
  responses: 'AGENT_WEB_SEARCH_RESPONSES_BASE_URL',
  zhipu_web_search: 'AGENT_WEB_SEARCH_ZHIPU_WEB_SEARCH_BASE_URL',
  zhipu_chat_search: 'AGENT_WEB_SEARCH_ZHIPU_CHAT_BASE_URL',
}

const EXTRA_ENDPOINT_ENV = [
  'AGENT_WEB_SEARCH_EXA_ENDPOINT',
  'AGENT_WEB_SEARCH_PARALLEL_MCP_URL',
]

function endpointValue(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return undefined
  let url
  try { url = new URL(raw.trim()) } catch { throw providerError('provider endpoint is invalid', 'configuration') }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) || url.username || url.password || url.hash) {
    throw providerError('provider endpoint must use HTTPS, or HTTP on loopback, without credentials or fragments', 'configuration')
  }
  return url.href
}

const providerError = (message, code = 'bridge_error', details = {}) => {
  const error = new Error(message)
  error.code = code
  Object.assign(error, details)
  return error
}

function abortError(message = 'search aborted') {
  const error = new Error(message)
  error.name = 'AbortError'
  error.code = 'cancelled'
  return error
}

function timeoutError() {
  const error = new Error('search timed out')
  error.name = 'TimeoutError'
  error.code = 'timeout'
  return error
}

function parseArgs(raw) {
  if (!raw) return []
  let parsed
  try { parsed = JSON.parse(raw) } catch { throw providerError('MCP command arguments are invalid', 'configuration') }
  if (!Array.isArray(parsed) || parsed.some(item => typeof item !== 'string')) {
    throw providerError('MCP command arguments must be a JSON array of strings', 'configuration')
  }
  return parsed
}

function readEnvironment(options = {}) {
  const environment = options.environment ?? process.env
  const command = options.command ?? environment.AGENT_WEB_SEARCH_MCP_COMMAND ?? DEFAULT_COMMAND
  const args = options.args ?? parseArgs(environment.AGENT_WEB_SEARCH_MCP_ARGS)
  if (typeof command !== 'string' || command.trim() === '') {
    throw providerError('AGENT_WEB_SEARCH_MCP_COMMAND must not be empty', 'configuration')
  }
  return { command: command.trim(), args }
}

function withAbort(signal, promise) {
  if (!signal) return promise
  if (signal.aborted) return Promise.reject(signal.reason ?? abortError())
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? abortError())
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort)).catch(() => {})
  })
}

function sourceUrl(raw) {
  if (typeof raw !== 'string') return undefined
  try {
    const url = new URL(raw.trim())
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
    if (url.username || url.password || url.hash) return undefined
    return url.href
  } catch { return undefined }
}

function mapProviderPayload(payload, maxResults) {
  if (!payload || typeof payload !== 'object' || !payload.providers || typeof payload.providers !== 'object') {
    throw providerError('MCP result was malformed', 'malformed_result')
  }
  const sources = []
  const answers = []
  const labels = {
    ark: 'ARK', brave: 'Brave', deepseek: 'DeepSeek', ddgs: 'DuckDuckGo', exa: 'Exa',
    gemini: 'Gemini', grok: 'Grok', messages: 'Anthropic Messages', parallel: 'Parallel',
    perplexity: 'Perplexity', responses: 'OpenAI Responses', tavily: 'Tavily', you: 'You.com',
    zhipu_web_search: 'Zhipu Web Search', zhipu_chat_search: 'Zhipu Chat Search',
  }
  for (const [provider, value] of Object.entries(payload.providers)) {
    if (!value || typeof value !== 'object') continue
    const label = labels[provider] ?? provider
    if (typeof value.answer === 'string' && value.answer.trim()) {
      answers.push(`【来源：${labels[provider] ?? provider}】\n${value.answer.trim()}`)
    }
    if (!Array.isArray(value.results)) continue
    for (const row of value.results) {
      const url = sourceUrl(row?.url)
      if (!url) continue
      sources.push({
        title: `【来源：${label}】${typeof row.title === 'string' && row.title.trim() ? ` ${row.title.trim()}` : ''}`,
        url,
        ...(typeof row.description === 'string' && row.description.trim() ? { snippet: row.description.trim() } : {}),
        ...(typeof row.published_at === 'string' ? { publishedAt: row.published_at } : {}),
        ...(typeof row.author === 'string' ? { author: row.author } : {}),
      })
      if (sources.length >= maxResults * 4) break
    }
  }
  return {
    sources,
    ...(answers.length > 0 ? { content: answers.join('\n\n') } : {}),
    truncated: false,
  }
}

function publicProviderErrors(value) {
  if (!value || typeof value !== 'object') return {}
  return Object.fromEntries(Object.entries(value).filter(([name, message]) => (
    typeof name === 'string' && typeof message === 'string' && message.length <= 160
  )))
}

function parseToolEnvelope(envelope) {
  if (!envelope || typeof envelope !== 'object') throw providerError('MCP result was malformed', 'malformed_result')
  if (envelope.error) throw providerError('MCP tool call failed', 'tool_error')
  const result = envelope.result
  if (!result || typeof result !== 'object' || !Array.isArray(result.content)) {
    throw providerError('MCP result was malformed', 'malformed_result')
  }
  const text = result.content
    .filter(part => part?.type === 'text' && typeof part.text === 'string')
    .map(part => part.text)
    .join('\n')
  if (text.length > MAX_OUTPUT_BYTES) throw providerError('MCP result exceeds 1 MiB', 'output_limit')
  let payload
  try { payload = JSON.parse(text) } catch { throw providerError('MCP result was not valid JSON', 'malformed_result') }
  if (result.isError === true || payload?.error?.code === 'all_providers_failed') {
    const error = providerError('All configured search providers failed', payload?.error?.code ?? 'all_providers_failed')
    error.providerErrors = publicProviderErrors(payload?.error?.provider_errors)
    throw error
  }
  return payload
}

class StdioRpc {
  constructor(child, signal, maxBytes = MAX_OUTPUT_BYTES, lineMode = false) {
    this.child = child
    this.signal = signal
    this.maxBytes = maxBytes
    this.lineMode = lineMode
    this.buffer = ''
    this.bytes = 0
    this.pending = new Map()
    this.closed = false
    this.onData = chunk => this.#data(chunk)
    this.onError = () => this.#fail(providerError('MCP process failed', 'process_error'))
    this.onExit = () => this.#fail(providerError('MCP process exited before replying', 'process_error'))
    this.onAbort = () => this.#fail(this.signal.reason ?? abortError())
    child.stdout?.on('data', this.onData)
    child.stderr?.on('data', chunk => {
      this.bytes += Buffer.byteLength(chunk)
      if (this.bytes > this.maxBytes) this.#fail(providerError('MCP output exceeds 1 MiB', 'output_limit'))
    })
    child.on('error', this.onError)
    child.on('exit', this.onExit)
    signal?.addEventListener('abort', this.onAbort, { once: true })
    if (signal?.aborted) this.#fail(signal.reason ?? abortError())
  }

  #data(chunk) {
    if (this.closed) return
    this.bytes += Buffer.byteLength(chunk)
    if (this.bytes > this.maxBytes) return this.#fail(providerError('MCP output exceeds 1 MiB', 'output_limit'))
    this.buffer += chunk.toString()
    while (true) {
      let text
      if (this.lineMode) {
        const newline = this.buffer.indexOf('\n')
        if (newline < 0) return
        text = this.buffer.slice(0, newline).trim()
        this.buffer = this.buffer.slice(newline + 1)
        if (!text) continue
      } else {
        const separator = this.buffer.indexOf('\r\n\r\n')
        const alternate = this.buffer.indexOf('\n\n')
        const headerEnd = separator >= 0 ? separator : alternate
        if (headerEnd < 0) return
        const header = this.buffer.slice(0, headerEnd)
        const match = header.match(/(?:^|\r?\n)content-length:\s*(\d+)\s*$/im)
        if (!match) return this.#fail(providerError('MCP process returned malformed headers', 'malformed_result'))
        const bodyStart = headerEnd + (separator >= 0 ? 4 : 2)
        const length = Number(match[1])
        const body = Buffer.from(this.buffer.slice(bodyStart))
        if (body.byteLength < length) return
        text = body.subarray(0, length).toString()
        this.buffer = body.subarray(length).toString()
      }
      let message
      try { message = JSON.parse(text) } catch { return this.#fail(providerError('MCP process returned malformed JSON', 'malformed_result')) }
      if (message.id === undefined) continue
      const pending = this.pending.get(message.id)
      if (!pending) continue
      this.pending.delete(message.id)
      pending.resolve(message)
    }
  }

  #fail(error) {
    if (this.closed) return
    this.closed = true
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
  }

  call(id, method, params) {
    if (this.closed) return Promise.reject(providerError('MCP process is closed', 'process_error'))
    const message = { jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) }
    return withAbort(this.signal, new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      try { this.write(message) } catch { this.pending.delete(id); reject(providerError('MCP process write failed', 'process_error')) }
    }))
  }

  notify(method, params) {
    if (this.closed) throw providerError('MCP process is closed', 'process_error')
    this.write({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) })
  }

  write(message) {
    const text = JSON.stringify(message)
    if (this.lineMode) this.child.stdin.write(`${text}\n`)
    else this.child.stdin.write(`Content-Length: ${Buffer.byteLength(text)}\r\n\r\n${text}`)
  }

  close() {
    if (this.closed) return
    this.#fail(providerError('MCP process closed', 'process_error'))
    this.signal?.removeEventListener('abort', this.onAbort)
  }
}

export class PythonSearchBridge {
  constructor(options = {}) {
    this.spawn = options.spawn ?? defaultSpawn
    this.command = options.command
    this.args = options.args
    this.baseEnv = options.env ?? process.env
    this.maxOutputBytes = options.maxOutputBytes ?? MAX_OUTPUT_BYTES
    this.lineMode = options.lineMode !== false
  }

  async search({ query, maxResults, providers, entries, resolveValue, timeoutMs, signal }) {
    if (!Array.isArray(providers) || providers.length === 0) {
      throw providerError('No Python search providers are configured', 'configuration')
    }
    const childSignal = signal
    if (childSignal?.aborted) throw childSignal.reason ?? abortError()
    const environment = await buildEnvironment({
      baseEnv: this.baseEnv,
      entries,
      providers,
      resolveValue,
      signal: childSignal,
      timeoutMs,
    })
    const command = readEnvironment({ command: this.command, args: this.args, environment: this.baseEnv })
    let child
    try {
      child = this.spawn(command.command, command.args, { env: environment, stdio: ['pipe', 'pipe', 'pipe'] })
      if (childSignal?.aborted) throw childSignal.reason ?? abortError()
      const timeout = timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined
      const combined = timeout && childSignal ? AbortSignal.any([childSignal, timeout]) : (timeout ?? childSignal)
      const request = new StdioRpc(child, combined, this.maxOutputBytes, this.lineMode)
      const initialized = await request.call(1, 'initialize', {
        protocolVersion: DEFAULT_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'dsh-agent-web-search', version: '0.5.0' },
      })
      if (initialized.error) throw providerError('MCP initialization failed', 'protocol_error')
      request.notify('notifications/initialized')
      const envelope = await request.call(2, 'tools/call', {
        name: 'web_search',
        arguments: { query, max_results: maxResults, providers },
      })
      return mapProviderPayload(parseToolEnvelope(envelope), maxResults)
    } catch (error) {
      if (childSignal?.aborted) throw childSignal.reason ?? abortError()
      if (error?.name === 'TimeoutError') throw timeoutError()
      if (error?.name === 'AbortError') throw error
      throw error?.code ? error : providerError('Python search bridge failed', 'bridge_error')
    } finally {
      if (child) {
        try { child.stdin?.end() } catch {}
        try { child.kill('SIGTERM') } catch {}
      }
    }
  }
}

async function buildEnvironment({ baseEnv, entries, providers, resolveValue, signal, timeoutMs }) {
  const env = { ...baseEnv }
  env.AGENT_WEB_SEARCH_PROVIDERS = providers.join(',')
  env.AGENT_WEB_SEARCH_TIMEOUT = String(Math.max(0.001, timeoutMs / 1000))
  env.AGENT_WEB_SEARCH_MCP_TRANSPORT = 'stdio'
  for (const [name, variable] of Object.entries(CREDENTIAL_ENV)) delete env[variable]
  for (const variable of Object.values(ENDPOINT_ENV)) delete env[variable]
  for (const variable of Object.values(BASE_URL_ENV)) delete env[variable]
  for (const variable of EXTRA_ENDPOINT_ENV) delete env[variable]
  for (const entry of entries ?? []) {
    if (!providers.includes(entry.kind)) continue
    const credentialEnv = CREDENTIAL_ENV[entry.kind]
    if (credentialEnv && entry.credentialRef && typeof resolveValue === 'function') {
      const value = await withAbort(signal, Promise.resolve(resolveValue(entry.credentialRef, signal)))
      if (typeof value === 'string' && value.trim()) env[credentialEnv] = value
    }
    if (entry.baseURL) {
      const endpoint = endpointValue(entry.baseURL)
      const variable = BASE_URL_ENV[entry.kind] ?? ENDPOINT_ENV[entry.kind]
      if (variable) env[variable] = endpoint
      if (entry.kind === 'exa') {
        env.EXA_MCP_URL = endpoint
        env.AGENT_WEB_SEARCH_EXA_ENDPOINT = endpoint
      }
      if (entry.kind === 'parallel') {
        env.AGENT_WEB_SEARCH_PARALLEL_MCP_URL = endpoint
        env.AGENT_WEB_SEARCH_PARALLEL_ENDPOINT = endpoint
      }
    }
  }
  return env
}

function normalizedKey(url) {
  try {
    const parsed = new URL(url)
    parsed.hash = ''
    return parsed.href.replace(/\/$/, '').toLowerCase()
  } catch { return url }
}

function mergeOutcomes(outcomes, maxResults, dedupeByUrl) {
  const sources = []
  const seen = new Set()
  const answers = []
  for (const outcome of outcomes) {
    if (outcome?.content) answers.push(outcome.content)
    for (const source of outcome?.sources ?? []) {
      const key = normalizedKey(source.url)
      if (dedupeByUrl && seen.has(key)) continue
      seen.add(key)
      sources.push(source)
      if (sources.length >= maxResults) break
    }
    if (sources.length >= maxResults) break
  }
  return {
    sources,
    truncated: outcomes.some(outcome => outcome?.truncated) || sources.length >= maxResults,
    ...(answers.length > 0 ? { content: answers.join('\n\n---\n\n') } : {}),
  }
}

export function mergeBridgeOutcomes(outcomes, maxResults, dedupeByUrl = true) {
  return mergeOutcomes(outcomes, Math.max(1, Math.min(MAX_RESULTS, Math.floor(maxResults))), dedupeByUrl)
}

export { CREDENTIAL_ENV, ENDPOINT_ENV, BASE_URL_ENV, MAX_OUTPUT_BYTES, mapProviderPayload, parseToolEnvelope }
