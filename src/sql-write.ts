import type { ColumnRef, Engine, TableRef } from './electron'

export const quoteIdent = (identifier: string) => `"${identifier.replaceAll('"', '""')}"`

export const quoteQualified = (table: TableRef) =>
  table.schema ? `${quoteIdent(table.schema)}.${quoteIdent(table.name)}` : quoteIdent(table.name)

// Turns a cell's string input into a bound parameter, guided by the column's
// declared type: empty + nullable → NULL; numeric/boolean parsed; anything else
// passed as text for the engine to cast. Unparseable input falls back to text
// so a typo surfaces as a DB error rather than a silent wrong value.
export function coerceValue(value: string, column: ColumnRef | undefined, dialect?: Engine): unknown {
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
    if (truthy || falsy) return dialect === 'sqlite' ? (truthy ? 1 : 0) : truthy
  }
  return value
}

export type UpdateSpec = {
  table: TableRef
  column: string
  columnMeta: ColumnRef | undefined
  /** Raw string from the cell editor; coerced per columnMeta. */
  value: string
  /** Primary-key column/value pairs identifying the one row to update. */
  pks: { name: string; value: unknown }[]
  dialect: Engine
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
  dialect: Engine
}

export type RowKey = { name: string; value: unknown }[]

export type DeleteRowsSpec = {
  table: TableRef
  rows: RowKey[]
  dialect: Engine
}

// Builds a single-row parameterized UPDATE. Placeholders are $1.. for Postgres,
// ? otherwise (SQLite). Params are [newValue, ...pkValues] in placeholder order.
export function buildUpdate(spec: UpdateSpec): { sql: string; params: unknown[] } {
  if (spec.pks.length === 0) throw new Error('Cannot build an UPDATE without a primary key')
  const placeholder = (index: number) => (spec.dialect === 'postgresql' ? `$${index}` : '?')
  const where = spec.pks.map((pk, i) => `${quoteIdent(pk.name)} = ${placeholder(i + 2)}`).join(' AND ')
  const sql = `UPDATE ${quoteQualified(spec.table)}\n   SET ${quoteIdent(spec.column)} = ${placeholder(1)}\n WHERE ${where}`
  return { sql, params: [coerceValue(spec.value, spec.columnMeta, spec.dialect), ...spec.pks.map((pk) => pk.value)] }
}

// Builds one atomic UPDATE for multiple cells. Each target column gets a CASE
// expression keyed by the row's primary key; rows/columns outside the selection
// keep their existing values.
export function buildBatchUpdate(spec: BatchUpdateSpec): { sql: string; params: unknown[] } {
  if (spec.edits.length === 0) throw new Error('Cannot build an UPDATE without edits')

  const params: unknown[] = []
  const bind = (value: unknown) => {
    params.push(value)
    return spec.dialect === 'postgresql' ? `$${params.length}` : '?'
  }
  const condition = (pks: { name: string; value: unknown }[]) => {
    if (pks.length === 0) throw new Error('Cannot build an UPDATE without a primary key')
    return pks.map((pk) => `${quoteIdent(pk.name)} = ${bind(pk.value)}`).join(' AND ')
  }

  const byColumn = new Map<string, string[]>()
  for (const edit of spec.edits) {
    const cases = byColumn.get(edit.column) ?? []
    cases.push(`WHEN ${condition(edit.pks)} THEN ${bind(coerceValue(edit.value, edit.columnMeta, spec.dialect))}`)
    byColumn.set(edit.column, cases)
  }

  const set = [...byColumn.entries()]
    .map(([column, cases]) => `       ${quoteIdent(column)} = CASE\n         ${cases.join('\n         ')}\n         ELSE ${quoteIdent(column)}\n       END`)
    .join(',\n')
  const where = spec.edits.map((edit) => `(${condition(edit.pks)})`).join(' OR ')

  return { sql: `UPDATE ${quoteQualified(spec.table)}\n   SET\n${set}\n WHERE ${where}`, params }
}

export function buildInsertDefault(table: TableRef): { sql: string; params: unknown[] } {
  return { sql: `INSERT INTO ${quoteQualified(table)} DEFAULT VALUES`, params: [] }
}

export type InsertSpec = {
  table: TableRef
  /** Only the columns the user filled in; untouched columns are omitted so the
   * table's own DEFAULT applies — the one portable way to express defaults
   * (SQLite rejects the DEFAULT keyword inside a VALUES list). */
  columns: { name: string; columnMeta: ColumnRef | undefined }[]
  /** Raw cell strings aligned to `columns`, coerced per column. */
  values: string[]
  dialect: Engine
}

// One parameterized single-row INSERT. With no filled columns it falls back to
// DEFAULT VALUES. Kept single-statement so params bind on both engines (SQLite
// only binds params for a lone statement; Postgres params are extended-protocol).
export function buildInsert(spec: InsertSpec): { sql: string; params: unknown[] } {
  if (spec.columns.length === 0) return buildInsertDefault(spec.table)
  const placeholder = (index: number) => (spec.dialect === 'postgresql' ? `$${index}` : '?')
  const columns = spec.columns.map((column) => quoteIdent(column.name)).join(', ')
  const placeholders = spec.columns.map((_, index) => placeholder(index + 1)).join(', ')
  const params = spec.columns.map((column, index) => coerceValue(spec.values[index] ?? '', column.columnMeta, spec.dialect))
  return { sql: `INSERT INTO ${quoteQualified(spec.table)} (${columns})\nVALUES (${placeholders})`, params }
}

export function buildDeleteRows(spec: DeleteRowsSpec): { sql: string; params: unknown[] } {
  if (spec.rows.length === 0) throw new Error('Cannot build a DELETE without rows')
  const params: unknown[] = []
  const bind = (value: unknown) => {
    params.push(value)
    return spec.dialect === 'postgresql' ? `$${params.length}` : '?'
  }
  const condition = (pks: RowKey) => {
    if (pks.length === 0) throw new Error('Cannot build a DELETE without a primary key')
    return pks.map((pk) => `${quoteIdent(pk.name)} = ${bind(pk.value)}`).join(' AND ')
  }
  const where = spec.rows.map((pks) => `(${condition(pks)})`).join(' OR ')
  return { sql: `DELETE FROM ${quoteQualified(spec.table)}\n WHERE ${where}`, params }
}
