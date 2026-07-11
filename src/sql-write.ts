import type { ColumnRef, Engine, InspectColumn, TableRef } from './electron'
import { dialectFor, type Dialect } from './dialect'

// A single-quoted SQL string literal (doubling embedded quotes). Column DDL runs
// param-free, so the review preview is exactly what executes.
export const quoteLiteral = (value: string) => `'${value.replaceAll("'", "''")}'`

export const quoteQualified = (table: TableRef, dialect: Dialect) =>
  table.schema ? `${dialect.quoteIdent(table.schema)}.${dialect.quoteIdent(table.name)}` : dialect.quoteIdent(table.name)

// Explicit SQL NULL as editor state. Distinct from '' so clearing a text cell
// and setting NULL are different, user-visible actions.
export type SqlNull = { readonly kind: 'sql-null' }
export type CellInput = string | SqlNull
export const SQL_NULL: SqlNull = Object.freeze({ kind: 'sql-null' })
export const isSqlNull = (value: unknown): value is SqlNull =>
  typeof value === 'object' && value !== null && (value as { kind?: unknown }).kind === 'sql-null'

// Turns an explicit editor value into a bound parameter, guided by the column's
// declared type: numeric/boolean parsed when lossless; anything else passed as
// text for the engine to cast. Unparseable input falls back to text so a typo
// surfaces as a DB error rather than a silent wrong value.
export function coerceValue(value: CellInput, column: ColumnRef | undefined, engine?: Engine): unknown {
  if (isSqlNull(value)) return null
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
  /** Raw editor value from the edit prompt; coerced per target column. */
  value: CellInput
  /** Value that was displayed when the edit was staged, for optimistic concurrency. */
  originalValue?: unknown
  /** Primary-key column/value pairs identifying the row to update. */
  pks: RowKey
}

export type BatchUpdateSpec = {
  table: TableRef
  edits: BatchUpdateEdit[]
  engine: Engine
}

export type RowKey = { name: string; value: unknown; columnMeta?: ColumnRef }[]

export type DeleteRowsSpec = {
  table: TableRef
  rows: RowKey[]
  engine: Engine
}

const baseType = (column: ColumnRef | undefined) => column?.dataType.toLowerCase().match(/^[\w ]+/)?.[0]?.trim() ?? ''

// Types an optimistic guard can't compare with equality on this engine —
// rejected before the save preview rather than failing inside the transaction.
export function supportsOptimisticComparison(engine: Engine, column: ColumnRef | undefined): boolean {
  const type = baseType(column)
  if (engine === 'postgresql') return type !== 'json' && type !== 'xml'
  if (engine === 'sqlserver') return !['text', 'ntext', 'image', 'xml', 'geography', 'geometry', 'hierarchyid'].includes(type)
  return true
}

const isTextType = (column: ColumnRef | undefined) =>
  /^(?:n?varchar|n?char|text|tinytext|mediumtext|longtext|citext)/.test(baseType(column))

const isIntegerType = (column: ColumnRef | undefined) =>
  /^(?:big|medium|small|tiny)?int(?:eger)?\b/.test(baseType(column))

// mysql2 interpolates string params as quoted literals, and MySQL compares an
// integer column against a string constant as doubles — so adjacent BIGINTs past
// 2^53 collide. A bigint param renders unquoted, keeping the comparison exact.
const exactGuardValue = (engine: Engine, key: { value: unknown; columnMeta?: ColumnRef }): unknown =>
  engine === 'mysql' && typeof key.value === 'string' && isIntegerType(key.columnMeta) && /^-?\d+$/.test(key.value)
    ? BigInt(key.value)
    : key.value

// A null-safe, case-exact equality predicate per engine. Plain `col = ?` misses
// case-only concurrent changes under case-insensitive collations and never
// matches NULL, so guards built from displayed values would silently pass or fail.
const comparisonPredicate = (
  engine: Engine,
  dialect: Dialect,
  key: { name: string; value: unknown; columnMeta?: ColumnRef },
  bind: (value: unknown) => string,
) => {
  const identifier = dialect.quoteIdent(key.name)
  if (key.value === null || key.value === undefined) return `${identifier} IS NULL`
  if (!supportsOptimisticComparison(engine, key.columnMeta)) {
    throw new Error(`Column ${key.name} (${key.columnMeta?.dataType ?? 'unknown type'}) cannot be compared safely for an optimistic write.`)
  }
  const parameter = bind(exactGuardValue(engine, key))
  if (engine === 'postgresql') return `${identifier} IS NOT DISTINCT FROM ${parameter}`
  if (engine === 'mysql') return isTextType(key.columnMeta)
    ? `BINARY ${identifier} <=> BINARY ${parameter}`
    : `${identifier} <=> ${parameter}`
  if (engine === 'sqlite') return `${identifier} COLLATE BINARY IS ${parameter}`
  if (isTextType(key.columnMeta)) {
    return `${identifier} COLLATE Latin1_General_100_BIN2 = ${parameter} COLLATE Latin1_General_100_BIN2`
  }
  return `${identifier} = ${parameter}`
}

