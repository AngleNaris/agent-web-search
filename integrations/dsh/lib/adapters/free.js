/**
 * The zero-cost upstreams: Exa, Parallel and DuckDuckGo.
 *
 * These three are why this plugin is worth installing: none of them needs an
 * API key, so a fresh deployment serves searches without touching anyone's
 * billing. Exa and Parallel expose a free MCP endpoint that an unauthenticated
 * client may call; DuckDuckGo exposes a plain HTML results page.
 *
 * @module dsh-agent-web-search/adapters/free-mcp
 */

import { KIND_DEFAULT_BASE_URL } from '../defaults.js'
import { UpstreamError, fetchText, postJsonRpc, readJsonRpc } from '../http.js'

/** Split an Exa free-MCP text block into rows. */
function parseExaText(text) {
  const rows = []
  for (const block of text.split('\n\n---\n\n')) {
    const trimmed = block.trim()
    if (trimmed.length === 0) continue
    let title = ''
    let url = ''
    let published = ''
    let author = ''
    const snippet = []
    let inHighlights = false
    for (const line of trimmed.split('\n')) {
      const stripped = line.trim()
      if (stripped.length === 0) continue
      const separator = stripped.indexOf(':')
      const key = separator === -1 ? '' : stripped.slice(0, separator).trim().toLowerCase()
      const value = separator === -1 ? '' : stripped.slice(separator + 1).trim()
      if (key === 'title') { title = value; inHighlights = false; continue }
      if (key === 'url') { url = value; inHighlights = false; continue }
      if (key === 'published') { published = value; inHighlights = false; continue }
      if (key === 'author') { author = value; inHighlights = false; continue }
      if (key === 'highlights') { inHighlights = true; if (value.length > 0) snippet.push(value); continue }
      if (inHighlights) snippet.push(stripped)
    }
    if (url.length > 0) {
      rows.push({ title, url, description: snippet.join(' ').slice(0, 500), publishedAt: published || undefined, author: author || undefined })
    }
  }
  return rows
}

/** Exa: free MCP endpoint when no key is present, paid REST API when one is. */
export const exaAdapter = {
  kind: 'exa',
  label: 'Exa',
  credentialRef: 'EXA_API_KEY',
  anonymousOk: true,
  defaultBaseURL: KIND_DEFAULT_BASE_URL.exa,

  async search({ query, maxResults, apiKey, baseURL, signal }) {
    if (apiKey !== undefined && apiKey.length > 0) {
      // Paid path: the REST API returns clean JSON rows.
      const response = await fetchText('https://api.exa.ai/search', {
        method: 'POST',
        headers: { 'x-api-key': apiKey },
        body: { query, type: 'auto', numResults: maxResults, useAutoprompt: true, contents: { highlights: true } },
        signal,
        timeoutMs: 0,
        what: 'exa',
      })
      if (response.status < 200 || response.status >= 300) {
        throw new UpstreamError(`exa HTTP ${String(response.status)}`, { status: response.status, kind: 'exa' })
      }
      const data = JSON.parse(response.text)
      const results = (data.results ?? [])
        .filter(item => typeof item?.url === 'string' && item.url.length > 0)
        .map(item => ({
          title: (item.title ?? '').trim(),
          url: item.url,
          description: (Array.isArray(item.highlights) ? item.highlights.join(' ') : '').slice(0, 500),
          publishedAt: item.publishedDate ?? undefined,
          author: item.author ?? undefined,
        }))
      return { results, searched: results.length > 0 }
    }
    // Free path: one stateless tools/call, no handshake needed.
    const payload = {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'web_search_exa',
        arguments: {
          query,
          num_results: maxResults,
          livecrawl: 'fallback',
          type: 'magic',
          use_autoprompt: true,
        },
      },
    }
    const response = await postJsonRpc(baseURL, payload, { signal, timeoutMs: 0, what: 'exa' })
    if (response.status < 200 || response.status >= 300) {
      throw new UpstreamError(`exa MCP HTTP ${String(response.status)}`, { status: response.status, kind: 'exa' })
    }
    const envelope = readJsonRpc(response.body)
    if (envelope?.error !== undefined) {
      throw new UpstreamError(`exa MCP error: ${JSON.stringify(envelope.error).slice(0, 200)}`, { kind: 'exa' })
    }
    const blocks = envelope?.result?.content ?? []
    const text = blocks.filter(block => block?.type === 'text').map(block => block.text ?? '').join('\n')
    const results = parseExaText(text)
    return { results, searched: results.length > 0 }
  },
}

/** Read Parallel's MCP payload out of either a structured field or a text block. */
function readParallelPayload(envelope) {
  const result = envelope?.result
  if (result === undefined || result === null) return undefined
  if (result.isError === true) throw new UpstreamError(`parallel MCP tool error: ${JSON.stringify(result).slice(0, 200)}`, { kind: 'parallel' })
  if (typeof result.structuredContent === 'object' && result.structuredContent !== null) return result.structuredContent
  for (const block of result.content ?? []) {
    if (block?.type !== 'text') continue
    try {
      const parsed = JSON.parse(block.text ?? '')
      if (typeof parsed === 'object' && parsed !== null) return parsed
    } catch {
      continue
    }
  }
  return undefined
}

