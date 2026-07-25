import { describe, expect, it } from 'vitest'
import { aggregateCells, formatFixed, parseFixed } from './result-aggregate'

describe('parseFixed', () => {
  it('parses plain decimals exactly, including sign and bare fractions', () => {
    expect(parseFixed('123.45')).toEqual({ digits: 12345n, scale: 2 })
    expect(parseFixed('-0.010')).toEqual({ digits: -10n, scale: 3 })
    expect(parseFixed('.5')).toEqual({ digits: 5n, scale: 1 })
    expect(parseFixed('42')).toEqual({ digits: 42n, scale: 0 })
    expect(parseFixed('  7.5  ')).toEqual({ digits: 75n, scale: 1 })
  })

  it('refuses anything it cannot represent without loss', () => {
    for (const input of ['1e5', '0x10', 'abc', '', '1,000', 'NaN', '1.2.3']) {
      expect(parseFixed(input)).toBeNull()
    }
  })
})

describe('formatFixed', () => {
  it('trims trailing zeros but honours a minimum scale', () => {
    expect(formatFixed({ digits: 12345n, scale: 2 })).toBe('123.45')
    expect(formatFixed({ digits: 1000n, scale: 3 })).toBe('1')
    expect(formatFixed({ digits: 1000n, scale: 3 }, 2)).toBe('1.00')
    expect(formatFixed({ digits: -5n, scale: 2 })).toBe('-0.05')
    expect(formatFixed({ digits: 0n, scale: 2 }, 2)).toBe('0.00')
  })
})

describe('aggregateCells', () => {
  it('counts cells, nulls and numerics separately', () => {
    const stats = aggregateCells(['1', null, 'hello', 2, undefined])
    expect(stats.count).toBe(5)
    expect(stats.nulls).toBe(2)
    // 'hello' counts as a cell but not as a numeric.
    expect(stats.numeric).toBe(2)
    expect(stats.sum).toBe('3')
  })

  it('reports no aggregate for a selection with nothing numeric', () => {
    const stats = aggregateCells(['a', 'b', null])
    expect(stats).toMatchObject({ count: 3, nulls: 1, numeric: 0, sum: null, avg: null })
  })

  it('is empty for an empty selection', () => {
    expect(aggregateCells([]).count).toBe(0)
    expect(aggregateCells([]).sum).toBeNull()
  })

  // The reason this module exists: exact numerics arrive as strings and must not
  // be routed through Number.
  it('sums decimal strings exactly, past double precision', () => {
    const stats = aggregateCells(['0.1', '0.2'])
    expect(stats.sum).toBe('0.3')
    expect(stats.approximate).toBe(false)

    const wide = aggregateCells(['123456789012345678.90', '0.10'])
    expect(wide.sum).toBe('123456789012345679.00')
    expect(wide.approximate).toBe(false)
  })

  it('sums bigints past 2^53 without rounding', () => {
    const stats = aggregateCells(['9007199254740993', '9007199254740993'])
    expect(stats.sum).toBe('18014398509481986')
    expect(stats.max).toBe('9007199254740993')
    expect(stats.approximate).toBe(false)

    expect(aggregateCells([9007199254740993n, 1n]).sum).toBe('9007199254740994')
  })

  it('compares min/max exactly for adjacent large integers', () => {
    // Through Number these two collapse to the same value.
    const stats = aggregateCells(['9007199254740993', '9007199254740992'])
    expect(stats.min).toBe('9007199254740992')
    expect(stats.max).toBe('9007199254740993')
  })

  it('aligns mixed scales', () => {
    const stats = aggregateCells(['1.5', '2.25', '3'])
    expect(stats.sum).toBe('6.75')
    expect(stats.min).toBe('1.50')
    expect(stats.max).toBe('3.00')
  })

  it('keeps money-style scale on the sum', () => {
    const stats = aggregateCells(['10.00', '5.50', '0.25'])
    expect(stats.sum).toBe('15.75')
    expect(stats.avg).toBe('5.25')
  })

  it('averages exactly when it divides, and rounds when it does not', () => {
    // Integer inputs keep no minimum scale, so this is 1.5 rather than 1.50;
    // the money case above shows the scale being carried when there is one.
    expect(aggregateCells(['1', '2']).avg).toBe('1.5')
    // 10/3 carries the extra fraction digits rather than a float artefact.
    expect(aggregateCells(['1', '2', '7']).avg).toBe('3.333333')
  })

  it('ignores nulls in the aggregate, SQL-style', () => {
    const stats = aggregateCells(['10.00', null, '20.00'])
    expect(stats.sum).toBe('30.00')
    expect(stats.avg).toBe('15.00')
    // Divided by the two numerics, not the three cells.
    expect(stats.numeric).toBe(2)
    expect(stats.nulls).toBe(1)
  })

  it('flags approximate once a genuine float is involved, and still reads cleanly', () => {
    const stats = aggregateCells([0.1, 0.2])
    expect(stats.approximate).toBe(true)
    // The point: never 0.30000000000000004 in the readout.
    expect(stats.sum).toBe('0.3')
  })

  it('treats exponent notation as numeric but approximate', () => {
    const stats = aggregateCells(['1e2', '1'])
    expect(stats.numeric).toBe(2)
    expect(stats.sum).toBe('101')
    expect(stats.approximate).toBe(true)
  })

  it('skips non-finite values without counting them as numeric', () => {
    const stats = aggregateCells([Number.NaN, Number.POSITIVE_INFINITY, '5'])
    expect(stats.numeric).toBe(1)
    expect(stats.sum).toBe('5')
  })

  it('handles negatives and a negative average', () => {
    const stats = aggregateCells(['-1.50', '0.50'])
    expect(stats.sum).toBe('-1.00')
    expect(stats.avg).toBe('-0.50')
    expect(stats.min).toBe('-1.50')
    expect(stats.max).toBe('0.50')
  })

  it('leaves blobs and objects out of the aggregate', () => {
    const stats = aggregateCells([new Uint8Array([1, 2]), { a: 1 }, '3'])
    expect(stats.count).toBe(3)
    expect(stats.numeric).toBe(1)
    expect(stats.sum).toBe('3')
  })
})
