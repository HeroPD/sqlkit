// Turning a query result's rows into clipboard/file formats. Pure and
// renderer-only; the rows here are whatever the panel holds (capped at the
// IPC boundary), never a re-run of the query.

const bigintReplacer = (_key: string, value: unknown): unknown => typeof value === 'bigint' ? value.toString() : value

const cellText = (value: unknown): string => {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'boolean') return String(value)
  try {
    return JSON.stringify(value, bigintReplacer) ?? '[unserializable value]'
  } catch {
    return '[unserializable value]'
  }
}

// A spreadsheet reads a field starting with one of these as a formula, so a
// hostile DB value like `=HYPERLINK("http://evil",…)` or a DDE payload would
// execute when the exported file is opened — or when the cell is pasted into a
// sheet. Prefixing with a single quote forces it to be read as literal text.
const FORMULA_LEAD = /^[=+\-@\t\r]/

// The one place the formula-injection rule lives, so CSV/TSV export and every
// clipboard copy path stay in sync. Keyed on the original value's type: only
// string cells are neutralized — numbers/booleans can't carry a payload, and a
// leading-minus number like -5 must not become '-5. `text` is the already
// formatted cell string (callers format differently: cellText vs formatCell).
export const formulaSafeText = (value: unknown, text: string): string =>
  typeof value === 'string' && FORMULA_LEAD.test(text) ? `'${text}` : text

const delimitedField = (value: unknown, delimiter: string): string => {
  const text = formulaSafeText(value, cellText(value))
  return text.includes('"') || text.includes(delimiter) || /[\r\n]/.test(text) ? quoteField(text) : text
}

const quoteField = (text: string): string => `"${text.replaceAll('"', '""')}"`

const delimitedRow = (row: unknown[], delimiter: ',' | '\t'): string =>
  row.map((value) => delimitedField(value, delimiter)).join(delimiter)

/** CSV/TSV with a header row; RFC-4180-style quoting. */
export const toDelimited = (columns: string[], rows: unknown[][], delimiter: ',' | '\t'): string =>
  [columns, ...rows].map((row) => delimitedRow(row, delimiter)).join('\n')

/** One TSV line of a single row — what pasting a row into a spreadsheet wants. */
export const rowToTsv = (row: unknown[]): string => delimitedRow(row, '\t')

// A single value escaped as one TSV field, for single-value clipboard copies
// (Copy Cell, Copy Column Name). Quoted only if it contains a tab/newline so an
// embedded delimiter can't split it into extra spreadsheet cells or rows; a
// harmless quote-only value should still paste as the text the user copied.
export const cellToTsv = (value: unknown): string => {
  const text = formulaSafeText(value, cellText(value))
  return text.includes('\t') || /[\r\n]/.test(text) ? quoteField(text) : text
}

// A headerless TSV block of selected cells, for clipboard range copy. Uses the
// same per-field escaping as export, so a cell containing a tab or newline is
// quoted — it can't split into a new, possibly formula-leading, spreadsheet
// cell on paste — and formula-leading cells are neutralized.
export const cellsToTsv = (rows: unknown[][]): string => rows.map((row) => delimitedRow(row, '\t')).join('\n')

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
    bigintReplacer,
    2,
  )
}
