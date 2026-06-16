import { DatabaseSync, type StatementSync } from 'node:sqlite'
import type { ColumnRef, ConnectionProfile, InspectSection, QueryResult, TableRef } from '../../src/electron'
import { MAX_RESULT_ROWS } from './driver'
import type { Driver } from './driver'

// SQLite via the node:sqlite module built into Electron's Node — no native
// addon, so nothing to rebuild against Electron's ABI. The API is
// synchronous; statements run on the main process thread, which is fine for
// the interactive query sizes a workbench issues.
export function createSqliteDriver(profile: ConnectionProfile): Driver {
  let db: DatabaseSync | null = null

  const open = () => {
    if (!db) throw new Error('Not connected')
    return db
  }

  return {
    async connect() {
      const file = profile.file.trim()
      if (!file) throw new Error('Choose a database file first.')
      // Opens (and creates, if missing) the file eagerly so a bad path fails
      // here rather than on the first query.
      db = new DatabaseSync(file)
      const row = db.prepare('select sqlite_version() as version').get() as { version: string }
      return `SQLite ${row.version}`
    },

    async disconnect() {
      db?.close()
      db = null
    },

    async query(sql, params = []) {
      const statement = open().prepare(sql)
      const started = performance.now()
      const result = run(statement, params as Array<string | number | bigint | null>)
      return { ...result, durationMs: performance.now() - started }
    },

    async listTables() {
      const rows = open()
        .prepare(
          "select name, type from sqlite_master where type in ('table', 'view') and name not like 'sqlite_%' order by name",
        )
        .all() as Array<{ name: string; type: string }>
      return rows.map((row): TableRef => ({ schema: null, name: row.name, kind: row.type === 'view' ? 'view' : 'table' }))
    },

    async listColumns() {
      // pragma_table_info as a correlated table-valued function: one statement
      // covers every table without string-built pragmas.
      const rows = open()
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
    },

    async inspectTable(table) {
      const db = open()
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
    },
  }
}

function run(statement: StatementSync, params: Array<string | number | bigint | null>): Omit<QueryResult, 'durationMs'> {
  const columns = statement.columns().map((column) => column.name)

  // No result columns means a write/DDL statement: execute and report the
  // affected-row count instead of an empty row set.
  if (columns.length === 0) {
    const info = statement.run(...params)
    return { columns: [], rows: [], rowCount: Number(info.changes) }
  }

  // Stream rows (iterate, not all) so a huge result can't blow up memory; keep
  // only what the renderer shows. Object rows collapse duplicate column names.
  const rows: unknown[][] = []
  let total = 0
  for (const row of statement.iterate(...params)) {
    total += 1
    if (rows.length < MAX_RESULT_ROWS) rows.push(columns.map((column) => row[column]))
  }
  return { columns, rows, rowCount: total, truncated: total > MAX_RESULT_ROWS }
}
