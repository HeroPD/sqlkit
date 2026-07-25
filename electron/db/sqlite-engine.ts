import { DatabaseSync, type StatementSync } from 'node:sqlite'
import { closeSync, openSync, writeSync } from 'node:fs'
import type { BatchResult, ColumnRef, DdlResult, InspectSection, QueryResult, QueryResultSet, TableInspection, TableRef } from '../../src/electron'
import { createExportSerializer, type ExportFormat } from '../../src/result-export'
import { t } from '../../src/i18n'
import { BATCH_ZERO_ROWS, boundedRow, MAX_BUFFERED_ROWS } from './limits'
import { columnReference } from './column-reference'
import { assertSelfContainedTransaction, containsSqliteTrigger } from './sql-script'

// The synchronous SQLite core, factored out of any process/threading concern:
// every function takes the DatabaseSync it operates on. The worker owns the
// handle and calls these; tests call them against an in-memory database
// directly. node:sqlite is built into Electron's Node, so there's no native
// addon to rebuild against Electron's ABI.

export type SqliteParam = string | number | bigint | null | Uint8Array

export const openDatabase = (file: string): DatabaseSync => new DatabaseSync(file, { readBigInts: true })

export const serverVersion = (db: DatabaseSync): string => {
  const row = db.prepare('select sqlite_version() as version').get() as { version: string }
  return `SQLite ${row.version}`
}

// A statement that SQLite refuses to run inside a transaction, so the
// multi-statement wrapper must not enclose a script containing one. Matches a
// leading VACUUM or PRAGMA past any whitespace/comments.
const TXN_INCOMPATIBLE = /^(?:\s|--[^\n]*|\/\*[\s\S]*?\*\/)*(?:vacuum|pragma)\b/i

export function queryDatabase(db: DatabaseSync, sql: string, params: SqliteParam[] = []): QueryResult {
  const managesOwnTransaction = assertSelfContainedTransaction(sql, 'sqlite')
  const started = performance.now()
  const stamp = (result: Omit<QueryResult, 'durationMs'>): QueryResult => ({ ...result, durationMs: performance.now() - started })

  const masked = maskSqlite(sql)
  const statements = splitStatements(sql, masked)
  const budget = { bytes: 0 }

  if (statements.length === 0) return stamp({ columns: [], rows: [], rowCount: 0 })

  // Single statement (the run-at-caret case): prepare and run, binding params.
  if (statements.length === 1) return stamp(run(db.prepare(statements[0]!), params, budget))

  // SQLite treats unbound ? placeholders as NULL — running a parameterized
  // script statement-by-statement with no binds would silently write NULLs.
  if (params.length > 0) throw new Error(t('sqlite.singleStatementParams'))

  // CREATE TRIGGER bodies carry their own semicolons that a top-level split
  // would break, so let exec run the whole script authoritatively. exec returns
  // no rows; if the script ends with a read (a verification SELECT), re-run just
  // that statement to surface its result — safe because reads have no side
  // effects, so running it a second time can't change anything.
  if (containsSqliteTrigger(masked)) {
    db.exec(sql)
    const tail = statements[statements.length - 1]
    if (tail && /^(?:select|values|explain)\b/i.test(tail)) {
      try {
        return stamp(run(db.prepare(tail), [], budget))
      } catch {
        // Tail wasn't a runnable standalone statement; fall through to empty.
      }
    }
    return stamp({ columns: [], rows: [], rowCount: 0 })
  }

  // node:sqlite's prepare runs only the first statement, so run each in order
  // (preparing against the schema left by the previous one) and return the last
  // result — matching Postgres, where the final statement supplies the columns.
  // Params aren't bound to multi-statement runs. Wrap the run in one transaction
  // so a mid-script error rolls the whole thing back instead of half-applying —
  // the same all-or-nothing a multi-statement Postgres run gets. Skip the
  // wrapper when the script drives its own BEGIN/COMMIT (SQLite forbids a nested
  // BEGIN), or contains a statement that can't run inside a transaction (VACUUM,
  // and PRAGMAs like journal_mode) — those keep the old statement-by-statement
  // behavior instead of erroring under the wrapper. The tail result still surfaces.
  const resultSets: QueryResultSet[] = []
  const wrap = !managesOwnTransaction && !statements.some((statement) => TXN_INCOMPATIBLE.test(statement))
  if (wrap) db.exec('BEGIN')
  try {
    for (const statement of statements) resultSets.push(run(db.prepare(statement), [], budget))
    if (wrap) db.exec('COMMIT')
  } catch (error) {
    if (wrap) {
      try {
        db.exec('ROLLBACK')
      } catch {
        // The transaction may have auto-aborted already; nothing left to undo.
      }
    }
    throw error
  }
  const result = resultSets[resultSets.length - 1] ?? { columns: [], rows: [], rowCount: 0 }
  return stamp({ ...result, ...(resultSets.length > 1 ? { resultSets } : {}) })
}

