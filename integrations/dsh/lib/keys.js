/**
 * Credential helpers shared by the Host half and the browser card.
 *
 * A kind's single credential holds all of that provider's keys joined by `,`
 * (the upstream `agent-web-search` convention), so one reference can carry a
 * pool an adapter rotates through. Literals never enter the settings section —
 * they live in the credentials seam and are addressed by reference name only.
 *
 * @module dsh-agent-web-search/keys
 */

/**
 * Split a credential value into its key literals.
 *
 * @param {string | undefined} value - the raw credential value.
 * @returns {string[]} the non-empty literals, in stored order.
 */
export function parseApiKeys(value) {
  if (typeof value !== 'string') return []
  return value
    .split(/[,\n]/)
    .map(part => part.trim())
    .filter(part => part.length > 0)
}

/**
 * Join key literals back into one credential value.
 *
 * @param {readonly string[]} literals - the keys, in the order to store.
 * @returns {string} the joined value.
 */
export function formatApiKeys(literals) {
  return literals
    .map(literal => literal.trim())
    .filter(literal => literal.length > 0)
    .join(',')
}

/**
 * Mask a key for display: enough head to recognise it, never enough to use it.
 *
 * @param {string} literal - the key.
 * @returns {string} the masked form.
 */
export function maskApiKey(literal) {
  if (literal.length <= 8) return '•'.repeat(literal.length)
  return `${literal.slice(0, 4)}${'•'.repeat(Math.min(12, literal.length - 8))}${literal.slice(-4)}`
}

/**
 * Pick one key out of a pool, rotating so a multi-key pool spreads its load.
 *
 * @param {readonly string[]} keys - the resolved pool.
 * @param {number} cursor - the rotation start index.
 * @returns {{key: string | undefined, next: number}} the chosen key and the next cursor.
 */
export function pickKey(keys, cursor) {
  if (keys.length === 0) return { key: undefined, next: 0 }
  const index = ((cursor % keys.length) + keys.length) % keys.length
  return { key: keys[index], next: (index + 1) % keys.length }
}

/**
 * Normalize a URL for de-duplication: lowercase host, drop the fragment, drop
 * tracking parameters, and drop a trailing slash.
 *
 * @param {string} url - the raw result URL.
 * @returns {string} a stable de-duplication key (empty when the URL is unusable).
 */
export function urlKey(url) {
  if (typeof url !== 'string') return ''
  let parsed
  try {
    parsed = new URL(url.trim())
  } catch {
    return ''
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return ''
  const params = new URLSearchParams()
  for (const [name, value] of parsed.searchParams) {
    if (/^(utm_|fbclid|gclid|ref|source|spm|from)/i.test(name)) continue
    params.append(name, value)
  }
  const search = params.toString()
  return `${parsed.host.toLowerCase()}${parsed.pathname.replace(/\/+$/, '')}${search.length > 0 ? `?${search}` : ''}`
}
