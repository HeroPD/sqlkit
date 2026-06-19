import type {
  ColumnsResult,
  ConnectResult,
  ConnectionProfile,
  ConnectionStatus,
  DbObject,
  DbObjectKind,
  FetchRowsResult,
  InspectResult,
  ObjectsResult,
  QueryResponse,
  ServerInfoResult,
  TableRef,
  TablesResult,
  TestConnectionResult,
} from '../../src/electron'
import { createDriver, type Driver } from './driver'
import { PAGE_SIZE, ResultSessionStore } from './result-sessions'
import { resolveEndpoint, type Endpoint, type Tunnel } from './transport'

type Active = {
  /** Null until createDriver succeeds; phase 'connected' implies non-null. */
  driver: Driver | null
  /** SSH tunnel the session rides on; torn down with the session. */
  tunnel: Tunnel | null
  status: ConnectionStatus
}

export type ConnectionManager = ReturnType<typeof createConnectionManager>

// Owns every live connection, keyed by profile id. All state transitions go
// through setStatus so the renderer hears about each one via `broadcast`;
// profiles absent from the map are simply disconnected. Failed connections
// stay in the map in the 'error' phase so the UI can show what went wrong
// until the user reconnects or disconnects.
export function createConnectionManager(broadcast: (statuses: ConnectionStatus[]) => void) {
  const connections = new Map<string, Active>()
  // Buffered result rows the renderer pages through; freed on disconnect.
  const sessions = new ResultSessionStore()

  const statuses = () => [...connections.values()].map((active) => active.status)

  const setStatus = (active: Active, status: ConnectionStatus) => {
    active.status = status
    broadcast(statuses())
  }

  const remove = (profileId: string) => {
    if (connections.delete(profileId)) broadcast(statuses())
  }

  async function disconnect(profileId: string) {
    const active = connections.get(profileId)
    if (!active) return
    remove(profileId)
    sessions.closeProfile(profileId)
    await active.driver?.disconnect().catch(() => {})
    await active.tunnel?.close().catch(() => {})
  }

  async function connect(profile: ConnectionProfile): Promise<ConnectResult> {
    await disconnect(profile.id)

    const active: Active = { driver: null, tunnel: null, status: { profileId: profile.id, phase: 'connecting' } }
    connections.set(profile.id, active)
    broadcast(statuses())

    // True while `active` is still the entry registered for this profile. A
    // concurrent connect (or a disconnect) replaces or removes it mid-await;
    // when that happens this attempt must tear down whatever it built and
    // leave the newer entry's state alone.
    const isCurrent = () => connections.get(profile.id) === active

    // Closes only the resources this attempt opened — used on failure and when
    // the attempt is superseded, so a slow tunnel/pool can't outlive its entry.
    const teardown = async () => {
      await active.driver?.disconnect().catch(() => {})
      await active.tunnel?.close().catch(() => {})
    }

    // Only flag the session that actually failed; a reconnect may have
    // already replaced this entry.
    const onError = (message: string) => {
      if (isCurrent()) setStatus(active, { profileId: profile.id, phase: 'error', error: message })
    }

    try {
      const endpoint = await resolveEndpoint(profile, onError)
      active.tunnel = endpoint.tunnel
      // Superseded while the tunnel was opening: own the tunnel we just got so
      // teardown can close it, then bail without overwriting the newer entry.
      if (!isCurrent()) {
        await teardown()
        return { success: false, error: 'Connection superseded' }
      }
      active.driver = createDriver(profile, endpoint, { onError })
      const serverVersion = await active.driver.connect()
      if (!isCurrent()) {
        await teardown()
        return { success: false, error: 'Connection superseded' }
      }
      setStatus(active, {
        profileId: profile.id,
        phase: 'connected',
        serverVersion,
        tunneled: active.tunnel !== null,
        children: active.driver.children?.(),
      })
      return { success: true, serverVersion }
    } catch (error) {
      const message = (error as Error).message
      if (isCurrent()) setStatus(active, { profileId: profile.id, phase: 'error', error: message })
      // A failed connect must not leak the pool or the tunnel under it.
      await teardown()
      return { success: false, error: message }
    }
  }

  async function disconnectAll() {
    await Promise.all([...connections.keys()].map((profileId) => disconnect(profileId)))
  }

  const connectedDriver = (profileId: string) => {
    const active = connections.get(profileId)
    return active?.status.phase === 'connected' ? active.driver : null
  }

  async function query(profileId: string, childDb: string | null, sql: string, params?: unknown[]): Promise<QueryResponse> {
    const driver = connectedDriver(profileId)
    if (!driver) return { success: false, error: 'Not connected' }
    try {
      const raw = await driver.query(sql, params, childDb)
      // Disconnected mid-query: don't register a buffer no one can page or free
      // (disconnect already swept this profile's sessions). Return a single
      // page, sessionless, so it can't leak.
      if (!connectedDriver(profileId)) return { success: true, result: { ...raw, rows: raw.rows.slice(0, PAGE_SIZE) } }
      // The driver buffers up to MAX_BUFFERED_ROWS; open() keeps that buffer and
      // returns just the first page (with a sessionId) so a big result doesn't
      // cross IPC all at once. The renderer pages the rest via fetchRows.
      return { success: true, result: sessions.open(profileId, raw) }
    } catch (error) {
      return { success: false, error: (error as Error).message }
    }
  }

  // A page of a buffered result; fails when the session is gone (evicted or its
  // connection dropped) so the renderer can fall back instead of seeing 0 rows.
  function fetchRows(sessionId: string, offset: number, limit: number): FetchRowsResult {
    const rows = sessions.fetch(sessionId, offset, limit)
    return rows === null ? { success: false, error: 'Result buffer expired' } : { success: true, rows }
  }

  const closeSession = (sessionId: string) => sessions.close(sessionId)

  async function cancelQuery(profileId: string): Promise<{ success: boolean; error?: string }> {
    const driver = connectedDriver(profileId)
    if (!driver?.cancel) return { success: false, error: 'Cancel is not supported on this connection' }
    try {
      const { running, cancelled } = await driver.cancel()
      if (cancelled > 0) return { success: true }
      if (running > 0) {
        return { success: false, error: 'The query is starting up and could not be cancelled yet — try again in a moment.' }
      }
      return { success: false, error: 'No query is currently running.' }
    } catch (error) {
      return { success: false, error: (error as Error).message }
    }
  }

  // Switches the active child database (all-databases mode) and rebroadcasts
  // so every window sees the new inUse flags.
  function setActiveChild(profileId: string, database: string): { success: boolean; error?: string } {
    const active = connections.get(profileId)
    if (!active || active.status.phase !== 'connected' || !active.driver) {
      return { success: false, error: 'Not connected' }
    }
    if (!active.driver.useChild?.(database)) {
      return { success: false, error: `Database "${database}" is not available on this connection` }
    }
    setStatus(active, { ...active.status, children: active.driver.children?.() })
    return { success: true }
  }

  // Create/drop run through the driver (it owns the pools that must close
  // before a drop) and rebroadcast so every window sees the new child list.
  async function mutateDatabase(profileId: string, run: (driver: Driver) => Promise<void> | undefined) {
    const active = connections.get(profileId)
    if (active?.status.phase !== 'connected' || !active.driver) return { success: false, error: 'Not connected' }
    try {
      const pending = run(active.driver)
      if (!pending) return { success: false, error: 'Not supported for this engine' }
      await pending
      setStatus(active, { ...active.status, children: active.driver.children?.() })
      return { success: true }
    } catch (error) {
      return { success: false, error: (error as Error).message }
    }
  }

  const createDatabase = (profileId: string, name: string) =>
    mutateDatabase(profileId, (driver) => driver.createDatabase?.(name))

  const dropDatabase = (profileId: string, name: string) =>
    mutateDatabase(profileId, (driver) => driver.dropDatabase?.(name))

  async function listTables(profileId: string): Promise<TablesResult> {
    const driver = connectedDriver(profileId)
    if (!driver) return { success: false, error: 'Not connected' }
    try {
      return { success: true, tables: await driver.listTables() }
    } catch (error) {
      return { success: false, error: (error as Error).message }
    }
  }

  async function listObjects(profileId: string): Promise<ObjectsResult> {
    const driver = connectedDriver(profileId)
    if (!driver) return { success: false, error: 'Not connected' }
    try {
      // Engines without schema objects (sqlite) just have empty lists.
      return { success: true, objects: (await driver.listObjects?.()) ?? { functions: [], types: [] } }
    } catch (error) {
      return { success: false, error: (error as Error).message }
    }
  }

  async function inspectObject(profileId: string, object: DbObject, objectKind: DbObjectKind): Promise<InspectResult> {
    const driver = connectedDriver(profileId)
    if (!driver) return { success: false, error: 'Not connected' }
    if (!driver.inspectObject) return { success: false, error: 'Not supported for this engine' }
    try {
      return { success: true, inspection: await driver.inspectObject(object, objectKind) }
    } catch (error) {
      return { success: false, error: (error as Error).message }
    }
  }

  async function inspectServer(profileId: string): Promise<ServerInfoResult> {
    const driver = connectedDriver(profileId)
    if (!driver) return { success: false, error: 'Not connected' }
    if (!driver.inspectServer) return { success: false, error: 'No server info for this engine' }
    try {
      return { success: true, sections: await driver.inspectServer() }
    } catch (error) {
      return { success: false, error: (error as Error).message }
    }
  }

  async function inspectTable(profileId: string, table: TableRef): Promise<InspectResult> {
    const driver = connectedDriver(profileId)
    if (!driver) return { success: false, error: 'Not connected' }
    try {
      return { success: true, inspection: await driver.inspectTable(table) }
    } catch (error) {
      return { success: false, error: (error as Error).message }
    }
  }

  async function listColumns(profileId: string): Promise<ColumnsResult> {
    const driver = connectedDriver(profileId)
    if (!driver) return { success: false, error: 'Not connected' }
    try {
      return { success: true, columns: await driver.listColumns() }
    } catch (error) {
      return { success: false, error: (error as Error).message }
    }
  }

  return {
    connect,
    disconnect,
    disconnectAll,
    statuses,
    query,
    fetchRows,
    closeSession,
    cancelQuery,
    listTables,
    listColumns,
    listObjects,
    inspectTable,
    inspectObject,
    inspectServer,
    setActiveChild,
    createDatabase,
    dropDatabase,
  }
}

/**
 * Connects with a throwaway driver (and tunnel, if configured) and tears
 * everything down: the form's Test Connection button. Touches no state.
 */
export async function testConnection(profile: ConnectionProfile): Promise<TestConnectionResult> {
  const started = performance.now()
  const tookMs = () => Math.round(performance.now() - started)

  let endpoint: Endpoint | null = null
  let driver: Driver | null = null
  try {
    endpoint = await resolveEndpoint(profile, () => {})
    driver = createDriver(profile, endpoint, { onError: () => {} })
    const serverVersion = await driver.connect()
    return { success: true, serverVersion, tookMs: tookMs() }
  } catch (error) {
    return { success: false, error: (error as Error).message, tookMs: tookMs() }
  } finally {
    await driver?.disconnect().catch(() => {})
    await endpoint?.tunnel?.close().catch(() => {})
  }
}
