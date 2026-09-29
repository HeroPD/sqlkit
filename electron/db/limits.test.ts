import { describe, expect, it } from 'vitest'
import { boundedRow, fairShareCap, MAX_BUFFERED_BYTES, MAX_BUFFERED_ROW_BYTES, MAX_CELL_BYTES } from './limits'

describe('boundedRow', () => {
  it('keeps safe integers as numbers and preserves unsafe integers as bigint', () => {
    expect(boundedRow([42n, 9007199254740993n], 0)?.row).toEqual([42, 9007199254740993n])
  })

  it('truncates oversized cells and rejects rows beyond the byte budget', () => {
    const large = 'x'.repeat(MAX_CELL_BYTES + 100)
    const bounded = boundedRow([large], 0)
    expect(bounded?.truncated).toBe(true)
    expect(String(bounded?.row[0])).toContain('cell truncated')
    expect(boundedRow(['x'], MAX_BUFFERED_BYTES)).toBeNull()
  })

  it('bounds a single very wide row below the IPC page ceiling', () => {
    const bounded = boundedRow(Array.from({ length: 20 }, () => 'x'.repeat(MAX_CELL_BYTES)), 0)!
    const bytes = bounded.row.reduce((total: number, value) => total + Buffer.byteLength(String(value)), 0)
    expect(bounded.truncated).toBe(true)
    expect(bytes).toBeLessThanOrEqual(MAX_BUFFERED_ROW_BYTES)
  })
})

describe('fair-share cell truncation', () => {
  it('keeps every cell of a wide row whose total fits the row budget', () => {
    const row = [...Array.from({ length: 59 }, (_, index) => index), 'y'.repeat(40 * 1024)]
    const bounded = boundedRow(row, 0)!
    expect(bounded.truncated).toBe(false)
    expect(bounded.row[59]).toBe('y'.repeat(40 * 1024))
  })

  it('cuts only the largest cells, each to a fair share of what the rest leave', () => {
    const small = 'a'.repeat(40 * 1024)
    const row = [small, 'b'.repeat(MAX_CELL_BYTES), small, 'c'.repeat(MAX_CELL_BYTES), 7]
    const bounded = boundedRow(row, 0)!
    expect(bounded.row[0]).toBe(small)
    expect(bounded.row[2]).toBe(small)
    expect(String(bounded.row[1])).toContain('cell truncated')
    expect(String(bounded.row[3])).toContain('cell truncated')
    const share = Math.floor((MAX_BUFFERED_ROW_BYTES - 16 * 6 - 16 - 2 * small.length) / 2)
    expect(Buffer.byteLength(String(bounded.row[1]))).toBeLessThanOrEqual(share)
    expect(Buffer.byteLength(String(bounded.row[1]))).toBeGreaterThan(share - 64)
    expect(bounded.bytes).toBeLessThanOrEqual(MAX_BUFFERED_ROW_BYTES)
  })

  it('names the shortened columns so the result can flag them', () => {
    const bounded = boundedRow(['x', 'z'.repeat(MAX_CELL_BYTES + 1)], 0)!
    expect(bounded.truncatedColumns).toEqual([1])
  })

  it('computes the water-filling cap', () => {
    expect(fairShareCap([10, 20, 30], 100)).toBe(Infinity)
    expect(fairShareCap([10, 100, 200], 110)).toBe(50)
    expect(fairShareCap([], 0)).toBe(Infinity)
  })
})
