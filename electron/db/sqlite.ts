import { DatabaseSync, type StatementSync } from 'node:sqlite'
import type { ConnectionProfile, QueryResult, TableRef } from '../../src/electron'
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
        .prepare("select name from sqlite_master where type in ('table', 'view') and name not like 'sqlite_%' order by name")
        .all() as Array<{ name: string }>
      return rows.map((row): TableRef => ({ schema: null, name: row.name }))
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

  const rows = statement.all(...params) as Array<Record<string, unknown>>
  // Object rows collapse duplicate column names (select a.id, b.id); the
  // duplicates still appear as columns, both reading the surviving value.
  return {
    columns,
    rows: rows.map((row) => columns.map((column) => row[column])),
    rowCount: rows.length,
  }
}
