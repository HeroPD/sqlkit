// Turning a query result's rows into clipboard/file formats. Pure and
// renderer-only; the rows here are whatever the panel holds (capped at the
// IPC boundary), never a re-run of the query.

const cellText = (value: unknown): string => {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'boolean') return String(value)
  return JSON.stringify(value)
}

const delimitedField = (value: unknown, delimiter: string): string => {
  const text = cellText(value)
  return text.includes('"') || text.includes(delimiter) || /[\r\n]/.test(text)
    ? `"${text.replaceAll('"', '""')}"`
    : text
}

/** CSV/TSV with a header row; RFC-4180-style quoting. */
export const toDelimited = (columns: string[], rows: unknown[][], delimiter: ',' | '\t'): string =>
  [columns, ...rows].map((row) => row.map((value) => delimitedField(value, delimiter)).join(delimiter)).join('\n')

/** One TSV line of a single row — what pasting a row into a spreadsheet wants. */
export const rowToTsv = (row: unknown[]): string => row.map((value) => delimitedField(value, '\t')).join('\t')

/** Array of objects; duplicate column names (select a.id, b.id) get numbered
 * suffixes so no value is silently dropped. */
export function toJson(columns: string[], rows: unknown[][]): string {
  const seen = new Map<string, number>()
  const keys = columns.map((name) => {
    const count = seen.get(name) ?? 0
    seen.set(name, count + 1)
    return count === 0 ? name : `${name}_${count + 1}`
  })
  return JSON.stringify(
    rows.map((row) => Object.fromEntries(keys.map((key, index) => [key, row[index] ?? null]))),
    null,
    2,
  )
}