/** Parallel: free MCP endpoint when no key is present, paid REST API when one is. */
export const parallelAdapter = {
  kind: 'parallel',
  label: 'Parallel',
  credentialRef: 'PARALLEL_API_KEY',
  anonymousOk: true,
  defaultBaseURL: KIND_DEFAULT_BASE_URL.parallel,

  async search({ query, maxResults, apiKey, baseURL, signal }) {
    if (apiKey !== undefined && apiKey.length > 0) {
      const response = await fetchText('https://api.parallel.ai/v1/search', {
        method: 'POST',
        headers: { 'x-api-key': apiKey },
        body: {
          objective: query.slice(0, 5000),
          search_queries: [query.slice(0, 200)],
          advanced_settings: { max_results: maxResults },
        },
        signal,
        timeoutMs: 0,
        what: 'parallel',
      })
      if (response.status < 200 || response.status >= 300) {
        throw new UpstreamError(`parallel HTTP ${String(response.status)}`, { status: response.status, kind: 'parallel' })
      }
      const data = JSON.parse(response.text)
      const results = (data.results ?? [])
        .filter(item => typeof item?.url === 'string' && item.url.length > 0)
        .map(item => ({
          title: (item.title ?? '').trim(),
          url: item.url,
          description: (Array.isArray(item.excerpts) ? item.excerpts.join(' ') : '').slice(0, 500),
          publishedAt: item.publish_date ?? undefined,
        }))
      return { results, searched: results.length > 0 }
    }

    // Free path: Parallel's MCP endpoint is sessionful, so initialize first and
    // carry the session id into the tool call. A server that declines to issue
    // a session still answers the stateless call, which is why this continues
    // rather than failing when the header is absent.
    const init = await postJsonRpc(baseURL, {
      jsonrpc: '2.0',
      id: 'init',
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'dsh-agent-web-search', version: '0.1.0' },
      },
    }, { signal, timeoutMs: 0, what: 'parallel' })
    if (init.status < 200 || init.status >= 300) {
      throw new UpstreamError(`parallel MCP initialize HTTP ${String(init.status)}`, { status: init.status, kind: 'parallel' })
    }
    const call = await postJsonRpc(baseURL, {
      jsonrpc: '2.0',
      id: 'search',
      method: 'tools/call',
      params: {
        name: 'web_search',
        arguments: {
          objective: query.slice(0, 5000),
          search_queries: [query.slice(0, 200)],
          advanced_settings: { max_results: maxResults },
        },
      },
    }, {
      signal,
      timeoutMs: 0,
      what: 'parallel',
      sessionId: init.sessionId,
      headers: { 'mcp-protocol-version': '2025-06-18' },
    })
    if (call.status < 200 || call.status >= 300) {
      throw new UpstreamError(`parallel MCP HTTP ${String(call.status)}`, { status: call.status, kind: 'parallel' })
    }
    const envelope = readJsonRpc(call.body)
    if (envelope?.error !== undefined) {
      throw new UpstreamError(`parallel MCP error: ${JSON.stringify(envelope.error).slice(0, 200)}`, { kind: 'parallel' })
    }
    const data = readParallelPayload(envelope)
    const results = (data?.results ?? [])
      .filter(item => typeof item?.url === 'string' && item.url.length > 0)
      .map(item => ({
        title: (item.title ?? '').trim(),
        url: item.url,
        description: (Array.isArray(item.excerpts) ? item.excerpts.join(' ') : '').slice(0, 500),
        publishedAt: item.publish_date ?? undefined,
      }))
    return { results, searched: results.length > 0 }
  },
}

/** Unwrap DuckDuckGo's `/l/?uddg=` redirect wrapper. */
function unwrapDdgHref(href) {
  if (href.startsWith('//')) href = `https:${href}`
  try {
    const parsed = new URL(href)
    const target = parsed.searchParams.get('uddg')
    if (target !== null) return decodeURIComponent(target)
    return href
  } catch {
    return href
  }
}

/** Strip tags and decode the handful of entities DuckDuckGo emits. */
function stripHtml(value) {
  return value
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * DuckDuckGo: no key, no JSON API — the public HTML endpoint is scraped.
 *
 * This is the least robust upstream of the three (the markup can change and the
 * endpoint rate-limits aggressive clients), which is exactly why it sits behind
 * two JSON-speaking siblings rather than serving alone.
 */
export const ddgsAdapter = {
  kind: 'ddgs',
  label: 'DuckDuckGo',
  credentialRef: null,
  anonymousOk: true,
  defaultBaseURL: KIND_DEFAULT_BASE_URL.ddgs,

  async search({ query, maxResults, baseURL, signal }) {
    const url = `${baseURL.replace(/\/+$/, '')}/?q=${encodeURIComponent(query)}`
    const response = await fetchText(url, {
      method: 'GET',
      headers: {
        accept: 'text/html,application/xhtml+xml',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      },
      signal,
      timeoutMs: 0,
      what: 'ddgs',
    })
    if (response.status < 200 || response.status >= 300) {
      throw new UpstreamError(`ddgs HTTP ${String(response.status)}`, { status: response.status, kind: 'ddgs' })
    }
    if (/anomaly|unusual traffic|captcha/i.test(response.text)) {
      throw new UpstreamError('ddgs returned an anti-bot interstitial', { kind: 'ddgs' })
    }
    const linkPattern = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g
    const snippetPattern = /class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/g
    const snippets = []
    for (let match = snippetPattern.exec(response.text); match !== null; match = snippetPattern.exec(response.text)) {
      snippets.push(stripHtml(match[1]))
    }
    const results = []
    let index = 0
    for (let match = linkPattern.exec(response.text); match !== null && results.length < maxResults; match = linkPattern.exec(response.text)) {
      const url2 = unwrapDdgHref(match[1].trim())
      const title = stripHtml(match[2])
      if (!/^https?:\/\//i.test(url2) || title.length === 0) { index += 1; continue }
      results.push({ title, url: url2, description: snippets[index] ?? '' })
      index += 1
    }
    return { results, searched: results.length > 0 }
  },
}
