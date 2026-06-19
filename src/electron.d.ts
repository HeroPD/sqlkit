export type RecentWorkspace = {
  name: string
  path: string
  lastOpened: string
}

export type WorkspaceResult =
  | { success: true; path: string; name: string }
  | { success: false; canceled?: boolean; error?: string }

export type Engine = 'postgresql' | 'sqlite' | 'mysql' | 'sqlserver'

/**
 * single — the connection stays on its one configured database.
 * all — list every database on the server as runtime children; one is active
 * at a time and queries/tables target it.
 */
export type DatabaseMode = 'single' | 'all'

export type ChildDb = { name: string; inUse: boolean }

export type SshAuthType = 'password' | 'key'

export type SslMode = 'disable' | 'require' | 'verify-ca' | 'verify-full'

export type SslConfig = {
  /** disable = plain TCP; require = encrypted without certificate verification. */
  mode: SslMode
  /** Optional CA certificate file path for verify-ca / verify-full. Supports a leading ~. */
  ca: string
}

export type SshConfig = {
  enabled: boolean
  host: string
  port: string
  username: string
  authType: SshAuthType
  password: string
  /** Private key file path; supports a leading ~. */
  keyPath: string
  passphrase: string
}

export type ConnectionProfile = {
  id: string
  name: string
  engine: Engine
  host: string
  port: string
  username: string
  password: string
  database: string
  /** Absent means 'single'. */
  databaseMode?: DatabaseMode
  /** Last child database the user worked in (all-databases mode). */
  lastChildDb?: string
  /** Database file path; only meaningful for file-based engines (sqlite). */
  file: string
  /**
   * Workspace subfolder holding this connection's .sql files, so files never
   * mix between database contexts. Assigned from the name on first save and
   * then left untouched (renames don't move files).
   */
  folder: string
  /** TLS settings for server-based engines; absent means SSL disabled. */
  ssl?: SslConfig
  /** SSH tunnel settings; absent means a direct connection. */
  ssh?: SshConfig
}

export type WorkspaceConfig = {
  version: number
  connections: ConnectionProfile[]
  /** The in-use database context (⌘K); restored on workspace open. */
  activeDbId?: string | null
}

export type SaveResult = { success: true } | { success: false; error: string }

export type WorkspaceConfigResult = {
  config: WorkspaceConfig
  /** Set when an existing config file couldn't be read/parsed; the file is left untouched. */
  error?: string
}

// --- Live connections ---------------------------------------------------

export type ConnectionPhase = 'connecting' | 'connected' | 'error'

/** Status of one live connection; profiles with no status are disconnected. */
export type ConnectionStatus = {
  profileId: string
  phase: ConnectionPhase
  serverVersion?: string
  /** True when the connection runs through an SSH tunnel. */
  tunneled?: boolean
  /** Child databases (all-databases mode); exactly one is inUse. */
  children?: ChildDb[]
  error?: string
}

export type ConnectResult = { success: true; serverVersion: string } | { success: false; error: string }

export type TestConnectionResult =
  | { success: true; serverVersion: string; tookMs: number }
  | { success: false; error: string; tookMs: number }

export type TestSshResult = { success: true; tookMs: number } | { success: false; error: string; tookMs: number }

export type QueryResult = {
  columns: string[]
  /** The first page when a session exists (paged via fetchRows); all buffered rows otherwise. */
  rows: unknown[][]
  /** Rows returned for reads, rows affected for writes. */
  rowCount: number
  durationMs: number
  /** Result exceeded the buffer cap; rowCount still reports the full count. */
  truncated?: boolean
  /** Set when more rows are buffered in the main process than were sent; page them via fetchRows. */
  sessionId?: string
  /** Total rows buffered in the main process (>= rows.length); present with sessionId. */
  bufferedRowCount?: number
}

export type QueryResponse = { success: true; result: QueryResult } | { success: false; error: string }

export type FetchRowsResult = { success: true; rows: unknown[][] } | { success: false; error: string }

/** Partitioned tables count as plain tables — partitioning is hidden anyway. */
export type TableKind = 'table' | 'view' | 'matview' | 'foreign'

export type TableRef = {
  /** Namespace of the table (Postgres schema); null for engines without one. */
  schema: string | null
  name: string
  kind: TableKind
}

export type TablesResult = { success: true; tables: TableRef[] } | { success: false; error: string }

export type ColumnRef = {
  /** Schema of the owning table; null for engines without one. */
  schema: string | null
  table: string
  name: string
  dataType: string
  nullable: boolean
  primaryKey: boolean
  /** Member of a foreign-key constraint referencing another table. */
  foreignKey: boolean
}

export type ColumnsResult = { success: true; columns: ColumnRef[] } | { success: false; error: string }

/** A named schema-scoped object (function, type, …) for the explorer lists. */
export type DbObject = {
  schema: string | null
  name: string
  /** Function arg signature, or the type's flavor (enum/domain/…). */
  detail: string
}

export type DbObjects = { functions: DbObject[]; types: DbObject[] }

export type DbObjectKind = 'function' | 'type'

export type ObjectsResult = { success: true; objects: DbObjects } | { success: false; error: string }

export type InspectColumn = {
  name: string
  dataType: string
  nullable: boolean
  default: string | null
  primaryKey: boolean
}

/** One named-rows block of a table inspection (Indexes, Triggers, …).
 * Engines supply whichever sections they have; empty ones are omitted. */
export type InspectSection = { title: string; rows: Array<{ name: string; definition: string }> }

export type TableInspection = { columns: InspectColumn[]; sections: InspectSection[] }

