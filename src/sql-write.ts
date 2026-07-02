import type { ColumnRef, Engine, InspectColumn, TableRef } from './electron'
import { dialectFor, type Dialect } from './dialect'

// A single-quoted SQL string literal (doubling embedded quotes). Column DDL runs
// param-free, so the review preview is exactly what executes.
export const quoteLiteral = (value: string) => `'${value.replaceAll("'", "''")}'`

export const quoteQualified = (table: TableRef, dialect: Dialect) =>
  table.schema ? `${dialect.quoteIdent(table.schema)}.${dialect.quoteIdent(table.name)}` : dialect.quoteIdent(table.name)

// Turns a cell's string input into a bound parameter, guided by the column's
// declared type: empty + nullable → NULL; numeric/boolean parsed; anything else
// passed as text for the engine to cast. Unparseable input falls back to text
// so a typo surfaces as a DB error rather than a silent wrong value.
export function coerceValue(value: string, column: ColumnRef | undefined, engine?: Engine): unknown {
  if (value === '' && (column?.nullable ?? true)) return null
  const type = column?.dataType?.toLowerCase() ?? ''
  if (/int|serial|numeric|decimal|real|double|float|money/.test(type)) {
    const trimmed = value.trim()
    if (trimmed === '') return value
    // Keep the raw string unless it round-trips losslessly through Number: a
    // bigint/numeric past 2^53 routed through Number() rounds — corrupting the save.
    const n = Number(trimmed)
    return Number.isFinite(n) && String(n) === trimmed ? n : value
  }
  if (/bool/.test(type) || type === 'bit') { // bit is SQL Server's boolean
    const truthy = /^(t|true|1|yes|y)$/i.test(value)
    const falsy = /^(f|false|0|no|n)$/i.test(value)
    // The dialect decides how a boolean binds; an unrecognized token falls through to text.
    if (truthy || falsy) return engine ? dialectFor(engine).bindBoolean(truthy) : truthy
  }
  return value
}

export type BatchUpdateEdit = {
  column: string
  columnMeta: ColumnRef | undefined
  /** Raw string from the edit prompt; coerced per target column. */
  value: string
  /** Primary-key column/value pairs identifying the row to update. */
  pks: { name: string; value: unknown }[]
}

export type BatchUpdateSpec = {
  table: TableRef
  edits: BatchUpdateEdit[]
  engine: Engine
}

export type RowKey = { name: string; value: unknown }[]

export type DeleteRowsSpec = {
  table: TableRef
  rows: RowKey[]
  engine: Engine
}

// Builds one atomic UPDATE for multiple cells. Each target column gets a CASE
// expression keyed by the row's primary key; rows/columns outside the selection
// keep their existing values. Quoting and placeholder style come from the
// engine's dialect, so backtick/bracket engines stay correct.
export function buildBatchUpdate(spec: BatchUpdateSpec): { sql: string; params: unknown[] } {
  if (spec.edits.length === 0) throw new Error('Cannot build an UPDATE without edits')
  const dialect = dialectFor(spec.engine)

  const params: unknown[] = []
  const bind = (value: unknown) => {
    params.push(value)
    return dialect.placeholder(params.length)
  }
  const condition = (pks: { name: string; value: unknown }[]) => {
    if (pks.length === 0) throw new Error('Cannot build an UPDATE without a primary key')
    return pks.map((pk) => `${dialect.quoteIdent(pk.name)} = ${bind(pk.value)}`).join(' AND ')
  }

  const byColumn = new Map<string, string[]>()
  for (const edit of spec.edits) {
    const cases = byColumn.get(edit.column) ?? []
    cases.push(`WHEN ${condition(edit.pks)} THEN ${bind(coerceValue(edit.value, edit.columnMeta, spec.engine))}`)
    byColumn.set(edit.column, cases)
  }

  const set = [...byColumn.entries()]
    .map(([column, cases]) => `       ${dialect.quoteIdent(column)} = CASE\n         ${cases.join('\n         ')}\n         ELSE ${dialect.quoteIdent(column)}\n       END`)
    .join(',\n')
  const where = spec.edits.map((edit) => `(${condition(edit.pks)})`).join(' OR ')

  return { sql: `UPDATE ${quoteQualified(spec.table, dialect)}\n   SET\n${set}\n WHERE ${where}`, params }
}

export function buildInsertDefault(table: TableRef, dialect: Dialect): { sql: string; params: unknown[] } {
  return { sql: `INSERT INTO ${quoteQualified(table, dialect)} DEFAULT VALUES`, params: [] }
}

