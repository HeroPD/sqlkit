import type { Engine } from './electron'

export type EngineCapabilities = {
  /** Guarantee for a multi-statement runDdl call. */
  ddlAtomicity: 'atomic' | 'best-effort'
  cancellation: 'server' | 'request' | 'worker-restart'
  rowCount: 'exact-after-drain' | 'bounded-lower-bound'
  namespaceModel: 'database-and-schema' | 'database-is-schema' | 'flat-file'
  /** Whether a run that leaves a transaction open pins its connection for
   * later runs (manual transactions). SQLite's single shared handle cannot. */
  manualTransactions: boolean
  /** Live server load for the Tasks dashboard, or false where there is no
   * server to ask. `cancelSession` is false on engines whose only interrupt
   * ends the whole session, so the UI offers just one destructive action. */
  serverActivity: false | { cancelSession: boolean }
}

export const ENGINE_CAPABILITIES: Readonly<Record<Engine, EngineCapabilities>> = {
  postgresql: {
    ddlAtomicity: 'atomic',
    cancellation: 'server',
    rowCount: 'exact-after-drain',
    namespaceModel: 'database-and-schema',
    manualTransactions: true,
    // pg_cancel_backend interrupts the statement, pg_terminate_backend drops it.
    serverActivity: { cancelSession: true },
  },
  mysql: {
    // MySQL implicitly commits most DDL, so a later failure cannot roll back
    // statements that already succeeded.
    ddlAtomicity: 'best-effort',
    cancellation: 'server',
    rowCount: 'exact-after-drain',
    namespaceModel: 'database-is-schema',
    manualTransactions: true,
    // KILL QUERY vs KILL CONNECTION.
    serverActivity: { cancelSession: true },
  },
  sqlserver: {
    ddlAtomicity: 'atomic',
    cancellation: 'request',
    rowCount: 'exact-after-drain',
    namespaceModel: 'database-and-schema',
    manualTransactions: true,
    // KILL always ends the session; there is no statement-only form.
    serverActivity: { cancelSession: false },
  },
  sqlite: {
    ddlAtomicity: 'atomic',
    cancellation: 'worker-restart',
    rowCount: 'bounded-lower-bound',
    namespaceModel: 'flat-file',
    manualTransactions: false,
    // A local file has no sessions, connections or uptime to report.
    serverActivity: false,
  },
}

export const capabilitiesFor = (engine: Engine): EngineCapabilities => ENGINE_CAPABILITIES[engine]
