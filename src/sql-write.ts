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

// MySQL compares an int column to a quoted string literal as doubles, colliding
// BIGINTs past 2^53; a bigint param renders unquoted so the guard stays exact.
const exactGuardValue = (engine: Engine, key: { value: unknown; columnMeta?: ColumnRef }): unknown =>
  engine === 'mysql' && typeof key.value === 'string' && isIntegerType(key.columnMeta) && /^-?\d+$/.test(key.value)
    ? BigInt(key.value)
    : key.value

const isDecimalType = (column: ColumnRef | undefined) =>
  /^(?:decimal|numeric|dec|fixed)\b/.test(baseType(column))

// DECIMAL columns hit the same MySQL double-comparison trap as BIGINT above; the
// value's fraction length is the column scale (the server renders at scale).
const mysqlDecimalScale = (key: { value: unknown; columnMeta?: ColumnRef }): number | null => {
  if (!isDecimalType(key.columnMeta) || typeof key.value !== 'string') return null
  const match = /^-?\d+(?:\.(\d+))?$/.exec(key.value)
  return match ? Math.min(match[1]?.length ?? 0, 30) : null
}

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
  if (engine === 'mysql') {
    if (isTextType(key.columnMeta)) return `BINARY ${identifier} <=> BINARY ${parameter}`
    const scale = mysqlDecimalScale(key)
    return scale === null
      ? `${identifier} <=> ${parameter}`
      : `${identifier} <=> CAST(${parameter} AS DECIMAL(65,${scale}))`
  }
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

export type IndexSpec = {
  name: string
  columns: string[]
  unique: boolean
  /** PostgreSQL access method; empty or 'btree' emits no USING clause. */
  method?: string
}

export const PG_INDEX_METHODS = ['btree', 'hash', 'gin', 'gist', 'spgist', 'brin'] as const

// CREATE INDEX is the rare DDL all four engines spell alike apart from quoting.
export function buildCreateIndex(table: TableRef, spec: IndexSpec, engine: Engine): string {
  const dialect = dialectFor(engine)
  const name = spec.name.trim()
  if (!name) throw new Error('Index name is required')
  if (!spec.columns.length) throw new Error('An index needs at least one column')
  const method = spec.method?.trim() ?? ''
  if (method && !(PG_INDEX_METHODS as readonly string[]).includes(method)) throw new Error(`Unknown index method: ${method}`)
  const using = engine === 'postgresql' && method && method !== 'btree' ? ` USING ${method}` : ''
  const columns = spec.columns.map((column) => dialect.quoteIdent(column)).join(', ')
  return `CREATE ${spec.unique ? 'UNIQUE ' : ''}INDEX ${dialect.quoteIdent(name)} ON ${quoteQualified(table, dialect)}${using} (${columns})`
}

export type TriggerTiming = 'BEFORE' | 'AFTER' | 'INSTEAD OF'
export type TriggerEvent = 'INSERT' | 'UPDATE' | 'DELETE'

export type TriggerSpec = {
  name: string
  timing: TriggerTiming
  events: TriggerEvent[]
  level: 'ROW' | 'STATEMENT'
  /** PostgreSQL: existing trigger function to execute. */
  functionName?: string
  /** Other engines: inline trigger body statements. */
  body?: string
}

export type TriggerCaps = {
  timings: TriggerTiming[]
  multiEvent: boolean
  levels: TriggerSpec['level'][]
  usesFunction: boolean
}

// What the add-trigger dialog may offer per engine; buildCreateTrigger enforces it.
export function triggerCapabilities(engine: Engine): TriggerCaps {
  // The inspect add flow targets real tables. PostgreSQL and SQLite only allow
  // INSTEAD OF triggers on views, so offering it here produces invalid DDL.
  if (engine === 'postgresql') return { timings: ['BEFORE', 'AFTER'], multiEvent: true, levels: ['ROW', 'STATEMENT'], usesFunction: true }
  if (engine === 'mysql') return { timings: ['BEFORE', 'AFTER'], multiEvent: false, levels: ['ROW'], usesFunction: false }
  if (engine === 'sqlserver') return { timings: ['AFTER', 'INSTEAD OF'], multiEvent: true, levels: ['STATEMENT'], usesFunction: false }
  return { timings: ['BEFORE', 'AFTER'], multiEvent: false, levels: ['ROW'], usesFunction: false }
}

// Compound bodies need each inner statement terminated before END.
const terminated = (body: string) => {
  const trimmed = body.trim()
  return trimmed.endsWith(';') ? trimmed : `${trimmed};`
}

