import type {
  ConnectResult,
  ConnectionProfile,
  ConnectionStatus,
  QueryResponse,
  TablesResult,
  TestConnectionResult,
} from '../../src/electron'
import { createDriver, type Driver } from './driver'
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
    await active.driver?.disconnect().catch(() => {})
    await active.tunnel?.close().catch(() => {})
  }

  async function connect(profile: ConnectionProfile): Promise<ConnectResult> {
    await disconnect(profile.id)

    const active: Active = { driver: null, tunnel: null, status: { profileId: profile.id, phase: 'connecting' } }
    connections.set(profile.id, active)
    broadcast(statuses())

    // Only flag the session that actually failed; a reconnect may have
    // already replaced this entry.
    const onError = (message: string) => {
      if (connections.get(profile.id) === active) {
        setStatus(active, { profileId: profile.id, phase: 'error', error: message })
      }
    }

    try {
      const endpoint = await resolveEndpoint(profile, onError)
      active.tunnel = endpoint.tunnel
      active.driver = createDriver(profile, endpoint, { onError })
      const serverVersion = await active.driver.connect()
      setStatus(active, {
        profileId: profile.id,
        phase: 'connected',
        serverVersion,
        tunneled: active.tunnel !== null,
      })
      return { success: true, serverVersion }
    } catch (error) {
      const message = (error as Error).message
      setStatus(active, { profileId: profile.id, phase: 'error', error: message })
      // A failed connect must not leak the pool or the tunnel under it.
      await active.driver?.disconnect().catch(() => {})
      await active.tunnel?.close().catch(() => {})
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

  async function query(profileId: string, sql: string, params?: unknown[]): Promise<QueryResponse> {
    const driver = connectedDriver(profileId)
    if (!driver) return { success: false, error: 'Not connected' }
    try {
      return { success: true, result: await driver.query(sql, params) }
    } catch (error) {
      return { success: false, error: (error as Error).message }
    }
  }

  async function listTables(profileId: string): Promise<TablesResult> {
    const driver = connectedDriver(profileId)
    if (!driver) return { success: false, error: 'Not connected' }
    try {
      return { success: true, tables: await driver.listTables() }
    } catch (error) {
      return { success: false, error: (error as Error).message }
    }
  }

  return { connect, disconnect, disconnectAll, statuses, query, listTables }
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
