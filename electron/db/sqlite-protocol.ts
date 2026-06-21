import type { TableRef } from '../../src/electron'
import type { SqliteParam } from './sqlite-engine'

// Wire format between the SQLite driver (main process) and its worker. One
// request gets exactly one response, correlated by id. Type-only, so importing
// it couples neither side to the other's runtime.
export type SqliteRequest =
  | { id: number; type: 'open'; file: string }
  | { id: number; type: 'query'; sql: string; params: SqliteParam[] }
  | { id: number; type: 'listTables' }
  | { id: number; type: 'listColumns' }
  | { id: number; type: 'inspectTable'; table: TableRef }

export type SqliteResponse =
  | { id: number; ok: true; value: unknown }
  | { id: number; ok: false; error: string }
