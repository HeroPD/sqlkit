import type {
  ChildDb,
  ColumnRef,
  ConnectionProfile,
  DbObject,
  DbObjectKind,
  DbObjects,
  InspectSection,
  QueryResult,
  TableInspection,
  TableRef,
} from '../../src/electron'
import type { Endpoint } from './transport'
import { createPostgresDriver } from './postgres'
import { createSqliteDriver } from './sqlite'

// One live database session. Drivers own the engine-specific client and
// normalize results into the shared QueryResult shape; the connection
// manager owns lifecycle, status, tunnels, and error reporting on top.
export type Driver = {
  /** Opens the connection; resolves with the server version string. */
  connect(): Promise<string>
  disconnect(): Promise<void>
  /** Runs in `childDb` when provided; otherwise uses the driver's active database. */
  query(sql: string, params?: unknown[], childDb?: string | null): Promise<QueryResult>
  /** Cancels the in-flight query; false when nothing is running. Engines
   * without server-side cancellation (sqlite) leave it undefined. */
  cancel?(): Promise<boolean>
  listTables(): Promise<TableRef[]>
  /** Columns of every listed table, in table order then column position. */
  listColumns(): Promise<ColumnRef[]>
  /** One table's structure: columns plus engine-specific sections. */
  inspectTable(table: TableRef): Promise<TableInspection>
  /** Schema-scoped functions/types; undefined when the engine has none. */
  listObjects?(): Promise<DbObjects>
  /** One function/type's structure, in the table-inspection shape. */
  inspectObject?(object: DbObject, objectKind: DbObjectKind): Promise<TableInspection>
  /** Server-scoped reference (extensions, roles, …) for the Server view. */
  inspectServer?(): Promise<InspectSection[]>
  /** Child databases; undefined for engines without all-databases support. */
  children?(): ChildDb[]
  /** Server-side CREATE DATABASE; undefined for file-based engines. */
  createDatabase?(name: string): Promise<void>
  /** Server-side DROP DATABASE; refuses the in-use child. */
  dropDatabase?(name: string): Promise<void>
  /** Switches the active child; false when the name is unknown. */
  useChild?(database: string): boolean
}

export type DriverEvents = {
  /** Async failure outside a call (e.g. an idle pool client dropping). */
  onError(message: string): void
}

/** Rows shipped to the renderer per query; the rest never cross IPC. */
export const MAX_RESULT_ROWS = 1000

// Caps rows at the IPC boundary so a stray `select *` on a huge table can't
// flood the renderer. rowCount keeps the full count for the status line.
export function capResult(result: QueryResult): QueryResult {
  if (result.rows.length <= MAX_RESULT_ROWS) return result
  return { ...result, rows: result.rows.slice(0, MAX_RESULT_ROWS), truncated: true }
}

// The endpoint carries the host/port the driver should actually dial — the
// transport layer has already rewritten it to a tunnel's local port when the
// profile asks for SSH. File-based engines ignore it.
export function createDriver(profile: ConnectionProfile, endpoint: Endpoint, events: DriverEvents): Driver {
  switch (profile.engine) {
    case 'postgresql':
      return createPostgresDriver(profile, endpoint, events)
    case 'sqlite':
      return createSqliteDriver(profile)
    default:
      throw new Error(`No ${profile.engine} driver yet — only PostgreSQL and SQLite are supported.`)
  }
}
