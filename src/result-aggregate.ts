// Aggregates over a selected cell range, for the status bar's Excel-style
// readout. Deliberately engine-agnostic: it infers numerics from the values
// themselves rather than declared column types, because the four drivers spell
// those differently and a selection can span columns.
//
// Exact numerics reach the renderer as strings on purpose (pg TypeOverrides,
// mysql2 supportBigNumbers, the tedious value patch), so summing through Number
// would undo that — decimal(38,2) money and bigint ids past 2^53 are exactly
// what people select. Sums, mins and maxes are therefore computed in scaled
// BigInt when every value parses exactly, and only fall back to float when a
// genuine float/real (or an exponent form) is in the selection. `approximate`
// says which happened, so the caller can mark the readout.

/** A decimal parsed without loss: value === digits / 10^scale. */
type Fixed = { digits: bigint; scale: number }

const DECIMAL = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/

// Exact parse of a plain decimal string. Exponent forms ("1e5") and anything
// non-numeric return null so the caller can degrade to float.
export function parseFixed(text: string): Fixed | null {
  const trimmed = text.trim()
  if (!DECIMAL.test(trimmed)) return null
  const negative = trimmed.startsWith('-')
  const unsigned = trimmed.replace(/^[+-]/, '')
  const [whole = '', fraction = ''] = unsigned.split('.')
  const digits = BigInt((whole || '0') + fraction)
  return { digits: negative ? -digits : digits, scale: fraction.length }
}

const scaleTo = (value: Fixed, scale: number): bigint =>
  value.digits * 10n ** BigInt(scale - value.scale)

/** Renders digits/10^scale, trimming trailing fraction zeros but keeping `min`. */
export function formatFixed({ digits, scale }: Fixed, minScale = 0): string {
  const negative = digits < 0n
  let text = (negative ? -digits : digits).toString().padStart(scale + 1, '0')
  if (scale > 0) {
    let fraction = text.slice(text.length - scale)
    text = text.slice(0, text.length - scale)
    fraction = fraction.replace(/0+$/, '')
    while (fraction.length < minScale) fraction += '0'
    if (fraction) text += `.${fraction}`
  }
  return (negative ? '-' : '') + text
}

export type SelectionStats = {
  /** Cells in the selection, including nulls and non-numeric ones. */
  count: number
  /** Cells that parsed as a number — what sum/avg/min/max cover. */
  numeric: number
  nulls: number
  sum: string | null
  avg: string | null
  min: string | null
  max: string | null
  /** A float crept in, so sum/avg/min/max are rounded rather than exact. */
  approximate: boolean
}

const EMPTY: SelectionStats = {
  count: 0, numeric: 0, nulls: 0, sum: null, avg: null, min: null, max: null, approximate: false,
}

// Floats are rendered at this many significant digits: enough to be faithful,
// short enough that 0.1 + 0.2 reads as 0.3 rather than 0.30000000000000004.
const FLOAT_PRECISION = 12
const formatFloat = (value: number): string =>
  Number.isFinite(value) ? String(Number(value.toPrecision(FLOAT_PRECISION))) : String(value)

// Avg of exact values still divides, so it carries this many fraction digits
// past the summed scale before trailing zeros are trimmed.
const AVG_EXTRA_SCALE = 6

/**
 * Aggregates the given cell values. `null`/`undefined` count as nulls; numbers,
 * bigints and plain decimal strings count as numeric; everything else (text,
 * blobs, json) only contributes to `count`.
 */
export function aggregateCells(values: readonly unknown[]): SelectionStats {
  if (!values.length) return EMPTY

  let count = 0
  let nulls = 0
  let approximate = false
  const exact: Fixed[] = []
  const floats: number[] = []

  for (const value of values) {
    count += 1
    if (value === null || value === undefined) {
      nulls += 1
      continue
    }
    if (typeof value === 'bigint') {
      exact.push({ digits: value, scale: 0 })
      continue
    }
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) continue
      // An integer-valued double is exact; a fractional one is already a float,
      // so parse its shortest representation and accept the rounding.
      if (Number.isInteger(value)) exact.push({ digits: BigInt(value), scale: 0 })
      else {
        const parsed = parseFixed(String(value))
        if (parsed) exact.push(parsed)
        else floats.push(value)
        approximate = true
      }
      continue
    }
    if (typeof value === 'string') {
      const parsed = parseFixed(value)
      if (parsed) exact.push(parsed)
      else {
        // Exponent notation ("1.5e-7") is numeric but not exactly parseable here.
        const asFloat = Number(value.trim())
        if (value.trim() !== '' && Number.isFinite(asFloat)) {
          floats.push(asFloat)
          approximate = true
        }
      }
    }
  }

  const numeric = exact.length + floats.length
  if (!numeric) return { ...EMPTY, count, nulls }

  if (floats.length) {
    // Mixed or float-only: one float total, rounded for display.
    let total = floats.reduce((sum, value) => sum + value, 0)
    for (const value of exact) total += Number(formatFixed(value))
    const all = [...floats, ...exact.map((value) => Number(formatFixed(value)))]
    return {
      count,
      numeric,
      nulls,
      sum: formatFloat(total),
      avg: formatFloat(total / numeric),
      min: formatFloat(Math.min(...all)),
      max: formatFloat(Math.max(...all)),
      approximate: true,
    }
  }

  // All exact: align every value to the widest scale and work in BigInt.
  const scale = exact.reduce((widest, value) => Math.max(widest, value.scale), 0)
  const aligned = exact.map((value) => scaleTo(value, scale))
  const total = aligned.reduce((sum, value) => sum + value, 0n)
  const smallest = aligned.reduce((least, value) => (value < least ? value : least))
  const largest = aligned.reduce((most, value) => (value > most ? value : most))

  // Round-half-away-from-zero division for the average, at scale + extra digits.
  const avgScale = scale + AVG_EXTRA_SCALE
  const numerator = total * 10n ** BigInt(AVG_EXTRA_SCALE) * 2n
  const divisor = BigInt(numeric) * 2n
  const quotient = numerator / divisor
  const remainder = (numerator % divisor) * 2n
  const rounded = remainder >= divisor
    ? quotient + (total < 0n ? -1n : 1n)
    : remainder <= -divisor
      ? quotient - 1n
      : quotient

  return {
    count,
    numeric,
    nulls,
    sum: formatFixed({ digits: total, scale }, scale),
    avg: formatFixed({ digits: rounded, scale: avgScale }, Math.min(scale, 2)),
    min: formatFixed({ digits: smallest, scale }, scale),
    max: formatFixed({ digits: largest, scale }, scale),
    approximate,
  }
}