export type InspectResult = { success: true; inspection: TableInspection } | { success: false; error: string }

export type ServerInfoResult = { success: true; sections: InspectSection[] } | { success: false; error: string }

// --- Workspace files ------------------------------------------------------

export type FileInfo = {
  type: 'file' | 'folder'
  name: string
  /** Absolute path. */
  path: string
  /** Path relative to the workspace root, '/'-separated. */
  relativePath: string
}

export type FilesResult = { success: true; files: FileInfo[] } | { success: false; error: string }

export type FileReadResult = { success: true; content: string } | { success: false; error: string }

export type FileSaveResult =
  | { success: true; path: string; name: string }
  | { success: false; canceled?: boolean; error?: string }

export type FileDeleteResult = { success: true } | { success: false; canceled?: boolean; error?: string }

export type SqlkitApi = {
  openWorkspace: () => Promise<WorkspaceResult>
  openWorkspacePath: (path: string) => Promise<WorkspaceResult>
  closeWorkspace: () => Promise<void>
  newWindow: () => Promise<void>
  getRecentWorkspaces: () => Promise<RecentWorkspace[]>
  getWorkspaceConfig: () => Promise<WorkspaceConfigResult>
  saveWorkspaceConfig: (config: WorkspaceConfig) => Promise<SaveResult>
  testConnection: (profile: ConnectionProfile) => Promise<TestConnectionResult>
  testSshTunnel: (profile: ConnectionProfile) => Promise<TestSshResult>
  connectDatabase: (profile: ConnectionProfile) => Promise<ConnectResult>
  disconnectDatabase: (profileId: string) => Promise<void>
  /** Switches the active child database of an all-databases connection. */
  setActiveChildDb: (profileId: string, database: string) => Promise<{ success: boolean; error?: string }>
  disconnectAllDatabases: () => Promise<void>
  getConnectionStatuses: () => Promise<ConnectionStatus[]>
  /** Subscribes to status pushes from the main process; returns unsubscribe. */
  onConnectionStatus: (listener: (statuses: ConnectionStatus[]) => void) => () => void
  runQuery: (profileId: string, childDb: string | null, sql: string, params?: unknown[]) => Promise<QueryResponse>
  /** A page of a buffered result; rows beyond the first page are pulled on demand. */
  fetchRows: (sessionId: string, offset: number, limit: number) => Promise<FetchRowsResult>
  /** Releases a result's main-process buffer (tab closed / superseded). */
  closeSession: (sessionId: string) => Promise<void>
  /** Cancels the profile's in-flight query; the pending runQuery rejects. */
  cancelQuery: (profileId: string) => Promise<{ success: boolean; error?: string }>
  /** Server-side CREATE DATABASE on a connected profile (postgres only). */
  createDatabase: (profileId: string, name: string) => Promise<{ success: boolean; error?: string }>
  /** Server-side DROP DATABASE; refuses the connection's in-use child. */
  dropDatabase: (profileId: string, name: string) => Promise<{ success: boolean; error?: string }>
  listTables: (profileId: string) => Promise<TablesResult>
  /** Columns of every table in the connected database, one round trip. */
  listColumns: (profileId: string) => Promise<ColumnsResult>
  /** Structure of one table: columns, constraints, indexes, triggers, …. */
  inspectTable: (profileId: string, table: TableRef) => Promise<InspectResult>
  /** Schema-scoped objects (functions, types) for the explorer. */
  listObjects: (profileId: string) => Promise<ObjectsResult>
  /** Structure of one function/type: definition, values, attributes. Reuses
   * the table-inspection shape (columns for composites, sections for the rest). */
  inspectObject: (profileId: string, object: DbObject, objectKind: DbObjectKind) => Promise<InspectResult>
  /** Server/cluster-scoped reference: extensions, roles, tablespaces, settings. */
  inspectServer: (profileId: string) => Promise<ServerInfoResult>
  pickSqliteFile: () => Promise<string | null>
  /** Lists the .sql files of one database context's workspace subfolder. */
  listFiles: (folder: string) => Promise<FilesResult>
  readFile: (path: string) => Promise<FileReadResult>
  saveFile: (path: string, content: string) => Promise<FileSaveResult>
  /** Native save dialog defaulting into a database context's folder. */
  saveFileAs: (folder: string, suggestedName: string, content: string) => Promise<FileSaveResult>
  /** Save-dialog export to anywhere on disk (results CSV, not workspace files). */
  exportFile: (
    suggestedName: string,
    content: string,
  ) => Promise<{ success: boolean; canceled?: boolean; error?: string }>
  /** Creates an empty .sql file at folder/relativePath; fails if it exists. */
  createFile: (folder: string, relativePath: string) => Promise<FileSaveResult>
  /** Renames a file in place (same directory). */
  renameFile: (path: string, newName: string) => Promise<FileSaveResult>
  /** Confirms, then moves a workspace file or folder to the Trash. */
  deleteFile: (path: string) => Promise<FileDeleteResult>
  /** Opens a workspace file with the system default app (non-.sql files). */
  openExternal: (path: string) => Promise<{ success: boolean; error?: string }>
  /** Fires when .sql files in the workspace change on disk; returns unsubscribe. */
  onFilesChanged: (listener: () => void) => () => void
  /** Fires on app-menu items (File > New Query / Save / …); returns unsubscribe. */
  onMenuAction: (listener: (action: MenuAction) => void) => () => void
}

/** Action ids the app menu sends over `app:menu`. */
export type MenuAction = 'new-query' | 'save' | 'save-as' | 'close-tab'

declare global {
  interface Window {
    sqlkit: SqlkitApi
  }
}
