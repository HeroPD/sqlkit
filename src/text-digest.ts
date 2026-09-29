// A synchronous identity for a file's text, persisted with the session so a restore can tell the file changed underneath.
// Not a security boundary: it only has to notice a different text, so a fast 53-bit hash (cyrb53) serves.
const PREFIX = 'c53:'

function cyrb53(text: string): string {
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i)
    h1 = Math.imul(h1 ^ code, 2654435761)
    h2 = Math.imul(h2 ^ code, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16)
}

// Layout writes rehash every dirty tab's baseline; the baselines themselves rarely change.
const cache = new Map<string, string>()
const CACHE_LIMIT = 32

/** The digest recorded as a dirty tab's `baseline`, algorithm-prefixed. */
export function textDigest(text: string): string {
  const hit = cache.get(text)
  if (hit !== undefined) return hit
  const digest = PREFIX + cyrb53(text)
  if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value as string)
  cache.set(text, digest)
  return digest
}

/** Whether `text` is what `baseline` was taken from; null for a digest this build cannot compute. */
export function matchesDigest(text: string, baseline: string): boolean | null {
  return baseline.startsWith(PREFIX) ? textDigest(text) === baseline : null
}
