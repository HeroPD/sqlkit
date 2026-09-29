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

// A cell's cost in the buffer, plus what a shortened one is cut from (objects as their JSON).
type Measured = { size: number; text?: string; binary?: Uint8Array }

const measure = (value: unknown): Measured => {
  if (typeof value === 'string') return { size: utf8Bytes(value), text: value }
  if (value instanceof Uint8Array) return { size: value.byteLength, binary: value }
  if (value && typeof value === 'object') {
    let encoded: string
    try {
      encoded = JSON.stringify(value, bigintReplacer) ?? '[unserializable value]'
    } catch {
      encoded = '[unserializable value]'
    }
    return { size: utf8Bytes(encoded), text: encoded }
  }
  return { size: 16 }
}

// The per-cell ceiling that fits `sizes` in `budget` cutting only the largest:
// a cell within its fair share of what the smaller ones leave keeps every byte.
export function fairShareCap(sizes: readonly number[], budget: number): number {
  const sorted = [...sizes].sort((a, b) => a - b)
  let remaining = Math.max(0, budget)
  for (let index = 0; index < sorted.length; index += 1) {
    const share = Math.floor(remaining / (sorted.length - index))
    if (sorted[index]! > share) return share
    remaining -= sorted[index]!
  }
  return Infinity
}

const truncateText = (value: string, label: string, budget: number) => {
  const suffix = `\n… [${label} truncated by SqlKit Studio]`
  const suffixBytes = utf8Bytes(suffix)
  if (budget <= suffixBytes) return ''
  let low = 0
  let high = Math.min(value.length, budget)
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (utf8Bytes(value.slice(0, middle)) + suffixBytes <= budget) low = middle
    else high = middle - 1
  }
  // Never end on half a surrogate pair.
  const code = value.charCodeAt(low - 1)
  if (low > 0 && code >= 0xd800 && code <= 0xdbff) low -= 1
  return value.slice(0, low) + suffix
}

// A row as the buffer keeps it. Only a row over its budget is cut, and then only
// its largest cells (named by `truncatedColumns`); null means the buffer is full.
export function boundedRow(
  row: unknown[],
  usedBytes: number,
): { row: unknown[]; bytes: number; truncated: boolean; truncatedColumns: number[] } | null {
  const overhead = 16 * (row.length + 1)
  const measured = row.map(measure)
  const cuttable = (cell: Measured) => cell.text !== undefined || cell.binary !== undefined
  const fixed = measured.reduce((total, cell) => total + (cuttable(cell) ? 0 : cell.size), 0)
  const sizes = measured.filter(cuttable).map((cell) => cell.size)
  const cap = Math.min(MAX_CELL_BYTES, fairShareCap(sizes, MAX_BUFFERED_ROW_BYTES - overhead - fixed))
  const truncatedColumns: number[] = []
  let bytes = overhead
  const bounded = row.map((value, index) => {
    const cell = measured[index]!
    if (!cuttable(cell) || cell.size <= cap) {
      bytes += cell.size
      if (typeof value !== 'bigint') return value
      return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value
    }
    truncatedColumns.push(index)
    if (cell.binary) {
      const limited = cell.binary.slice(0, cap)
      bytes += limited.byteLength
      return limited
    }
    const limited = truncateText(cell.text!, typeof value === 'string' ? 'cell' : 'value', cap)
    bytes += utf8Bytes(limited)
    return limited
  })
  if (usedBytes + bytes > MAX_BUFFERED_BYTES) return null
  return { row: bounded, bytes, truncated: truncatedColumns.length > 0, truncatedColumns }
}

// Records the shortened cells of the row about to be buffered at `rowIndex`.
export function noteTruncatedCells(cells: Array<[number, number]>, rowIndex: number, columns: readonly number[]) {
  for (const col of columns) cells.push([rowIndex, col])
}

// The result-set field for those cells, absent when none were shortened.
export const truncatedCellsField = (cells: Array<[number, number]>) => (cells.length ? { truncatedCells: cells } : {})

// Shared rows-affected-gate message for runBatch implementations.
export const BATCH_ZERO_ROWS = t('editing.noRowsAffected')
import { t } from '../../src/i18n'
