import type { QueryResult, QueryResultSet } from '../../src/electron'

// Rows delivered in the initial query response and per fetch-more page. The
// driver buffers up to MAX_BUFFERED_ROWS; the renderer pulls these pages as it
// scrolls so a big result never crosses IPC all at once.
export const PAGE_SIZE = 200

// Bytes held across all query tabs. A renderer that forgets to close sessions
// cannot leak unboundedly; oldest buffers are evicted until under this ceiling.
const MAX_SESSION_BYTES = 64 * 1024 * 1024
const MAX_PAGE_BYTES = 2 * 1024 * 1024
const MAX_INITIAL_RESPONSE_BYTES = 4 * 1024 * 1024
const bigintReplacer = (_key: string, item: unknown): unknown => typeof item === 'bigint' ? item.toString() : item

type ResultSession = {
  profileId: string
  rows: unknown[][]
  bytes: number
}

const valueBytes = (value: unknown): number => {
  if (typeof value === 'string') return Buffer.byteLength(value, 'utf8')
  if (value instanceof Uint8Array) return value.byteLength
  if (value === null || value === undefined || typeof value !== 'object') return 16
  try {
    return Buffer.byteLength(JSON.stringify(value, bigintReplacer) ?? '', 'utf8')
  } catch {
    return 64
  }
}

const rowBytes = (row: unknown[]) => row.reduce<number>((total, value) => total + valueBytes(value), 16)
const rowsBytes = (rows: unknown[][]) => rows.reduce<number>((total, row) => total + rowBytes(row), 0)

const page = (rows: unknown[][], offset: number, limit: number, maxBytes = MAX_PAGE_BYTES) => {
  const result: unknown[][] = []
  if (maxBytes <= 0) return result
  let bytes = 0
  for (let index = offset; index < rows.length && result.length < limit; index += 1) {
    const row = rows[index]!
    const size = rowBytes(row)
    if (bytes + size > maxBytes) break
    result.push(row)
    bytes += size
  }
  return result
}

// Holds the full buffered rows of a result in the main process and hands the
// renderer pages on demand. Pure and side-effect free apart from its own map,
// so it can be unit-tested without a live connection.
export class ResultSessionStore {
  private sessions = new Map<string, ResultSession>()
  private totalBytes = 0
  private makeId: () => string

  constructor(makeId: () => string = () => crypto.randomUUID()) {
    this.makeId = makeId
  }

  // Registers a session for a row result that exceeds one page and returns the
  // first-page response (sessionId + total buffered count). Small results and
  // non-row results (writes/DDL) pass through unchanged — no session, no paging.
  open(profileId: string, result: QueryResult): QueryResult {
    if (!result.resultSets?.length) return this.openSet(profileId, result) as QueryResult

    let remaining = MAX_INITIAL_RESPONSE_BYTES
    const resultSets: QueryResultSet[] = [...result.resultSets]
    // The final (initially visible) result gets first claim on the response
    // budget; earlier sets remain fetchable through their own sessions.
    const order = [result.resultSets.length - 1, ...result.resultSets.slice(0, -1).map((_, index) => index)]
    for (const index of order) {
      const opened = this.openSet(profileId, result.resultSets[index]!, Math.min(MAX_PAGE_BYTES, remaining))
      resultSets[index] = opened
      remaining = Math.max(0, remaining - rowsBytes(opened.rows))
    }
    const selected = resultSets[resultSets.length - 1]!
    return { ...result, ...selected, durationMs: result.durationMs, resultSets }
  }

  /** Produces a bounded, sessionless response for a result whose connection was
   * superseded while running. No retained buffer is registered, including for
   * embedded result sets. */
  preview(result: QueryResult): QueryResult {
    let remaining = MAX_INITIAL_RESPONSE_BYTES
    const trim = (set: QueryResultSet) => {
      const rows = page(set.rows, 0, PAGE_SIZE, Math.min(MAX_PAGE_BYTES, remaining))
      remaining = Math.max(0, remaining - rowsBytes(rows))
      return rows.length < set.rows.length
        ? { ...set, rows, truncated: true, bufferedRowCount: rows.length }
        : set
    }
    if (!result.resultSets?.length) return trim(result) as QueryResult
    const resultSets = [...result.resultSets]
    const order = [result.resultSets.length - 1, ...result.resultSets.slice(0, -1).map((_, index) => index)]
    for (const index of order) resultSets[index] = trim(result.resultSets[index]!)
    const selected = resultSets[resultSets.length - 1]!
    return { ...result, ...selected, durationMs: result.durationMs, resultSets }
  }

  // A slice of a session's buffer, or null when the session is gone (closed,
  // evicted, or never existed) — distinct from an empty slice so callers can
  // fall back instead of treating a lost buffer as "no rows".
  fetch(id: string, offset: number, limit: number): unknown[][] | null {
    const session = this.sessions.get(id)
    if (!session) return null
    const safeOffset = Math.max(0, Math.trunc(offset) || 0)
    const safeLimit = Math.min(PAGE_SIZE, Math.max(0, Math.trunc(limit) || 0))
    // Touch for LRU: most-recently-fetched sessions evict last.
    this.sessions.delete(id)
    this.sessions.set(id, session)
    return page(session.rows, safeOffset, safeLimit)
  }

  close(id: string) {
    const session = this.sessions.get(id)
    if (!session) return
    this.totalBytes -= session.bytes
    this.sessions.delete(id)
  }

  // Frees every buffer for a profile (called when it disconnects).
  closeProfile(profileId: string) {
    for (const [id, session] of this.sessions) {
      if (session.profileId === profileId) this.close(id)
    }
  }

  /** Live session count — for tests and diagnostics. */
  get size() {
    return this.sessions.size
  }

  private evictExcess() {
    while (this.totalBytes > MAX_SESSION_BYTES) {
      const oldest = this.sessions.keys().next().value
      if (oldest === undefined) break
      this.close(oldest)
    }
  }

  private openSet(profileId: string, result: QueryResultSet, maxPageBytes = MAX_PAGE_BYTES): QueryResultSet {
    if (!result.columns.length || !result.rows.length) return result
    const first = page(result.rows, 0, PAGE_SIZE, maxPageBytes)
    if (first.length === result.rows.length) return result

    const id = this.makeId()
    const bytes = rowsBytes(result.rows)
    this.sessions.set(id, { profileId, rows: result.rows, bytes })
    this.totalBytes += bytes
    this.evictExcess()
    return {
      ...result,
      rows: first,
      sessionId: id,
      bufferedRowCount: result.rows.length,
    }
  }
}