// Builds one atomic UPDATE for multiple cells. Each target column gets a CASE
// expression keyed by the row's primary key; rows/columns outside the selection
// keep their existing values. Quoting and placeholder style come from the
// engine's dialect, so backtick/bracket engines stay correct.
export function buildBatchUpdate(spec: BatchUpdateSpec): { sql: string; params: unknown[]; expectedRows: number } {
  if (spec.edits.length === 0) throw new Error('Cannot build an UPDATE without edits')
  const dialect = dialectFor(spec.engine)

  const params: unknown[] = []
  const bind = (value: unknown) => {
    params.push(value)
    return dialect.placeholder(params.length)
  }
  const keyCondition = (pks: RowKey) => {
    if (pks.length === 0) throw new Error('Cannot build an UPDATE without a primary key')
    return pks.map((pk) => comparisonPredicate(spec.engine, dialect, pk, bind)).join(' AND ')
  }

  const keyValue = (value: unknown) => {
    if (typeof value === 'bigint') return `bigint:${value.toString()}`
    if (value instanceof Uint8Array) return `bytes:${Array.from(value).join(',')}`
    try {
      return `${typeof value}:${JSON.stringify(value)}`
    } catch {
      throw new Error('Cannot build an UPDATE for an unserializable primary key value')
    }
  }
  const rowKey = (edit: BatchUpdateEdit) => JSON.stringify(edit.pks.map((pk) => [pk.name, keyValue(pk.value)]))
  const byRow = new Map<string, BatchUpdateEdit[]>()
  for (const edit of spec.edits) byRow.set(rowKey(edit), [...(byRow.get(rowKey(edit)) ?? []), edit])
  const rowCondition = (edits: BatchUpdateEdit[]) => {
    const predicates = [keyCondition(edits[0]!.pks)]
    const seen = new Set<string>()
    for (const edit of edits) {
      if (!('originalValue' in edit) || seen.has(edit.column)) continue
      seen.add(edit.column)
      predicates.push(comparisonPredicate(spec.engine, dialect, {
        name: edit.column,
        value: edit.originalValue,
        columnMeta: edit.columnMeta,
      }, bind))
    }
    return predicates.join(' AND ')
  }

  const byColumn = new Map<string, string[]>()
  for (const edit of spec.edits) {
    const cases = byColumn.get(edit.column) ?? []
    cases.push(`WHEN ${rowCondition(byRow.get(rowKey(edit))!)} THEN ${bind(coerceValue(edit.value, edit.columnMeta, spec.engine))}`)
    byColumn.set(edit.column, cases)
  }

  const set = [...byColumn.entries()]
    .map(([column, cases]) => `       ${dialect.quoteIdent(column)} = CASE\n         ${cases.join('\n         ')}\n         ELSE ${dialect.quoteIdent(column)}\n       END`)
    .join(',\n')
  const where = [...byRow.values()].map((edits) => `(${rowCondition(edits)})`).join(' OR ')
  const uniqueRows = byRow.size

  return { sql: `UPDATE ${quoteQualified(spec.table, dialect)}\n   SET\n${set}\n WHERE ${where}`, params, expectedRows: uniqueRows }
}

const parameterLimit = (engine: Engine) => engine === 'sqlserver' ? 2_000 : engine === 'sqlite' ? 900 : 60_000

const comparableKey = (value: unknown): string => {
  if (typeof value === 'bigint') return `bigint:${value.toString()}`
  if (value instanceof Uint8Array) return `bytes:${Array.from(value).join(',')}`
  try {
    return `${typeof value}:${JSON.stringify(value)}`
  } catch {
    throw new Error('Cannot group an unserializable row key')
  }
}

/** Splits a large staged update at row boundaries so no statement exceeds the
 * backend's bind-parameter ceiling. The driver still executes every statement
 * in one transaction, preserving all-or-nothing save semantics. */
