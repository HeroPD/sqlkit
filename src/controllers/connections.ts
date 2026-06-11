import type { ReactiveController, ReactiveControllerHost } from 'lit'
import type { ConnectionPhase, ConnectionProfile, ConnectionStatus, TableRef } from '../electron'

// Owns the live-connection picture pushed from the main process: statuses by
// profile id, and the table list of every connected database (fetched once
// per connection). Pure data + IPC wrappers — what to render with it is the
// host's business.
export class ConnectionsController implements ReactiveController {
  /** Live status by profile id; profiles without an entry are disconnected. */
  statuses: Record<string, ConnectionStatus> = {}

  /** Tables of connected databases, keyed by profile id. */
  tables: Record<string, TableRef[]> = {}

  private host: ReactiveControllerHost
  private unsubscribe: (() => void) | null = null

  constructor(host: ReactiveControllerHost) {
    this.host = host
    host.addController(this)
  }

  hostConnected() {
    this.unsubscribe = window.sqlkit.onConnectionStatus((statuses) => this.apply(statuses))
    void window.sqlkit.getConnectionStatuses().then((statuses) => this.apply(statuses))
  }

  hostDisconnected() {
    this.unsubscribe?.()
    this.unsubscribe = null
  }

  phase(profileId: string): ConnectionPhase | null {
    return this.statuses[profileId]?.phase ?? null
  }

  connected(): ConnectionStatus[] {
    return Object.values(this.statuses).filter((status) => status.phase === 'connected')
  }

  connect(profile: ConnectionProfile) {
    return window.sqlkit.connectDatabase(profile)
  }

  disconnect(profileId: string) {
    return window.sqlkit.disconnectDatabase(profileId)
  }

  disconnectAll() {
    return window.sqlkit.disconnectAllDatabases()
  }

  private apply(statuses: ConnectionStatus[]) {
    const byId: Record<string, ConnectionStatus> = {}
    for (const status of statuses) byId[status.profileId] = status
    this.statuses = byId

    // Keep table lists only for still-connected databases, and fetch for
    // freshly connected ones.
    const tables: Record<string, TableRef[]> = {}
    for (const [id, list] of Object.entries(this.tables)) {
      if (byId[id]?.phase === 'connected') tables[id] = list
    }
    this.tables = tables
    for (const status of statuses) {
      if (status.phase === 'connected' && !(status.profileId in this.tables)) {
        void this.loadTables(status.profileId)
      }
    }
    this.host.requestUpdate()
  }

  private async loadTables(profileId: string) {
    const result = await window.sqlkit.listTables(profileId)
    if (result.success && this.statuses[profileId]?.phase === 'connected') {
      this.tables = { ...this.tables, [profileId]: result.tables }
      this.host.requestUpdate()
    }
  }
}
