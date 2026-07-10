import { describe, expect, it } from 'vitest'
import { boundedRow, MAX_BUFFERED_BYTES, MAX_CELL_BYTES } from './limits'

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
})