// Streams a read-only query straight to `filePath` in the worker (off the main
// process), so a full result exports without the row/byte caps that the paged
// display path applies. The manager guarantees the SQL is read-only.
export function exportQuery(
  db: DatabaseSync,
  sql: string,
  params: SqliteParam[],
  filePath: string,
  format: ExportFormat,
): { rowCount: number } {
  const statements = splitStatements(sql, maskSqlite(sql))
  if (statements.length !== 1) throw new Error(t('export.singleStatement'))
  const statement = db.prepare(statements[0]!)
  const columns = statement.columns().map((column) => column.name)
  if (!columns.length) throw new Error(t('export.resultOnly'))
  const serializer = createExportSerializer(columns, format)
  statement.setReturnArrays(true)
  const fd = openSync(filePath, 'w')
  let rowCount = 0
  try {
    // Buffer to ~64 KB before each syncronous write to keep syscall count low.
    let buffer = serializer.header()
    for (const row of statement.iterate(...params) as unknown as Iterable<unknown[]>) {
      buffer += serializer.row(row)
      rowCount += 1
      if (buffer.length >= 65_536) {
        writeSync(fd, buffer)
        buffer = ''
      }
    }
    buffer += serializer.footer()
    if (buffer) writeSync(fd, buffer)
    return { rowCount }
  } finally {
    closeSync(fd)
  }
}

export function listTables(db: DatabaseSync): TableRef[] {
  const rows = db
    .prepare(
      "select name, type from sqlite_master where type in ('table', 'view') and name not like 'sqlite_%' order by name",
    )
    .all() as Array<{ name: string; type: string }>
  return rows.map((row): TableRef => ({ schema: null, name: row.name, kind: row.type === 'view' ? 'view' : 'table' }))
}

export function listColumns(db: DatabaseSync): ColumnRef[] {
  // pragma_table_info as a correlated table-valued function: one statement
  // covers every table without string-built pragmas.
  const rows = db
    .prepare(
      `select m.name as table_name, p.name as column_name, p.type as data_type,
              p."notnull" as not_null, p.pk as pk,
              exists (select 1 from pragma_foreign_key_list(m.name) f where f."from" = p.name) as fk
       from sqlite_master m
       join pragma_table_info(m.name) p
       where m.type in ('table', 'view') and m.name not like 'sqlite_%'
       order by m.name, p.cid`,
    )
    .all() as Array<{
    table_name: string
    column_name: string
    data_type: string
    not_null: number
    pk: number
    fk: number
  }>
  const targets = foreignKeyTargets(db)
  return rows.map((row): ColumnRef => {
    const target = targets.get(targetKey(row.table_name, row.column_name))
    return {
      schema: null,
      table: row.table_name,
      name: row.column_name,
      dataType: row.data_type || 'any',
      nullable: !row.not_null,
      primaryKey: row.pk > 0,
      foreignKey: row.fk > 0,
      ...columnReference(null, target?.table, target?.column, target?.constraint),
    }
  })
}

