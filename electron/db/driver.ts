import type {
  BatchResult,
  BatchStatement,
  ChildDb,
  ColumnRef,
  ConnectionProfile,
  DatabaseCreateMeta,
  DatabaseCreateOptions,
  DbObject,
  DbObjectKind,
  DbObjects,
  DdlResult,
  ObjectDdlRef,
  InspectSection,
  QueryResult,
  QuerySort,
  ServerActivity,
  SessionEndMode,
  TableInspection,
  TableRef,
} from '../../src/electron'
import type { ExportFormat, SqlExportTarget } from '../../src/result-export'
import type { Endpoint } from './transport'
import { createMssqlDriver } from './mssql'
import { createMysqlDriver } from './mysql'
import { createPostgresDriver } from './postgres'
import { createSqliteDriver } from './sqlite'

// One live database session. Drivers own the engine-specific client and
// normalize results into the shared QueryResult shape; the connection
// manager owns lifecycle, status, tunnels, and error reporting on top.
export type Driver = {
  /** Opens the connection; resolves with the server version string. */
  connect(): Promise<string>
  disconnect(): Promise<void>
  /** Executes one self-contained, stateless SQL run in `childDb` when provided,
   * otherwise in the active database. Connection-scoped state is not preserved
   * between calls; transactions must begin and finish in this call. `filter`
   * and `sort` inject outer WHERE/ORDER BY clauses only for one SELECT. */
  query(
    sql: string,
    params?: unknown[],
    childDb?: string | null,
    sort?: QuerySort | null,
    filter?: string | null,
    executionId?: string,
  ): Promise<QueryResult>
  /** Runs statements in a single transaction on one connection, committing only
   * if every statement succeeds and affects at least one row — otherwise the
   * whole batch rolls back. Undefined for engines without transaction support. */
  runBatch?(statements: BatchStatement[], childDb?: string | null): Promise<BatchResult>
  /** Runs schema statements in a single transaction, committing only if every one
   * succeeds. Like runBatch but with no rows-affected gate (DDL affects 0 rows).
   * Undefined for engines without transaction support. */
  runDdl?(statements: string[], childDb?: string | null): Promise<DdlResult>
  /** Interrupts in-flight queries. Reports how many were `running` and how many
   * could be `cancelled` — a query whose backend PID isn't known yet can't be
   * targeted, so the caller can tell "nothing running" (running 0) from "running
   * but un-cancellable" (running > 0, cancelled 0). With no executionId it
   * targets everything in flight — on the server engines that includes runBatch
   * /runDdl saves (their transactions roll back); SQLite deliberately never
   * cancels saves, since its only interrupt is killing the worker mid-write. */
  cancel?(executionId?: string): Promise<{ running: number; cancelled: number }>
  /** Streams a read-only query straight to `filePath` in `format`, bypassing the
   * buffered/paged result path so a full large result exports without the row
   * cap. Returns the number of data rows written. The manager guarantees the SQL
   * is read-only before calling. Registers under `executionId` so cancel() can
   * interrupt it like any query. Undefined where the engine can't stream a run. */
  exportQuery?(args: {
    sql: string
    params: unknown[]
    childDb: string | null
    sort: QuerySort | null
    filter?: string | null
    filePath: string
    format: ExportFormat
    /** Present only for the `sql` format: the engine whose literal syntax the
     * values take, and the table the INSERTs name. */
    sqlTarget?: SqlExportTarget
    executionId?: string
  }): Promise<{ rowCount: number }>
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
  /** Re-runnable CREATE DDL for a function/view; undefined when unsupported. */
  objectDdl?(ref: ObjectDdlRef, childDb?: string | null): Promise<string>
  /** Server-scoped reference (extensions, roles, …) for the Server view. */
  inspectServer?(childDb?: string | null): Promise<InspectSection[]>
  /** Live server load for the Tasks dashboard: connection usage, headline stats,
   * and the session list. Undefined for engines with no server to ask (SQLite),
   * which is what `serverActivity` in engine-capabilities reflects. Polled while
   * the view is open, so it must stay a handful of cheap catalog reads. */
  serverActivity?(childDb?: string | null): Promise<ServerActivity>
  /** Ends someone's work: `cancel` interrupts the running statement, `terminate`
   * drops the session outright. Paired with serverActivity. */
  endSession?(sessionId: string, mode: SessionEndMode): Promise<void>
  /** Child databases; undefined for engines without all-databases support. */
  children?(): ChildDb[]
  /** Engine-specific option values (collations, charsets, …) for the create dialog. */
  databaseCreateMeta?(): Promise<DatabaseCreateMeta>
  /** Server-side CREATE DATABASE; undefined for file-based engines. */
  createDatabase?(name: string, options?: DatabaseCreateOptions): Promise<void>
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
    case 'mysql':
      return createMysqlDriver(profile, endpoint, events)
    case 'sqlserver':
      return createMssqlDriver(profile, endpoint, events)
    case 'sqlite':
      return createSqliteDriver(profile)
  }
}
