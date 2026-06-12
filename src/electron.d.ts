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
  rows: unknown[][]
  /** Rows returned for reads, rows affected for writes. */
  rowCount: number
  durationMs: number
  /** Rows were capped before crossing IPC; rowCount still reports the full count. */
  truncated?: boolean
}

export type QueryResponse = { success: true; result: QueryResult } | { success: false; error: string }

export type TableRef = {
  /** Namespace of the table (Postgres schema); null for engines without one. */
  schema: string | null
  name: string
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
  getRecentWorkspaces: () => Promise<RecentWorkspace[]>
  getWorkspaceConfig: () => Promise<WorkspaceConfig>
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
  runQuery: (profileId: string, sql: string, params?: unknown[]) => Promise<QueryResponse>
  /** Cancels the profile's in-flight query; the pending runQuery rejects. */
  cancelQuery: (profileId: string) => Promise<{ success: boolean; error?: string }>
  /** Server-side CREATE DATABASE on a connected profile (postgres only). */
  createDatabase: (profileId: string, name: string) => Promise<{ success: boolean; error?: string }>
  /** Server-side DROP DATABASE; refuses the connection's in-use child. */
  dropDatabase: (profileId: string, name: string) => Promise<{ success: boolean; error?: string }>
  listTables: (profileId: string) => Promise<TablesResult>
  /** Columns of every table in the connected database, one round trip. */
  listColumns: (profileId: string) => Promise<ColumnsResult>
  pickSqliteFile: () => Promise<string | null>
  /** Lists the .sql files of one database context's workspace subfolder. */
  listFiles: (folder: string) => Promise<FilesResult>
  readFile: (path: string) => Promise<FileReadResult>
  saveFile: (path: string, content: string) => Promise<FileSaveResult>
  /** Native save dialog defaulting into a database context's folder. */
  saveFileAs: (folder: string, suggestedName: string, content: string) => Promise<FileSaveResult>
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