// NUL-separated, so a name containing the separator can't collide two different
// (table, column) pairs onto one key.
const targetKey = (table: string, column: string | number) => `${table}\0${column}`

// FK target per "table\0column", merged in JS rather than SQL: pragma_table_info
// has to be consulted for a *second* table (the referenced one) to resolve an
// implicit target, and nesting correlated pragmas inside a join is fragile.
//
// Two SQLite-specific quirks are handled here. `to` is NULL when the key targets
// the parent's primary key implicitly (REFERENCES parent without a column list),
// so it falls back to the parent's PK column at the matching key position —
// pragma_table_info.pk is 1-based within the PK and foreign_key_list.seq is
// 0-based within the key, so a composite implicit target still pairs correctly.
// And SQLite exposes no FK constraint names, only a per-table `id`; that id is
// synthesized into a label, which is all `constraint` is used for (grouping the
// columns of one composite key).
function foreignKeyTargets(db: DatabaseSync): Map<string, { table: string; column: string; constraint: string }> {
  const keys = db
    .prepare(
      `select m.name as table_name, f.id as id, f.seq as seq, f."table" as ref_table,
              f."from" as from_col, f."to" as to_col
       from sqlite_master m
       join pragma_foreign_key_list(m.name) f
       where m.type in ('table', 'view') and m.name not like 'sqlite_%'
       order by m.name, f.id, f.seq`,
    )
    // The handle is opened with readBigInts, so integer columns arrive as BigInt;
    // they are converted explicitly below rather than mixed into arithmetic.
    .all() as Array<{ table_name: string; id: bigint; seq: bigint; ref_table: string; from_col: string; to_col: string | null }>
  if (!keys.length) return new Map()

  // Primary-key columns of every table, keyed by "table\0pkPosition", for the
  // implicit-target fallback above.
  const primaryKeys = new Map<string, string>()
  const pkRows = db
    .prepare(
      `select m.name as table_name, p.name as column_name, p.pk as pk
       from sqlite_master m
       join pragma_table_info(m.name) p
       where m.type = 'table' and p.pk > 0`,
    )
    .all() as Array<{ table_name: string; column_name: string; pk: bigint }>
  for (const row of pkRows) primaryKeys.set(targetKey(row.table_name, Number(row.pk)), row.column_name)

  const targets = new Map<string, { table: string; column: string; constraint: string }>()
  for (const key of keys) {
    const mapKey = targetKey(key.table_name, key.from_col)
    // Rows arrive ordered by id, so the first entry for a column wins — the same
    // "lowest/first constraint" rule the server drivers apply.
    if (targets.has(mapKey)) continue
    const column = key.to_col ?? primaryKeys.get(targetKey(key.ref_table, Number(key.seq) + 1))
    // An unresolvable target (referenced table missing, or a rowid-only parent)
    // leaves the column a foreign key with nothing to navigate to.
    if (!column) continue
    targets.set(mapKey, { table: key.ref_table, column, constraint: `fk_${Number(key.id)}` })
  }
  return targets
}

