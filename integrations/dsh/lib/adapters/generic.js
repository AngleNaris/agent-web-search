/**
 * The generic, protocol-level upstreams: Anthropic Messages (also used for
 * DeepSeek's Anthropic-compatible route) and OpenAI Responses.
 *
 * These exist so a deployment can point search at any endpoint speaking one of
 * the two protocols, including a self-hosted gateway or a relay. Because the
 * concrete provider is a configuration choice rather than a code path, the
 * model name is a plain constant here — change it with the endpoint.
 *
 * @module dsh-agent-web-search/adapters/generic
 */

import { KIND_DEFAULT_BASE_URL } from '../defaults.js'
import { UpstreamError, fetchText } from '../http.js'
import { groundingPrompt, extractGrounding } from './grounding.js'

/** Models used by the protocol-level routes. */
export const GENERIC_MODELS = {
  deepseek: 'deepseek-v4-flash',
  messages: 'claude-3-7-sonnet-20250219',
  responses: 'gpt-5-mini',
}

/** POST JSON and parse, keeping a slice of the body in the failure message. */
async function postJson(url, { headers, body, signal, kind }) {
  const response = await fetchText(url, { method: 'POST', headers, body, signal, timeoutMs: 0, what: kind })
  if (response.status < 200 || response.status >= 300) {
    const detail = response.text.slice(0, 200).replace(/\s+/g, ' ')
    throw new UpstreamError(`${kind} HTTP ${String(response.status)}${detail.length > 0 ? `: ${detail}` : ''}`, { status: response.status, kind })
  }
  try {
    return JSON.parse(response.text)
  } catch {
    throw new UpstreamError(`${kind} returned invalid JSON`, { kind })
  }
}

/**
 * Read an Anthropic Messages response carrying a web-search tool result.
 *
 * The answer is the concatenated `text` blocks; the sources arrive inside a
 * `web_search_tool_result` block, which nests its own typed content array.
 *
 * @param {object} data - the parsed body.
 * @returns {{answer: string, results: Array<object>}} the extracted shape.
 */
export function extractMessages(data) {
  let answer = ''
  const results = []
  for (const block of data?.content ?? []) {
    if (block?.type === 'text' && typeof block.text === 'string') {
      answer = answer.length === 0 ? block.text : `${answer}\n${block.text}`
      continue
    }
    if (block?.type !== 'web_search_tool_result') continue
    const inner = Array.isArray(block.content) ? block.content : []
    for (const row of inner) {
      if (row?.type !== 'web_search_result') continue
      const url = typeof row.url === 'string' ? row.url.trim() : ''
      if (url.length === 0) continue
      results.push({ title: (row.title ?? '').trim(), url, description: (row.page_age ?? '') })
    }
  }
  const unique = new Map()
  for (const row of results) if (!unique.has(row.url)) unique.set(row.url, row)
  return { answer: answer.trim(), results: [...unique.values()] }
}

/** Build a Messages-protocol adapter (shared by DeepSeek's compatible route). */
function messagesAdapter({ kind, label, credentialRef, defaultBaseURL, model, extraHeaders }) {
  return {
    kind,
    label,
    credentialRef,
    anonymousOk: false,
    defaultBaseURL,

    async search({ query, maxResults, apiKey, baseURL, signal }) {
      if (typeof apiKey !== 'string' || apiKey.trim().length === 0) {
        throw new UpstreamError(`${credentialRef} is not set`, { kind })
      }
      const url = `${baseURL.replace(/\/+$/, '')}/v1/messages`
      const data = await postJson(url, {
        headers: { 'x-api-key': apiKey.trim(), 'anthropic-version': '2023-06-01', ...(extraHeaders ?? {}) },
        body: {
          model,
          max_tokens: 4096,
          messages: [{ role: 'user', content: groundingPrompt(query, maxResults) }],
          tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }],
        },
        signal,
        kind,
      })
      const extracted = extractMessages(data)
      return { ...extracted, searched: extracted.results.length > 0 }
    },
  }
}

/** DeepSeek's Anthropic-compatible Messages route. */
export const deepseekAdapter = messagesAdapter({
  kind: 'deepseek',
  label: 'DeepSeek',
  credentialRef: 'DEEPSEEK_API_KEY',
  defaultBaseURL: `${KIND_DEFAULT_BASE_URL.deepseek}/anthropic`,
  model: GENERIC_MODELS.deepseek,
})

/** A generic Anthropic Messages endpoint. */
export const messagesAdapterDef = messagesAdapter({
  kind: 'messages',
  label: 'Anthropic Messages',
  credentialRef: 'AGENT_WEB_SEARCH_MESSAGES_API_KEY',
  defaultBaseURL: KIND_DEFAULT_BASE_URL.messages,
  model: GENERIC_MODELS.messages,
})

/** A generic OpenAI Responses endpoint. */
export const responsesAdapter = {
  kind: 'responses',
  label: 'OpenAI Responses',
  credentialRef: 'AGENT_WEB_SEARCH_RESPONSES_API_KEY',
  anonymousOk: false,
  defaultBaseURL: KIND_DEFAULT_BASE_URL.responses,

  async search({ query, maxResults, apiKey, baseURL, signal }) {
    if (typeof apiKey !== 'string' || apiKey.trim().length === 0) {
      throw new UpstreamError('AGENT_WEB_SEARCH_RESPONSES_API_KEY is not set', { kind: 'responses' })
    }
    const url = `${baseURL.replace(/\/+$/, '')}/responses`
    const data = await postJson(url, {
      headers: { authorization: `Bearer ${apiKey.trim()}` },
      body: {
        model: GENERIC_MODELS.responses,
        input: [{ role: 'user', content: groundingPrompt(query, maxResults) }],
        tools: [{ type: 'web_search' }],
      },
      signal,
      kind: 'responses',
    })
    // The Responses shape matches the grounding upstreams exactly.
    const extracted = extractGrounding(data, 'responses')
    return { ...extracted, searched: extracted.results.length > 0 }
  },
}
