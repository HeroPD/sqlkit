import type {
  BatchResult,
  BatchStatement,
  ColumnsResult,
  ConnectResult,
  ConnectionProfile,
  ConnectionStatus,
  DbObject,
  DbObjectKind,
  DdlResult,
  FetchRowsResult,
  InspectResult,
  ObjectsResult,
  QueryResponse,
  QuerySort,
  ServerInfoResult,
  TableRef,
  TablesResult,
  TestConnectionResult,
} from '../../src/electron'
import { unlink } from 'node:fs/promises'
import type { ExportFormat } from '../../src/result-export'
import { isReadOnlyQuery } from '../../src/sql-order'
import { createDriver, type Driver } from './driver'
import { ResultSessionStore } from './result-sessions'
import { resolveEndpoint, type Endpoint, type Tunnel } from './transport'

type ConnectionResources = { driver: Driver | null; tunnel: Tunnel | null }
type Active =
  | ({ phase: 'connecting'; profileId: string } & ConnectionResources)
  | { phase: 'connected'; profileId: string; driver: Driver; tunnel: Tunnel | null; serverVersion: string }
  | ({ phase: 'error'; profileId: string; error: string } & ConnectionResources)

export type ConnectionManager = ReturnType<typeof createConnectionManager>

// Owns every live connection, keyed by profile id. All state transitions go
// through replace so the renderer hears about each one via `broadcast`;
// profiles absent from the map are simply disconnected. Failed connections
// stay in the map in the 'error' phase so the UI can show what went wrong
// until the user reconnects or disconnects.
export function createConnectionManager(broadcast: (statuses: ConnectionStatus[]) => void) {
  const connections = new Map<string, Active>()
  // Buffered result rows the renderer pages through; freed on disconnect.
  const sessions = new ResultSessionStore()

  const statusOf = (active: Active): ConnectionStatus => {
    if (active.phase === 'connecting') return { profileId: active.profileId, phase: 'connecting' }
    if (active.phase === 'error') return { profileId: active.profileId, phase: 'error', error: active.error }
    return {
      profileId: active.profileId,
      phase: 'connected',
      serverVersion: active.serverVersion,
      tunneled: active.tunnel !== null,
      children: active.driver.children?.(),
    }
  }
  const statuses = () => [...connections.values()].map(statusOf)

  const replace = (profileId: string, active: Active) => {
    connections.set(profileId, active)
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
    // One deadline over cancel + disconnect + tunnel close — cancel()'s 8s
    // out-of-band dial would otherwise hold pools/tunnel long past the cap.
    let settled = false
    const teardown = (async () => {
      await active.driver?.cancel?.().catch(() => {})
      await active.driver?.disconnect().catch(() => {})
      await active.tunnel?.close().catch(() => {})
      settled = true
    })()
    await Promise.race([teardown, new Promise<void>((resolve) => setTimeout(resolve, 3000))])
    // A hung disconnect can deadlock on its own tunnel (pool.end waits for a
    // client whose socket rides it); force the tunnel down so both unstick.
    // Without a tunnel, the abandoned teardown still settles on its own:
    // every driver's sockets carry TCP keepalive, so a dead peer terminates
    // them and pool.end() completes rather than holding sockets forever.
    if (!settled) void active.tunnel?.close().catch(() => {})
  }

  async function connect(profile: ConnectionProfile): Promise<ConnectResult> {
    await disconnect(profile.id)

    const resources: ConnectionResources = { driver: null, tunnel: null }
    const attempt = Symbol(profile.id)
    const attempts = new WeakMap<Active, symbol>()
    const register = (state: Active) => {
      attempts.set(state, attempt)
      replace(profile.id, state)
      return state
    }
    register({ phase: 'connecting', profileId: profile.id, ...resources })

    // True while `active` is still the entry registered for this profile. A
    // concurrent connect (or a disconnect) replaces or removes it mid-await;
    // when that happens this attempt must tear down whatever it built and
    // leave the newer entry's state alone.
    const isCurrent = () => {
      const current = connections.get(profile.id)
      return !!current && attempts.get(current) === attempt
    }

    // Closes only the resources this attempt opened — used on failure and when
    // the attempt is superseded, so a slow tunnel/pool can't outlive its entry.
    const teardown = async () => {
      await resources.driver?.disconnect().catch(() => {})
      await resources.tunnel?.close().catch(() => {})
    }

    // A tunnel that drops after it was established won't recover on its own and
    // takes the pools under it with it, so flag the connection as failed. Only
    // flag the session that actually failed; a reconnect may have already
    // replaced this entry.
    const onTransportError = (message: string) => {
      if (isCurrent()) register({ phase: 'error', profileId: profile.id, error: message, ...resources })
    }

    // Pool clients drop routinely while idle (managed-database idle timeouts,
    // brief network blips); the pool discards the dead client and opens a fresh
    // one on the next checkout. Demoting the whole connection to 'error' here
    // would disable a pool that is about to heal — and blank the schema tree —
    // so an async driver error is advisory only. A genuinely dead backend still
    // surfaces as the next query's error.
    const onDriverError = (_message: string) => {}

    try {
      const endpoint = await resolveEndpoint(profile, onTransportError)
      resources.tunnel = endpoint.tunnel
      if (isCurrent()) register({ phase: 'connecting', profileId: profile.id, ...resources })
      // Superseded while the tunnel was opening: own the tunnel we just got so
      // teardown can close it, then bail without overwriting the newer entry.
      if (!isCurrent()) {
        await teardown()
        return { success: false, error: 'Connection superseded' }
      }
      resources.driver = createDriver(profile, endpoint, { onError: onDriverError })
      if (isCurrent()) register({ phase: 'connecting', profileId: profile.id, ...resources })
      const serverVersion = await resources.driver.connect()
      if (!isCurrent()) {
        await teardown()
        return { success: false, error: 'Connection superseded' }
      }
      register({
        profileId: profile.id,
        phase: 'connected',
        serverVersion,
        driver: resources.driver,
        tunnel: resources.tunnel,
      })
      return { success: true, serverVersion }
    } catch (error) {
      const message = (error as Error).message
      if (isCurrent()) register({ phase: 'error', profileId: profile.id, error: message, ...resources })
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
    return active?.phase === 'connected' ? active.driver : null
  }

  async function query(
    profileId: string,
    childDb: string | null,
    sql: string,
    params?: unknown[],
    sort?: QuerySort | null,
    executionId?: string,
  ): Promise<QueryResponse> {
    const driver = connectedDriver(profileId)
    if (!driver) return { success: false, error: 'Not connected' }
    try {
      const raw = await driver.query(sql, params, childDb, sort, executionId)
      // Disconnected mid-query: don't register a buffer no one can page or free
      // (disconnect already swept this profile's sessions). Return a single
      // page, sessionless, so it can't leak.
      if (connectedDriver(profileId) !== driver) return { success: true, result: sessions.preview(raw) }
      // The driver buffers up to MAX_BUFFERED_ROWS; open() keeps that buffer and
      // returns just the first page (with a sessionId) so a big result doesn't
      // cross IPC all at once. The renderer pages the rest via fetchRows.
      return { success: true, result: sessions.open(profileId, raw) }
    } catch (error) {
      // Typed here — same process as the drivers' throw — so the renderer never
      // has to pattern-match the human-readable message.
      const message = (error as Error).message
      return { success: false, error: message, ...(message === 'Query cancelled.' ? { cancelled: true } : {}) }
    }
  }

  // Atomic write batch: the whole save commits or rolls back on one connection.
  // A connection-level failure (not connected / unsupported) reports no
  // failedIndex, since nothing ran.
  async function runBatch(profileId: string, childDb: string | null, statements: BatchStatement[]): Promise<BatchResult> {
    const driver = connectedDriver(profileId)
    if (!driver) return { success: false, error: 'Not connected' }
    if (!driver.runBatch) return { success: false, error: 'Atomic writes are not supported on this connection' }
    try {
      return await driver.runBatch(statements, childDb)
    } catch (error) {
      return { success: false, error: (error as Error).message }
    }
  }

  // Atomic schema batch: all statements commit or none do, on one connection.
  async function runDdl(profileId: string, childDb: string | null, statements: string[]): Promise<DdlResult> {
    const driver = connectedDriver(profileId)
    if (!driver) return { success: false, error: 'Not connected' }
    if (!driver.runDdl) return { success: false, error: 'Schema changes are not supported on this connection' }
    try {
      return await driver.runDdl(statements, childDb)
    } catch (error) {
      return { success: false, error: (error as Error).message }
    }
  }

  // Streams a full read-only result straight to a file, past the display buffer's
  // row cap. Enforces read-only here too (IPC input is untrusted) so a re-run can
  // never re-execute a write. A failed export leaves no half-written file.
  async function exportQuery(
    profileId: string,
    childDb: string | null,
    sql: string,
    sort: QuerySort | null,
    filePath: string,
    format: ExportFormat,
    executionId?: string,
  ): Promise<{ success: boolean; rowCount?: number; error?: string; cancelled?: boolean }> {
    const driver = connectedDriver(profileId)
    if (!driver) return { success: false, error: 'Not connected' }
    if (!driver.exportQuery) return { success: false, error: 'Export is not supported on this connection' }
    if (!isReadOnlyQuery(sql)) return { success: false, error: 'Only read-only queries can be exported to a file.' }
    try {
      const { rowCount } = await driver.exportQuery({ sql, params: [], childDb, sort, filePath, format, executionId })
      return { success: true, rowCount }
    } catch (error) {
      await unlink(filePath).catch(() => {})
      const message = (error as Error).message
      return { success: false, error: message, ...(message === 'Query cancelled.' ? { cancelled: true } : {}) }
    }
  }

  // A page of a buffered result; fails when the session is gone (evicted or its
  // connection dropped) so the renderer can fall back instead of seeing 0 rows.
  function fetchRows(sessionId: string, offset: number, limit: number): FetchRowsResult {
    const rows = sessions.fetch(sessionId, offset, limit)
    return rows === null ? { success: false, error: 'Result buffer expired' } : { success: true, rows }
  }

  const closeSession = (sessionId: string) => sessions.close(sessionId)

  async function cancelQuery(profileId: string, executionId?: string): Promise<{ success: boolean; error?: string }> {
    const driver = connectedDriver(profileId)
    if (!driver?.cancel) return { success: false, error: 'Cancel is not supported on this connection' }
    try {
      const { running, cancelled } = await driver.cancel(executionId)
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
    if (!active || active.phase !== 'connected') {
      return { success: false, error: 'Not connected' }
    }
    if (!active.driver.useChild?.(database)) {
      return { success: false, error: `Database "${database}" is not available on this connection` }
    }
    broadcast(statuses())
    return { success: true }
  }

  // Create/drop run through the driver (it owns the pools that must close
  // before a drop) and rebroadcast so every window sees the new child list.
  async function mutateDatabase(profileId: string, run: (driver: Driver) => Promise<void> | undefined) {
    const active = connections.get(profileId)
    if (active?.phase !== 'connected') return { success: false, error: 'Not connected' }
    try {
      const pending = run(active.driver)
      if (!pending) return { success: false, error: 'Not supported for this engine' }
      await pending
      broadcast(statuses())
      return { success: true }
    } catch (error) {
      return { success: false, error: (error as Error).message }
    }
  }

  const createDatabase = (profileId: string, name: string) =>
    mutateDatabase(profileId, (driver) => driver.createDatabase?.(name))

  const dropDatabase = (profileId: string, name: string) =>
    mutateDatabase(profileId, (driver) => driver.dropDatabase?.(name))

  async function listTables(profileId: string, childDb: string | null = null): Promise<TablesResult> {
    const driver = connectedDriver(profileId)
    if (!driver) return { success: false, error: 'Not connected' }
    try {
      return { success: true, tables: await driver.listTables(childDb) }
    } catch (error) {
      return { success: false, error: (error as Error).message }
    }
  }

  async function listObjects(profileId: string, childDb: string | null = null): Promise<ObjectsResult> {
    const driver = connectedDriver(profileId)
    if (!driver) return { success: false, error: 'Not connected' }
    try {
      // Engines without schema objects (sqlite) just have empty lists.
      return { success: true, objects: (await driver.listObjects?.(childDb)) ?? { functions: [], types: [] } }
    } catch (error) {
      return { success: false, error: (error as Error).message }
    }
  }

  async function inspectObject(
    profileId: string,
    object: DbObject,
    objectKind: DbObjectKind,
    childDb: string | null = null,
  ): Promise<InspectResult> {
    const driver = connectedDriver(profileId)
    if (!driver) return { success: false, error: 'Not connected' }
    if (!driver.inspectObject) return { success: false, error: 'Not supported for this engine' }
    try {
      return { success: true, inspection: await driver.inspectObject(object, objectKind, childDb) }
    } catch (error) {
      return { success: false, error: (error as Error).message }
    }
  }

  async function inspectServer(profileId: string, childDb: string | null = null): Promise<ServerInfoResult> {
    const driver = connectedDriver(profileId)
    if (!driver) return { success: false, error: 'Not connected' }
    if (!driver.inspectServer) return { success: false, error: 'No server info for this engine' }
    try {
      return { success: true, sections: await driver.inspectServer(childDb) }
    } catch (error) {
      return { success: false, error: (error as Error).message }
    }
  }

  async function inspectTable(profileId: string, table: TableRef, childDb: string | null = null): Promise<InspectResult> {
    const driver = connectedDriver(profileId)
    if (!driver) return { success: false, error: 'Not connected' }
    try {
      return { success: true, inspection: await driver.inspectTable(table, childDb) }
    } catch (error) {
      return { success: false, error: (error as Error).message }
    }
  }

  async function listColumns(profileId: string, childDb: string | null = null): Promise<ColumnsResult> {
    const driver = connectedDriver(profileId)
    if (!driver) return { success: false, error: 'Not connected' }
    try {
      return { success: true, columns: await driver.listColumns(childDb) }
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
    runBatch,
    runDdl,
    exportQuery,
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