export function inspectTable(db: DatabaseSync, table: TableRef): TableInspection {
  const columns = db.prepare(`select name, type, "notnull" as not_null, dflt_value, pk from pragma_table_info(?)`).all(table.name) as Array<{
    name: string
    type: string
    not_null: number
    dflt_value: string | null
    pk: number
  }>
  const foreignKeys = db
    .prepare(`select id, seq, "table" as ref_table, "from" as from_col, "to" as to_col, on_update, on_delete from pragma_foreign_key_list(?) order by id, seq`)
    .all(table.name) as Array<{
    id: number
    ref_table: string
    from_col: string
    to_col: string | null
    on_update: string
    on_delete: string
  }>
  const named = db
    .prepare(`select name, type, sql from sqlite_master where tbl_name = ? and type in ('index', 'trigger') order by type, name`)
    .all(table.name) as Array<{ name: string; type: string; sql: string | null }>

  // The primary key columns, ordered by their position in the key (pk is 0 when
  // the column isn't part of it). Shown read-only in the UI, like FKs.
  const pkColumns = columns.filter((row) => row.pk > 0).sort((a, b) => a.pk - b.pk).map((row) => row.name)

  const sections: InspectSection[] = [
    {
      title: 'Foreign Keys',
      rows: foreignKeys.map((fk) => ({
        name: fk.from_col,
        definition: `REFERENCES ${fk.ref_table}(${fk.to_col ?? 'rowid'}) ON UPDATE ${fk.on_update} ON DELETE ${fk.on_delete}`,
      })),
    },
    {
      title: 'Constraints',
      rows: pkColumns.length ? [{ name: 'PRIMARY KEY', definition: `PRIMARY KEY (${pkColumns.join(', ')})` }] : [],
    },
    {
      title: 'Indexes',
      // sql is null for the implicit indexes behind UNIQUE/PK constraints.
      rows: named
        .filter((row) => row.type === 'index')
        .map((row) => ({ name: row.name, definition: row.sql ?? '(auto: unique/primary key)' })),
    },
    {
      title: 'Triggers',
      rows: named.filter((row) => row.type === 'trigger').map((row) => ({ name: row.name, definition: row.sql ?? '' })),
    },
  ]
  return {
    columns: columns.map((row) => ({
      name: row.name,
      dataType: row.type || 'any',
      nullable: !row.not_null,
      default: row.dflt_value,
      primaryKey: row.pk > 0,
      foreignKey: foreignKeys.some((foreignKey) => foreignKey.from_col === row.name),
      // SQLite has no native column comments.
      comment: null,
    })),
    sections: sections.filter((section) => section.rows.length),
  }
}

// Blanks the contents of strings, quoted identifiers and comments (preserving
// length) so a `;` or keyword inside them isn't mistaken for a statement
// boundary. SQLite has no dollar-quoting; quoting forms are '' "" `` [].
function maskSqlite(sql: string): string {
  let out = ''
  let i = 0
  const blank = (from: number, to: number) => ' '.repeat(to - from)
  const scanQuote = (close: string, doubled: boolean) => {
    let j = i + 1
    while (j < sql.length) {
      if (doubled && sql[j] === close && sql[j + 1] === close) {
        j += 2
        continue
      }
      if (sql[j] === close) return j + 1
      j += 1
    }
    return sql.length
  }
  while (i < sql.length) {
    const ch = sql[i]
    let end: number
    if (ch === '-' && sql[i + 1] === '-') {
      const nl = sql.indexOf('\n', i + 2)
      end = nl < 0 ? sql.length : nl
    } else if (ch === '/' && sql[i + 1] === '*') {
      const close = sql.indexOf('*/', i + 2)
      end = close < 0 ? sql.length : close + 2
    } else if (ch === "'" || ch === '"' || ch === '`') {
      end = scanQuote(ch, true)
    } else if (ch === '[') {
      const close = sql.indexOf(']', i + 1)
      end = close < 0 ? sql.length : close + 1
    } else {
      out += ch
      i += 1
      continue
    }
    out += blank(i, end)
    i = end
  }
  return out
}

// Splits at top-level semicolons located in the masked copy, slicing the
// original. Trailing `;`, comments and whitespace yield no extra statement.
function splitStatements(sql: string, masked: string): string[] {
  const parts: string[] = []
  let start = 0
  for (let i = 0; i < masked.length; i += 1) {
    if (masked[i] !== ';') continue
    const piece = sql.slice(start, i).trim()
    if (masked.slice(start, i).trim()) parts.push(piece)
    start = i + 1
  }
  const tail = sql.slice(start).trim()
  if (masked.slice(start).trim()) parts.push(tail)
  return parts
}

