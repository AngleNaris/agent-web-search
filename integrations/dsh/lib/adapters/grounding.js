/**
 * Model-native grounding upstreams: Gemini, Grok and Volcengine ARK.
 *
 * These do not expose a "search API" at all. Instead the model itself is given
 * a search tool and asked to answer the query; the sources come back as
 * `url_citation` annotations attached to the model's text. That makes them the
 * most expensive and the most opinionated upstreams in the set — but also the
 * ones that return prose plus citations in a single round trip.
 *
 * A caveat worth stating plainly: every one of these bills against the model
 * provider's own quota. Plugging them in does not make search free, it just
 * moves which meter runs.
 *
 * @module dsh-agent-web-search/adapters/grounding
 */

import { KIND_DEFAULT_BASE_URL } from '../defaults.js'
import { UpstreamError, fetchText } from '../http.js'

/** Default models, kept here so the card stays a small set of controls. */
export const DEFAULT_MODELS = {
  gemini: 'gemini-3.7-flash',
  grok: 'grok-4.6',
  ark: 'doubao-seed-2-1-turbo-260628',
}

/**
 * Build the instruction handed to a grounding model.
 *
 * @param {string} query - the user query.
 * @param {number} maxResults - how many sources to ask for.
 * @returns {string} the prompt.
 */
export function groundingPrompt(query, maxResults) {
  return [
    `请使用你自带的网络搜索工具，检索并回答下面的问题。`,
    ``,
    `问题：${query}`,
    ``,
    `要求：`,
    `1. 先执行搜索，再基于搜索结果作答，不要凭记忆回答。`,
    `2. 答案要简洁、准确、有据可依。`,
    `3. 最多引用 ${String(maxResults)} 个来源。`,
  ].join('\n')
}

/**
 * Pull the answer text and its citations out of a grounding response.
 *
 * Gemini, Grok and ARK all produce `output[].content[]` items carrying either
 * `text`/`output_text` or `annotations[].type === 'url_citation'`, so one
 * reader covers all three.
 *
 * @param {object} data - the parsed response body.
 * @param {string} kind - the upstream name, stamped on each row.
 * @returns {{answer: string, results: Array<object>}} the extracted shape.
 */
export function extractGrounding(data, kind) {
  const output = Array.isArray(data?.output) ? data.output : Array.isArray(data?.steps) ? data.steps : []
  let answer = ''
  const rows = []
  for (const step of output) {
    const contents = Array.isArray(step?.content) ? step.content : []
    for (const content of contents) {
      const type = content?.type
      if ((type === 'text' || type === 'output_text') && typeof content.text === 'string' && content.text.trim().length > 0) {
        answer = content.text
      }
      for (const annotation of content?.annotations ?? []) {
        if (annotation?.type !== 'url_citation') continue
        const url = typeof annotation.url === 'string' ? annotation.url.trim() : ''
        if (url.length === 0) continue
        rows.push({ title: (annotation.title ?? '').trim(), url })
      }
    }
  }
  if (answer.length === 0 && typeof data?.output_text === 'string') answer = data.output_text
  const unique = new Map()
  for (const row of rows) if (!unique.has(row.url)) unique.set(row.url, row)
  return { answer: answer.trim(), results: [...unique.values()] }
}

/** Read a response body, failing with the upstream's own status on non-2xx. */
async function postJson(url, { headers, body, signal, kind }) {
  const response = await fetchText(url, { method: 'POST', headers, body, signal, timeoutMs: 0, what: kind })
  if (response.status < 200 || response.status >= 300) {
    // The body often explains the refusal (quota, bad model, blocked region),
    // so keep a trimmed slice of it in the message instead of only the status.
    const detail = response.text.slice(0, 200).replace(/\s+/g, ' ')
    throw new UpstreamError(`${kind} HTTP ${String(response.status)}${detail.length > 0 ? `: ${detail}` : ''}`, { status: response.status, kind })
  }
  try {
    return JSON.parse(response.text)
  } catch {
    throw new UpstreamError(`${kind} returned invalid JSON`, { kind })
  }
}

/** Gemini through the Interactions API with the native Google Search tool. */
export const geminiAdapter = {
  kind: 'gemini',
  label: 'Gemini',
  credentialRef: 'GEMINI_API_KEY',
  anonymousOk: false,
  defaultBaseURL: KIND_DEFAULT_BASE_URL.gemini,

  async search({ query, maxResults, apiKey, baseURL, signal }) {
    if (typeof apiKey !== 'string' || apiKey.trim().length === 0) {
      throw new UpstreamError('GEMINI_API_KEY is not set', { kind: 'gemini' })
    }
    const data = await postJson(baseURL, {
      headers: { 'x-goog-api-key': apiKey.trim() },
      body: {
        model: DEFAULT_MODELS.gemini,
        input: groundingPrompt(query, maxResults),
        tools: [{ type: 'google_search' }],
      },
      signal,
      kind: 'gemini',
    })
    const extracted = extractGrounding(data, 'gemini')
    return { ...extracted, searched: extracted.results.length > 0 }
  },
}

/** Grok through the xAI Responses API. */
export const grokAdapter = {
  kind: 'grok',
  label: 'Grok',
  credentialRef: 'XAI_API_KEY',
  anonymousOk: false,
  defaultBaseURL: KIND_DEFAULT_BASE_URL.grok,

  async search({ query, maxResults, apiKey, baseURL, signal }) {
    if (typeof apiKey !== 'string' || apiKey.trim().length === 0) {
      throw new UpstreamError('XAI_API_KEY is not set', { kind: 'grok' })
    }
    const data = await postJson(baseURL, {
      headers: { authorization: `Bearer ${apiKey.trim()}` },
      body: {
        model: DEFAULT_MODELS.grok,
        input: [{ role: 'user', content: groundingPrompt(query, maxResults) }],
        tools: [{ type: 'web_search' }, { type: 'x_search' }],
      },
      signal,
      kind: 'grok',
    })
    const extracted = extractGrounding(data, 'grok')
    return { ...extracted, searched: extracted.results.length > 0 }
  },
}

/** Volcengine ARK (Doubao / GLM) through its Responses API. */
export const arkAdapter = {
  kind: 'ark',
  label: 'Volcengine ARK',
  credentialRef: 'ARK_API_KEY',
  anonymousOk: false,
  defaultBaseURL: KIND_DEFAULT_BASE_URL.ark,

  async search({ query, maxResults, apiKey, baseURL, signal }) {
    if (typeof apiKey !== 'string' || apiKey.trim().length === 0) {
      throw new UpstreamError('ARK_API_KEY is not set', { kind: 'ark' })
    }
    // ARK accepts a comma-joined key pool in one credential; one is enough per
    // attempt because the engine already rotates across calls.
    const key = apiKey.split(',')[0].trim()
    const limit = Math.max(1, Math.min(20, maxResults))
    const data = await postJson(baseURL, {
      headers: { authorization: `Bearer ${key}` },
      body: {
        model: DEFAULT_MODELS.ark,
        input: [{ role: 'user', content: [{ type: 'input_text', text: groundingPrompt(query, maxResults) }] }],
        tools: [{ type: 'web_search', limit }],
        max_tool_calls: 2,
        stream: false,
        max_output_tokens: 4096,
      },
      signal,
      kind: 'ark',
    })
    const extracted = extractGrounding(data, 'ark')
    return { ...extracted, searched: extracted.results.length > 0 }
  },
}
