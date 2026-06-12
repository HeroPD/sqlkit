import type { ReactiveController, ReactiveControllerHost } from 'lit'
import type { ColumnRef, ConnectionPhase, ConnectionProfile, ConnectionStatus, DbObjects, TableRef } from '../electron'

// Owns the live-connection picture pushed from the main process: statuses by
// profile id, and the table/column metadata of every connected database
// (fetched once per connection). Pure data + IPC wrappers — what to render
// with it is the host's business.
export class ConnectionsController implements ReactiveController {
  /** Live status by profile id; profiles without an entry are disconnected. */
  statuses: Record<string, ConnectionStatus> = {}

  /** Tables of connected databases, keyed by profile id. */
  tables: Record<string, TableRef[]> = {}

  /** Columns of every table, keyed by profile id (loaded with the tables). */
  columns: Record<string, ColumnRef[]> = {}

  /** Schema objects (functions, types), keyed by profile id. */
  objects: Record<string, DbObjects> = {}

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

  /** Re-fetches a connected database's tables and columns. */
  refresh(profileId: string) {
    if (this.statuses[profileId]?.phase !== 'connected') return
    void this.loadTables(profileId)
  }

  /** Switches an all-databases connection's active child and refetches its metadata. */
  async setActiveChild(profileId: string, database: string) {
    const result = await window.sqlkit.setActiveChildDb(profileId, database)
    if (result.success) {
      const tables = { ...this.tables }
      delete tables[profileId]
      this.tables = tables
      const columns = { ...this.columns }
      delete columns[profileId]
      this.columns = columns
      const objects = { ...this.objects }
      delete objects[profileId]
      this.objects = objects
      this.host.requestUpdate()
      void this.loadTables(profileId)
    }
    return result
  }

  private apply(statuses: ConnectionStatus[]) {
    const byId: Record<string, ConnectionStatus> = {}
    for (const status of statuses) byId[status.profileId] = status
    this.statuses = byId

    // Keep metadata only for still-connected databases, and fetch for
    // freshly connected ones.
    const tables: Record<string, TableRef[]> = {}
    const columns: Record<string, ColumnRef[]> = {}
    const objects: Record<string, DbObjects> = {}
    for (const [id, list] of Object.entries(this.tables)) {
      if (byId[id]?.phase === 'connected') tables[id] = list
    }
    for (const [id, list] of Object.entries(this.columns)) {
      if (byId[id]?.phase === 'connected') columns[id] = list
    }
    for (const [id, list] of Object.entries(this.objects)) {
      if (byId[id]?.phase === 'connected') objects[id] = list
    }
    this.tables = tables
    this.columns = columns
    this.objects = objects
    for (const status of statuses) {
      if (status.phase === 'connected' && !(status.profileId in this.tables)) {
        void this.loadTables(status.profileId)
      }
    }
    this.host.requestUpdate()
  }

  private async loadTables(profileId: string) {
    const [tables, columns, objects] = await Promise.all([
      window.sqlkit.listTables(profileId),
      window.sqlkit.listColumns(profileId),
      window.sqlkit.listObjects(profileId),
    ])
    if (this.statuses[profileId]?.phase !== 'connected') return
    if (tables.success) this.tables = { ...this.tables, [profileId]: tables.tables }
    if (columns.success) this.columns = { ...this.columns, [profileId]: columns.columns }
    if (objects.success) this.objects = { ...this.objects, [profileId]: objects.objects }
    if (tables.success || columns.success || objects.success) this.host.requestUpdate()
  }
}
