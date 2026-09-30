/**
 * Zhipu (BigModel / 智谱) upstreams.
 *
 * Two distinct products live here: a standalone Web Search API that returns
 * rows directly, and a Chat Completions route that attaches a search tool to a
 * model call. They share a base URL and little else.
 *
 * @module dsh-agent-web-search/adapters/zhipu
 */

import { KIND_DEFAULT_BASE_URL } from '../defaults.js'
import { UpstreamError, fetchJson } from '../http.js'

/** Map one Zhipu row, dropping anything whose link is not a usable URL. */
function mapZhipuRows(rows, kind, maxResults) {
  const results = []
  const seen = new Set()
  for (const row of rows ?? []) {
    const raw = typeof row?.link === 'string' ? row.link : typeof row?.url === 'string' ? row.url : ''
    const url = raw.trim()
    if (!/^https?:\/\//i.test(url) || seen.has(url)) continue
    seen.add(url)
    results.push({
      title: (row.title ?? '').trim(),
      url,
      description: (row.content ?? row.snippet ?? '').trim(),
      publishedAt: (row.publish_date ?? row.publishDate ?? '') || undefined,
    })
    if (results.length >= maxResults) break
  }
  return results
}

/** Zhipu standalone Web Search API. */
export const zhipuWebSearchAdapter = {
  kind: 'zhipu_web_search',
  label: 'Zhipu Web Search',
  credentialRef: 'ZHIPU_WEB_SEARCH_API_KEY',
  anonymousOk: false,
  defaultBaseURL: KIND_DEFAULT_BASE_URL.zhipu_web_search,

  async search({ query, maxResults, apiKey, baseURL, signal }) {
    if (typeof apiKey !== 'string' || apiKey.trim().length === 0) {
      throw new UpstreamError('ZHIPU_WEB_SEARCH_API_KEY is not set', { kind: 'zhipu_web_search' })
    }
    const url = `${baseURL.replace(/\/+$/, '')}/api/paas/v4/web_search`
    const data = await fetchJson(url, {
      method: 'POST',
      headers: { accept: 'application/json', authorization: `Bearer ${apiKey.trim()}` },
      body: {
        search_engine: 'search_pro',
        search_intent: false,
        count: Math.max(1, Math.min(20, maxResults)),
        search_query: query,
        content_size: 'medium',
      },
      signal,
      timeoutMs: 0,
      what: 'zhipu_web_search',
    })
    if (data?.error !== undefined) {
      throw new UpstreamError(`Zhipu Web Search upstream error: ${JSON.stringify(data.error).slice(0, 200)}`, { kind: 'zhipu_web_search' })
    }
    if (!Array.isArray(data?.search_result)) {
      throw new UpstreamError('Zhipu Web Search response is missing search_result', { kind: 'zhipu_web_search' })
    }
    const results = mapZhipuRows(data.search_result, 'zhipu_web_search', maxResults)
    return { results, searched: true }
  },
}

/** Zhipu Chat Completions with the Web Search tool attached to the model call. */
export const zhipuChatSearchAdapter = {
  kind: 'zhipu_chat_search',
  label: 'Zhipu Chat Search',
  credentialRef: 'ZHIPU_CHAT_SEARCH_API_KEY',
  anonymousOk: false,
  defaultBaseURL: KIND_DEFAULT_BASE_URL.zhipu_chat_search,

  async search({ query, maxResults, apiKey, baseURL, signal }) {
    if (typeof apiKey !== 'string' || apiKey.trim().length === 0) {
      throw new UpstreamError('ZHIPU_CHAT_SEARCH_API_KEY is not set', { kind: 'zhipu_chat_search' })
    }
    const url = `${baseURL.replace(/\/+$/, '')}/api/paas/v4/chat/completions`
    const data = await fetchJson(url, {
      method: 'POST',
      headers: { accept: 'application/json', authorization: `Bearer ${apiKey.trim()}` },
      body: {
        model: 'glm-5.3-flash',
        messages: [{ role: 'user', content: query }],
        tools: [{
          type: 'web_search',
          web_search: { enable: true, search_result: true, count: Math.max(1, Math.min(20, maxResults)) },
        }],
        stream: false,
      },
      signal,
      timeoutMs: 0,
      what: 'zhipu_chat_search',
    })
    const message = data?.choices?.[0]?.message ?? {}
    const answer = typeof message.content === 'string' ? message.content.trim() : ''
    // Rows can arrive either on the message or at the top level depending on the
    // route and the `search_result` flag, so accept both shapes.
    const rows = message.web_search ?? data?.web_search ?? data?.search_result ?? []
    const results = mapZhipuRows(Array.isArray(rows) ? rows : [], 'zhipu_chat_search', maxResults)
    return { results, answer, searched: results.length > 0 }
  },
}
