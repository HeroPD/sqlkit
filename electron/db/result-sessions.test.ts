import { describe, expect, it } from 'vitest'
import type { QueryResult } from '../../src/electron'
import { PAGE_SIZE, ResultSessionStore } from './result-sessions'

const result = (rowCount: number): QueryResult => ({
  columns: ['id'],
  rows: Array.from({ length: rowCount }, (_, i) => [i]),
  rowCount,
  durationMs: 1,
})

// Deterministic ids so tests can address sessions without crypto.randomUUID.
const seqIds = () => {
  let n = 0
  return () => `s${n++}`
}

describe('ResultSessionStore.open', () => {
  it('passes a result that fits in one page through unchanged', () => {
    const store = new ResultSessionStore(seqIds())
    const r = result(PAGE_SIZE)
    const out = store.open('p1', r)
    expect(out).toBe(r)
    expect(out.sessionId).toBeUndefined()
    expect(store.size).toBe(0)
  })

  it('does not open a session for a write/DDL result (no columns)', () => {
    const store = new ResultSessionStore(seqIds())
    const write: QueryResult = { columns: [], rows: [], rowCount: 5, durationMs: 1 }
    expect(store.open('p1', write)).toBe(write)
    expect(store.size).toBe(0)
  })

  it('opens a session for a multi-page result and returns the first page', () => {
    const store = new ResultSessionStore(seqIds())
    const out = store.open('p1', result(PAGE_SIZE + 50))
    expect(out.rows).toHaveLength(PAGE_SIZE)
    expect(out.sessionId).toBe('s0')
    expect(out.bufferedRowCount).toBe(PAGE_SIZE + 50)
    expect(out.rowCount).toBe(PAGE_SIZE + 50)
    expect(store.size).toBe(1)
  })
})

describe('ResultSessionStore.fetch', () => {
  it('returns the requested slice of the buffer', () => {
    const store = new ResultSessionStore(seqIds())
    const out = store.open('p1', result(500))
    const rows = store.fetch(out.sessionId!, PAGE_SIZE, PAGE_SIZE)
    expect(rows).toHaveLength(PAGE_SIZE)
    expect(rows?.[0]).toEqual([PAGE_SIZE])
  })

  it('returns empty for an unknown or closed session', () => {
    const store = new ResultSessionStore(seqIds())
    const out = store.open('p1', result(500))
    store.close(out.sessionId!)
    expect(store.fetch(out.sessionId!, 0, 10)).toBeNull()
    expect(store.fetch('nope', 0, 10)).toBeNull()
  })
})

describe('ResultSessionStore lifecycle', () => {
  it('closeProfile frees only that profile’s sessions', () => {
    const store = new ResultSessionStore(seqIds())
    const a = store.open('p1', result(300))
    const b = store.open('p2', result(300))
    store.closeProfile('p1')
    expect(store.fetch(a.sessionId!, 0, 1)).toBeNull()
    expect(store.fetch(b.sessionId!, 0, 1)).toHaveLength(1)
  })

  it('evicts the oldest session once past the cap (24)', () => {
    const store = new ResultSessionStore(seqIds())
    const first = store.open('p1', result(300))
    for (let i = 0; i < 24; i += 1) store.open('p1', result(300)) // 25 total → evict the first
    expect(store.fetch(first.sessionId!, 0, 1)).toBeNull()
    expect(store.size).toBe(24)
  })
})