export type InsertSpec = {
  table: TableRef
  /** Only the columns the user filled in; untouched columns are omitted so the
   * table's own DEFAULT applies — the one portable way to express defaults
   * (SQLite rejects the DEFAULT keyword inside a VALUES list). */
  columns: { name: string; columnMeta: ColumnRef | undefined }[]
  /** Raw cell strings aligned to `columns`, coerced per column. */
  values: string[]
  engine: Engine
}

// One parameterized single-row INSERT. With no filled columns it falls back to
// DEFAULT VALUES. Kept single-statement so params bind on both engines (SQLite
// only binds params for a lone statement; Postgres params are extended-protocol).
export function buildInsert(spec: InsertSpec): { sql: string; params: unknown[] } {
  const dialect = dialectFor(spec.engine)
  if (spec.columns.length === 0) return buildInsertDefault(spec.table, dialect)
  const columns = spec.columns.map((column) => dialect.quoteIdent(column.name)).join(', ')
  const placeholders = spec.columns.map((_, index) => dialect.placeholder(index + 1)).join(', ')
  const params = spec.columns.map((column, index) => coerceValue(spec.values[index] ?? '', column.columnMeta, spec.engine))
  return { sql: `INSERT INTO ${quoteQualified(spec.table, dialect)} (${columns})\nVALUES (${placeholders})`, params }
}

// One column's staged edits, diffed against the loaded structure. Only fields
// that differ from `original` produce a statement; `original.name` is the old
// name for RENAME and the target for the other alters.
export type ColumnAlter = {
  original: InspectColumn
  name?: string
  dataType?: string
  nullable?: boolean
  default?: string | null
  comment?: string | null
}

// Builds the ALTER/COMMENT/RENAME statements for staged column edits, one per
// changed property. Engines with supportsColumnAlter get the full set; the rest
// only RENAME COLUMN. Statements that keep a column's name run first
// (referencing the original name); RENAME runs last so every prior statement
// targets a name that still exists.
export function buildColumnAlter(table: TableRef, edits: ColumnAlter[], engine: Engine): string[] {
  const dialect = dialectFor(engine)
  const qualified = quoteQualified(table, dialect)
  const alters: string[] = []
  const renames: string[] = []
  for (const edit of edits) {
    const col = dialect.quoteIdent(edit.original.name)
    if (dialect.supportsColumnAlter) {
      if (edit.dataType !== undefined && edit.dataType !== edit.original.dataType) {
        alters.push(`ALTER TABLE ${qualified} ALTER COLUMN ${col} TYPE ${edit.dataType}`)
      }
      if (edit.nullable !== undefined && edit.nullable !== edit.original.nullable) {
        alters.push(`ALTER TABLE ${qualified} ALTER COLUMN ${col} ${edit.nullable ? 'DROP NOT NULL' : 'SET NOT NULL'}`)
      }
      if (edit.default !== undefined) {
        const next = edit.default ?? ''
        const current = edit.original.default ?? ''
        if (next !== current) {
          alters.push(
            next === ''
              ? `ALTER TABLE ${qualified} ALTER COLUMN ${col} DROP DEFAULT`
              : `ALTER TABLE ${qualified} ALTER COLUMN ${col} SET DEFAULT ${next}`,
          )
        }
      }
      if (edit.comment !== undefined) {
        const next = edit.comment ?? ''
        const current = edit.original.comment ?? ''
        if (next !== current) {
          alters.push(`COMMENT ON COLUMN ${qualified}.${col} IS ${next === '' ? 'NULL' : quoteLiteral(next)}`)
        }
      }
    }
    if (edit.name !== undefined && edit.name !== edit.original.name) {
      renames.push(`ALTER TABLE ${qualified} RENAME COLUMN ${col} TO ${dialect.quoteIdent(edit.name)}`)
    }
  }
  return [...alters, ...renames]
}

export function buildDeleteRows(spec: DeleteRowsSpec): { sql: string; params: unknown[] } {
  if (spec.rows.length === 0) throw new Error('Cannot build a DELETE without rows')
  const dialect = dialectFor(spec.engine)
  const params: unknown[] = []
  const bind = (value: unknown) => {
    params.push(value)
    return dialect.placeholder(params.length)
  }
  const condition = (pks: RowKey) => {
    if (pks.length === 0) throw new Error('Cannot build a DELETE without a primary key')
    return pks.map((pk) => `${dialect.quoteIdent(pk.name)} = ${bind(pk.value)}`).join(' AND ')
  }
  const where = spec.rows.map((pks) => `(${condition(pks)})`).join(' OR ')
  return { sql: `DELETE FROM ${quoteQualified(spec.table, dialect)}\n WHERE ${where}`, params }
}
