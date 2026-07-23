import type { ExportFormat } from './result-export'

export type RecentWorkspace = {
  name: string
  path: string
  lastOpened: string
}

export type WorkspaceResult =
  | { success: true; path: string; name: string }
  | { success: false; canceled?: boolean; error?: string }

export type Engine = 'postgresql' | 'sqlite' | 'mysql' | 'sqlserver'

/** Branding variant of a wire-compatible engine; all behavior comes from `engine`. */
export type EngineFlavor = 'supabase' | 'mariadb'

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
  /** Main-process credential store has a password; the value is redacted in renderer DTOs. */
  passwordSaved?: boolean
  /** Private key file path; supports a leading ~. */
  keyPath: string
  passphrase: string
  /** Main-process credential store has a passphrase; the value is redacted in renderer DTOs. */
  passphraseSaved?: boolean
}

export type ConnectionProfile = {
  id: string
  name: string
  engine: Engine
  /** Set when the user picked a compatible variant (Supabase, MariaDB) in the
   *  engine list; presentational only — drivers and dialects key on `engine`. */
  flavor?: EngineFlavor
  host: string
  port: string
  username: string
  password: string
  /** Main-process credential store has a password; the value is redacted in renderer DTOs. */
  passwordSaved?: boolean
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
  /** True when the loaded config holds secrets stored unencrypted (no OS key store). */
  unencryptedSecrets?: boolean
  /** Linux safeStorage is using basic_text rather than a real keyring. */
  weakCredentialStorage?: boolean
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

export type QueryResultSet = {
  columns: string[]
  /** Origin of each result column when the driver can identify it; nulls are expressions. */
  columnSources?: Array<{ schema: string | null; table: string | null; column: string | null }>
  /** The first page when a session exists (paged via fetchRows); all buffered rows otherwise. */
  rows: unknown[][]
  /** Rows returned for reads, rows affected for writes. */
  rowCount: number
  /** Result exceeded the buffer cap. */
  truncated?: boolean
  /** False when execution was stopped at the cap and rowCount is only a lower bound. */
  rowCountExact?: boolean
  /** Set when more rows are buffered in the main process than were sent. */
  sessionId?: string
  /** Total rows available through fetchRows; present with sessionId. */
  bufferedRowCount?: number
}

export type QueryResult = QueryResultSet & {
  durationMs: number
  /** Every result set in statement order when a script produced more than one. */
  resultSets?: QueryResultSet[]
}

/** `cancelled` marks a run stopped by the user, so callers never have to
 * pattern-match the human-readable error text. `errorLine` is the 1-based line
 * within the submitted SQL, when the engine reported a usable position. */
export type QueryResponse = { success: true; result: QueryResult } | { success: false; error: string; cancelled?: boolean; errorLine?: number }

/** One entry of the per-workspace query history (persisted in .sqlkit/history.json). */
export type HistoryItem = {
  id: string
  /** The context (connection + child) that ran the query. */
  contextKey: string
  sql: string
  success: boolean
  durationMs: number
  rowCount: number | null
  error: string
  createdAt: string
}

/** One parameterized statement in an atomic write batch. */
export type BatchStatement = {
  sql: string
  params: unknown[]
  /** Exact affected-row count required for optimistic writes. */
  expectedRows?: number
}

/** Outcome of an atomic write batch: every statement committed, or none did.
 * `failedIndex` points at the statement that aborted it (absent for a
 * connection-level failure that ran nothing). */
export type BatchResult = { success: true } | { success: false; error: string; failedIndex?: number }

/** Outcome of an atomic DDL batch: same shape as BatchResult, but DDL statements
 * legitimately affect zero rows so there's no rows-affected gate. */
export type DdlResult =
  | { success: true }
  | { success: false; error: string; failedIndex?: number; partial?: boolean; appliedCount?: number }

/** A column sort the UI injects into a query at run time; the driver builds the
 * engine-correct ORDER BY (its own identifier quoting). */
// Sort targets a result column by its 0-based position, not its name: the sort
// injects a positional `ORDER BY <n>`, which is unambiguous even when columns
// share a name (select a.id, b.id) or are expressions with no real identifier.
export type QuerySort = { columnIndex: number; direction: 'asc' | 'desc' }

export type FetchRowsResult = { success: true; rows: unknown[][] } | { success: false; error: string }

/** `canceled` is a dismissed save dialog; `cancelled` a stopped export run. */
export type ExportQueryResult =
  | { success: true; rowCount: number }
  | { success: false; error?: string; canceled?: boolean; cancelled?: boolean }

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

// Identifies a function or view whose re-runnable CREATE DDL the "Edit" flow
// opens in a new editor tab. `detail` carries a function's identity args.
export type ObjectDdlKind = 'function' | 'view' | 'matview'
export type ObjectDdlRef = { schema: string | null; name: string; kind: ObjectDdlKind; detail: string | null }
export type ObjectDdlResult = { success: true; sql: string } | { success: false; error: string }

export type InspectColumn = {
  name: string
  dataType: string
  nullable: boolean
  default: string | null
  primaryKey: boolean
  foreignKey?: boolean
  comment: string | null
  /** Non-default collation (SQL Server only): ALTER COLUMN must restate it or
   *  the server silently resets the column to the database default. */
  collation?: string | null
  /** Server-generated/computed column; its physical definition cannot be altered directly. */
  generated?: boolean
  /** Server-managed identity. `always` rejects explicit values; `default`
   * permits them but normally generates a value when the column is omitted. */
  identity?: 'always' | 'default'
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
  /** OS clipboard access lives in the trusted process so packaged sandboxed renderers work reliably. */
  readClipboardText: () => Promise<string>
  writeClipboardText: (text: string) => Promise<void>
  openWorkspace: () => Promise<WorkspaceResult>
  openWorkspacePath: (path: string) => Promise<WorkspaceResult>
  closeWorkspace: () => Promise<void>
  newWindow: () => Promise<void>
  getRecentWorkspaces: () => Promise<RecentWorkspace[]>
  getTheme: () => Promise<ThemeId>
  getWorkspaceConfig: () => Promise<WorkspaceConfigResult>
  saveWorkspaceConfig: (config: WorkspaceConfig) => Promise<SaveResult>
  /** The workspace's persisted query history, newest first. */
  readHistory: () => Promise<HistoryItem[]>
  /** Replaces the workspace's persisted query history (write-through per run). */
  writeHistory: (items: HistoryItem[]) => Promise<SaveResult>
  testConnection: (profile: ConnectionProfile) => Promise<TestConnectionResult>
  testSshTunnel: (profile: ConnectionProfile) => Promise<TestSshResult>
  connectDatabase: (profile: ConnectionProfile) => Promise<ConnectResult>
  disconnectDatabase: (profileId: string) => Promise<void>
  /** Switches the active child database of an all-databases connection. */
  setActiveChildDb: (profileId: string, database: string) => Promise<{ success: boolean; error?: string }>
  disconnectAllDatabases: () => Promise<void>
  /** Drops a stale error status for a profile (e.g. after its config is re-saved). */
  clearConnectionError: (profileId: string) => Promise<void>
  getConnectionStatuses: () => Promise<ConnectionStatus[]>
  /** Subscribes to status pushes from the main process; returns unsubscribe. */
  onConnectionStatus: (listener: (statuses: ConnectionStatus[]) => void) => () => void
  runQuery: (
    profileId: string,
    childDb: string | null,
    sql: string,
    params?: unknown[],
    sort?: QuerySort | null,
    filter?: string | null,
    executionId?: string,
  ) => Promise<QueryResponse>
  /** Runs statements in one transaction on a single connection: all commit or
   * all roll back. The result-grid save path uses this so a multi-row edit
   * (UPDATE + INSERTs) can't half-apply. */
  runBatch: (profileId: string, childDb: string | null, statements: BatchStatement[]) => Promise<BatchResult>
  /** Runs schema statements (ALTER/COMMENT/…) in one transaction: all commit or
   * all roll back. Unlike runBatch there's no rows-affected check, since DDL
   * affects zero rows. The Inspect tab's column edits use this. */
  runDdl: (profileId: string, childDb: string | null, statements: string[]) => Promise<DdlResult>
  /** A page of a buffered result; rows beyond the first page are pulled on demand. */
  fetchRows: (sessionId: string, offset: number, limit: number) => Promise<FetchRowsResult>
  /** Streams a full read-only result straight to a file the user picks, past the
   * in-memory row cap. Re-runs the query (with any injected sort), so the main
   * process enforces read-only. Returns the number of rows written. The
   * executionId makes the export cancellable through cancelQuery. */
  exportQuery: (
    profileId: string,
    childDb: string | null,
    sql: string,
    params: unknown[] | undefined,
    sort: QuerySort | null,
    filter: string | null,
    format: ExportFormat,
    suggestedName: string,
    executionId?: string,
  ) => Promise<ExportQueryResult>
  /** Releases a result's main-process buffer (tab closed / superseded). */
  closeSession: (sessionId: string) => Promise<void>
  /** Cancels one in-flight execution; omit executionId only for connection teardown. */
  cancelQuery: (profileId: string, executionId?: string) => Promise<{ success: boolean; error?: string }>
  /** Server-side CREATE DATABASE on a connected profile (postgres only). */
  createDatabase: (profileId: string, name: string) => Promise<{ success: boolean; error?: string }>
  /** Server-side DROP DATABASE; refuses the connection's in-use child. */
  dropDatabase: (profileId: string, name: string) => Promise<{ success: boolean; error?: string }>
  // Metadata is scoped to a specific child database (all-databases mode), like
  // runQuery — pass null to target the connection's active child.
  listTables: (profileId: string, childDb: string | null) => Promise<TablesResult>
  /** Columns of every table in the database, one round trip. */
  listColumns: (profileId: string, childDb: string | null) => Promise<ColumnsResult>
  /** Structure of one table: columns, constraints, indexes, triggers, …. */
  inspectTable: (profileId: string, childDb: string | null, table: TableRef) => Promise<InspectResult>
  /** Schema-scoped objects (functions, types) for the explorer. */
  listObjects: (profileId: string, childDb: string | null) => Promise<ObjectsResult>
  /** Structure of one function/type: definition, values, attributes. Reuses
   * the table-inspection shape (columns for composites, sections for the rest). */
  inspectObject: (profileId: string, childDb: string | null, object: DbObject, objectKind: DbObjectKind) => Promise<InspectResult>
  /** Re-runnable CREATE DDL for a function or view, for "Edit" → new SQL tab. */
  getObjectDdl: (profileId: string, childDb: string | null, ref: ObjectDdlRef) => Promise<ObjectDdlResult>
  /** Server/cluster-scoped reference: extensions, roles, tablespaces, settings. */
  inspectServer: (profileId: string, childDb: string | null) => Promise<ServerInfoResult>
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
export type MenuAction = 'new-query' | 'save' | 'save-as' | 'close-tab' | 'refresh-results' | `theme:${ThemeId}`

export type ThemeId = 'dark' | 'light' | 'midnight-blue' | 'warm-dark'

declare global {
  interface Window {
    sqlkit: SqlkitApi
  }
}
