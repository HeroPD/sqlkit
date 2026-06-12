import { describe, expect, it } from 'vitest'
import type { QueryResult } from '../../src/electron'
import { capResult, MAX_RESULT_ROWS } from './driver'

const select = (rowCount: number): QueryResult => ({
  columns: ['id'],
  rows: Array.from({ length: rowCount }, (_, i) => [i]),
  rowCount,
  durationMs: 1,
})

describe('capResult', () => {
  it('passes small results through untouched', () => {
    const result = select(3)
    expect(capResult(result)).toBe(result)
    expect(result.truncated).toBeUndefined()
  })

  it('passes results exactly at the cap through untouched', () => {
    const result = select(MAX_RESULT_ROWS)
    expect(capResult(result)).toBe(result)
  })

  it('caps oversized results and keeps the full rowCount', () => {
    const capped = capResult(select(MAX_RESULT_ROWS + 500))
    expect(capped.rows).toHaveLength(MAX_RESULT_ROWS)
    expect(capped.rows[MAX_RESULT_ROWS - 1]).toEqual([MAX_RESULT_ROWS - 1])
    expect(capped.rowCount).toBe(MAX_RESULT_ROWS + 500)
    expect(capped.truncated).toBe(true)
  })

  it('leaves write results alone (no rows, rowCount = affected)', () => {
    const write: QueryResult = { columns: [], rows: [], rowCount: 5000, durationMs: 1 }
    expect(capResult(write)).toBe(write)
  })
})
