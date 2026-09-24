import type { ColumnRef, QueryResultSet } from './electron'
import { sourceColumnMeta } from './json-columns'

// Which result columns hold numbers, by result column index, so the grid can
// right-align them. A column traced to its table goes by its declared type; an
// expression (count, sum, a literal) goes by the values it returned.

// Declared numeric types across Postgres, MySQL/MariaDB, SQL Server and SQLite.
const NUMERIC_TYPE =
  /^(?:(?:tiny|small|medium|big)?int(?:eger)?|int[248]|(?:small|big)?serial|decimal|dec|numeric|number|real|float\d*|double|money|smallmoney)\b/

// Canonical numerals only: a leading zero ("02134") reads as a code, not a quantity.
const NUMERAL = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/

const SAMPLE_ROWS = 200

const isNumberValue = (value: unknown) =>
  typeof value === 'number' || typeof value === 'bigint' || (typeof value === 'string' && NUMERAL.test(value))

export function numericColumns(result: QueryResultSet, columns: ColumnRef[]): Set<number> {
  const found = new Set<number>()
  const meta = sourceColumnMeta(result, columns)
  const sample = result.rows.slice(0, SAMPLE_ROWS)
  result.columns.forEach((_, index) => {
    const declared = meta[index]
    if (declared) {
      if (NUMERIC_TYPE.test(declared.dataType.trim().toLowerCase())) found.add(index)
      return
    }
    let seen = false
    for (const row of sample) {
      const value = row[index]
      if (value === null || value === undefined) continue
      if (!isNumberValue(value)) return
      seen = true
    }
    if (seen) found.add(index)
  })
  return found
}