export function buildCreateTrigger(table: TableRef, spec: TriggerSpec, engine: Engine): string {
  const dialect = dialectFor(engine)
  const caps = triggerCapabilities(engine)
  const name = spec.name.trim()
  if (!name) throw new Error('Trigger name is required')
  if (!spec.events.length) throw new Error('A trigger needs at least one event')
  if (!caps.timings.includes(spec.timing)) throw new Error(`${spec.timing} triggers are not supported on this engine`)
  if (!caps.multiEvent && spec.events.length > 1) throw new Error('This engine allows one event per trigger')
  if (!caps.levels.includes(spec.level)) throw new Error(`FOR EACH ${spec.level} is not supported on this engine`)
  const qualified = quoteQualified(table, dialect)
  const events = spec.events.join(engine === 'sqlserver' ? ', ' : ' OR ')
  if (engine === 'postgresql') {
    const fn = spec.functionName?.trim() ?? ''
    if (!fn) throw new Error('A PostgreSQL trigger executes an existing function — name one')
    const call = fn.includes('(') ? fn : `${fn}()`
    return `CREATE TRIGGER ${dialect.quoteIdent(name)}\n${spec.timing} ${events} ON ${qualified}\nFOR EACH ${spec.level} EXECUTE FUNCTION ${call}`
  }
  const body = spec.body?.trim() ?? ''
  if (!body) throw new Error('Trigger body is required')
  if (engine === 'sqlserver') {
    return `CREATE TRIGGER ${dialect.quoteIdent(name)} ON ${qualified}\n${spec.timing} ${events}\nAS\nBEGIN\n${terminated(body)}\nEND`
  }
  // MySQL and SQLite share the shape; both are row-level with a compound body.
  return `CREATE TRIGGER ${dialect.quoteIdent(name)}\n${spec.timing} ${events} ON ${qualified}\nFOR EACH ROW\nBEGIN\n${terminated(body)}\nEND`
}

export type PartitionSpec = {
  name: string
  /** PG: `FOR VALUES …` tail or DEFAULT; MySQL: `VALUES LESS THAN (…)` / `VALUES IN (…)`. */
  bounds: string
}

// Adds one partition to an already-partitioned table (PG/MySQL only — the
// inspect UI offers this only when a Partitions section exists).
export function buildAddPartition(table: TableRef, spec: PartitionSpec, engine: Engine): string {
  const dialect = dialectFor(engine)
  const name = spec.name.trim()
  const bounds = spec.bounds.trim().replace(/^for\s+values\s+/i, '')
  if (!name) throw new Error('Partition name is required')
  if (engine === 'postgresql') {
    const child = quoteQualified({ schema: table.schema, name, kind: 'table' }, dialect)
    if (/^default$/i.test(bounds)) return `CREATE TABLE ${child} PARTITION OF ${quoteQualified(table, dialect)} DEFAULT`
    if (!bounds) throw new Error('Partition bounds are required (e.g. FROM (…) TO (…), IN (…), or DEFAULT)')
    return `CREATE TABLE ${child} PARTITION OF ${quoteQualified(table, dialect)} FOR VALUES ${bounds}`
  }
  if (engine === 'mysql') {
    if (!bounds) throw new Error('Partition bounds are required (e.g. VALUES LESS THAN (…))')
    return `ALTER TABLE ${quoteQualified(table, dialect)} ADD PARTITION (PARTITION ${dialect.quoteIdent(name)} ${bounds})`
  }
  throw new Error('Adding partitions is not supported on this engine')
}

// Adding FKs / CHECK / UNIQUE via ALTER works on the three server engines;
// SQLite's ALTER can't, so the inspect UI leaves those sections read-only there.
export const canAddConstraint = (engine: Engine): boolean => engine !== 'sqlite'

// Quotes a user-typed table reference that may be schema-qualified ("s.t" → "s"."t").
const quoteRef = (ref: string, dialect: Dialect): string =>
  ref.trim().split('.').map((part) => dialect.quoteIdent(part.trim())).join('.')

export type ForeignKeyAction = 'NO ACTION' | 'RESTRICT' | 'CASCADE' | 'SET NULL' | 'SET DEFAULT'

// Referential actions each engine accepts (MySQL rejects SET DEFAULT; MSSQL has
// no RESTRICT keyword). NO ACTION is the SQL default and always valid.
export function foreignKeyActions(engine: Engine): ForeignKeyAction[] {
  if (engine === 'mysql') return ['NO ACTION', 'RESTRICT', 'CASCADE', 'SET NULL']
  if (engine === 'sqlserver') return ['NO ACTION', 'CASCADE', 'SET NULL', 'SET DEFAULT']
  return ['NO ACTION', 'RESTRICT', 'CASCADE', 'SET NULL', 'SET DEFAULT']
}

export type ForeignKeySpec = {
  name: string
  columns: string[]
  refTable: string
  refColumns: string[]
  onDelete?: ForeignKeyAction
  onUpdate?: ForeignKeyAction
}