export function buildBatchUpdates(spec: BatchUpdateSpec): Array<ReturnType<typeof buildBatchUpdate>> {
  const groups = new Map<string, BatchUpdateEdit[]>()
  for (const edit of spec.edits) {
    const key = JSON.stringify(edit.pks.map((pk) => [pk.name, comparableKey(pk.value)]))
    groups.set(key, [...(groups.get(key) ?? []), edit])
  }
  const result: Array<ReturnType<typeof buildBatchUpdate>> = []
  let pending: BatchUpdateEdit[] = []
  for (const group of groups.values()) {
    const candidate = buildBatchUpdate({ ...spec, edits: [...pending, ...group] })
    if (candidate.params.length <= parameterLimit(spec.engine)) {
      pending.push(...group)
      continue
    }
    if (!pending.length) throw new Error('One edited row requires more bind parameters than this database supports.')
    result.push(buildBatchUpdate({ ...spec, edits: pending }))
    pending = [...group]
    if (buildBatchUpdate({ ...spec, edits: pending }).params.length > parameterLimit(spec.engine)) {
      throw new Error('One edited row requires more bind parameters than this database supports.')
    }
  }
  if (pending.length) result.push(buildBatchUpdate({ ...spec, edits: pending }))
  return result
}

export function buildInsertDefault(table: TableRef, dialect: Dialect): { sql: string; params: unknown[]; expectedRows: number } {
  // MySQL/MariaDB have no DEFAULT VALUES clause; the empty column/value lists are their spelling.
  const allDefaults = dialect.engine === 'mysql' ? '() VALUES ()' : 'DEFAULT VALUES'
  return { sql: `INSERT INTO ${quoteQualified(table, dialect)} ${allDefaults}`, params: [], expectedRows: 1 }
}

export type InsertSpec = {
  table: TableRef
  /** Only the columns the user filled in; untouched columns are omitted so the
   * table's own DEFAULT applies — the one portable way to express defaults
   * (SQLite rejects the DEFAULT keyword inside a VALUES list). */
  columns: { name: string; columnMeta: ColumnRef | undefined }[]
  /** Raw editor values aligned to `columns`, coerced per column. */
  values: CellInput[]
  engine: Engine
}

