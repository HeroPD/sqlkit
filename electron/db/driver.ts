import type {
  BatchResult,
  BatchStatement,
  ChildDb,
  ColumnRef,
  ConnectionProfile,
  DbObject,
  DbObjectKind,
  DbObjects,
  InspectSection,
  QueryResult,
  QuerySort,
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
  /** Runs in `childDb` when provided; otherwise uses the driver's active
   * database. `sort` injects an ORDER BY the driver builds with its own
   * identifier quoting. */
  query(sql: string, params?: unknown[], childDb?: string | null, sort?: QuerySort | null): Promise<QueryResult>
  /** Runs statements in a single transaction on one connection, committing only
   * if every statement succeeds and affects at least one row — otherwise the
   * whole batch rolls back. Undefined for engines without transaction support. */
  runBatch?(statements: BatchStatement[], childDb?: string | null): Promise<BatchResult>
  /** Interrupts in-flight queries. Reports how many were `running` and how many
   * could be `cancelled` — a query whose backend PID isn't known yet can't be
   * targeted, so the caller can tell "nothing running" (running 0) from "running
   * but un-cancellable" (running > 0, cancelled 0). Engines without server-side
   * cancellation (sqlite) leave it undefined. */
  cancel?(): Promise<{ running: number; cancelled: number }>
  // Metadata methods target `childDb` when given, else the active child — same
  // contract as query(), so listings never silently follow a different child
  // than the one the caller asked for.
  listTables(childDb?: string | null): Promise<TableRef[]>
  /** Columns of every listed table, in table order then column position. */
  listColumns(childDb?: string | null): Promise<ColumnRef[]>
  /** One table's structure: columns plus engine-specific sections. */
  inspectTable(table: TableRef, childDb?: string | null): Promise<TableInspection>
  /** Schema-scoped functions/types; undefined when the engine has none. */
  listObjects?(childDb?: string | null): Promise<DbObjects>
  /** One function/type's structure, in the table-inspection shape. */
  inspectObject?(object: DbObject, objectKind: DbObjectKind, childDb?: string | null): Promise<TableInspection>
  /** Server-scoped reference (extensions, roles, …) for the Server view. */
  inspectServer?(childDb?: string | null): Promise<InspectSection[]>
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

export { MAX_BUFFERED_ROWS } from './limits'

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
