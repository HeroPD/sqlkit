import type { ReactiveController, ReactiveControllerHost } from 'lit'
import type { ColumnRef, ConnectionPhase, ConnectionProfile, ConnectResult, ConnectionStatus, DbObjects, TableRef, TableStat } from '../electron'

const activeChildName = (status: ConnectionStatus | undefined): string | null =>
  status?.phase === 'connected' ? (status.children?.find((child) => child.inUse)?.name ?? null) : null

/** Identity of a table list, so sizes can be re-read only when it changes. */
const tableListKey = (tables: TableRef[]): string => tables.map((table) => `${table.schema ?? ''}.${table.name}`).join('\n')

/** What was last read for one database, so returning to it renders at once. */
type DatabaseMetadata = {
  tables?: TableRef[]
  columns?: ColumnRef[]
  tableStats?: TableStat[]
  objects?: DbObjects
  statsKey?: string
}

// Databases remembered per connection, least-recently-used first: the handful
// a session moves between, not every column of a whole server.
const REMEMBERED_DATABASES = 12

const withEntry = <T>(map: Record<string, T>, id: string, value: T | undefined): Record<string, T> => {
  const next = { ...map }
  if (value === undefined) delete next[id]
  else next[id] = value
  return next
}

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

  /**
   * Allocated sizes, keyed by profile id. An absent entry means the engine
   * cannot report them (SQLite) or the read was refused — the explorer drops
   * its size column rather than ruling a dash down every row.
   */
  tableStats: Record<string, TableStat[]> = {}

  /** Schema objects (functions, types), keyed by profile id. */
  objects: Record<string, DbObjects> = {}

  private host: ReactiveControllerHost
  private unsubscribe: (() => void) | null = null
  /** Per-profile metadata-load token; a newer load invalidates older ones. */
  private metaGen: Record<string, number> = {}
  /** The table list each profile's sizes were read for, so an unchanged list skips the re-read. */
  private statsKey: Record<string, string> = {}
  /** Metadata of every database visited on a connection, so switching back to
   * one shows its tree at once. Dropped with the connection it came from. */
  private remembered = new Map<string, Map<string, DatabaseMetadata>>()
  /** Which child database each profile's visible metadata describes. */
  private metaChild: Record<string, string | null> = {}
  /** In-flight connect per profile, so two cold tabs don't open two tunnels/pools. */
  private connecting = new Map<string, Promise<ConnectResult>>()
  /**
   * Metadata reads run one at a time per profile, with at most one more queued.
   *
   * A driver keeps a pool for the child in use and retires the others, so two
   * loads for different children retire each other's pool and both come back
   * "Pool is closed" — for a database that has tables. Overlapping loads were
   * never wanted anyway: only the newest one's answer is kept.
   */
  private loading = new Set<string>()
  private queued = new Set<string>()

  constructor(host: ReactiveControllerHost) {
    this.host = host
    host.addController(this)
  }

  hostConnected() {
    this.unsubscribe = window.sqlkit.onConnectionStatus((statuses) => this.apply(statuses))
    void window.sqlkit.getConnectionStatuses().then((statuses) => this.apply(statuses)).catch(() => {})
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

  connect(profile: ConnectionProfile): Promise<ConnectResult> {
    // Coalesce concurrent connects for the same profile (two cold tabs running
    // at once) onto a single attempt; otherwise each opens its own SSH tunnel
    // and pool, and the manager tears one back down after the handshake.
    const inFlight = this.connecting.get(profile.id)
    if (inFlight) return inFlight
    const attempt: Promise<ConnectResult> = this.runConnect(profile).finally(() => {
      // Only clear our own entry: a disconnect (which drops the entry) followed
      // by a fresh connect may have replaced it, and that newer attempt must survive.
      if (this.connecting.get(profile.id) === attempt) this.connecting.delete(profile.id)
    })
    this.connecting.set(profile.id, attempt)
    return attempt
  }

  private async runConnect(profile: ConnectionProfile): Promise<ConnectResult> {
    const result = await window.sqlkit.connectDatabase(profile)
    // The status push (with the connection's child databases) is a separate
    // IPC message that may not have landed when this resolves; pull the fresh
    // statuses so a caller that aligns the active child right after sees them.
    if (result.success) this.apply(await window.sqlkit.getConnectionStatuses())
    return result
  }

  disconnect(profileId: string) {
    // Drop any in-flight connect so a connect after this disconnect starts a
    // fresh attempt instead of resolving with the one being torn down.
    this.connecting.delete(profileId)
    return window.sqlkit.disconnectDatabase(profileId)
  }

  disconnectAll() {
    this.connecting.clear()
    return window.sqlkit.disconnectAllDatabases()
  }

  /** Clears a stale error status (e.g. after the profile's config is re-saved). */
  clearError(profileId: string) {
    if (this.statuses[profileId]?.phase !== 'error') return Promise.resolve()
    return window.sqlkit.clearConnectionError(profileId)
  }

  /** Re-fetches a connected database's tables and columns. */
  refresh(profileId: string) {
    if (this.statuses[profileId]?.phase !== 'connected') return
    void this.queueLoad(profileId)
  }

  /** The open manual transaction on this connection, if any. */
  transaction(profileId: string) {
    const status = this.statuses[profileId]
    return status?.phase === 'connected' ? status.transaction : undefined
  }

  /** The read-only guardrail the live session enforces — not what the saved
   * profile asks for, which only applies on the next connect. */
  readOnly(profileId: string): boolean {
    const status = this.statuses[profileId]
    return status?.phase === 'connected' ? status.readOnly === true : false
  }

  /** Commits or rolls back the open manual transaction. */
  async endTransaction(profileId: string, mode: 'commit' | 'rollback') {
    const result = await window.sqlkit.endTransaction(profileId, mode)
    // Fully committed work changes what the schema tree and grids should
    // believe. A nested SQL Server commit leaves the outer transaction open,
    // so its deferred refresh must stay deferred too.
    if (result.success && !result.transaction) this.refresh(profileId)
    return result
  }

  /** Switches an all-databases connection's active child and refetches its metadata. */
  async setActiveChild(profileId: string, database: string) {
    const result = await window.sqlkit.setActiveChildDb(profileId, database)
    if (result.success) {
      // Same reason as runConnect: the status naming the new in-use child is a
      // separate push. A caller that reads inUseChild() right after this
      // resolves — connect does, to pick the context — would otherwise pick the
      // database we just switched away from, and then disagree with the driver.
      this.apply(await window.sqlkit.getConnectionStatuses())
      // apply() swaps this profile's metadata when it sees the child change;
      // force it only when the status did not report one.
      if (profileId in this.metaChild && this.metaChild[profileId] !== database) {
        this.showMetadata(profileId, database)
        this.host.requestUpdate()
        void this.queueLoad(profileId)
      }
    }
    return result
  }

  private apply(statuses: ConnectionStatus[]) {
    const byId: Record<string, ConnectionStatus> = {}
    for (const status of statuses) byId[status.profileId] = status
    const live = (id: string) => byId[id]?.phase === 'connected'

    this.statuses = byId

    // Keep metadata only for still-connected databases, and fetch for
    // freshly connected ones.
    const tables: Record<string, TableRef[]> = {}
    const columns: Record<string, ColumnRef[]> = {}
    const tableStats: Record<string, TableStat[]> = {}
    const objects: Record<string, DbObjects> = {}
    for (const [id, list] of Object.entries(this.tables)) if (live(id)) tables[id] = list
    for (const [id, list] of Object.entries(this.columns)) if (live(id)) columns[id] = list
    for (const [id, list] of Object.entries(this.tableStats)) if (live(id)) tableStats[id] = list
    for (const [id, list] of Object.entries(this.objects)) if (live(id)) objects[id] = list
    // Drop the cached list identity wherever the sizes went, so a reconnect
    // onto the same schema reads them again instead of skipping as unchanged.
    for (const id of Object.keys(this.statsKey)) {
      if (!(id in tableStats)) delete this.statsKey[id]
    }
    this.tables = tables
    this.columns = columns
    this.tableStats = tableStats
    this.objects = objects
    for (const id of [...this.remembered.keys()]) if (!live(id)) this.remembered.delete(id)
    for (const id of Object.keys(this.metaChild)) if (!live(id)) delete this.metaChild[id]

    for (const status of statuses) {
      if (status.phase !== 'connected') continue
      const id = status.profileId
      // The active child moved: show it as last seen, reload underneath.
      const switched = id in this.metaChild && this.metaChild[id] !== activeChildName(status)
      if (switched) this.showMetadata(id, activeChildName(status))
      if (switched || !(id in this.tables)) void this.queueLoad(id)
    }
    this.host.requestUpdate()
  }

  /**
   * Runs a metadata load, or marks one to follow if this profile is mid-read.
   * The follow-up re-reads whatever child is current when it starts, so a
   * request made during a load is never simply dropped.
   */
  private async queueLoad(profileId: string) {
    if (this.loading.has(profileId)) {
      this.queued.add(profileId)
      return
    }
    this.loading.add(profileId)
    try {
      await this.loadTables(profileId)
    } finally {
      this.loading.delete(profileId)
      if (this.queued.delete(profileId)) void this.queueLoad(profileId)
    }
  }

  private async loadTables(profileId: string) {
    // Tag this load; a newer one (child switch, refresh, reconnect) for the
    // same profile supersedes it, so a slower earlier response can't overwrite
    // the newer child's metadata.
    const gen = (this.metaGen[profileId] = (this.metaGen[profileId] ?? 0) + 1)
    // Pin the fetch to the child we believe is active, so a concurrent child
    // switch can't make the main process answer for a different database.
    const childDb = activeChildName(this.statuses[profileId])
    let tables: Awaited<ReturnType<typeof window.sqlkit.listTables>>
    let columns: Awaited<ReturnType<typeof window.sqlkit.listColumns>>
    let objects: Awaited<ReturnType<typeof window.sqlkit.listObjects>>
    // Sequential, not Promise.all: three concurrent reads made the driver open
    // three connections for what is otherwise a one-connection job, and a GUI on
    // a shared server should not spend its whole budget listing tables.
    try {
      tables = await window.sqlkit.listTables(profileId, childDb)
      columns = await window.sqlkit.listColumns(profileId, childDb)
      objects = await window.sqlkit.listObjects(profileId, childDb)
    } catch {
      return
    }
    if (this.metaGen[profileId] !== gen) return
    if (this.statuses[profileId]?.phase !== 'connected') return
    this.metaChild[profileId] = childDb
    if (tables.success) this.tables = { ...this.tables, [profileId]: tables.tables }
    if (columns.success) this.columns = { ...this.columns, [profileId]: columns.columns }
    if (objects.success) this.objects = { ...this.objects, [profileId]: objects.objects }
    if (tables.success || columns.success || objects.success) {
      this.remember(profileId, childDb, {
        ...(tables.success ? { tables: tables.tables } : {}),
        ...(columns.success ? { columns: columns.columns } : {}),
        ...(objects.success ? { objects: objects.objects } : {}),
      })
      this.host.requestUpdate()
    }

    // Storage statistics are optional and sometimes permission-gated. Essential
    // explorer metadata is already visible before this best-effort read starts.
    //
    // Sizing every relation is the most expensive metadata read there is — on
    // Postgres it stats each one on disk — and refresh() runs after every
    // committed transaction. So it is re-read only when the table list itself
    // changed shape; rows added to a table already listed move its size too
    // little to be worth a full scan per commit.
    const key = tables.success ? tableListKey(tables.tables) : null
    if (key === null || this.statsKey[profileId] === key) return
    let stats: Awaited<ReturnType<typeof window.sqlkit.listTableStats>>
    try {
      stats = await window.sqlkit.listTableStats(profileId, childDb)
    } catch {
      return
    }
    if (this.metaGen[profileId] !== gen || this.statuses[profileId]?.phase !== 'connected') return
    // Leave the entry absent when sizes are unavailable, so the explorer can
    // tell "this engine has no sizes" from "every table is empty".
    if (!stats.success) return
    this.statsKey[profileId] = key
    this.tableStats = { ...this.tableStats, [profileId]: stats.stats }
    this.remember(profileId, childDb, { tableStats: stats.stats, statsKey: key })
    this.host.requestUpdate()
  }

  /** Points a profile's visible metadata at `childDb`: what that database
   * looked like when last read, or nothing on a first visit. */
  private showMetadata(profileId: string, childDb: string | null) {
    // A load already in flight was reading the database being left.
    this.metaGen[profileId] = (this.metaGen[profileId] ?? 0) + 1
    const entry = this.recall(profileId, childDb)
    this.metaChild[profileId] = childDb
    this.tables = withEntry(this.tables, profileId, entry?.tables)
    this.columns = withEntry(this.columns, profileId, entry?.columns)
    this.tableStats = withEntry(this.tableStats, profileId, entry?.tableStats)
    this.objects = withEntry(this.objects, profileId, entry?.objects)
    if (entry?.statsKey === undefined) delete this.statsKey[profileId]
    else this.statsKey[profileId] = entry.statsKey
  }

  /** One database's remembered metadata, moved to most-recently-used. */
  private recall(profileId: string, childDb: string | null): DatabaseMetadata | undefined {
    const byChild = this.remembered.get(profileId)
    const key = childDb ?? ''
    const entry = byChild?.get(key)
    if (byChild && entry) {
      byChild.delete(key)
      byChild.set(key, entry)
    }
    return entry
  }

  private remember(profileId: string, childDb: string | null, patch: DatabaseMetadata) {
    const byChild = this.remembered.get(profileId) ?? new Map<string, DatabaseMetadata>()
    this.remembered.set(profileId, byChild)
    const key = childDb ?? ''
    // A partial read keeps what the last one saw, as the visible metadata does.
    const entry = { ...byChild.get(key), ...patch }
    byChild.delete(key)
    byChild.set(key, entry)
    for (const oldest of byChild.keys()) {
      if (byChild.size <= REMEMBERED_DATABASES) break
      byChild.delete(oldest)
    }
  }
}
