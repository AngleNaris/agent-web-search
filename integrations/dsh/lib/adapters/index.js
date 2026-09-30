/**
 * The adapter registry: kind → implementation.
 *
 * Every adapter exposes the same contract, so the engine never branches on a
 * kind name:
 *
 * ```js
 * {
 *   kind: string,
 *   label: string,
 *   credentialRef: string | null,   // null = runs anonymously
 *   anonymousOk: boolean,           // true = an attempt is made without a key
 *   defaultBaseURL: string,
 *   async search({ query, maxResults, apiKey, baseURL, signal })
 *     -> { results: [{title, url, description, publishedAt?}], answer?, searched }
 * }
 * ```
 *
 * @module dsh-agent-web-search/adapters
 */

import { ddgsAdapter, exaAdapter, parallelAdapter } from './free.js'
import { arkAdapter, geminiAdapter, grokAdapter } from './grounding.js'
import { braveAdapter, perplexityAdapter, tavilyAdapter, youAdapter } from './search-apis.js'
import { deepseekAdapter, messagesAdapterDef, responsesAdapter } from './generic.js'
import { zhipuChatSearchAdapter, zhipuWebSearchAdapter } from './zhipu.js'
import { mcpAdapter } from './mcp.js'

/** All adapters, in the order the card lists their kinds. */
export const ADAPTER_LIST = [
  exaAdapter,
  parallelAdapter,
  ddgsAdapter,
  braveAdapter,
  tavilyAdapter,
  perplexityAdapter,
  youAdapter,
  geminiAdapter,
  grokAdapter,
  arkAdapter,
  zhipuWebSearchAdapter,
  zhipuChatSearchAdapter,
  deepseekAdapter,
  messagesAdapterDef,
  responsesAdapter,
  mcpAdapter,
]

/** Kind → adapter. */
export const ADAPTERS = new Map(ADAPTER_LIST.map(adapter => [adapter.kind, adapter]))

export {
  arkAdapter, braveAdapter, ddgsAdapter, deepseekAdapter, exaAdapter, geminiAdapter,
  grokAdapter, messagesAdapterDef, parallelAdapter, perplexityAdapter, responsesAdapter,
  tavilyAdapter, youAdapter, zhipuChatSearchAdapter, zhipuWebSearchAdapter, mcpAdapter,
}