export function buildAddForeignKey(table: TableRef, spec: ForeignKeySpec, engine: Engine): string {
  if (!canAddConstraint(engine)) throw new Error('SQLite cannot add a foreign key to an existing table — recreate the table instead')
  const dialect = dialectFor(engine)
  const name = spec.name.trim()
  const refTable = spec.refTable.trim()
  if (!name) throw new Error('Constraint name is required')
  if (!spec.columns.length) throw new Error('A foreign key needs at least one column')
  if (!refTable) throw new Error('A referenced table is required')
  if (!spec.refColumns.length) throw new Error('At least one referenced column is required')
  if (spec.columns.length !== spec.refColumns.length) throw new Error('Local and referenced columns must match in count')
  const cols = spec.columns.map((column) => dialect.quoteIdent(column)).join(', ')
  const refCols = spec.refColumns.map((column) => dialect.quoteIdent(column.trim())).join(', ')
  const actions = foreignKeyActions(engine)
  const clause = (keyword: string, action: ForeignKeyAction | undefined) =>
    action && action !== 'NO ACTION' && actions.includes(action) ? ` ${keyword} ${action}` : ''
  return `ALTER TABLE ${quoteQualified(table, dialect)} ADD CONSTRAINT ${dialect.quoteIdent(name)} ` +
    `FOREIGN KEY (${cols}) REFERENCES ${quoteRef(refTable, dialect)} (${refCols})` +
    clause('ON DELETE', spec.onDelete) + clause('ON UPDATE', spec.onUpdate)
}

export type ConstraintSpec = {
  name: string
  type: 'CHECK' | 'UNIQUE'
  /** CHECK expression, or comma-column list for UNIQUE (via `columns`). */
  expression?: string
  columns?: string[]
}

export function buildAddConstraint(table: TableRef, spec: ConstraintSpec, engine: Engine): string {
  if (!canAddConstraint(engine)) throw new Error('SQLite cannot add this constraint to an existing table — recreate the table, or use a unique index')
  const dialect = dialectFor(engine)
  const name = spec.name.trim()
  if (!name) throw new Error('Constraint name is required')
  const head = `ALTER TABLE ${quoteQualified(table, dialect)} ADD CONSTRAINT ${dialect.quoteIdent(name)}`
  if (spec.type === 'CHECK') {
    const expression = spec.expression?.trim() ?? ''
    if (!expression) throw new Error('A CHECK constraint needs a boolean expression')
    return `${head} CHECK (${expression})`
  }
  if (!spec.columns?.length) throw new Error('A UNIQUE constraint needs at least one column')
  return `${head} UNIQUE (${spec.columns.map((column) => dialect.quoteIdent(column)).join(', ')})`
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
  const renamePairs: Array<{ from: string; to: string }> = []
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
      renamePairs.push({ from: edit.original.name, to: edit.name })
    }
  }
  // Renames run after the value alters (which reference the original names), and
  // in a collision-safe order so a swap/cycle (a→b, b→a) doesn't fail because the
  // target name is still occupied when its rename executes.
  const renames = orderColumnRenames(renamePairs).map(({ from, to }) =>
    engine === 'sqlserver'
      ? spRename(table, from, to)
      : `ALTER TABLE ${qualified} RENAME COLUMN ${dialect.quoteIdent(from)} TO ${dialect.quoteIdent(to)}`,
  )
  return [...alters, ...renames]
}

// Orders column renames so none transiently collides: a rename runs only after
// the column currently holding its target name has itself been renamed away. A
// true cycle (a↔b) is broken by first moving one column to a temporary name, so
// swapping two column names in one save works instead of erroring at the server.
function orderColumnRenames(pairs: Array<{ from: string; to: string }>): Array<{ from: string; to: string }> {
  const names = new Set(pairs.flatMap((pair) => [pair.from, pair.to]))
  const tempFor = (seed: string) => {
    let candidate = `${seed}_sqlkit_tmp`
    for (let n = 2; names.has(candidate); n += 1) candidate = `${seed}_sqlkit_tmp_${n}`
    names.add(candidate)
    return candidate
  }
  const pending = pairs.map((pair) => ({ ...pair }))
  const ordered: Array<{ from: string; to: string }> = []
  while (pending.length) {
    // Ready = no other pending rename still occupies this one's target name.
    const ready = pending.findIndex((pair) => !pending.some((other) => other !== pair && other.from === pair.to))
    if (ready >= 0) {
      ordered.push(pending.splice(ready, 1)[0]!)
      continue
    }
    // All remaining are blocked → a cycle: move one column to a temp name now and
    // finish its rename (temp → target) once the cycle has cleared.
    const blocked = pending[0]!
    const temp = tempFor(blocked.from)
    ordered.push({ from: blocked.from, to: temp })
    blocked.from = temp
  }
  return ordered
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
