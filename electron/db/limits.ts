// Rows a query buffers in the main process; the renderer pages through these on
// demand (see result-sessions.ts) instead of receiving them all at once.
// `truncated` flags a result larger than these caps. Kept in its own module so
// the SQLite worker can import it without pulling in the rest of the driver graph.
// Announced to the server on connect (application_name / program name), so the
// Tasks dashboard can tell the app's own sessions from everyone else's — and so
// SqlKit is identifiable in server logs and other DBAs' process lists.
export const APP_CONNECTION_NAME = 'SqlKit Studio'

// The whole connection budget for one profile, across every database it can
// reach. A GUI sitting on a shared server should be close to invisible in
// pg_stat_activity, so the drivers keep ONE live pool (the database in use) and
// let this be its ceiling — not a per-database allowance. Cancels dial a
// separate out-of-band connection, so a cancel can briefly make it this + 1.
export const MAX_POOL_CONNECTIONS = 3

// Idle connections are handed back this long after their last use. Set
// explicitly rather than inherited from each client library's default, so the
// budget above decays predictably instead of at three different rates.
export const POOL_IDLE_MS = 10_000

// Sessions the server panel lists. A busy server can hold thousands; the panel
// shows the interesting ones (active first) rather than paging through all.
export const MAX_SESSIONS = 50

export const MAX_BUFFERED_ROWS = 50_000
export const MAX_BUFFERED_BYTES = 32 * 1024 * 1024
export const MAX_CELL_BYTES = 1024 * 1024
// A single structured-clone row must always fit inside the 2 MB IPC page cap.
export const MAX_BUFFERED_ROW_BYTES = 1536 * 1024

const utf8Bytes = (value: string) => Buffer.byteLength(value, 'utf8')
const bigintReplacer = (_key: string, value: unknown): unknown => typeof value === 'bigint' ? value.toString() : value

export function boundedRow(row: unknown[], usedBytes: number): { row: unknown[]; bytes: number; truncated: boolean } | null {
  let bytes = 0
  let truncated = false
  const overhead = 16 * (row.length + 1)
  const valueBudget = Math.max(0, Math.min(MAX_CELL_BYTES, Math.floor((MAX_BUFFERED_ROW_BYTES - overhead) / Math.max(1, row.length))))
  const truncateText = (value: string, label: string) => {
    const suffix = `\n… [${label} truncated by SqlKit Studio]`
    if (valueBudget <= utf8Bytes(suffix)) return ''
    let low = 0
    let high = Math.min(value.length, valueBudget)
    while (low < high) {
      const middle = Math.ceil((low + high) / 2)
      if (utf8Bytes(value.slice(0, middle)) + utf8Bytes(suffix) <= valueBudget) low = middle
      else high = middle - 1
    }
    return value.slice(0, low) + suffix
  }
  const bounded = row.map((value) => {
    if (typeof value === 'bigint') {
      bytes += 16
      return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value
    }
    if (typeof value === 'string') {
      const size = utf8Bytes(value)
      if (size <= valueBudget) {
        bytes += size
        return value
      }
      truncated = true
      const limited = truncateText(value, 'cell')
      bytes += utf8Bytes(limited)
      return limited
    }
    if (value instanceof Uint8Array) {
      const size = value.byteLength
      if (size <= valueBudget) {
        bytes += size
        return value
      }
      truncated = true
      const limited = value.slice(0, valueBudget)
      bytes += limited.byteLength
      return limited
    }
    if (value && typeof value === 'object') {
      let encoded: string
      try {
        encoded = JSON.stringify(value, bigintReplacer) ?? '[unserializable value]'
      } catch {
        encoded = '[unserializable value]'
      }
      const size = utf8Bytes(encoded)
      if (size <= valueBudget) {
        bytes += size
        return value
      }
      truncated = true
      const limited = truncateText(encoded, 'value')
      bytes += utf8Bytes(limited)
      return limited
    }
    bytes += 16
    return value
  })
  bytes += overhead
  if (usedBytes + bytes > MAX_BUFFERED_BYTES) return null
  return { row: bounded, bytes, truncated }
}

// Shared rows-affected-gate message for runBatch implementations.
export const BATCH_ZERO_ROWS = t('editing.noRowsAffected')
import { t } from '../../src/i18n'
