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

  // Exact accumulators, all held at one running scale that widens as wider
  // values arrive. Single pass: nothing is buffered, and no value makes a
  // string round trip on the way to the total.
  let exactCount = 0
  let scale = 0
  let sum = 0n
  let least: bigint | null = null
  let most: bigint | null = null

  const widen = (to: number) => {
    if (to <= scale) return
    const factor = 10n ** BigInt(to - scale)
    sum *= factor
    if (least !== null) least *= factor
    if (most !== null) most *= factor
    scale = to
  }

  const addExact = (value: Fixed) => {
    widen(value.scale)
    const digits = value.digits * 10n ** BigInt(scale - value.scale)
    sum += digits
    if (least === null || digits < least) least = digits
    if (most === null || digits > most) most = digits
    exactCount += 1
  }

  // Float accumulators, for real/float columns and exponent forms. Kept as
  // running scalars so min/max never need an array (a spread of one would sit
  // close to the argument-count limit at the caller's cell cap).
  let floatCount = 0
  let floatSum = 0
  let floatLeast = Number.POSITIVE_INFINITY
  let floatMost = Number.NEGATIVE_INFINITY

  const addFloat = (value: number) => {
    floatSum += value
    if (value < floatLeast) floatLeast = value
    if (value > floatMost) floatMost = value
    floatCount += 1
    approximate = true
  }

  for (const value of values) {
    count += 1
    if (value === null || value === undefined) {
      nulls += 1
      continue
    }
    if (typeof value === 'bigint') {
      addExact({ digits: value, scale: 0 })
      continue
    }
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) continue
      if (Number.isInteger(value)) {
        addExact({ digits: BigInt(value), scale: 0 })
        continue
      }
      // A fractional double is already approximate; its shortest decimal form
      // is the faithful reading of it, so keep it on the exact path but say so.
      const parsed = parseFixed(String(value))
      if (parsed) {
        addExact(parsed)
        approximate = true
      } else {
        addFloat(value)
      }
      continue
    }
    if (typeof value !== 'string') continue
    const parsed = parseFixed(value)
    if (parsed) {
      addExact(parsed)
      continue
    }
    // Exponent notation ("1.5e-7") is numeric but not exactly parseable here.
    const asFloat = Number(value.trim())
    if (value.trim() !== '' && Number.isFinite(asFloat)) addFloat(asFloat)
  }

  const numeric = exactCount + floatCount
  if (!numeric) return { ...EMPTY, count, nulls }

  if (floatCount) {
    // Mixed or float-only: fold the exact side in once — three conversions,
    // not one per value — and report rounded floats.
    const exactSum = exactCount ? Number(formatFixed({ digits: sum, scale })) : 0
    const total = floatSum + exactSum
    const low = exactCount ? Math.min(floatLeast, Number(formatFixed({ digits: least!, scale }))) : floatLeast
    const high = exactCount ? Math.max(floatMost, Number(formatFixed({ digits: most!, scale }))) : floatMost
    return {
      count,
      numeric,
      nulls,
      sum: formatFloat(total),
      avg: formatFloat(total / numeric),
      min: formatFloat(low),
      max: formatFloat(high),
      approximate: true,
    }
  }

  // The average still divides, so it carries extra fraction digits and rounds
  // half away from zero at that width.
  const scaled = sum * 10n ** BigInt(AVG_EXTRA_SCALE)
  const divisor = BigInt(numeric)
  const quotient = scaled / divisor
  const remainder = scaled % divisor
  const magnitude = remainder < 0n ? -remainder : remainder
  const rounded = magnitude * 2n >= divisor ? quotient + (scaled < 0n ? -1n : 1n) : quotient

  return {
    count,
    numeric,
    nulls,
    sum: formatFixed({ digits: sum, scale }, scale),
    avg: formatFixed({ digits: rounded, scale: scale + AVG_EXTRA_SCALE }, Math.min(scale, 2)),
    min: formatFixed({ digits: least!, scale }, scale),
    max: formatFixed({ digits: most!, scale }, scale),
    approximate,
  }
}
