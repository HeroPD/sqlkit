import type {
  BatchResult,
  BatchStatement,
  ColumnsResult,
  ConnectResult,
  ConnectionProfile,
  ConnectionStatus,
  DatabaseCreateMetaResult,
  DatabaseCreateOptions,
  DbObject,
  DbObjectKind,
  DdlResult,
  Engine,
  FetchRowsResult,
  InspectResult,
  ObjectDdlRef,
  ObjectDdlResult,
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
import { t } from '../../src/i18n'
import { createDriver, type Driver } from './driver'
import { queryErrorLine } from './error-line'
import { ResultSessionStore } from './result-sessions'
import { resolveEndpoint, type Endpoint, type Tunnel } from './transport'

type ConnectionResources = { driver: Driver | null; tunnel: Tunnel | null }
type Active =
  | ({ phase: 'connecting'; profileId: string } & ConnectionResources)
  | { phase: 'connected'; profileId: string; engine: Engine; driver: Driver; tunnel: Tunnel | null; serverVersion: string }
  | ({ phase: 'error'; profileId: string; error: string } & ConnectionResources)

export type ConnectionManager = ReturnType<typeof createConnectionManager>

// Owns every live connection, keyed by profile id. All state transitions go
// through replace so the renderer hears about each one via `broadcast`;
// profiles absent from the map are simply disconnected. Failed connections
// stay in the map in the 'error' phase so the UI can show what went wrong
// until the user reconnects or disconnects.
export function createConnectionManager(broadcast: (statuses: ConnectionStatus[]) => void) {
  const connections = new Map<string, Active>()
  // Latest requested connect per profile. This exists independently of the
  // active map because teardown removes that entry before its awaits settle.
  const connectAttempts = new Map<string, symbol>()
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

  async function disconnectActive(profileId: string) {
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

  async function disconnect(profileId: string) {
    // An explicit disconnect also supersedes a connect still opening its
    // tunnel/driver, including one waiting for an older session to tear down.
    connectAttempts.delete(profileId)
    await disconnectActive(profileId)
  }

  // Drops a stale 'error' entry so the status list stops reporting a failure for
  // settings that no longer exist (e.g. after the profile is edited and saved).
  // A live or in-flight connection is left untouched; teardown here is a no-op
  // for a failed connect or transport error (both already cleaned up).
  async function clearError(profileId: string) {
    if (connections.get(profileId)?.phase === 'error') await disconnect(profileId)
  }

  async function connect(profile: ConnectionProfile): Promise<ConnectResult> {
    const attempt = Symbol(profile.id)
    connectAttempts.set(profile.id, attempt)
    await disconnectActive(profile.id)
    // A newer connect may have completed while this call awaited the previous
    // session's teardown. Never let the older call register over it.
    if (connectAttempts.get(profile.id) !== attempt) return { success: false, error: t('connection.superseded') }

    const resources: ConnectionResources = { driver: null, tunnel: null }
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
      return connectAttempts.get(profile.id) === attempt && !!current && attempts.get(current) === attempt
    }

    // Closes only the resources this attempt opened — used on failure and when
    // the attempt is superseded, so a slow tunnel/pool can't outlive its entry.
    const teardown = async () => {
      await resources.driver?.disconnect().catch(() => {})
      await resources.tunnel?.close().catch(() => {})
    }

    // A tunnel that drops after it was established won't recover on its own and
    // takes the pools under it with it, so flag the connection as failed and
    // free everything it held — pools, listener, buffered results — instead of
    // keeping them until the user reconnects. Only the session that actually
    // failed; a reconnect may have already replaced this entry.
    const onTransportError = (message: string) => {
      if (!isCurrent()) return
      sessions.closeProfile(profile.id)
      register({ phase: 'error', profileId: profile.id, error: message, driver: null, tunnel: null })
      // Tunnel first: a pool drain can hang waiting on sockets that ride it.
      void (async () => {
        await resources.tunnel?.close().catch(() => {})
        await resources.driver?.disconnect().catch(() => {})
      })()
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
        return { success: false, error: t('connection.superseded') }
      }
      resources.driver = createDriver(profile, endpoint, { onError: onDriverError })
      if (isCurrent()) register({ phase: 'connecting', profileId: profile.id, ...resources })
      const serverVersion = await resources.driver.connect()
      if (!isCurrent()) {
        await teardown()
        return { success: false, error: t('connection.superseded') }
      }
      register({
        profileId: profile.id,
        phase: 'connected',
        engine: profile.engine,
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
    const profileIds = new Set([...connections.keys(), ...connectAttempts.keys()])
    await Promise.all([...profileIds].map((profileId) => disconnect(profileId)))
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
    filter?: string | null,
    executionId?: string,
  ): Promise<QueryResponse> {
    const driver = connectedDriver(profileId)
    if (!driver) return { success: false, error: t('connection.notConnected') }
    try {
      const raw = await driver.query(sql, params, childDb, sort, filter, executionId)
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
      const cancelled = message === t('query.cancelled')
      // Position mapping only holds when the submitted text was the raw sql;
      // a grid sort/filter rewrite shifts every offset.
      const errorLine = cancelled || sort || filter ? undefined : queryErrorLine(error, sql)
      return {
        success: false,
        error: message,
        ...(errorLine !== undefined ? { errorLine } : {}),
        ...(cancelled ? { cancelled: true } : {}),
      }
    }
  }

  // Atomic write batch: the whole save commits or rolls back on one connection.
  // A connection-level failure (not connected / unsupported) reports no
  // failedIndex, since nothing ran.
  async function runBatch(profileId: string, childDb: string | null, statements: BatchStatement[]): Promise<BatchResult> {
    const driver = connectedDriver(profileId)
    if (!driver) return { success: false, error: t('connection.notConnected') }
    if (!driver.runBatch) return { success: false, error: t('connection.atomicWritesUnsupported') }
    try {
      return await driver.runBatch(statements, childDb)
    } catch (error) {
      return { success: false, error: (error as Error).message }
    }
  }

  // Atomic schema batch: all statements commit or none do, on one connection.
  async function runDdl(profileId: string, childDb: string | null, statements: string[]): Promise<DdlResult> {
    const driver = connectedDriver(profileId)
    if (!driver) return { success: false, error: t('connection.notConnected') }
    if (!driver.runDdl) return { success: false, error: t('connection.schemaChangesUnsupported') }
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
    params: unknown[] | undefined,
    sort: QuerySort | null,
    filter: string | null,
    filePath: string,
    format: ExportFormat,
    sqlTable: TableRef | null,
    executionId?: string,
  ): Promise<{ success: boolean; rowCount?: number; error?: string; cancelled?: boolean }> {
    const active = connections.get(profileId)
    if (active?.phase !== 'connected') return { success: false, error: t('connection.notConnected') }
    const driver = active.driver
    if (!driver.exportQuery) return { success: false, error: t('connection.exportUnsupported') }
    if (!isReadOnlyQuery(sql, active.engine)) return { success: false, error: t('export.readOnlyOnly') }
    // The engine comes from the live connection, never the renderer, so exported
    // literals are always spelled for the database they were read from.
    const sqlTarget = format === 'sql' ? { engine: active.engine, table: sqlTable } : undefined
    try {
      const { rowCount } = await driver.exportQuery({ sql, params: params ?? [], childDb, sort, filter, filePath, format, sqlTarget, executionId })
      return { success: true, rowCount }
    } catch (error) {
      await unlink(filePath).catch(() => {})
      const message = (error as Error).message
      return { success: false, error: message, ...(message === t('query.cancelled') ? { cancelled: true } : {}) }
    }
  }

  // A page of a buffered result; fails when the session is gone (evicted or its
  // connection dropped) so the renderer can fall back instead of seeing 0 rows.
  function fetchRows(sessionId: string, offset: number, limit: number): FetchRowsResult {
    const rows = sessions.fetch(sessionId, offset, limit)
    return rows === null ? { success: false, error: t('results.bufferExpired') } : { success: true, rows }
  }

  const closeSession = (sessionId: string) => sessions.close(sessionId)

  async function cancelQuery(profileId: string, executionId?: string): Promise<{ success: boolean; error?: string }> {
    const driver = connectedDriver(profileId)
    if (!driver?.cancel) return { success: false, error: t('connection.cancelUnsupported') }
    try {
      const { running, cancelled } = await driver.cancel(executionId)
      if (cancelled > 0) return { success: true }
      if (running > 0) {
        return { success: false, error: t('connection.cancelStarting') }
      }
      return { success: false, error: t('connection.noRunningQuery') }
    } catch (error) {
      return { success: false, error: (error as Error).message }
    }
  }

  // Switches the active child database (all-databases mode) and rebroadcasts
  // so every window sees the new inUse flags.
  function setActiveChild(profileId: string, database: string): { success: boolean; error?: string } {
    const active = connections.get(profileId)
    if (!active || active.phase !== 'connected') {
      return { success: false, error: t('connection.notConnected') }
    }
    if (!active.driver.useChild?.(database)) {
      return { success: false, error: t('connection.databaseUnavailable', { database }) }
    }
    broadcast(statuses())
    return { success: true }
  }

  // Create/drop run through the driver (it owns the pools that must close
  // before a drop) and rebroadcast so every window sees the new child list.
  async function mutateDatabase(profileId: string, run: (driver: Driver) => Promise<void> | undefined) {
    const active = connections.get(profileId)
    if (active?.phase !== 'connected') return { success: false, error: t('connection.notConnected') }
    try {
      const pending = run(active.driver)
      if (!pending) return { success: false, error: t('connection.engineUnsupported') }
      await pending
      broadcast(statuses())
      return { success: true }
    } catch (error) {
      return { success: false, error: (error as Error).message }
    }
  }

  const createDatabase = (profileId: string, name: string, options?: DatabaseCreateOptions) =>
    mutateDatabase(profileId, (driver) => driver.createDatabase?.(name, options))

  async function databaseCreateMeta(profileId: string): Promise<DatabaseCreateMetaResult> {
    const driver = connectedDriver(profileId)
    if (!driver) return { success: false, error: t('connection.notConnected') }
    if (!driver.databaseCreateMeta) return { success: false, error: t('connection.engineUnsupported') }
    try {
      return { success: true, meta: await driver.databaseCreateMeta() }
    } catch (error) {
      return { success: false, error: (error as Error).message }
    }
  }

  const dropDatabase = (profileId: string, name: string) =>
    mutateDatabase(profileId, (driver) => driver.dropDatabase?.(name))

  async function listTables(profileId: string, childDb: string | null = null): Promise<TablesResult> {
    const driver = connectedDriver(profileId)
    if (!driver) return { success: false, error: t('connection.notConnected') }
    try {
      return { success: true, tables: await driver.listTables(childDb) }
    } catch (error) {
      return { success: false, error: (error as Error).message }
    }
  }

  async function listObjects(profileId: string, childDb: string | null = null): Promise<ObjectsResult> {
    const driver = connectedDriver(profileId)
    if (!driver) return { success: false, error: t('connection.notConnected') }
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
    if (!driver) return { success: false, error: t('connection.notConnected') }
    if (!driver.inspectObject) return { success: false, error: t('connection.engineUnsupported') }
    try {
      return { success: true, inspection: await driver.inspectObject(object, objectKind, childDb) }
    } catch (error) {
      return { success: false, error: (error as Error).message }
    }
  }

  async function objectDdl(profileId: string, ref: ObjectDdlRef, childDb: string | null = null): Promise<ObjectDdlResult> {
    const driver = connectedDriver(profileId)
    if (!driver) return { success: false, error: t('connection.notConnected') }
    if (!driver.objectDdl) return { success: false, error: t('connection.engineUnsupported') }
    try {
      return { success: true, sql: await driver.objectDdl(ref, childDb) }
    } catch (error) {
      return { success: false, error: (error as Error).message }
    }
  }

  async function inspectServer(profileId: string, childDb: string | null = null): Promise<ServerInfoResult> {
    const driver = connectedDriver(profileId)
    if (!driver) return { success: false, error: t('connection.notConnected') }
    if (!driver.inspectServer) return { success: false, error: t('connection.noServerInfo') }
    try {
      return { success: true, sections: await driver.inspectServer(childDb) }
    } catch (error) {
      return { success: false, error: (error as Error).message }
    }
  }

  async function inspectTable(profileId: string, table: TableRef, childDb: string | null = null): Promise<InspectResult> {
    const driver = connectedDriver(profileId)
    if (!driver) return { success: false, error: t('connection.notConnected') }
    try {
      return { success: true, inspection: await driver.inspectTable(table, childDb) }
    } catch (error) {
      return { success: false, error: (error as Error).message }
    }
  }

  async function listColumns(profileId: string, childDb: string | null = null): Promise<ColumnsResult> {
    const driver = connectedDriver(profileId)
    if (!driver) return { success: false, error: t('connection.notConnected') }
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
    clearError,
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
    objectDdl,
    inspectServer,
    setActiveChild,
    createDatabase,
    databaseCreateMeta,
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
