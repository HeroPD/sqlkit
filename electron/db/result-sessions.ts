import type { QueryResult } from '../../src/electron'

// Rows delivered in the initial query response and per fetch-more page. The
// driver buffers up to MAX_BUFFERED_ROWS; the renderer pulls these pages as it
// scrolls so a big result never crosses IPC all at once.
export const PAGE_SIZE = 200

// Buffers held at once across all query tabs. A renderer that forgets to close
// a session can't leak unboundedly; the oldest buffer is evicted (a later
// fetch on it returns empty, which the renderer treats as "no more rows").
const MAX_SESSIONS = 24

type ResultSession = {
  profileId: string
  rows: unknown[][]
}

// Holds the full buffered rows of a result in the main process and hands the
// renderer pages on demand. Pure and side-effect free apart from its own map,
// so it can be unit-tested without a live connection.
export class ResultSessionStore {
  private sessions = new Map<string, ResultSession>()
  private makeId: () => string

  constructor(makeId: () => string = () => crypto.randomUUID()) {
    this.makeId = makeId
  }

  // Registers a session for a row result that exceeds one page and returns the
  // first-page response (sessionId + total buffered count). Small results and
  // non-row results (writes/DDL) pass through unchanged — no session, no paging.
  open(profileId: string, result: QueryResult): QueryResult {
    if (result.columns.length === 0 || result.rows.length <= PAGE_SIZE) return result

    const id = this.makeId()
    this.sessions.set(id, { profileId, rows: result.rows })
    this.evictExcess()

    return {
      ...result,
      rows: result.rows.slice(0, PAGE_SIZE),
      sessionId: id,
      bufferedRowCount: result.rows.length,
    }
  }

  // A slice of a session's buffer, or null when the session is gone (closed,
  // evicted, or never existed) — distinct from an empty slice so callers can
  // fall back instead of treating a lost buffer as "no rows".
  fetch(id: string, offset: number, limit: number): unknown[][] | null {
    const session = this.sessions.get(id)
    if (!session) return null
    // Touch for LRU: most-recently-fetched sessions evict last.
    this.sessions.delete(id)
    this.sessions.set(id, session)
    return session.rows.slice(offset, offset + limit)
  }

  close(id: string) {
    this.sessions.delete(id)
  }

  // Frees every buffer for a profile (called when it disconnects).
  closeProfile(profileId: string) {
    for (const [id, session] of this.sessions) {
      if (session.profileId === profileId) this.sessions.delete(id)
    }
  }

  /** Live session count — for tests and diagnostics. */
  get size() {
    return this.sessions.size
  }

  private evictExcess() {
    while (this.sessions.size > MAX_SESSIONS) {
      const oldest = this.sessions.keys().next().value
      if (oldest === undefined) break
      this.sessions.delete(oldest)
    }
  }
}
