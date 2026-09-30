/**
 * Config schema, defaults and normalization for the aggregated search plugin.
 *
 * Since dsh 0.1.7 a plugin's configuration page is derived from its composition
 * entry's `Config` schema: every field marked `.volatile()` is editable live and
 * a committed write is pushed into the running plugin's volatile references
 * without a remount. This schema therefore IS the `agent-web-search` settings
 * section — `apply` receives the volatile fields as live references and the
 * provider re-reads them per request, so a queue edited in the UI reaches the
 * very next search.
 *
 * A provider kind appears at most once in the queue (normalization keeps the
 * first entry per kind), and each kind reads exactly one fixed credential —
 * `KIND_CREDENTIAL_REF[kind]` — whose value holds all its keys joined by `,`.
 *
 * @module dsh-agent-web-search/config
 */

import z from '@deepseek-ai/schemastery'
import {
  DEFAULT_ATTEMPT_TIMEOUT_MS,
  DEFAULT_MAX_RESULTS,
  DEFAULT_QUEUE,
  DEFAULT_TOTAL_TIMEOUT_MS,
  MAX_ATTEMPT_TIMEOUT_MS,
  MAX_MAX_RESULTS,
  MAX_TOTAL_TIMEOUT_MS,
  MIN_ATTEMPT_TIMEOUT_MS,
  MIN_MAX_RESULTS,
  MIN_TOTAL_TIMEOUT_MS,
  MODES,
  PROVIDER_KINDS,
} from './defaults.js'

/**
 * The shipped schema. Volatile fields are the ones the settings card edits;
 * nothing here is restart-managed, so every control on the page is live.
 */
export const Config = z.object({
  mode: z.union(MODES).default('fanout').volatile(),
  providers: z.array(z.object({
    // Accept retired kinds in existing profiles, then drop them in resolveConfig.
    // They never reach an adapter and do not make an upgraded profile unloadable.
    // The id/toolName/template/path fields below are legacy: stored custom MCP
    // sources from older versions still validate, then resolveConfig drops them.
    kind: z.string(),
    enabled: z.boolean().default(true),
    baseURL: z.string(),
    id: z.string().default(''),
    toolName: z.string().default(''),
    inputTemplate: z.string().default('{"query":"{{query}}"}'),
    responseMode: z.union(['auto', 'structured', 'text-json', 'text']).default('auto'),
    resultPath: z.string().default('/results'),
    urlPath: z.string().default('/url'),
    titlePath: z.string().default('/title'),
    snippetPath: z.string().default('/snippet'),
    publishedAtPath: z.string().default('/publishedAt'),
  })).max(40).default(DEFAULT_QUEUE.map(entry => ({ ...entry }))).volatile(),
  maxResults: z.natural().min(MIN_MAX_RESULTS).max(MAX_MAX_RESULTS).default(DEFAULT_MAX_RESULTS).volatile(),
  attemptTimeoutMs: z.natural().min(MIN_ATTEMPT_TIMEOUT_MS).max(MAX_ATTEMPT_TIMEOUT_MS).default(DEFAULT_ATTEMPT_TIMEOUT_MS).volatile(),
  totalTimeoutMs: z.natural().min(MIN_TOTAL_TIMEOUT_MS).max(MAX_TOTAL_TIMEOUT_MS).default(DEFAULT_TOTAL_TIMEOUT_MS).volatile(),
  dedupeByUrl: z.boolean().default(true).volatile(),
  includeAnswer: z.boolean().default(true).volatile(),
})

/**
 * Normalize one queue entry: trim the endpoint override and drop it when empty.
 *
 * @param {{kind: string, enabled?: boolean, baseURL?: string}} entry - the schema-validated entry.
 * @returns {{kind: string, enabled: boolean, baseURL?: string}} the normalized entry.
 */
export function normalizeEntry(entry) {
  const baseURL = typeof entry.baseURL === 'string' ? entry.baseURL.trim() : ''
  return {
    kind: entry.kind,
    enabled: entry.enabled !== false,
    ...(baseURL.length > 0 ? { baseURL } : {}),
  }
}

/**
 * Resolve any accepted config input into plain values the engine consumes.
 *
 * Later entries whose kind already appeared are dropped, so one upstream can
 * never be queued twice even if a hand-written profile patch says so.
 *
 * @param {object} [input] - composition entry config, settings-section value, or volatile snapshots.
 * @returns {{mode: string, providers: Array<{kind: string, enabled: boolean, baseURL?: string}>, maxResults: number, attemptTimeoutMs: number, totalTimeoutMs: number, dedupeByUrl: boolean, includeAnswer: boolean}} the resolved config.
 */
export function resolveConfig(input = {}) {
  // Re-validating fills the schema defaults; volatile wrappers are unwrapped
  // immediately because the engine consumes plain values.
  const resolved = Config(input)
  const seen = new Set()
  const providers = []
  for (const raw of resolved.providers.get()) {
    if (!PROVIDER_KINDS.includes(raw.kind)) continue
    const identity = raw.kind === 'mcp' ? `mcp:${raw.id}` : raw.kind
    if (seen.has(identity)) continue
    seen.add(identity)
    providers.push(normalizeEntry(raw))
  }
  return {
    mode: resolved.mode.get(),
    providers,
    maxResults: resolved.maxResults.get(),
    attemptTimeoutMs: resolved.attemptTimeoutMs.get(),
    totalTimeoutMs: resolved.totalTimeoutMs.get(),
    dedupeByUrl: resolved.dedupeByUrl.get(),
    includeAnswer: resolved.includeAnswer.get(),
  }
}

/**
 * Read the live references `apply` holds into one plain input.
 *
 * A settings commit has usually replaced the snapshots since the last call,
 * which is exactly the point: the provider calls this per request.
 *
 * @param {object} config - the plugin config as the loader resolved it.
 * @returns {object} the current snapshots, ready for resolution.
 */
export function snapshotsOf(config) {
  return {
    mode: config.mode.get(),
    providers: [...config.providers.get()],
    maxResults: config.maxResults.get(),
    attemptTimeoutMs: config.attemptTimeoutMs.get(),
    totalTimeoutMs: config.totalTimeoutMs.get(),
    dedupeByUrl: config.dedupeByUrl.get(),
    includeAnswer: config.includeAnswer.get(),
  }
}

export {
  DEFAULT_ATTEMPT_TIMEOUT_MS,
  DEFAULT_MAX_RESULTS,
  DEFAULT_QUEUE,
  DEFAULT_TOTAL_TIMEOUT_MS,
  MAX_ATTEMPT_TIMEOUT_MS,
  MAX_MAX_RESULTS,
  MAX_TOTAL_TIMEOUT_MS,
  MIN_ATTEMPT_TIMEOUT_MS,
  MIN_MAX_RESULTS,
  MIN_TOTAL_TIMEOUT_MS,
}
