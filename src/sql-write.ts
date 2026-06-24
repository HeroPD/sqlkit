import type { ColumnRef, Engine, TableRef } from './electron'
import { dialectFor, type Dialect } from './dialect'

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
  if (/bool/.test(type)) {
    const truthy = /^(t|true|1|yes|y)$/i.test(value)
    const falsy = /^(f|false|0|no|n)$/i.test(value)
    // SQLite has no boolean type and rejects a JS boolean bind, so store 1/0;
    // Postgres takes the real boolean. An unrecognized token falls through to text.
    if (truthy || falsy) return engine === 'sqlite' ? (truthy ? 1 : 0) : truthy
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
