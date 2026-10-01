/**
 * `dsh-agent-web-search`: an aggregated multi-upstream search provider for the
 * DeepSeek Harness `ctx.web` seam.
 *
 * Enabling this plugin does two things:
 *
 *  1. Its bundle patch pins the seam's `searchProvider` to `agent-web-search`
 *     and disables the shipped `web-search-deepseek` row, so the built-in
 *     `web_search` tool starts answering from this plugin's queue with no other
 *     change — same tool, same prompt, same citation UI.
 *  2. It registers that one provider, which fans out across the configured
 *     upstreams and merges the answers.
 *
 * A function plugin (like the shipped search providers), not a default-exported
 * service: it registers INTO the web seam's search registry.
 *
 * @module dsh-agent-web-search
 */

import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { Config, resolveConfig, snapshotsOf } from './config.js'
import { AgentWebSearchProvider } from './provider.js'
import { SearchHistory } from './history.js'
import {
  AGENT_WEB_SEARCH_NAMESPACE,
  AGENT_WEB_SEARCH_PROVIDER_ID,
  PACKAGE_NAME,
} from './defaults.js'

export { Config, resolveConfig, snapshotsOf } from './config.js'
export { AgentWebSearchProvider } from './provider.js'
export {
  AGENT_WEB_SEARCH_NAMESPACE,
  AGENT_WEB_SEARCH_PROVIDER_ID,
  ANONYMOUS_KINDS,
  DEFAULT_QUEUE,
  KIND_CREDENTIAL_REF,
  KIND_DEFAULT_BASE_URL,
  KIND_DEFAULT_MODELS,
  KIND_LABEL,
  MODEL_ENV,
  PACKAGE_NAME,
  PROVIDER_KINDS,
  TIME_RANGES,
} from './defaults.js'

/** Cordis plugin name used by loader diagnostics. */
export const name = PACKAGE_NAME

/**
 * Capability seams this plugin registers into.
 *
 * `web` is where the provider goes. `credentials` is read-only here: API keys
 * stay in the credential store addressed by reference name and never enter the
 * settings section, so a saved config holds no secrets.
 */
export const inject = ['web', 'credentials']

/** A POSIX identifier, which is all `credentialRef` accepts. */
const REF_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * Resolve one credential reference to its literal value.
 *
 * A reference this deployment does not know resolves to `undefined`, and a
 * malformed name is ignored rather than thrown: a hand-written profile patch
 * should degrade to "no key" rather than fail the whole plugin tree at boot.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {string} ref - the reference name.
 * @returns {Promise<string | undefined>} the credential value, if any.
 */
async function resolveCredential(ctx, ref) {
  if (typeof ref !== 'string' || !REF_NAME.test(ref)) return undefined
  try {
    const hit = await ctx.credentials.resolve(credentialRef(ref))
    return typeof hit?.value === 'string' ? hit.value : undefined
  } catch {
    return undefined
  }
}

/**
 * Register the aggregated provider with `ctx.web`.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context supplying the web seam and credentials domain.
 * @param {object} config - the loader-resolved plugin config; volatile fields are live references a settings commit updates in place.
 */
export function apply(ctx, config) {
  const history = new SearchHistory()
  ctx.web.registerSearchProvider(new AgentWebSearchProvider({
    // Read per request, so a queue committed from the settings page between two
    // searches serves the second one.
    config: () => config,
    resolveValue: ref => resolveCredential(ctx, ref),
    record: entry => history.record(entry),
    logger: ctx.logger,
  }))
  // The Connection's /api fetch routes enforce its normal peer authentication.
  // No public webServer route, raw query, credential or response body is exposed.
  ctx.inject(['connection'], scoped => scoped.effect(() => scoped.connection.fetch.register({
    path: '/api/agent-web-search/history',
    methods: ['GET'],
    requestBody: 'buffered',
    fetch() {
      const webEntry = [...ctx.loader.entries()].find(entry => entry.options?.id === 'web')
      const selected = webEntry?.fiber?.config?.searchProvider ?? webEntry?.options?.config?.searchProvider
      return Response.json({
        ...history.snapshot(),
        selectedProvider: typeof selected === 'string' ? selected.slice(0, 80) : null,
      }, { headers: { 'cache-control': 'no-store' } })
    },
  }), 'agent-web-search: authenticated diagnostics'))
  ctx.logger?.info(
    'agent-web-search: registered provider "%s"; edit it under Settings → %s',
    AGENT_WEB_SEARCH_PROVIDER_ID,
    AGENT_WEB_SEARCH_NAMESPACE,
  )
}