// One parameterized single-row INSERT. With no filled columns it falls back to
// DEFAULT VALUES. Kept single-statement so params bind on both engines (SQLite
// only binds params for a lone statement; Postgres params are extended-protocol).
export function buildInsert(spec: InsertSpec): { sql: string; params: unknown[]; expectedRows: number } {
  const dialect = dialectFor(spec.engine)
  if (spec.columns.length === 0) return buildInsertDefault(spec.table, dialect)
  const columns = spec.columns.map((column) => dialect.quoteIdent(column.name)).join(', ')
  const placeholders = spec.columns.map((_, index) => dialect.placeholder(index + 1)).join(', ')
  const params = spec.columns.map((column, index) => coerceValue(spec.values[index] ?? '', column.columnMeta, spec.engine))
  return { sql: `INSERT INTO ${quoteQualified(spec.table, dialect)} (${columns})\nVALUES (${placeholders})`, params, expectedRows: 1 }
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

// A brand-new column staged in the Inspect tab (no `original` to diff against).
export type ColumnAdd = {
  name: string
  dataType: string
  nullable: boolean
  default: string | null
  comment: string | null
}

// Builds the ADD statements for staged new columns (T-SQL has no COLUMN keyword).
// Comments ride inline on MySQL, as COMMENT ON on Postgres. A column with a
// blank name or type is skipped — the row is still a placeholder.
export function buildColumnAdd(table: TableRef, additions: ColumnAdd[], engine: Engine): string[] {
  const dialect = dialectFor(engine)
  const qualified = quoteQualified(table, dialect)
  const statements: string[] = []
  for (const add of additions) {
    if (!add.name.trim() || !add.dataType.trim()) continue
    const col = dialect.quoteIdent(add.name.trim())
    let sql = `ALTER TABLE ${qualified} ADD${engine === 'sqlserver' ? '' : ' COLUMN'} ${col} ${add.dataType.trim()}`
    if (add.default !== null && add.default !== '') sql += ` DEFAULT ${add.default}`
    if (!add.nullable) sql += ' NOT NULL'
    const comment = add.comment !== null && add.comment !== '' && dialect.supportsColumnComments ? add.comment : null
    if (comment !== null && engine === 'mysql') sql += ` COMMENT ${quoteLiteral(comment)}`
    statements.push(sql)
    if (comment !== null && engine === 'postgresql') {
      statements.push(`COMMENT ON COLUMN ${qualified}.${col} IS ${quoteLiteral(comment)}`)
    }
  }
  return statements
}

// One DROP COLUMN per staged drop — the one column alter every engine spells alike.
export function buildColumnDrop(table: TableRef, columns: string[], engine: Engine): string[] {
  const dialect = dialectFor(engine)
  const qualified = quoteQualified(table, dialect)
  return columns.map((name) => `ALTER TABLE ${qualified} DROP COLUMN ${dialect.quoteIdent(name)}`)
}

// sp_rename takes the column path as one literal; parts are bracket-quoted so
// dotted/odd names survive, while the new name must stay bare (unquoted).
function spRename(table: TableRef, from: string, to: string): string {
  const dialect = dialectFor('sqlserver')
  const path = [...(table.schema ? [table.schema] : []), table.name, from].map((part) => dialect.quoteIdent(part)).join('.')
  return `EXEC sp_rename N${quoteLiteral(path)}, N${quoteLiteral(to)}, 'COLUMN'`
}

// Builds the ALTER/COMMENT/RENAME statements for staged column edits, gated per
// field by the dialect's columnEdits. Statements that keep a column's name run
// first (referencing the original name); RENAME runs last so every prior
// statement targets a name that still exists.
export function buildColumnAlter(table: TableRef, edits: ColumnAlter[], engine: Engine): string[] {
  const dialect = dialectFor(engine)
  const caps = dialect.columnEdits
  const qualified = quoteQualified(table, dialect)
  const alters: string[] = []
  const renames: string[] = []
  for (const edit of edits) {
    const col = dialect.quoteIdent(edit.original.name)
    const dataType = caps.dataType && edit.dataType !== undefined && edit.dataType !== edit.original.dataType ? edit.dataType : undefined
    const nullable = caps.nullable && edit.nullable !== undefined && edit.nullable !== edit.original.nullable ? edit.nullable : undefined
    if (edit.original.generated && (dataType !== undefined || nullable !== undefined)) {
      throw new Error(`Cannot alter the type or nullability of generated column ${edit.original.name}`)
    }
    if (engine === 'sqlserver') {
      // T-SQL restates the full definition in one ALTER COLUMN; a custom collation
      // must be restated too or the server resets it to the database default.
      if (dataType !== undefined || nullable !== undefined) {
        const type = dataType ?? edit.original.dataType
        const collate = edit.original.collation && /char|text/i.test(type) ? ` COLLATE ${edit.original.collation}` : ''
        alters.push(
          `ALTER TABLE ${qualified} ALTER COLUMN ${col} ${type}${collate} ${(nullable ?? edit.original.nullable) ? 'NULL' : 'NOT NULL'}`,
        )
      }
    } else {
      if (dataType !== undefined) alters.push(`ALTER TABLE ${qualified} ALTER COLUMN ${col} TYPE ${dataType}`)
      if (nullable !== undefined) {
        alters.push(`ALTER TABLE ${qualified} ALTER COLUMN ${col} ${nullable ? 'DROP NOT NULL' : 'SET NOT NULL'}`)
      }
    }
    if (caps.default && edit.default !== undefined) {
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
    if (caps.comment && edit.comment !== undefined) {
      const next = edit.comment ?? ''
      const current = edit.original.comment ?? ''
      if (next !== current) {
        alters.push(`COMMENT ON COLUMN ${qualified}.${col} IS ${next === '' ? 'NULL' : quoteLiteral(next)}`)
      }
    }
    if (caps.rename && edit.name !== undefined && edit.name !== edit.original.name) {
      renames.push(
        engine === 'sqlserver'
          ? spRename(table, edit.original.name, edit.name)
          : `ALTER TABLE ${qualified} RENAME COLUMN ${col} TO ${dialect.quoteIdent(edit.name)}`,
      )
    }
  }
  return [...alters, ...renames]
}

export function buildDeleteRows(spec: DeleteRowsSpec): { sql: string; params: unknown[]; expectedRows: number } {
  if (spec.rows.length === 0) throw new Error('Cannot build a DELETE without rows')
  const dialect = dialectFor(spec.engine)
  const params: unknown[] = []
  const bind = (value: unknown) => {
    params.push(value)
    return dialect.placeholder(params.length)
  }
  const condition = (pks: RowKey) => {
    if (pks.length === 0) throw new Error('Cannot build a DELETE without a primary key')
    return pks.map((pk) => comparisonPredicate(spec.engine, dialect, pk, bind)).join(' AND ')
  }
  const where = spec.rows.map((pks) => `(${condition(pks)})`).join(' OR ')
  return { sql: `DELETE FROM ${quoteQualified(spec.table, dialect)}\n WHERE ${where}`, params, expectedRows: spec.rows.length }
}

export function buildDeleteRowBatches(spec: DeleteRowsSpec): Array<ReturnType<typeof buildDeleteRows>> {
  const result: Array<ReturnType<typeof buildDeleteRows>> = []
  let pending: RowKey[] = []
  for (const row of spec.rows) {
    const candidate = buildDeleteRows({ ...spec, rows: [...pending, row] })
    if (candidate.params.length <= parameterLimit(spec.engine)) {
      pending.push(row)
      continue
    }
    if (!pending.length) throw new Error('One deleted row requires more bind parameters than this database supports.')
    result.push(buildDeleteRows({ ...spec, rows: pending }))
    pending = [row]
  }
  if (pending.length) result.push(buildDeleteRows({ ...spec, rows: pending }))
  return result
}
