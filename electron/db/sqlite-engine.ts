import { DatabaseSync, type StatementSync } from 'node:sqlite'
import type { ColumnRef, InspectSection, QueryResult, TableInspection, TableRef } from '../../src/electron'
import { MAX_BUFFERED_ROWS } from './limits'

// The synchronous SQLite core, factored out of any process/threading concern:
// every function takes the DatabaseSync it operates on. The worker owns the
// handle and calls these; tests call them against an in-memory database
// directly. node:sqlite is built into Electron's Node, so there's no native
// addon to rebuild against Electron's ABI.

export type SqliteParam = string | number | bigint | null | Uint8Array

export const openDatabase = (file: string): DatabaseSync => new DatabaseSync(file)

export const serverVersion = (db: DatabaseSync): string => {
  const row = db.prepare('select sqlite_version() as version').get() as { version: string }
  return `SQLite ${row.version}`
}

export function queryDatabase(db: DatabaseSync, sql: string, params: SqliteParam[] = []): QueryResult {
  const statement = db.prepare(sql)
  const started = performance.now()
  const result = run(statement, params)
  return { ...result, durationMs: performance.now() - started }
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
  return rows.map(
    (row): ColumnRef => ({
      schema: null,
      table: row.table_name,
      name: row.column_name,
      dataType: row.data_type || 'any',
      nullable: !row.not_null,
      primaryKey: row.pk > 0,
      foreignKey: row.fk > 0,
    }),
  )
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

  const sections: InspectSection[] = [
    {
      title: 'Foreign Keys',
      rows: foreignKeys.map((fk) => ({
        name: fk.from_col,
        definition: `REFERENCES ${fk.ref_table}(${fk.to_col ?? 'rowid'}) ON UPDATE ${fk.on_update} ON DELETE ${fk.on_delete}`,
      })),
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
    })),
    sections: sections.filter((section) => section.rows.length),
  }
}

function run(statement: StatementSync, params: SqliteParam[]): Omit<QueryResult, 'durationMs'> {
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
  for (const row of statement.iterate(...params) as unknown as Iterable<unknown[]>) {
    if (rows.length >= MAX_BUFFERED_ROWS) {
      truncated = true
      break
    }
    rows.push(row)
  }
  return { columns, columnSources, rows, rowCount: rows.length, truncated }
}
