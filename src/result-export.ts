// Turning a query result's rows into clipboard/file formats. Pure and
// renderer-only; the rows here are whatever the panel holds (capped at the
// IPC boundary), never a re-run of the query.

import type { Engine, TableRef } from './electron'
import { insertStatementForRow } from './result-sql'
import { jsonError } from './json-text'
import { t } from './i18n'

const bigintReplacer = (_key: string, value: unknown): unknown => typeof value === 'bigint' ? value.toString() : value

const NO_JSON_COLUMNS: ReadonlySet<number> = new Set()

// A JSON-typed cell already holds the document's own text: JSON.stringify would
// wrap it in quotes (a double-encoded string instead of structure), and a parse
// round-trip would rewrite its number literals (see json-text.ts). Valid
// documents are spliced into a JSON export raw; anything else — NULL, or text a
// json-ish column holds that does not parse — falls back to normal encoding.
const rawJsonDocument = (value: unknown): string | null => {
  if (typeof value !== 'string') return null
  const text = value.trim()
  return text && !jsonError(text) ? text : null
}

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

/** Parses a spreadsheet clipboard block, including quoted tabs, newlines, and doubled quotes. */
export function parseClipboardTsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  let endedRow = false

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"'
          index += 1
        } else {
          quoted = false
        }
      } else {
        field += char
      }
      endedRow = false
      continue
    }
    if (char === '"' && field === '') {
      quoted = true
      endedRow = false
    } else if (char === '\t') {
      row.push(field)
      field = ''
      endedRow = false
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[index + 1] === '\n') index += 1
      row.push(field)
      rows.push(row)
      row = []
      field = ''
      endedRow = true
    } else {
      field += char
      endedRow = false
    }
  }
  if (!endedRow || row.length || field) {
    row.push(field)
    rows.push(row)
  }
  return rows.length ? rows : [['']]
}

// Numbered suffixes for duplicate column names (select a.id, b.id) so no value
// is silently dropped when a row becomes an object.
const jsonKeys = (columns: string[]): string[] => {
  const seen = new Map<string, number>()
  return columns.map((name) => {
    const count = seen.get(name) ?? 0
    seen.set(name, count + 1)
    return count === 0 ? name : `${name}_${count + 1}`
  })
}

/** Array of objects; duplicate column names get numbered suffixes. Cells in
 * `jsonColumns` are spliced in as raw documents (see rawJsonDocument). */
export function toJson(columns: string[], rows: unknown[][], jsonColumns: ReadonlySet<number> = NO_JSON_COLUMNS): string {
  const keys = jsonKeys(columns)
  if (!jsonColumns.size) {
    return JSON.stringify(
      rows.map((row) => Object.fromEntries(keys.map((key, index) => [key, row[index] ?? null]))),
      bigintReplacer,
      2,
    )
  }
  // Assembled by hand so raw documents can go in unescaped; they stay on the
  // one line they arrived as, everything else is encoded exactly as above.
  if (!rows.length) return '[]'
  const encoded = rows.map((row) => {
    const fields = keys.map((key, index) => {
      const raw = jsonColumns.has(index) ? rawJsonDocument(row[index]) : null
      return `    ${JSON.stringify(key)}: ${raw ?? JSON.stringify(row[index] ?? null, bigintReplacer)}`
    })
    return `  {\n${fields.join(',\n')}\n  }`
  })
  return `[\n${encoded.join(',\n')}\n]`
}

export type ExportFormat = 'csv' | 'tsv' | 'json' | 'sql'

/** What the SQL format needs beyond the rows: literals are spelled per engine,
 * and every statement names a target table (null → a placeholder name). */
export type SqlExportTarget = { engine: Engine; table: TableRef | null }

// Emits an export one piece at a time (header, then a line per row, then a
// footer) so a full result can be streamed straight to disk without ever
// holding every row in memory. Reuses the exact escaping and formula-injection
// neutralization of the buffered paths above, so a streamed file and a
// clipboard copy of the same rows are byte-identical.
export type ExportSerializer = {
  header(): string
  row(cells: unknown[]): string
  footer(): string
}

export function createExportSerializer(
  columns: string[],
  format: ExportFormat,
  sqlTarget?: SqlExportTarget,
  jsonColumns: ReadonlySet<number> = NO_JSON_COLUMNS,
): ExportSerializer {
  if (format === 'sql') {
    if (!sqlTarget) throw new Error(t('export.sqlTargetMissing'))
    // One INSERT per row rather than a packed VALUES list: the serializer sees a
    // row at a time and never holds a chunk to group, which is what keeps a
    // streamed export flat in memory. Statements stay independently runnable.
    return {
      header: () => '',
      row: (cells) => insertStatementForRow(cells, { columns, engine: sqlTarget.engine, table: sqlTarget.table }),
      footer: () => '',
    }
  }
  if (format === 'json') {
    const keys = jsonKeys(columns)
    let first = true
    return {
      header: () => '[\n',
      // One compact object per line, comma-separated — a valid JSON array that a
      // reader can also consume line by line. Assembled field by field so JSON
      // cells can be spliced in raw; for everything else this is byte-identical
      // to stringifying the whole object.
      row: (cells) => {
        const fields = keys.map((key, index) => {
          const raw = jsonColumns.has(index) ? rawJsonDocument(cells[index]) : null
          return `${JSON.stringify(key)}:${raw ?? JSON.stringify(cells[index] ?? null, bigintReplacer)}`
        })
        const text = `${first ? '' : ',\n'}{${fields.join(',')}}`
        first = false
        return text
      },
      footer: () => '\n]\n',
    }
  }
  const delimiter = format === 'tsv' ? '\t' : ','
  return {
    header: () => `${delimitedRow(columns, delimiter)}\n`,
    row: (cells) => `${delimitedRow(cells, delimiter)}\n`,
    footer: () => '',
  }
}
