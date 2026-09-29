import type { QueryResultSet } from './electron'

// Cells the driver shortened to fit the row budget hold a marker, not their value,
// so nothing may carry them into a file or the clipboard as if they were data.
const keysByResult = new WeakMap<readonly unknown[], ReadonlySet<string>>()

const truncatedKeys = (result: Pick<QueryResultSet, 'truncatedCells'>): ReadonlySet<string> => {
  const cells = result.truncatedCells
  if (!cells?.length) return new Set()
  let keys = keysByResult.get(cells)
  if (!keys) {
    keys = new Set(cells.map(([row, col]) => `${row}:${col}`))
    keysByResult.set(cells, keys)
  }
  return keys
}

export const hasTruncatedCells = (result: Pick<QueryResultSet, 'truncatedCells'> | null | undefined): boolean =>
  (result?.truncatedCells?.length ?? 0) > 0

export const isTruncatedCell = (result: Pick<QueryResultSet, 'truncatedCells'> | null | undefined, row: number, col: number): boolean =>
  !!result && hasTruncatedCells(result) && truncatedKeys(result).has(`${row}:${col}`)

/** Whether any of the first `rows` buffered rows holds a shortened cell. */
export const truncatedWithinRows = (result: Pick<QueryResultSet, 'truncatedCells'> | null | undefined, rows: number): boolean =>
  !!result?.truncatedCells?.some(([row]) => row < rows)
