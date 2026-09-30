/**
 * The keyed, JSON-speaking search APIs: Brave, Tavily, Perplexity and You.com.
 *
 * All four are plain request/response REST, so they share one shape: read the
 * key, POST or GET, map rows. Each one needs its own credential reference.
 *
 * @module dsh-agent-web-search/adapters/search-apis
 */

import { KIND_DEFAULT_BASE_URL } from '../defaults.js'
import { UpstreamError, fetchJson } from '../http.js'

/**
 * Require a key, or explain which reference is missing.
 *
 * @param {string | undefined} apiKey - the resolved credential.
 * @param {string} ref - the reference name to name in the error.
 * @param {string} kind - the upstream kind, for the message.
 * @returns {string} the key.
 * @throws {UpstreamError} when it is absent.
 */
function requireKey(apiKey, ref, kind) {
  if (typeof apiKey !== 'string' || apiKey.trim().length === 0) {
    throw new UpstreamError(`${ref} is not set`, { kind })
  }
  return apiKey.trim()
}

/** Brave Search API. */
export const braveAdapter = {
  kind: 'brave',
  label: 'Brave Search',
  credentialRef: 'BRAVE_SEARCH_API_KEY',
  anonymousOk: false,
  defaultBaseURL: KIND_DEFAULT_BASE_URL.brave,

  async search({ query, maxResults, apiKey, baseURL, signal }) {
    const key = requireKey(apiKey, 'BRAVE_SEARCH_API_KEY', 'brave')
    const url = `${baseURL}?q=${encodeURIComponent(query)}&count=${String(Math.max(1, Math.min(20, maxResults)))}`
    const data = await fetchJson(url, {
      method: 'GET',
      headers: { accept: 'application/json', 'x-subscription-token': key },
      signal,
      timeoutMs: 0,
      what: 'brave',
    })
    const results = (data?.web?.results ?? [])
      .filter(item => typeof item?.url === 'string' && item.url.length > 0)
      .map(item => ({
        title: (item.title ?? '').trim(),
        url: item.url.trim(),
        description: (item.description ?? '').trim(),
      }))
    return { results, searched: results.length > 0 }
  },
}

/** Tavily Search API. */
export const tavilyAdapter = {
  kind: 'tavily',
  label: 'Tavily',
  credentialRef: 'TAVILY_API_KEY',
  anonymousOk: false,
  defaultBaseURL: KIND_DEFAULT_BASE_URL.tavily,

  async search({ query, maxResults, apiKey, baseURL, signal }) {
    const key = requireKey(apiKey, 'TAVILY_API_KEY', 'tavily')
    const data = await fetchJson(baseURL, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}` },
      body: {
        query,
        search_depth: 'basic',
        topic: 'general',
        max_results: Math.max(1, Math.min(20, maxResults)),
        include_answer: false,
        include_raw_content: false,
        include_images: false,
      },
      signal,
      timeoutMs: 0,
      what: 'tavily',
    })
    const results = (data?.results ?? [])
      .filter(item => typeof item?.url === 'string' && item.url.length > 0)
      .map(item => ({
        title: (item.title ?? '').trim(),
        url: item.url.trim(),
        description: (item.content ?? '').trim(),
        publishedAt: item.published_date ?? undefined,
      }))
    const answer = typeof data?.answer === 'string' ? data.answer.trim() : ''
    return { results, answer, searched: results.length > 0 }
  },
}

/** Perplexity structured Search API. */
export const perplexityAdapter = {
  kind: 'perplexity',
  label: 'Perplexity',
  credentialRef: 'PERPLEXITY_API_KEY',
  anonymousOk: false,
  defaultBaseURL: KIND_DEFAULT_BASE_URL.perplexity,

  async search({ query, maxResults, apiKey, baseURL, signal }) {
    const key = requireKey(apiKey, 'PERPLEXITY_API_KEY', 'perplexity')
    const data = await fetchJson(baseURL, {
      method: 'POST',
      headers: { accept: 'application/json', authorization: `Bearer ${key}` },
      body: { query, max_results: Math.max(1, Math.min(20, maxResults)) },
      signal,
      timeoutMs: 0,
      what: 'perplexity',
    })
    const results = (data?.results ?? [])
      .filter(item => typeof item?.url === 'string' && item.url.length > 0)
      .map(item => ({
        title: (item.title ?? '').trim(),
        url: item.url.trim(),
        description: (item.snippet ?? '').trim(),
        publishedAt: item.date ?? undefined,
      }))
    return { results, searched: true }
  },
}

/** You.com Search API. */
export const youAdapter = {
  kind: 'you',
  label: 'You.com',
  credentialRef: 'YDC_API_KEY',
  anonymousOk: false,
  defaultBaseURL: KIND_DEFAULT_BASE_URL.you,

  async search({ query, maxResults, apiKey, baseURL, signal }) {
    const key = requireKey(apiKey, 'YDC_API_KEY', 'you')
    const data = await fetchJson(baseURL, {
      method: 'POST',
      headers: { accept: 'application/json', 'x-api-key': key },
      body: { query, count: Math.max(1, Math.min(20, maxResults)) },
      signal,
      timeoutMs: 0,
      what: 'you',
    })
    // You.com nests rows under `results.web` and `results.news`; both are
    // candidates and the same URL can appear in both.
    const sections = data?.results ?? {}
    const candidates = []
    if (typeof sections === 'object' && sections !== null) {
      for (const name of ['web', 'news']) {
        if (Array.isArray(sections[name])) candidates.push(...sections[name])
      }
    }
    const results = []
    const seen = new Set()
    for (const item of candidates) {
      const url = typeof item?.url === 'string' ? item.url.trim() : ''
      if (url.length === 0 || seen.has(url)) continue
      seen.add(url)
      const snippets = Array.isArray(item.snippets) ? item.snippets.filter(s => typeof s === 'string' && s.trim().length > 0) : []
      results.push({
        title: (item.title ?? '').trim(),
        url,
        description: (snippets.length > 0 ? snippets.join('\n\n') : (item.description ?? '')).trim(),
        publishedAt: item.page_age ?? item.published_at ?? item.date ?? undefined,
      })
      if (results.length >= maxResults) break
    }
    return { results, searched: true }
  },
}
