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

  it('pages every embedded result set without marking it truncated', () => {
    const store = new ResultSessionStore(seqIds())
    const many = Array.from({ length: PAGE_SIZE + 10 }, (_, index) => [index])
    const out = store.open('p1', {
      ...result(PAGE_SIZE + 10),
      resultSets: [
        { columns: ['a'], rows: many, rowCount: many.length },
        { columns: ['b'], rows: many, rowCount: many.length },
      ],
    })
    expect(out.resultSets?.[0]?.rows).toHaveLength(PAGE_SIZE)
    expect(out.resultSets?.[0]?.truncated).toBeUndefined()
    expect(out.resultSets?.[0]?.sessionId).toBe('s1')
    expect(out.resultSets?.[0]?.bufferedRowCount).toBe(PAGE_SIZE + 10)
    expect(out.resultSets?.[1]?.rows).toHaveLength(PAGE_SIZE)
    expect(out.resultSets?.[1]?.sessionId).toBe(out.sessionId)
    expect(store.fetch(out.resultSets![0]!.sessionId!, PAGE_SIZE, PAGE_SIZE)).toHaveLength(10)
  })

  it('byte-bounds an IPC page even when it contains fewer than 200 rows', () => {
    const store = new ResultSessionStore(seqIds())
    const wide = 'x'.repeat(700_000)
    const out = store.open('p1', {
      columns: ['payload'],
      rows: Array.from({ length: 5 }, () => [wide]),
      rowCount: 5,
      durationMs: 1,
    })
    expect(out.rows).toHaveLength(2)
    expect(out.sessionId).toBe('s0')
    expect(store.fetch(out.sessionId!, 2, PAGE_SIZE)).toHaveLength(2)
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

  it('clamps negative offsets and oversized limits to one page', () => {
    const store = new ResultSessionStore(seqIds())
    const out = store.open('p1', result(PAGE_SIZE * 3))

    const rows = store.fetch(out.sessionId!, -10, PAGE_SIZE * 10)

    expect(rows).toHaveLength(PAGE_SIZE)
    expect(rows?.[0]).toEqual([0])
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

  it('does not evict small result sets merely because a script produced several', () => {
    const store = new ResultSessionStore(seqIds())
    const first = store.open('p1', result(300))
    for (let i = 0; i < 8; i += 1) store.open('p1', result(300))
    expect(store.fetch(first.sessionId!, 0, 1)).toHaveLength(1)
    expect(store.size).toBe(9)
  })

  it('evicts oldest buffers when the aggregate byte ceiling is exceeded', () => {
    const store = new ResultSessionStore(seqIds())
    const cell = 'x'.repeat(40_000)
    const bulky = (): QueryResult => ({
      columns: ['payload'],
      rows: Array.from({ length: 201 }, () => [cell]),
      rowCount: 201,
      durationMs: 1,
    })
    const first = store.open('p1', bulky())
    for (let index = 0; index < 8; index += 1) store.open('p1', bulky())
    expect(store.fetch(first.sessionId!, 0, 1)).toBeNull()
    expect(store.size).toBeLessThan(9)
  })
})
