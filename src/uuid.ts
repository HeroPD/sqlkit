// Client-side UUID generation for inserting into new rows. Kept engine-agnostic
// (a literal string bound as a parameter), so it works on every backend; DB-side
// generation is reached instead via a column DEFAULT + the grid's "Use default".

/** Random UUID v4 via the platform CSPRNG. */
export const uuidv4 = (): string => crypto.randomUUID()

/** UUID v7: 48-bit Unix-ms timestamp + version/variant + random, so values sort
 * by creation time (kinder to B-tree indexes than v4). */
export function uuidv7(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  // Big-endian 48-bit millisecond timestamp in bytes 0-5.
  let ms = Date.now()
  for (let i = 5; i >= 0; i -= 1) {
    bytes[i] = ms % 256
    ms = Math.floor(ms / 256)
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x70 // version 7
  bytes[8] = (bytes[8]! & 0x3f) | 0x80 // RFC 4122 variant
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
