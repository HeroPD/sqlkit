// Rows a query buffers in the main process; the renderer pages through these on
// demand (see result-sessions.ts) instead of receiving them all at once.
// `truncated` flags a result larger than this cap. Server drivers stop a safe
// single SELECT and mark rowCountExact=false; scripts may still know the full
// count. Kept in its own module so the SQLite
// worker can import it without pulling in the rest of the driver graph.
export const MAX_BUFFERED_ROWS = 50_000
export const MAX_BUFFERED_BYTES = 32 * 1024 * 1024
export const MAX_CELL_BYTES = 1024 * 1024

const utf8Bytes = (value: string) => Buffer.byteLength(value, 'utf8')
const bigintReplacer = (_key: string, value: unknown): unknown => typeof value === 'bigint' ? value.toString() : value

export function boundedRow(row: unknown[], usedBytes: number): { row: unknown[]; bytes: number; truncated: boolean } | null {
  let bytes = 0
  let truncated = false
  const bounded = row.map((value) => {
    if (typeof value === 'bigint') {
      bytes += 16
      return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value
    }
    if (typeof value === 'string') {
      const size = utf8Bytes(value)
      bytes += Math.min(size, MAX_CELL_BYTES)
      if (size <= MAX_CELL_BYTES) return value
      truncated = true
      return `${value.slice(0, Math.min(value.length, MAX_CELL_BYTES / 2))}\n… [cell truncated by SqlKit]`
    }
    if (value instanceof Uint8Array) {
      const size = value.byteLength
      bytes += Math.min(size, MAX_CELL_BYTES)
      if (size <= MAX_CELL_BYTES) return value
      truncated = true
      return value.slice(0, MAX_CELL_BYTES)
    }
    if (value && typeof value === 'object') {
      let encoded: string
      try {
        encoded = JSON.stringify(value, bigintReplacer) ?? '[unserializable value]'
      } catch {
        encoded = '[unserializable value]'
      }
      const size = utf8Bytes(encoded)
      bytes += Math.min(size, MAX_CELL_BYTES)
      if (size <= MAX_CELL_BYTES) return value
      truncated = true
      return `${encoded.slice(0, MAX_CELL_BYTES / 2)}\n… [cell truncated by SqlKit]`
    }
    bytes += 16
    return value
  })
  if (usedBytes + bytes > MAX_BUFFERED_BYTES) return null
  return { row: bounded, bytes, truncated }
}

// Shared rows-affected-gate message for runBatch implementations.
export const BATCH_ZERO_ROWS = 'A change affected no rows; the row may have been modified or removed.'
