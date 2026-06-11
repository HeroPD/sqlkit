import type { ConnectionProfile, QueryResult, TableRef } from '../../src/electron'
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
  query(sql: string, params?: unknown[]): Promise<QueryResult>
  listTables(): Promise<TableRef[]>
}

export type DriverEvents = {
  /** Async failure outside a call (e.g. an idle pool client dropping). */
  onError(message: string): void
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