// Runs every statement inside one transaction on the worker's single handle:
// all commit, or the first failure (an error or a zero-row write) rolls the
// whole batch back. The result-grid save path relies on this all-or-nothing.
export function runBatch(
  db: DatabaseSync,
  statements: { sql: string; params: SqliteParam[]; expectedRows?: number }[],
): BatchResult {
  if (!statements.length) return { success: true }
  db.exec('BEGIN')
  let index = -1
  try {
    for (index = 0; index < statements.length; index += 1) {
      const statement = statements[index]!
      const info = db.prepare(statement.sql).run(...statement.params)
      const affected = Number(info.changes)
      if (statement.expectedRows !== undefined ? affected !== statement.expectedRows : affected === 0) {
        db.exec('ROLLBACK')
        return {
          success: false,
          failedIndex: index,
          error: statement.expectedRows !== undefined
            ? `Expected ${statement.expectedRows} affected row(s), but ${affected} matched. Refresh and try again.`
            : BATCH_ZERO_ROWS,
        }
      }
    }
    db.exec('COMMIT')
    return { success: true }
  } catch (error) {
    try {
      db.exec('ROLLBACK')
    } catch {
      // The transaction may have auto-aborted already; nothing left to undo.
    }
    return { success: false, failedIndex: index >= 0 ? index : undefined, error: (error as Error).message }
  }
}

// Schema statements in one transaction. Like runBatch but with no rows-affected
// gate — DDL affects zero rows — and no params (DDL runs param-free).
export function runDdl(db: DatabaseSync, statements: string[]): DdlResult {
  if (!statements.length) return { success: true }
  db.exec('BEGIN')
  let index = -1
  try {
    for (index = 0; index < statements.length; index += 1) db.exec(statements[index]!)
    db.exec('COMMIT')
    return { success: true }
  } catch (error) {
    try {
      db.exec('ROLLBACK')
    } catch {
      // The transaction may have auto-aborted already; nothing left to undo.
    }
    return { success: false, failedIndex: index >= 0 ? index : undefined, error: (error as Error).message }
  }
}

function run(statement: StatementSync, params: SqliteParam[], budget: { bytes: number }): QueryResultSet {
  const metadata = statement.columns()
  const columns = metadata.map((column) => column.name)
  const columnSources = metadata.some((column) => column.table !== null && column.column !== null)
    ? metadata.map((column) => ({ schema: null, table: column.table, column: column.column }))
    : undefined

  // No result columns means a write/DDL statement: execute and report the
  // affected-row count instead of an empty row set.
  if (columns.length === 0) {
    const info = statement.run(...params)
    return { columns: [], rows: [], rowCount: Number(info.changes) }
  }

  // Array rows (not objects) keep duplicate column names intact (select a.id,
  // b.id). Iteration is synchronous on the worker thread, so stop at the buffer
  // cap: scanning a huge result just to count it would peg the worker. A
  // truncated result reports the cap as a floor (the renderer shows "N+ rows").
  statement.setReturnArrays(true)
  const rows: unknown[][] = []
  let truncated = false
  let stoppedEarly = false
  for (const row of statement.iterate(...params) as unknown as Iterable<unknown[]>) {
    if (rows.length >= MAX_BUFFERED_ROWS) {
      truncated = true
      stoppedEarly = true
      break
    }
    const bounded = boundedRow(row, budget.bytes)
    if (!bounded) {
      truncated = true
      stoppedEarly = true
      break
    }
    rows.push(bounded.row)
    budget.bytes += bounded.bytes
    truncated ||= bounded.truncated
  }
  // Stopping early leaves the true count unknown; per-cell truncation does not.
  return { columns, columnSources, rows, rowCount: rows.length, truncated, rowCountExact: !stoppedEarly }
}
