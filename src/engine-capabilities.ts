import type { Engine } from './electron'

export type EngineCapabilities = {
  /** Guarantee for a multi-statement runDdl call. */
  ddlAtomicity: 'atomic' | 'best-effort'
  cancellation: 'server' | 'request' | 'worker-restart'
  rowCount: 'exact-after-drain' | 'bounded-lower-bound'
  namespaceModel: 'database-and-schema' | 'database-is-schema' | 'flat-file'
  /** Query calls intentionally do not preserve connection-scoped state. */
  persistentSession: false
}

export const ENGINE_CAPABILITIES: Readonly<Record<Engine, EngineCapabilities>> = {
  postgresql: {
    ddlAtomicity: 'atomic',
    cancellation: 'server',
    rowCount: 'exact-after-drain',
    namespaceModel: 'database-and-schema',
    persistentSession: false,
  },
  mysql: {
    // MySQL implicitly commits most DDL, so a later failure cannot roll back
    // statements that already succeeded.
    ddlAtomicity: 'best-effort',
    cancellation: 'server',
    rowCount: 'exact-after-drain',
    namespaceModel: 'database-is-schema',
    persistentSession: false,
  },
  sqlserver: {
    ddlAtomicity: 'atomic',
    cancellation: 'request',
    rowCount: 'exact-after-drain',
    namespaceModel: 'database-and-schema',
    persistentSession: false,
  },
  sqlite: {
    ddlAtomicity: 'atomic',
    cancellation: 'worker-restart',
    rowCount: 'bounded-lower-bound',
    namespaceModel: 'flat-file',
    persistentSession: false,
  },
}

export const capabilitiesFor = (engine: Engine): EngineCapabilities => ENGINE_CAPABILITIES[engine]
