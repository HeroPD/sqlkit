import { LitElement, css, html, type PropertyValues } from 'lit'
import { customElement, property, state } from 'lit/decorators.js'
import { keyed } from 'lit/directives/keyed.js'
import { unsafeHTML } from 'lit/directives/unsafe-html.js'
import { icons, controls, scrollbars, titlebar, tooltip, typography } from '../shared-styles'
import { ACTIVITY_ICONS } from '../icons/activity-icons'
import { isMac, mod } from '../platform'
import { ConnectionsController } from '../controllers/connections'
import { FilesController } from '../controllers/files'
import { QueriesController } from '../controllers/queries'
import { LayoutController } from '../controllers/layout'
import { CommandPaletteController } from '../controllers/command-palette'
import { DialogsController } from '../controllers/dialogs'
import { ResultEditingController } from '../controllers/result-editing'
import { SchemaOpsController } from '../controllers/schema-ops'
import { ConfigController } from '../controllers/config'
import { FileOpsController } from '../controllers/file-ops'
import { ContextsController, type EditorTabState } from '../controllers/contexts'
import type { ConnectionProfile, Engine, FileInfo, MenuAction, QueryResponse, SessionEndMode, TableRef } from '../electron'
import { buildInsertBatches, type CellInput } from '../sql-write'
import './activity-button'
import './command-palette'
import './confirm-dialog'
import './prompt-dialog'
import './create-database-dialog'
import './parameter-dialog'
import './review-query-dialog'
import './table-inspect'
import './databases-view'
import './db-config-form'
import './editor-empty'
import './editor-tab'
import './explorer-view'
import './history-view'
import './import-dialog'
import './tasks-view'
import './server-view'
import './results-panel'
import './search-view'
import './sql-editor'
import './status-bar'
import type { StatusConnection } from './status-bar'
import { tableKey } from './explorer-view'
import type { EmptyAction } from './editor-empty'
import { clearInspectDraftCache, dropInspectDraft, sweepInspectDrafts, type ColumnAlterEventDetail } from './table-inspect'
import { connectionLabelColorValue } from '../connection-label-colors'
import { clearEditorStateCache, type EditorCommandDetail, type RunQueryDetail } from './sql-editor'
import type { SelectionCommandId } from '../codemirror/selection-commands'
import { firstStatement } from '../codemirror/run-query'
import type { ObjectEditDetail, ObjectInspectDetail, TableBrowseDetail, TableCreateDetail, TableSelectDetail } from './explorer-view'
import type { HistoryExplainDetail, HistoryOpenDetail } from './history-view'
import type { SessionEndDetail, TaskStopDetail } from './tasks-view'
import { dialectForEngine } from '../codemirror/dialects'
import { dialectFor } from '../dialect'
import { quoteQualified } from '../sql-write'
import { isFilterableQuery } from '../sql-filter'
import { isReadOnlyQuery, isReorderableQuery } from '../sql-order'
import { analyzeDestructive, type DestructiveKind } from '../sql-destructive'
import { splitScript, splitTopLevelStatements } from '../sql-statements'
import { foreignKeyTargets } from '../foreign-keys'
import { jsonColumns } from '../json-columns'
import type { ExportFormat } from '../result-export'
import type { FollowForeignKeyDetail, ResultNavigateDetail, SortColumnDetail } from './results-panel'
import type { SelectionStats } from '../result-aggregate'
import type { ColumnRef, ColumnReference, QueryResult, QuerySort } from '../electron'
import { stripExplain } from '../sql-types'
import type { SearchOpenDetail } from './search-view'
import type { FileCreateDetail, FileDeleteDetail, FileRenameDetail, FileRevealDetail } from './file-tree'
import type { ImportColumn, ImportConfirmDetail } from './import-dialog'
import { bindParameterValues, queryParameters, type QueryParameter } from '../query-parameters'
import type { ParametersConfirmDetail } from './parameter-dialog'
import { formatInteger, formatTime, rowWord, t } from '../i18n'

// icon markup lives in ACTIVITY_ICONS (inline SVG, keyed by id) — see the
// activity-bar render and `.activity-bar svg` styles.
// shortcutKey binds ⌘⇧<key> to that view. Letters dodge the macOS ⌘⇧3/4/5
// screenshot keys; the set avoids combos the app menu owns (⌘⇧S/N/W) and ones
// tests guard for the browser (⌘⇧R reload, ⌘⇧Z redo).
const VIEWS = [
  { id: 'explorer', title: t('view.explorer'), hint: t('view.explorer.empty'), shortcutKey: 'E' },
  { id: 'search', title: t('view.search'), hint: t('view.search.empty'), shortcutKey: 'F' },
  { id: 'databases', title: t('view.databases'), hint: t('view.databases.empty'), shortcutKey: 'D' },
  { id: 'history', title: t('view.history'), hint: t('view.history.empty'), shortcutKey: 'H' },
  { id: 'tasks', title: t('view.tasks'), hint: t('view.tasks.empty'), shortcutKey: 'T' },
  { id: 'server', title: t('view.server'), hint: t('view.server.empty'), shortcutKey: 'G' },
] as const


type ViewId = (typeof VIEWS)[number]['id']

const tabTitle = (tab: EditorTabState) => {
  if (tab.kind === 'config') return tab.profile.name.trim() || t('config.newDatabase')
  if (tab.kind === 'inspect') return tab.createTable ? t('workbench.newTableTab') : t('workbench.infoTab', { name: tab.table.name })
  if (tab.kind === 'inspect-object') return t('workbench.infoTab', { name: tab.object.name })
  return tab.content === tab.savedContent ? tab.name : `${tab.name} •`
}

const NO_CONTEXT = '__none__'

const contextKey = (profileId: string | null, childDb: string | null) =>
  profileId === null ? NO_CONTEXT : `${profileId}:${childDb ?? ''}`

const tableContextKey = (profileId: string, childDb: string | null, table: TableRef) =>
  `${profileId}:${childDb ?? ''}:${table.schema ?? ''}:${table.name}`

type CsvImportState = {
  table: TableRef
  profileId: string
  childDb: string | null
  engine: Engine
  columns: ImportColumn[]
}

type TransactionRun = {
  sql: string
  tabName: string
  success: boolean
  durationMs: number
  rowCount: number | null
  error: string
  createdAt: string
}

type TransactionSession = {
  childDb: string
  startedAt: string
  runs: TransactionRun[]
}

const MAX_TRANSACTION_RUNS = 100

const summarizeTransactionSql = (sql: string) => sql.replace(/\s+/g, ' ').trim().slice(0, 180)

// Child database names become folder segments (connection/child/file.sql);
// strip anything that isn't a safe path character.
const childFolderSegment = (name: string) => {
  const cleaned = name.replace(/[^\w .-]/g, '_').replace(/^[. ]+/, '')
  return cleaned || 'database'
}

// Commands offered by the ⌘⇧P palette; ids are dispatched to _runCommand.
// Rows a browse query loads: the Explorer's double-click browse and the
// follow-a-foreign-key navigation both cap at this.
const BROWSE_ROW_LIMIT = 200

// Stable empty, so a render that offers no followable columns hands the grid the
// same reference every time.
const NO_FOREIGN_KEYS: ReadonlyMap<number, ColumnReference> = new Map()
const NO_JSON_COLUMNS: ReadonlySet<number> = new Set()
const NO_KEY_COLUMNS: readonly number[] = []

const COMMANDS: ReadonlyArray<{ id: string; label: string; keybind?: string }> = [
  { id: 'new-query', label: t('action.newQuery'), keybind: mod('N') },
  { id: 'new-window', label: t('action.newWindow'), keybind: `${isMac ? '⇧⌘' : 'Shift+Ctrl+'}N` },
  { id: 'run-query', label: t('action.runQuery'), keybind: isMac ? '⌘↵' : 'Ctrl+↵' },
  { id: 'save-file', label: t('action.saveFile'), keybind: mod('S') },
  { id: 'format-sql', label: t('action.formatSql'), keybind: isMac ? '⇧⌥F' : 'Shift+Alt+F' },
  { id: 'quick-open', label: t('action.quickOpen'), keybind: mod('P') },
  { id: 'switch-database', label: t('action.switchDatabase'), keybind: mod('K') },
  { id: 'add-database', label: t('action.addDatabase') },
  { id: 'disconnect-all', label: t('action.disconnectAll') },
  { id: 'refresh-files', label: t('action.refreshFiles') },
  { id: 'toggle-sidebar', label: t('action.toggleSidebar'), keybind: mod('B') },
  { id: 'toggle-results-panel', label: t('action.toggleResults'), keybind: mod('J') },
  { id: 'close-workspace', label: t('action.closeWorkspace') },
]

// Workbench shell and orchestrator: owns the tab model, the in-use database
// context, the command palette, and global shortcuts — and routes events
// between the sidebar views, the editor, and the panels. Live-connection and
// file-listing data live in controllers; the views render them.
@customElement('workbench-screen')
export class WorkbenchScreen extends LitElement {
  @property({ attribute: false })
  workspace: { name: string; path: string } | null = null

  private _live = new ConnectionsController(this)

  private _workspaceFiles = new FilesController(this)

  // Aggregate over the result grid's selected cells, shown in the status bar.
  // Published by results-panel on selection change, not computed here.
  @state()
  private _selectionStats: SelectionStats | null = null
  @state()
  private _hasExplicitRunTarget = false

  @state()
  private _activeActionSurface: 'editor' | 'results' | null = null

  @state()
  private _resultHasUnstagedJson = false

  @state()
  private _transactionPopoverProfileId: string | null = null

  @state()
  private _transactionSessions = new Map<string, TransactionSession>()

  @state()
  private _activeView: ViewId | null = 'explorer'

  @state()
  private _inspectDirtyTabIds = new Set<string>()

  @state()
  private _parameterPrompt: { parameters: QueryParameter[]; resolve: (values: string[] | null) => void } | null = null

  // A run stopped for review because it cannot be undone; resolves with the
  // user's decision back into the _runSql that is waiting on it.
  @state()
  private _destructivePrompt:
    | { sql: string; params: unknown[]; risks: DestructiveKind[]; script: boolean; resolve: (run: boolean) => void }
    | null = null

  @state()
  private _csvImport: CsvImportState | null = null

  private _lastActiveTabId: string | null = null

  private _restoreScrollTabId: string | null = null

  private _tabScroll = new Map<string, { inspectTop?: number; resultsTop?: number; resultsLeft?: number }>()

  // Closing a tab reaches here via the switch-away that follows it, so skip any
  // tab that no longer exists — otherwise its entry is re-added after dropQuery
  // pruned it and the map grows with every tab ever opened. A tab stashed in
  // another context still exists, and its scroll is still worth keeping.
  private _captureTabScroll(tabId: string | null) {
    if (!tabId || !this._ctx.tabExists(tabId)) return
    const current = this._tabScroll.get(tabId) ?? {}
    const inspect = this.renderRoot.querySelector('table-inspect')?.shadowRoot?.querySelector<HTMLElement>('.scroll')
    const results = this.renderRoot.querySelector('results-panel')?.shadowRoot?.querySelector<HTMLElement>('.body')
    if (inspect) current.inspectTop = inspect.scrollTop
    if (results) {
      current.resultsTop = results.scrollTop
      current.resultsLeft = results.scrollLeft
    }
    this._tabScroll.set(tabId, current)
  }

  private async _restoreTabScroll(tabId: string) {
    const saved = this._tabScroll.get(tabId)
    if (!saved) return
    const inspectHost = this.renderRoot.querySelector('table-inspect')
    const resultsHost = this.renderRoot.querySelector('results-panel')
    await Promise.all([inspectHost?.updateComplete, resultsHost?.updateComplete])
    if (this._ctx.activeTabId !== tabId) return
    const inspect = inspectHost?.shadowRoot?.querySelector<HTMLElement>('.scroll')
    const results = resultsHost?.shadowRoot?.querySelector<HTMLElement>('.body')
    if (inspect && saved.inspectTop !== undefined) inspect.scrollTop = saved.inspectTop
    if (results) {
      if (saved.resultsTop !== undefined) results.scrollTop = saved.resultsTop
      if (saved.resultsLeft !== undefined) results.scrollLeft = saved.resultsLeft
    }
  }

  // ⌘⇧P / ⌘P / ⌘K palette: open/close state, entry list, and pick dispatch.
  private _cmdPalette = new CommandPaletteController(this, {
    live: this._live,
    commands: COMMANDS,
    files: () => this._workspaceFiles.files,
    connections: () => this._config.connections,
    activeProfile: () => this._config.activeProfile(),
    activeDbId: () => this._ctx.activeDbId,
    activeChildDb: () => this._ctx.activeChildDb,
    openFile: (file) => void this._fileOps.openFile(file),
    openTable: (key) => this._openTableFromPalette(key),
    // Picking a database from the palette lands the user on its files — open
    // the Explorer so the switch has a visible result.
    setActiveDb: (profileId, childDb) => {
      this._setActiveDb(profileId, childDb)
      this._activeView = 'explorer'
    },
    newQuery: () => this._ctx.newQuery(),
    runActiveTab: () => {
      const tab = this._ctx.activeSqlTab()
      if (!tab?.content.trim()) return
      const leading = tab.content.slice(0, tab.content.length - tab.content.trimStart().length)
      void this._runSql(tab.content.trim(), undefined, undefined, undefined, 1 + (leading.match(/\n/g)?.length ?? 0))
    },
    saveActiveTab: () => void this._fileOps.saveActive(),
    formatActiveTab: () => this.renderRoot.querySelector('sql-editor')?.formatSql(),
    addDatabase: () => this._onAddDatabase(),
    refreshFiles: () => void this._workspaceFiles.reload(),
    toggleSidebar: () => this._toggleSidebar(),
    toggleResultsPanel: () => this._layout.togglePanelCollapse(),
    closeWorkspace: () => this._onCloseWorkspace(),
  })

  // Query results, tasks, and history; re-renders us as runs progress.
  private _queries = new QueriesController(this, (tabId) => this._ctx.tabExists(tabId))

  // Sidebar width/collapse and results-panel height, with their drag handlers.
  private _layout = new LayoutController(this, {
    onSidebarCollapse: () => {
      this._activeView = null
    },
    panelEl: () => this.shadowRoot?.querySelector<HTMLElement>('results-panel') ?? null,
    editorPaneEl: () => this.shadowRoot?.querySelector<HTMLElement>('.editor-pane') ?? null,
  })

  // Modal confirm/prompt dialogs for destructive or input actions.
  private _dialogs = new DialogsController(this)

  // Per-context working state: open tabs, the active tab, the in-use context
  // (⌘K profile + child db), the Explorer's selected table, and the stash of
  // inactive contexts. Query results follow their tab via the QueriesController.
  private _ctx = new ContextsController(this, {
    contextKey,
    // The one funnel every tab close reaches, so per-tab state is dropped no
    // matter which path removed the tab.
    dropQuery: (tabId) => {
      this._queries.dropTab(tabId)
      this._tabScroll.delete(tabId)
      dropInspectDraft(tabId)
      this._forgetInspectDirty(tabId)
    },
  })

  // Saved connection profiles and the workspace config file (.sqlkit/config.json).
  private _config = new ConfigController(this, {
    live: this._live,
    dialogs: this._dialogs,
    activeDbId: () => this._ctx.activeDbId,
  })

  // Workspace-file actions: open into a tab, save, create/rename/delete.
  private _fileOps = new FileOpsController({
    ctx: this._ctx,
    files: this._workspaceFiles,
    queries: this._queries,
    dialogs: this._dialogs,
    sweepOrphanTabState: () => this._sweepOrphanTabState(),
    contextFolder: () => this._contextFolder(),
  })

  private _resultEditing = new ResultEditingController({
    activeTab: () => this._ctx.activeSqlTab(),
    activeDbId: () => this._ctx.activeDbId,
    activeChildDb: () => this._ctx.activeChildDb,
    activeProfile: () => this._config.activeProfile(),
    run: () => this._queries.runFor(this._ctx.activeTabId),
    tables: () => (this._ctx.activeDbId ? (this._live.tables[this._ctx.activeDbId] ?? []) : []),
    columns: () => (this._ctx.activeDbId ? (this._live.columns[this._ctx.activeDbId] ?? []) : []),
    dialogs: this._dialogs,
    refreshResult: () => this._refreshSavedResult(),
    refreshNotComing: () => this.renderRoot.querySelector('results-panel')?.refreshNotComing(),
    drafts: () => this._queries.draftsFor(this._ctx.activeTabId),
    dropDrafts: (tabId, indexes) => this._queries.dropDrafts(tabId, indexes),
    edits: () => this._queries.editsList(this._ctx.activeTabId),
    clearEdits: (tabId) => this._queries.clearEdits(tabId),
    deletes: () => this._queries.deletesList(this._ctx.activeTabId),
    clearDeletions: (tabId) => this._queries.clearDeletions(tabId),
    clearStagedHistory: (tabId) => this._queries.clearStagedHistory(tabId),
  })

  // Server-side schema mutations (drop/truncate/matview refresh, create/drop
  // database): builds the DDL and routes it through the dialogs and query path.
  private _schemaOps = new SchemaOpsController({
    activeProfile: () => this._config.activeProfile(),
    dialogs: this._dialogs,
    openPreview: (sql) => this._ctx.openPreview(sql),
    runSql: (sql, options) => this._runSql(sql, undefined, undefined, undefined, undefined, undefined, options?.preconfirmed),
    refresh: (profileId) => this._live.refresh(profileId),
    onDatabaseDropped: (profileId, database) => this._onDatabaseDropped(profileId, database),
  })

  /** Memo for _resultForeignKeys, keyed on the identities it derives from. */
  private _foreignKeyCache: { result: QueryResult; columns: ColumnRef[]; map: ReadonlyMap<number, ColumnReference> } | null = null

  private _jsonColumnCache: { result: QueryResult; columns: ColumnRef[]; set: ReadonlySet<number> } | null = null

  private _keyColumnCache: { result: QueryResult; columns: ColumnRef[]; keys: readonly number[] } | null = null

  private _unsubscribeMenu: (() => void) | null = null

  connectedCallback() {
    super.connectedCallback()
    this._unsubscribeMenu = window.sqlkit.onMenuAction((action) => this._onMenuAction(action))
    window.addEventListener('keydown', this._onGlobalKeydown)
    window.addEventListener('pointerdown', this._onWindowPointerDown)
  }

  disconnectedCallback() {
    super.disconnectedCallback()
    this._unsubscribeMenu?.()
    this._unsubscribeMenu = null
    window.removeEventListener('keydown', this._onGlobalKeydown)
    window.removeEventListener('pointerdown', this._onWindowPointerDown)
  }

  private _onWindowPointerDown = (event: PointerEvent) => {
    if (this._transactionPopoverProfileId === null) return
    const inside = event.composedPath().some(
      (node) => node instanceof HTMLElement && node.classList.contains('txn-control'),
    )
    if (!inside) this._transactionPopoverProfileId = null
  }

  /** App-menu items (File > …) arriving from the main process. */
  private _onMenuAction(action: MenuAction) {
    // The workbench stays mounted (hidden) on the welcome screen; File-menu
    // actions need an open workspace.
    if (!this.workspace) return
    switch (action) {
      case 'new-query':
        this._ctx.newQuery()
        break
      case 'save':
        this._saveActive()
        break
      case 'save-as':
        void this._fileOps.saveActiveAs()
        break
      case 'close-tab':
        if (this._ctx.activeTabId) this._requestCloseTab(this._ctx.activeTabId)
        break
      case 'refresh-results':
        void this._refreshResults()
        break
      default:
        // Selection menu: the command runs against the editor of the active tab,
        // and no-ops when the tab shows a form or an inspector instead.
        if (action.startsWith('selection:')) {
          this.renderRoot
            .querySelector('sql-editor')
            ?.runSelectionCommand(action.slice('selection:'.length) as SelectionCommandId)
        }
    }
  }

  // ⌘R: re-run the active tab's current result query, keeping its filter and sort.
  // No-op until a query has produced a result.
  private async _refreshResults() {
    const tabId = this._ctx.activeTabId
    const run = this._queries.runFor(tabId)
    if (run.phase !== 'done' || !run.sql) return
    // Carry the run's own table: a followed result re-run without it would fall
    // back to the tab's table and retarget (or disarm) grid editing.
    await this._runSql(run.sql, this._queries.sortFor(tabId), run.params, this._queries.filterFor(tabId), undefined, run.table ? { table: run.table } : undefined)
  }

  /** The refresh a committed save triggers: the same re-run as ⌘R, reporting
   * whether a result actually landed. _runSql has several ways to return before
   * it starts — a parameter prompt the user dismisses is the reachable one —
   * and none of them move the run, so nothing else can tell the panel that the
   * restore it armed has nothing to wait for. */
  private async _refreshSavedResult(): Promise<boolean> {
    const tabId = this._ctx.activeTabId
    const before = this._queries.runFor(tabId)
    await this._refreshResults()
    return this._queries.runFor(tabId) !== before
  }

  private _saveActive() {
    const activeTab = this._ctx.tabs.find((tab) => tab.id === this._ctx.activeTabId)
    if (activeTab?.kind === 'inspect' || activeTab?.kind === 'inspect-object') {
      this.renderRoot.querySelector('table-inspect')?.save()
      return
    }
    // The panel answers first, through the same call its Save button makes, so
    // ⌘S and the button cannot drift: it flushes the JSON editor and arms the
    // restore that keeps the reader in the view they saved from. It is also the
    // only one that can see an unflushed JSON document, which is why it decides
    // whether there was a save to make rather than being asked beforehand.
    if (this.renderRoot?.querySelector('results-panel')?.saveRows()) return
    if (this._resultEditing.hasPendingChanges()) {
      this._resultEditing.saveChanges()
      return
    }
    void this._fileOps.saveActive()
  }

  protected willUpdate(changed: PropertyValues) {
    if (changed.has('workspace')) {
      this._tabScroll.clear()
      this._ctx.reset()
      this._config.reset()
      this._cmdPalette.close()
      this._queries.reset()
      this._transactionSessions = new Map()
      this._transactionPopoverProfileId = null
      clearEditorStateCache()
      clearInspectDraftCache()
      this._inspectDirtyTabIds = new Set()
      this._activeActionSurface = null
      this._resultHasUnstagedJson = false
      this._workspaceFiles.setFolder(null)
      // Connections belong to the workspace they were opened from.
      void this._live.disconnectAll()
      if (this.workspace) void this._loadConfig()
    }
    if (this._ctx.activeTabId !== this._lastActiveTabId) {
      this._hasExplicitRunTarget = false
      this._activeActionSurface = null
      this._resultHasUnstagedJson = false
      this._captureTabScroll(this._lastActiveTabId)
      this._lastActiveTabId = this._ctx.activeTabId
      this._restoreScrollTabId = this._ctx.activeTabId
    }
  }

  protected updated() {
    const tabId = this._restoreScrollTabId
    this._restoreScrollTabId = null
    if (tabId) void this._restoreTabScroll(tabId)
    if (this._transactionPopoverProfileId && !this._live.transaction(this._transactionPopoverProfileId)) {
      this._transactionPopoverProfileId = null
    }
  }

  // --- workspace config + context -----------------------------------------

  private async _loadConfig() {
    // Restore the in-use context; the config controller defaults to the first
    // profile so the Explorer has a files folder to show right away.
    const { profileId, child } = await this._config.load()
    this._ctx.switchInstance(profileId, child)
    this._workspaceFiles.setFolder(this._contextFolder())
    void this._queries.loadHistory()
  }

  // Files nest per context: connection-folder/child-folder for all-databases
  // children, just the connection folder otherwise.
  private _contextFolder(): string | null {
    const folder = this._config.activeProfile()?.folder
    if (!folder) return null
    return this._ctx.activeChildDb ? `${folder}/${childFolderSegment(this._ctx.activeChildDb)}` : folder
  }

  /** The in-use profile when it is live-connected, else null. */
  private _connectedProfile(): ConnectionProfile | null {
    const profile = this._config.activeProfile()
    return profile && this._live.phase(profile.id) === 'connected' ? profile : null
  }

  /** Context key of the in-use database (⌘K) — history and stash lookups. */
  private _activeContextKey() {
    return contextKey(this._ctx.activeDbId, this._ctx.activeChildDb)
  }

  // Without an explicit child, a profile-level switch (⌘P table pick,
  // single-db connect) resolves the default child so all-databases contexts
  // never land on the parent folder.
  private _setActiveDb(profileId: string, childDb?: string | null) {
    const profile = this._config.byId(profileId)
    if (!profile) return
    const child = childDb === undefined ? this._config.defaultChild(profile) : childDb

    if (this._ctx.activeDbId === profileId && this._ctx.activeChildDb === child) return

    // A child switch the manager will refuse (open manual transaction on
    // another database) must not move the UI either: every switch flow
    // funnels through here, so this is the one place that keeps the
    // workbench from claiming a database the driver never switched to.
    const transaction = this._live.transaction(profileId)
    if (transaction && child && child !== transaction.childDb) {
      this._surfaceTransactionNotice(t('query.transactionSwitchBlocked', { database: transaction.childDb }))
      return
    }

    // Remember the pick so reopening the workspace lands on the same child.
    if (child) this._config.setLastChildDb(profileId, child)

    this._ctx.switchInstance(profileId, child)
    this._workspaceFiles.setFolder(this._contextFolder())
    this._config.persist()
  }

  // After a connect, the driver targets the discovery database; if the
  // context remembers a different child, point the driver at it.
  // Points profileId's driver at `childDb` (all-databases mode). Takes the
  // target explicitly rather than reading this._ctx.activeChildDb, so a run that
  // captured its context can align that exact child even after the active
  // selection has drifted.
  // 'aligned' — the driver is now on childDb (or there's nothing to align).
  // 'redirected' — childDb is gone, so (followMissing) the UI moved to the
  // child actually in use. 'unavailable' — childDb isn't on this connection and
  // we didn't redirect. Distinct outcomes so callers don't have to guess which.
  private async _alignActiveChild(
    profileId: string,
    childDb: string | null,
    options: { followMissing?: boolean } = {},
  ): Promise<'aligned' | 'redirected' | 'unavailable'> {
    if (!childDb) return 'aligned'
    const children = this._live.statuses[profileId]?.children ?? []
    if (children.length < 2) return 'aligned'
    const inUse = children.find((child) => child.inUse)?.name
    if (inUse === childDb) return 'aligned'
    if (children.some((child) => child.name === childDb)) {
      return (await this._live.setActiveChild(profileId, childDb)).success ? 'aligned' : 'unavailable'
    }
    if (options.followMissing && inUse) {
      this._setActiveDb(profileId, inUse)
      return 'redirected'
    }
    return 'unavailable'
  }

  // --- global shortcuts -----------------------------------------------------

  // ⌘⇧P commands, ⌘P quick open, ⌘K database switch, ⌘B sidebar, ⌘N new
  // query, ⌘S save, ⌘R/F5 refresh. The SQL editor alone owns ⌘↵.
  // True when the keystroke is inside an editable text field, which owns its own
  // native undo — inputs, textareas, or contenteditable (CodeMirror's editor).
  private _inTextField(event: KeyboardEvent): boolean {
    return event.composedPath().some(
      (node) =>
        node instanceof HTMLInputElement ||
        node instanceof HTMLTextAreaElement ||
        (node instanceof HTMLElement && (node.isContentEditable || node.tagName === 'SQL-EDITOR')),
    )
  }

  private _onGlobalKeydown = (event: KeyboardEvent) => {
    // Mounted but hidden on the welcome screen; ignore global keys until a
    // workspace is open.
    if (!this.workspace) return
    // Component keymaps prevent default when they own a chord.
    if (event.defaultPrevented) return
    const key = event.key.toLowerCase()
    const hasMod = event.metaKey || event.ctrlKey

    if (key === 'escape' && this._transactionPopoverProfileId !== null) {
      event.preventDefault()
      this._transactionPopoverProfileId = null
      return
    }

    if (key === 'f5' && !hasMod && !event.altKey && !event.shiftKey) {
      event.preventDefault()
      void this._refreshResults()
      return
    }
    if (key === 'r' && hasMod && !event.altKey && !event.shiftKey) {
      event.preventDefault()
      void this._refreshResults()
      return
    }

    // ⇧⌥F formats the active SQL tab; event.code sidesteps Option-key characters
    // on macOS. A focused editor already handled it (defaultPrevented above).
    if (event.code === 'KeyF' && event.altKey && event.shiftKey && !hasMod) {
      if (this._inTextField(event)) return
      if (this.renderRoot.querySelector('sql-editor')?.formatSql()) event.preventDefault()
      return
    }

    if (!hasMod) return

    // ⌘Z / ⌘⇧Z steps the active tab's staged edits from anywhere in the
    // workbench — unless focus is in a text field, which keeps its native undo.
    if (key === 'z' && !event.altKey) {
      if (this._inTextField(event)) return
      const activeTab = this._ctx.tabs.find((tab) => tab.id === this._ctx.activeTabId)
      if (activeTab?.kind === 'inspect' || activeTab?.kind === 'inspect-object') {
        const inspect = this.renderRoot.querySelector('table-inspect')
        if (event.shiftKey ? inspect?.redo() : inspect?.undo()) event.preventDefault()
        return
      }
      if (this._ctx.activeSqlTab() && !this._layout.panelCollapsed && !this._stagingFrozen()) {
        const tabId = this._ctx.activeTabId
        if (event.shiftKey ? this._queries.redoStaged(tabId) : this._queries.undoStaged(tabId)) event.preventDefault()
      }
      return
    }

    if (key === 'p') {
      event.preventDefault()
      this._cmdPalette.toggle(event.shiftKey ? 'commands' : 'quick')
      return
    }
    // ⌘⇧<letter> switches the sidebar activity view (toggling it shut if open).
    if (event.shiftKey && !event.altKey) {
      const view = VIEWS.find((candidate) => candidate.shortcutKey.toLowerCase() === key)
      if (view) {
        event.preventDefault()
        this._activeView = this._activeView === view.id ? null : view.id
        return
      }
    }
    if (event.shiftKey) return
    if (key === 'k') {
      event.preventDefault()
      this._cmdPalette.toggle('databases')
      return
    }
    // Sublime-style tab switching: Mod+1..8 pick that tab, Mod+9 the last.
    if (key >= '1' && key <= '9') {
      const tab = key === '9' ? this._ctx.tabs[this._ctx.tabs.length - 1] : this._ctx.tabs[Number(key) - 1]
      if (tab) {
        event.preventDefault()
        this._ctx.activeTabId = tab.id
      }
      return
    }
    if (key === 'b') {
      event.preventDefault()
      this._toggleSidebar()
      return
    }
    if (key === 'j') {
      event.preventDefault()
      this._layout.togglePanelCollapse()
      return
    }
    if (key === 'n') {
      event.preventDefault()
      this._ctx.newQuery()
      return
    }
    if (key === 's') {
      event.preventDefault()
      this._saveActive()
      return
    }
  }

  private _toggleSidebar() {
    this._activeView = this._activeView === null ? 'explorer' : null
  }

  // --- tabs ------------------------------------------------------------------

  // Close via ⌘W, the tab ✕, etc.: unsaved editor/grid state gets a confirmation first.
  private _requestCloseTab(id: string) {
    const tab = this._ctx.tabs.find((entry) => entry.id === id)
    const fileDirty = tab?.kind === 'sql' && tab.content !== tab.savedContent
    const inspectDirty = this._inspectDirtyTabIds.has(id)
    const stagedDirty = this._queries.hasStaged(id) || inspectDirty
    if (fileDirty || stagedDirty) {
      const title = tab ? (tab.kind === 'sql' ? tab.name : tabTitle(tab)) : 'tab'
      const detail = fileDirty && stagedDirty
        ? t('workbench.unsavedSqlAndEdits')
        : fileDirty
          ? t('workbench.unsavedChanges')
          : inspectDirty
            ? t('workbench.unsavedSchema')
            : t('workbench.unsavedResults')
      this._dialogs.confirm = {
        message: t('workbench.closeTabPrompt', { title }),
        detail,
        confirmLabel: fileDirty ? t('workbench.closeWithoutSaving') : t('workbench.discardAndClose'),
        danger: true,
        action: () => this._ctx.closeTab(id),
      }
      return
    }
    this._ctx.closeTab(id)
  }

  // --- query running ----------------------------------------------------------

  // Runs against the in-use context (⌘K), connecting it first if needed.
  // `filter`/`sort` re-run with grid-injected clauses; omitting them clears both.
  // `baseLine` is the editor line the SQL starts on, for error-line mapping.
  // `preconfirmed` skips the destructive preflight, for statements this app
  // generated and already had the user confirm (Explorer drop/truncate).
  private async _runSql(
    sqlText: string,
    sort?: QuerySort | null,
    suppliedParams?: unknown[],
    filter?: string | null,
    baseLine?: number,
    trail?: { push?: boolean; table?: TableRef },
    preconfirmed?: boolean,
  ) {
    // The run belongs to the tab it started from, even if the user switches
    // tabs or contexts before it finishes.
    const tabId = this._ctx.activeTabId
    if (!tabId) return
    const sourceTab = this._ctx.tabs.find((entry) => entry.id === tabId)
    const sourceTabName = sourceTab ? tabTitle(sourceTab).replace(/ •$/, '') : t('action.newQuery')
    // One run per tab: ignore re-triggers while this tab's query is in flight.
    if (this._queries.runFor(tabId).phase === 'running') return

    // Reveal the results panel if it was collapsed, so the run (or its error) shows.
    this._layout.expandPanel()

    const profile = this._config.activeProfile()
    if (!profile) {
      this._queries.setRun(tabId, { phase: 'error', error: t('workbench.noDatabase', { shortcut: mod('K') }) })
      return
    }

    // Capture before a parameter dialog can await user input; context switches
    // while it is open must not retarget the pending run.
    const childDb = this._ctx.activeChildDb
    const runContextKey = contextKey(profile.id, childDb)

    // A run against another database would be refused deeper down anyway, but
    // through _alignActiveChild its error reads as "database unavailable";
    // refuse here with the actionable message instead.
    const transaction = this._live.transaction(profile.id)
    if (transaction && childDb && childDb !== transaction.childDb) {
      this._queries.setRun(tabId, {
        phase: 'error',
        error: t('query.transactionOtherDatabase', { database: transaction.childDb }),
      })
      return
    }

    let params = suppliedParams
    if (params === undefined) {
      const parameters = queryParameters(sqlText, profile.engine)
      if (parameters.length) {
        if (this._parameterPrompt) return
        const values = await new Promise<string[] | null>((resolve) => {
          this._parameterPrompt = { parameters, resolve }
        })
        if (values === null) return
        // Another run may have started on this tab while the dialog was open.
        if (this._queries.runFor(tabId).phase === 'running') return
        params = bindParameterValues(parameters, values)
      }
    }

    // No engine gives us an undo, so an irreversible statement gets one look
    // first. After parameter binding, so the preview shows the values that will
    // really be sent.
    const risks = preconfirmed ? [] : analyzeDestructive(sqlText, profile.engine)
    if (risks.length) {
      if (this._destructivePrompt) return
      const confirmed = await new Promise<boolean>((resolve) => {
        this._destructivePrompt = {
          sql: sqlText,
          params: params ?? [],
          risks,
          script: splitTopLevelStatements(sqlText, profile.engine).length > 1,
          resolve,
        }
      })
      if (!confirmed) return
      // Another run may have started on this tab while the dialog was open.
      if (this._queries.runFor(tabId).phase === 'running') return
    }

    // Capture the context the run started in. The connect/align below await,
    // and the user may switch child or profile meanwhile; the run must target
    // and be logged under the context Run was pressed in, not the current one.
    const executionId = crypto.randomUUID()
    const phase = this._live.phase(profile.id)
    this._queries.beginRun(
      tabId,
      executionId,
      profile.id,
      phase === 'connected' ? undefined : t('workbench.connectingTo', { name: profile.name }),
      trail?.push ?? false,
    )

    // The tab is already in phase 'running'; a rejection escaping here would
    // leave it spinning forever (the in-flight guard above blocks every rerun).
    try {
      if (phase !== 'connected') {
        const connected = await this._live.connect(profile)
        if (!connected.success) {
          this._queries.setRun(tabId, { phase: 'error', error: connected.error })
          return
        }
      }
      // The driver may be targeting the discovery database; point it at the
      // captured child before running.
      if ((await this._alignActiveChild(profile.id, childDb)) === 'unavailable') {
        this._queries.setRun(tabId, { phase: 'error', error: t('workbench.databaseUnavailable', { database: childDb ?? '' }) })
        return
      }
    } catch (error) {
      this._queries.setRun(tabId, { phase: 'error', error: (error as Error).message })
      return
    }

    const transactionBeforeRun = this._live.transaction(profile.id)
    const runStartedAt = Date.now()
    const response = await this._queries.execute({
      tabId,
      profile,
      childDb,
      contextKey: runContextKey,
      sql: sqlText,
      params,
      sort,
      filter,
      executionId,
      baseLine,
      ...(trail?.table ? { table: trail.table } : {}),
    })
    if (response) {
      const transactionAfterRun = this._live.transaction(profile.id)
      // A run containing a top-level COMMIT/ROLLBACK ended the previous
      // transaction even when a new one is open afterwards ('COMMIT; BEGIN'):
      // the session log must restart rather than carry committed runs over.
      const restarted = Boolean(transactionBeforeRun) && splitScript(sqlText, profile.engine).statements.some(
        ({ masked }) => /^\s*(?:commit\b|rollback\b(?!\s+to\b))/i.test(masked),
      )
      this._updateTransactionSession({
        profileId: profile.id,
        childDb: transactionAfterRun?.childDb ?? transactionBeforeRun?.childDb ?? childDb ?? '',
        sourceTabName,
        sql: sqlText,
        response,
        runStartedAt,
        wasOpen: Boolean(transactionBeforeRun),
        isOpen: Boolean(transactionAfterRun),
        restarted,
      })
    }
    // A run that could have changed the schema updates what the tree,
    // completions and grid editability believe — same as the Inspect apply
    // path. Refreshed even on error: a failed script may have half-applied.
    // Deferred while a manual transaction is open (metadata reads could block
    // on its uncommitted DDL locks); endTransaction refreshes on commit.
    if (!isReadOnlyQuery(sqlText, profile.engine) && !this._live.transaction(profile.id)) {
      this._live.refresh(profile.id)
    }
  }

  private _updateTransactionSession(args: {
    profileId: string
    childDb: string
    sourceTabName: string
    sql: string
    response: QueryResponse
    runStartedAt: number
    wasOpen: boolean
    isOpen: boolean
    /** The run closed the previous transaction (even if a new one is open). */
    restarted: boolean
  }) {
    if (!args.isOpen) {
      if (args.wasOpen && this._transactionSessions.has(args.profileId)) {
        const next = new Map(this._transactionSessions)
        next.delete(args.profileId)
        this._transactionSessions = next
        if (this._transactionPopoverProfileId === args.profileId) this._transactionPopoverProfileId = null
      }
      return
    }

    const existing = args.wasOpen && !args.restarted ? this._transactionSessions.get(args.profileId) : undefined
    const session = existing?.childDb === args.childDb
      ? existing
      : { childDb: args.childDb, startedAt: new Date(args.runStartedAt).toISOString(), runs: [] }
    const run: TransactionRun = {
      sql: args.sql.slice(0, 10_000),
      tabName: args.sourceTabName,
      success: args.response.success,
      durationMs: args.response.success ? args.response.result.durationMs : Math.max(1, Date.now() - args.runStartedAt),
      rowCount: args.response.success ? args.response.result.rowCount : null,
      error: args.response.success ? '' : args.response.error,
      createdAt: new Date().toISOString(),
    }
    const next = new Map(this._transactionSessions)
    next.set(args.profileId, { ...session, runs: [...session.runs, run].slice(-MAX_TRANSACTION_RUNS) })
    this._transactionSessions = next
  }

  private async _endTransaction(profileId: string, mode: 'commit' | 'rollback') {
    const result = await this._live.endTransaction(profileId, mode)
    if (result.success) {
      const next = new Map(this._transactionSessions)
      next.delete(profileId)
      this._transactionSessions = next
      this._transactionPopoverProfileId = null
    }
    // Surface a failure where run errors already show; the control itself stays
    // truthful through the status rebroadcast.
    if (!result.success && result.error) this._surfaceTransactionNotice(result.error)
  }

  // Surfaces a transaction-guard message where run errors already show —
  // but never over a tab whose query is still in flight, which would hide
  // its spinner and defeat the one-run-per-tab guard.
  private _surfaceTransactionNotice(message: string) {
    const tabId = this._ctx.activeTabId
    if (tabId && this._queries.runFor(tabId).phase !== 'running') {
      this._queries.setRun(tabId, { phase: 'error', error: message })
    }
  }

  private _cancelParameterPrompt = () => {
    const prompt = this._parameterPrompt
    this._parameterPrompt = null
    prompt?.resolve(null)
  }

  private _confirmParameterPrompt = (event: Event) => {
    const prompt = this._parameterPrompt
    const { values } = (event as CustomEvent<ParametersConfirmDetail>).detail
    this._parameterPrompt = null
    prompt?.resolve(values)
  }

  private _cancelDestructivePrompt = () => {
    const prompt = this._destructivePrompt
    this._destructivePrompt = null
    prompt?.resolve(false)
  }

  // The review dialog's confirm hook. Releasing the waiting _runSql is all there
  // is to do: it reports failures in the results panel like any other run, so
  // nothing ever comes back to show inline here.
  private _runDestructive = (): Promise<string | null> => {
    const prompt = this._destructivePrompt
    this._destructivePrompt = null
    prompt?.resolve(true)
    return Promise.resolve(null)
  }

  // Double-click browse: a tab named after the table, pre-filled with a capped SELECT and run.
  // Re-browsing reuses the tab and runs its first statement, so trailing half-written SQL doesn't error.
  private _browseTable(profile: ConnectionProfile, table: TableRef) {
    const dialect = dialectFor(profile.engine)
    const sqlText = dialect.browseTable(quoteQualified(table, dialect), BROWSE_ROW_LIMIT)

    const id = `browse:${tableContextKey(profile.id, this._ctx.activeChildDb, table)}`
    // Capture the existing tab's content before addTab activates it: re-browse
    // re-runs that tab's first statement, leaving any trailing edits untouched.
    const existing = this._ctx.tabs.find((tab) => tab.id === id)
    this._ctx.addTab({ id, kind: 'sql', name: `${table.name}.sql`, path: null, content: sqlText, savedContent: sqlText, table })
    void this._runSql(existing?.kind === 'sql' ? firstStatement(existing.content) || sqlText : sqlText)
  }

  // Quick-open table pick: reveal it in the Explorer (switching context if
  // needed) and open its browse tab, as if double-clicked in the sidebar.
  private _openTableFromPalette(key: string) {
    this._ctx.selectedTable = key
    const profileId = key.split(':')[0]
    if (!profileId) return
    this._setActiveDb(profileId)
    this._activeView = 'explorer'
    const profile = this._config.byId(profileId)
    const table = (this._live.tables[profileId] ?? []).find((entry) => tableKey(profileId, entry) === key)
    if (profile && table) this._browseTable(profile, table)
  }

  // --- render -------------------------------------------------------------------

  private _onSelectionStats = (event: CustomEvent<{ stats: SelectionStats | null }>) => {
    this._selectionStats = event.detail.stats
  }

  private _onTitlebarAction() {
    const run = this._queries.runFor(this._ctx.activeTabId)
    if (run.phase === 'running') {
      this._onCancelQuery()
      return
    }
    if (this._activeActionSurface === 'results' && run.phase === 'done' && run.sql) {
      const unstagedJson = this.renderRoot.querySelector('results-panel')?.hasUnstagedJson() ?? false
      if (!this._resultEditing.hasPendingChanges() && !unstagedJson) void this._refreshResults()
      return
    }
    this.renderRoot.querySelector('sql-editor')?.runExplicitQuery()
  }

  private _onBodyFocusIn(event: FocusEvent) {
    const path = event.composedPath()
    if (path.some((target) => target instanceof Element && target.tagName === 'SQL-EDITOR')) {
      this._activeActionSurface = 'editor'
    } else if (path.some((target) => target instanceof Element && target.tagName === 'RESULTS-PANEL')) {
      this._activeActionSurface = 'results'
    } else {
      this._activeActionSurface = null
    }
  }

  private _onBodyFocusOut() {
    queueMicrotask(() => {
      const active = this.shadowRoot?.activeElement
      // Keep the source context while keyboard focus moves onto the action
      // itself, so the toolbar remains operable without a pointer.
      if (active?.matches('.query-action')) return
      if (active?.tagName === 'SQL-EDITOR') this._activeActionSurface = 'editor'
      else if (active?.tagName === 'RESULTS-PANEL') this._activeActionSurface = 'results'
      else this._activeActionSurface = null
    })
  }

  private _onResultDirtyChange(event: CustomEvent<{ dirty: boolean }>) {
    this._resultHasUnstagedJson = event.detail.dirty
  }

  private _openDatabasePicker() {
    this._cmdPalette.open('databases')
  }

  // The first connected profile holding an open manual transaction, so the
  // title-bar control stays reachable after switching to another connection.
  private _transactionOwner(): { profile: ConnectionProfile; transaction: { childDb: string; failed?: boolean } } | null {
    for (const candidate of this._config.connections) {
      const transaction = this._live.transaction(candidate.id)
      if (transaction) return { profile: candidate, transaction }
    }
    return null
  }

  private _renderTransactionControl(
    profile: ConnectionProfile,
    transaction: { childDb: string; failed?: boolean },
  ) {
    const session = this._transactionSessions.get(profile.id)
    const runs = session?.runs ?? []
    const open = this._transactionPopoverProfileId === profile.id
    const label = transaction.failed ? t('transaction.failedShort') : t('transaction.manualShort')
    return html`
      <div class="txn-control ${transaction.failed ? 'failed' : ''}">
        <button
          type="button"
          class="txn-status"
          aria-label=${t('transaction.sessionAria', { state: label, count: runs.length })}
          aria-haspopup="dialog"
          aria-expanded=${String(open)}
          @click=${() => {
            this._transactionPopoverProfileId = open ? null : profile.id
          }}
        >
          <span class="txn-dot" aria-hidden="true"></span>
          <span>${label}</span>
          <span class="txn-count">${runs.length}</span>
          <i class="icon icon-chevron-down" aria-hidden="true"></i>
        </button>
        ${transaction.failed
          ? ''
          : html`
              <span class="txn-divider" aria-hidden="true"></span>
              <button
                type="button"
                class="txn-commit"
                aria-label=${t('transaction.commit')}
                data-tooltip=${t('transaction.commit')}
                @click=${() => this._endTransaction(profile.id, 'commit')}
              >
                <i class="icon icon-check" aria-hidden="true"></i>${t('transaction.commit')}
              </button>
            `}
        <span class="txn-divider" aria-hidden="true"></span>
        <button
          type="button"
          class="txn-rollback"
          aria-label=${t('transaction.rollback')}
          data-tooltip=${t('transaction.rollback')}
          @click=${() => this._endTransaction(profile.id, 'rollback')}
        >
          <i class="icon icon-undo-2" aria-hidden="true"></i>${t('transaction.rollback')}
        </button>
        ${open
          ? html`
              <div class="txn-popover" role="dialog" aria-label=${t('transaction.session')}>
                <div class="txn-popover-head">
                  <div class="txn-popover-title">
                    <span class="txn-dot" aria-hidden="true"></span>
                    <strong>${transaction.failed ? t('transaction.sessionFailed') : t('transaction.session')}</strong>
                    ${session ? html`<span>${t('transaction.startedAt', { time: formatTime(session.startedAt) })}</span>` : ''}
                  </div>
                  <div class="txn-context">
                    <strong>${profile.name}</strong><span aria-hidden="true">›</span><span>${transaction.childDb}</span>
                  </div>
                </div>
                <div class="txn-runs">
                  ${runs.length
                    ? runs.map((run, index) => html`
                        <div class="txn-run" title=${run.success ? run.sql : `${run.sql}\n\n${run.error}`}>
                          <span class="txn-run-index">${index + 1}</span>
                          <div class="txn-run-copy">
                            <code>${summarizeTransactionSql(run.sql)}</code>
                            <span>
                              <span class="txn-outcome ${run.success ? 'ok' : 'error'}">
                                ${run.success ? t('common.ok') : t('common.error')}
                              </span>
                              ${run.success
                                ? html`${run.rowCount === null ? '' : ` · ${formatInteger(run.rowCount)} ${rowWord(run.rowCount)}`} · ${run.tabName}`
                                : html` · ${run.error} · ${run.tabName}`}
                            </span>
                          </div>
                          <span class="txn-duration">${Math.max(1, Math.round(run.durationMs))} ms</span>
                        </div>
                      `)
                    : html`<p class="txn-empty">${t('transaction.sessionEmpty')}</p>`}
                </div>
                <div class="txn-popover-foot">
                  <i class="icon icon-history" aria-hidden="true"></i>${t('transaction.sessionScope')}
                </div>
              </div>
            `
          : ''}
      </div>
    `
  }

  private _renderTitlebar() {
    const profile = this._config.activeProfile()
    const database = this._ctx.activeChildDb ?? profile?.database.trim() ?? ''
    const context = profile ? [profile.name, database].filter(Boolean).join(' · ') : t('action.switchDatabase')
    const phase = profile ? this._live.phase(profile.id) : null
    const labelColor = connectionLabelColorValue(profile?.labelColor)
    const tab = this._ctx.activeSqlTab()
    const run = this._queries.runFor(this._ctx.activeTabId)
    const running = run.phase === 'running'
    const refreshing = !running && this._activeActionSurface === 'results' && run.phase === 'done' && Boolean(run.sql)
    const runLabel = running ? t('common.stop') : refreshing ? t('menu.refreshResults') : t('action.runQuery')
    const runDisabled = !running && (refreshing
      ? this._resultEditing.hasPendingChanges() || this._resultHasUnstagedJson
      : this._activeActionSurface !== 'editor' || !tab?.content.trim() || !this._hasExplicitRunTarget)
    // The control follows the transaction, not the active profile: an open
    // transaction on another connection must stay visible and endable, or
    // its locks outlive any cue that it exists.
    const activeTransaction = profile ? this._live.transaction(profile.id) : undefined
    const transactionOwner = activeTransaction && profile
      ? { profile, transaction: activeTransaction }
      : this._transactionOwner()

    return html`
      <header class="app-titlebar">
        <div class="titlebar-inner">
          <div class="titlebar-left">
            <span class="title-product">${t('app.name')}</span>
            ${this.workspace?.name ? html`<span class="title-workspace">— ${this.workspace.name}</span>` : ''}
          </div>
          <div class="titlebar-center">
            <span
              class="database-target-wrap tooltip-start"
              data-tooltip=${context}
            >
              <button
                type="button"
                class="database-target"
                style=${labelColor ? `--connection-label-color: ${labelColor}` : ''}
                aria-label="${t('action.switchDatabase')}: ${context}"
                aria-haspopup="dialog"
                aria-expanded=${String(this._cmdPalette.mode === 'databases')}
                @click=${this._openDatabasePicker}
              >
                <span class="connection-dot ${phase ?? ''}" aria-hidden="true"></span>
                ${profile
                  ? html`
                      <span class="target-profile">${profile.name}</span>
                      ${database
                        ? html`
                            <span class="target-separator" aria-hidden="true">›</span>
                            <strong>${database}</strong>
                          `
                        : ''}
                    `
                  : html`<strong>${t('action.switchDatabase')}</strong>`}
                <i class="icon icon-chevron-down" aria-hidden="true"></i>
              </button>
            </span>
            <button
              type="button"
              class="query-action ${running ? 'running' : refreshing ? 'refreshing' : ''}"
              data-tooltip="${runLabel}${running ? '' : refreshing ? ` (${isMac ? '⌘' : 'Ctrl+'}R)` : ` (${isMac ? '⌘' : 'Ctrl+'}Enter)`}"
              aria-label=${runLabel}
              ?disabled=${runDisabled}
              @pointerdown=${(event: PointerEvent) => event.preventDefault()}
              @click=${this._onTitlebarAction}
            >
              ${running
                ? html`<svg viewBox="0 0 20 20" aria-hidden="true"><rect x="5" y="5" width="10" height="10" rx="1"></rect></svg>`
                : refreshing
                  ? html`<i class="icon icon-refresh-cw" aria-hidden="true"></i>`
                : html`<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5.5 3.8 16 10 5.5 16.2Z"></path></svg>`}
            </button>
          </div>
          <div class="titlebar-right">
            ${transactionOwner ? this._renderTransactionControl(transactionOwner.profile, transactionOwner.transaction) : ''}
            ${import.meta.env.DEV
              ? html`
                  <button type="button" class="update-preview">
                    <i class="icon icon-download" aria-hidden="true"></i>
                    <span>${t('update.available')}</span>
                  </button>
                `
              : ''}
          </div>
        </div>
      </header>
    `
  }

  render() {
    const activeView = VIEWS.find((view) => view.id === this._activeView)
    return html`
      ${this._renderTitlebar()}
      <div
        class="body"
        @focusin=${this._onBodyFocusIn}
        @focusout=${this._onBodyFocusOut}
        @db-select=${this._onDbSelect}
        @db-connect=${this._onDbConnect}
        @db-disconnect=${this._onDbDisconnect}
        @db-remove=${this._onDbRemove}
        @db-create-database=${this._onDbCreateDatabase}
        @db-drop-database=${this._onDbDropDatabase}
        @db-use-child=${this._onDbUseChild}
        @add-database=${this._onAddDatabase}
        @table-select=${this._onTableSelect}
        @table-browse=${this._onTableBrowse}
        @table-inspect=${this._onTableInspect}
        @table-create=${this._onTableCreate}
        @object-inspect=${this._onObjectInspect}
        @object-edit=${this._onObjectEdit}
        @matview-refresh=${this._onMatviewRefresh}
        @table-truncate=${this._onTableTruncate}
        @table-drop=${this._onTableDrop}
        @tables-refresh=${this._onTablesRefresh}
        @search-open=${this._onSearchOpen}
        @file-open=${this._onFileOpen}
        @file-create=${this._onFileCreate}
        @file-rename=${this._onFileRename}
        @file-delete=${this._onFileDelete}
        @file-reveal=${this._onFileReveal}
        @config-change=${this._onConfigChange}
        @config-save=${this._onConfigSave}
        @config-cancel=${this._onConfigCancel}
        @tab-select=${this._onTabSelect}
        @tab-close=${this._onTabClose}
        @editor-change=${this._onEditorChange}
        @run-target-change=${(event: CustomEvent<{ available: boolean }>) => {
          this._hasExplicitRunTarget = event.detail.available
        }}
        @run-query=${this._onRunQuery}
      >
        <nav class="activity-bar" @activity-select=${this._onActivitySelect}>
          ${VIEWS.map(
            (view) => html`
              <activity-button
                view=${view.id}
                class="tooltip-right"
                data-tooltip=${`${view.title} (${isMac ? '⇧⌘' : 'Shift+Ctrl+'}${view.shortcutKey})`}
                aria-label=${view.title}
                .active=${view.id === this._activeView}
                .badge=${view.id === 'tasks' ? this._queries.longRunningCount() : 0}
              >
                ${unsafeHTML(ACTIVITY_ICONS[view.id])}
              </activity-button>
            `,
          )}
        </nav>

        ${activeView
          ? html`
              <aside class="sidebar ${this._layout.sidebarCollapsing ? 'collapsed' : ''}" style="width: ${this._layout.sidebarWidth}px">
                <div class="sidebar-title">
                  <span>${activeView.title}</span>
                  ${this._renderTitleActions(activeView)}
                </div>
                ${this._renderSidebarView(activeView)}
              </aside>
              <div
                class="sidebar-resize ${this._layout.resizing ? 'active' : ''}"
                role="separator"
                aria-label=${t('workbench.resizeSidebar')}
                title=${t('workbench.resizeSidebar')}
                @pointerdown=${this._layout.onSidebarResizeStart}
                @dblclick=${this._layout.resetSidebarWidth}
              ></div>
            `
          : ''}

        <div class="editor-area">
          ${this._ctx.tabs.length
            ? html`
                <div class="tab-bar">
                  ${this._ctx.tabs.map(
                    (tab) => html`
                      <editor-tab
                        tabId=${tab.id}
                        name=${this._inspectDirtyTabIds.has(tab.id) ? `${tabTitle(tab)} •` : tabTitle(tab)}
                        .active=${tab.id === this._ctx.activeTabId}
                        .preview=${tab.kind === 'sql' && (tab.preview ?? false)}
                      ></editor-tab>
                    `,
                  )}
                </div>
              `
            : ''}
          ${this._renderEditorContent()}
        </div>
      </div>

      <command-palette
        .open=${this._cmdPalette.mode !== null}
        .mode=${this._cmdPalette.mode ?? 'commands'}
        .entries=${this._cmdPalette.entries()}
        @palette-close=${() => this._cmdPalette.close()}
        @palette-pick=${this._cmdPalette.onPick}
      ></command-palette>

      ${this._dialogs.confirm
        ? html`
            <confirm-dialog
              .message=${this._dialogs.confirm.message}
              .detail=${this._dialogs.confirm.detail}
              .confirmLabel=${this._dialogs.confirm.confirmLabel}
              .cancelLabel=${this._dialogs.confirm.cancelLabel === undefined ? t('common.cancel') : this._dialogs.confirm.cancelLabel}
              .danger=${this._dialogs.confirm.danger ?? false}
              @dialog-cancel=${() => (this._dialogs.confirm = null)}
              @dialog-confirm=${this._dialogs.acceptConfirm}
            ></confirm-dialog>
          `
        : ''}
      ${this._dialogs.prompt
        ? // Key by the config object so a queued prompt advancing mounts a fresh
          // dialog — the input is uncontrolled, so a reused element would keep
          // the previous prompt's typed text (and skip re-focus).
          keyed(
            this._dialogs.prompt,
            html`
              <prompt-dialog
                .message=${this._dialogs.prompt.message}
                .detail=${this._dialogs.prompt.detail}
                .confirmLabel=${this._dialogs.prompt.confirmLabel}
                .placeholder=${this._dialogs.prompt.placeholder}
                .allowEmpty=${this._dialogs.prompt.allowEmpty ?? false}
                .trim=${this._dialogs.prompt.trim ?? true}
                @dialog-cancel=${() => (this._dialogs.prompt = null)}
                @dialog-confirm=${this._dialogs.acceptPrompt}
              ></prompt-dialog>
            `,
          )
        : ''}
      ${this._dialogs.review
        ? html`
            <review-query-dialog
              .sql=${this._dialogs.review.sql}
              .params=${this._dialogs.review.params}
              .description=${this._dialogs.review.description ?? t('review.description')}
              .confirmLabel=${t('review.apply')}
              .run=${this._dialogs.review.run}
              @dialog-cancel=${() => {
                this._dialogs.review = null
                // A cancelled save never refreshes; the panel must not keep
                // waiting to restore its scroll into a later, unrelated result.
                this.renderRoot.querySelector('results-panel')?.refreshNotComing()
              }}
              @dialog-done=${() => (this._dialogs.review = null)}
            ></review-query-dialog>
          `
        : ''}
      ${this._dialogs.createDb
        ? keyed(
            this._dialogs.createDb,
            html`
              <create-database-dialog
                .meta=${this._dialogs.createDb.meta}
                @dialog-cancel=${() => (this._dialogs.createDb = null)}
                @dialog-confirm=${this._dialogs.acceptCreateDb}
              ></create-database-dialog>
            `,
          )
        : ''}
      ${this._renderCsvImportDialog()}
      ${this._parameterPrompt
        ? html`
            <parameter-dialog
              .parameters=${this._parameterPrompt.parameters}
              @dialog-cancel=${this._cancelParameterPrompt}
              @parameters-confirm=${this._confirmParameterPrompt}
            ></parameter-dialog>
          `
        : ''}
      ${this._destructivePrompt
        ? html`
            <review-query-dialog
              .heading=${this._destructivePrompt.script ? t('destructive.scriptTitle') : t('destructive.title')}
              .description=${[
                ...this._destructivePrompt.risks.map((risk) => t(`destructive.${risk}`)),
                t(this._destructivePrompt.risks.length > 1 ? 'destructive.cannotUndoMany' : 'destructive.cannotUndo'),
              ].join(' ')}
              .danger=${true}
              .confirmLabel=${t('destructive.run')}
              .sql=${this._destructivePrompt.sql}
              .params=${this._destructivePrompt.params}
              .run=${this._runDestructive}
              @dialog-cancel=${this._cancelDestructivePrompt}
            ></review-query-dialog>
          `
        : ''}

      <status-bar
        .workspaceName=${this.workspace?.name ?? ''}
        .contextName=${this._contextLabel()}
        .connections=${this._connectionList()}
        .sidebarOpen=${this._activeView !== null}
        .panelOpen=${!this._layout.panelCollapsed}
        .panelEnabled=${this._ctx.tabs.length > 0}
        .selectionStats=${this._selectionStats}
        @status-switch-database=${() => this._cmdPalette.open('databases')}
        @status-pick-connection=${this._onStatusPickConnection}
        @status-reveal-workspace=${() => void window.sqlkit.revealWorkspace()}
        @status-copy-workspace-path=${this._onCopyWorkspacePath}
        @status-toggle-sidebar=${() => this._toggleSidebar()}
        @status-toggle-panel=${() => this._layout.togglePanelCollapse()}
      ></status-bar>
    `
  }

  private _contextLabel() {
    const profile = this._config.activeProfile()
    if (!profile) return ''
    return this._ctx.activeChildDb ? `${profile.name} · ${this._ctx.activeChildDb}` : profile.name
  }

  private _connectionList(): StatusConnection[] {
    return this._live.connected().map((status) => ({
      profileId: status.profileId,
      name: this._config.byId(status.profileId)?.name ?? status.profileId,
      childDb: status.children?.find((child) => child.inUse)?.name ?? null,
      version: status.serverVersion ?? null,
      active: this._ctx.activeDbId === status.profileId,
    }))
  }

  private _onStatusPickConnection(event: Event) {
    const { profileId } = (event as CustomEvent<{ profileId: string }>).detail
    this._setActiveDb(profileId)
  }

  private _onCopyWorkspacePath = () => {
    if (this.workspace) void window.sqlkit.writeClipboardText(this.workspace.path)
  }

  // View-specific actions level with the sidebar title (reference layout).
  private _renderTitleActions(view: (typeof VIEWS)[number]) {
    if (view.id === 'history') {
      const key = this._activeContextKey()
      const count = this._queries.history.filter((item) => item.contextKey === key).length
      return html`
        <button
          class="title-action"
          title=${t('workbench.clearHistory')}
          aria-label=${t('workbench.clearHistory')}
          ?disabled=${!count}
          @click=${this._onHistoryClear}
        >
          <i class="icon icon-list-x" aria-hidden="true"></i>
        </button>
      `
    }
    if (view.id === 'tasks') {
      const finished = this._queries.tasks.some((task) => task.status !== 'running')
      return html`
        <button
          class="title-action"
          title=${t('workbench.clearTasks')}
          aria-label=${t('workbench.clearTasks')}
          ?disabled=${!finished}
          @click=${this._onTasksClear}
        >
          <i class="icon icon-list-x" aria-hidden="true"></i>
        </button>
      `
    }
    return ''
  }

  private _onTasksClear() {
    this._queries.clearFinishedTasks()
  }

  private _renderSidebarView(view: (typeof VIEWS)[number]) {
    if (view.id === 'databases') {
      return html`
        <databases-view
          .connections=${this._config.connections}
          .statuses=${this._live.statuses}
          .activeTabId=${this._ctx.activeTabId}
          .activeProfileId=${this._ctx.activeDbId}
          .activeChildDb=${this._ctx.activeChildDb}
        ></databases-view>
      `
    }
    if (view.id === 'explorer') {
      const activeTab = this._ctx.tabs.find((tab) => tab.id === this._ctx.activeTabId)
      const context = this._config.activeProfile()
      const live = this._connectedProfile()
      const children = live ? (this._live.statuses[live.id]?.children ?? []) : []
      const hasChildSelection = children.length > 1
      const activeChild = hasChildSelection ? (children.find((child) => child.inUse)?.name ?? null) : null
      const selectedChild = this._ctx.activeChildDb
      const metadataMatchesContext = !!live && (!hasChildSelection || (selectedChild !== null && selectedChild === activeChild))
      return html`
        <explorer-view
          .files=${this._workspaceFiles.files}
          .activePath=${activeTab?.kind === 'sql' ? activeTab.path : null}
          .contextName=${context ? this._contextLabel() : null}
          .profileId=${context?.id ?? null}
          .engine=${context?.engine ?? null}
          .tables=${metadataMatchesContext ? (this._live.tables[live.id] ?? []) : null}
          .columns=${metadataMatchesContext ? (this._live.columns[live.id] ?? null) : null}
          .objects=${metadataMatchesContext ? (this._live.objects[live.id] ?? null) : null}
          .activeChildName=${metadataMatchesContext ? activeChild : null}
          .awaitingDatabaseSelection=${!!live && hasChildSelection && selectedChild === null}
          .selectedTable=${this._ctx.selectedTable}
          .profileIds=${this._config.connections.map((connection) => connection.id)}
          @table-import=${this._onTableImport}
        ></explorer-view>
      `
    }
    if (view.id === 'search') {
      return html`<search-view .files=${this._workspaceFiles.files}></search-view>`
    }
    if (view.id === 'history') {
      const key = this._activeContextKey()
      return html`
        <history-view
          .items=${this._queries.history.filter((item) => item.contextKey === key)}
          .engine=${this._config.activeProfile()?.engine ?? null}
          @history-open=${this._onHistoryOpen}
          @history-open-permanent=${this._onHistoryOpenPermanent}
          @history-explain=${this._onHistoryExplain}
          @history-clear=${this._onHistoryClear}
        ></history-view>
      `
    }
    if (view.id === 'tasks') {
      const profile = this._connectedProfile()
      return html`
        <tasks-view
          .items=${this._queries.tasks}
          .profileId=${profile?.id ?? null}
          .childDb=${this._ctx.activeChildDb}
          .engine=${profile?.engine ?? null}
          @task-stop=${this._onTaskStop}
          @session-end=${this._onSessionEnd}
        ></tasks-view>
      `
    }
    // Every view id is handled above; 'server' is the last one.
    return html`<server-view .profileId=${this._connectedProfile()?.id ?? null} .childDb=${this._ctx.activeChildDb}></server-view>`
  }

  // Single click: open the SQL in the preview tab (recycled across picks, so
  // browsing history doesn't stack tabs). Never auto-runs.
  private _onHistoryOpen(event: Event) {
    const { sql } = (event as CustomEvent<HistoryOpenDetail>).detail
    this._ctx.openPreview(sql)
  }

  // Right-click explain: the prefixed statement lands in the preview tab and
  // runs immediately, so the plan arrives with its SQL visible.
  private _onHistoryExplain(event: Event) {
    const { sql, analyze } = (event as CustomEvent<HistoryExplainDetail>).detail
    const profile = this._config.activeProfile()
    if (!profile) return
    const prefix = profile.engine === 'sqlite' ? 'explain query plan ' : analyze ? 'explain analyze ' : 'explain '
    const statement = prefix + stripExplain(sql)
    this._ctx.openPreview(statement)
    void this._runSql(statement)
  }

  private _onHistoryOpenPermanent(event: Event) {
    this._ctx.openPermanent((event as CustomEvent<HistoryOpenDetail>).detail.sql)
  }

  private _onHistoryClear() {
    this._queries.clearHistory(this._activeContextKey())
  }

  private _renderEditorContent() {
    const activeTab = this._ctx.tabs.find((tab) => tab.id === this._ctx.activeTabId)
    if (activeTab?.kind === 'config') {
      return html`
        <div class="editor-content form">
          <db-config-form .profile=${activeTab.profile}></db-config-form>
        </div>
      `
    }
    if (activeTab?.kind === 'inspect') {
      return html`
        <div class="editor-content inspect">
          <table-inspect
            .tabId=${activeTab.id}
            .profileId=${activeTab.profileId}
            .childDb=${this._ctx.activeChildDb}
            .table=${activeTab.table}
            .createTable=${activeTab.createTable ?? false}
            .engine=${this._config.byId(activeTab.profileId)?.engine ?? null}
            .tables=${this._live.tables[activeTab.profileId] ?? []}
            .referenceColumns=${this._live.columns[activeTab.profileId] ?? []}
            .functions=${this._live.objects[activeTab.profileId]?.functions ?? []}
            @alter-columns=${this._onAlterColumns}
            @inspect-dirty=${this._onInspectDirty}
            @object-edit=${this._onObjectEdit}
          ></table-inspect>
        </div>
      `
    }
    if (activeTab?.kind === 'inspect-object') {
      return html`
        <div class="editor-content inspect">
          <table-inspect
            .profileId=${activeTab.profileId}
            .childDb=${this._ctx.activeChildDb}
            .object=${activeTab.object}
            .objectKind=${activeTab.objectKind}
            .engine=${this._config.byId(activeTab.profileId)?.engine ?? null}
            @object-edit=${this._onObjectEdit}
          ></table-inspect>
        </div>
      `
    }
    if (activeTab?.kind === 'sql') {
      const tables = this._ctx.activeDbId ? (this._live.tables[this._ctx.activeDbId] ?? []) : []
      const columns = this._ctx.activeDbId ? (this._live.columns[this._ctx.activeDbId] ?? null) : null
      const dialect = dialectForEngine[this._config.activeProfile()?.engine ?? 'postgresql']
      return html`
        <div class="editor-content sql">
          <div class="editor-pane">
            <sql-editor
              .tabId=${activeTab.id}
              .value=${activeTab.content}
              .dialect=${dialect}
              .tables=${tables}
              .columns=${columns}
              @editor-notice=${this._onGridNotice}
              @editor-command=${this._onEditorCommand}
            ></sql-editor>
          </div>
          ${this._layout.panelCollapsed
            ? ''
            : html`
                <div
                  class="panel-resize ${this._layout.panelResizing ? 'active' : ''}"
                  role="separator"
                  aria-label=${t('workbench.resizeResults')}
                  title=${t('workbench.resizeResults')}
                  @pointerdown=${this._layout.onPanelResizeStart}
                  @dblclick=${this._layout.resetPanelHeight}
                ></div>
              `}
          <results-panel
            .run=${this._queries.runFor(this._ctx.activeTabId)}
            .engine=${this._config.activeProfile()?.engine ?? 'postgresql'}
            .canCancel=${this._config.activeProfile()?.engine !== 'sqlite'}
            .canGoBack=${this._queries.canGoBack(this._ctx.activeTabId)}
            .canGoForward=${this._queries.canGoForward(this._ctx.activeTabId)}
            .foreignKeys=${this._resultForeignKeys()}
            .jsonColumns=${this._resultJsonColumns()}
            .keyColumns=${this._resultKeyColumns()}
            .tabId=${this._ctx.activeTabId}
            .editable=${this._resultEditing.hasResultCells()}
            .rowEditable=${this._resultEditing.rowEditable()}
            .insertTable=${this._resultEditing.resultTable()}
            .drafts=${this._queries.draftsFor(this._ctx.activeTabId)}
            .edits=${this._queries.editsFor(this._ctx.activeTabId)}
            .pendingDeletes=${this._queries.pendingDeletesFor(this._ctx.activeTabId)}
            .sort=${this._queries.sortFor(this._ctx.activeTabId)}
            .filter=${this._queries.filterFor(this._ctx.activeTabId)}
            .columnWidths=${this._resultColumnWidths()}
            .streamExportAvailable=${this._canStreamExport()}
            @cancel-query=${this._onCancelQuery}
            @result-navigate=${this._onResultNavigate}
            @follow-foreign-key=${this._onFollowForeignKey}
            @goto-error-line=${this._onGotoErrorLine}
            @stream-export=${this._onStreamExport}
            @load-more=${this._onLoadMore}
            @selection-stats=${this._onSelectionStats}
            @result-dirty-change=${this._onResultDirtyChange}
            @cell-edit=${this._onCellEdit}
            @cell-edit-clear=${this._onCellEditClear}
            @cells-fill=${this._onCellsFill}
            @add-row=${this._onAddRow}
            @duplicate-rows=${this._onDuplicateRows}
            @stage-delete=${this._onStageDelete}
            @draft-edit=${this._onDraftEdit}
            @grid-notice=${this._onGridNotice}
            @draft-remove=${this._onDraftRemove}
            @save-rows=${() => this._resultEditing.saveChanges()}
            @discard-changes=${this._onDiscardChanges}
            @resize-columns=${this._onResizeColumns}
            @sort-column=${this._onSortColumn}
            @filter-condition=${this._onFilterCondition}
            style="height: ${this._layout.panelStyleHeight()}${this._layout.panelCollapsed ? '; display: none' : ''}"
          ></results-panel>
        </div>
      `
    }

    return html`
      <div class="editor-content">
        <editor-empty @empty-action=${this._onEmptyAction}></editor-empty>
      </div>
    `
  }

  // --- event handlers --------------------------------------------------------

  private _onActivitySelect(event: Event) {
    const { view } = (event as CustomEvent<{ view: ViewId }>).detail
    this._activeView = this._activeView === view ? null : view
  }

  // The editor's right-click menu only asks for the palette so far.
  private _onEditorCommand(event: Event) {
    const { command } = (event as CustomEvent<EditorCommandDetail>).detail
    if (command === 'command-palette') this._cmdPalette.open('commands')
  }

  private _onEmptyAction(event: Event) {
    const { action } = (event as CustomEvent<{ action: EmptyAction }>).detail
    if (action === 'new-query') this._ctx.newQuery()
    if (action === 'quick-open') this._cmdPalette.open('quick')
    if (action === 'switch-database') this._cmdPalette.open('databases')
    if (action === 'command-palette') this._cmdPalette.open('commands')
    if (action === 'add-database') this._onAddDatabase()
    if (action === 'close-workspace') this._onCloseWorkspace()
  }

  private _onAddDatabase() {
    this._ctx.openConfigTab(this._config.newProfile())
  }

  private _onDbSelect(event: Event) {
    const { id } = (event as CustomEvent<{ id: string }>).detail
    const connection = this._config.byId(id)
    if (connection) this._ctx.openConfigTab(connection)
  }

  private async _onDbConnect(event: Event) {
    const { id } = (event as CustomEvent<{ id: string }>).detail
    const connection = this._config.byId(id)
    if (!connection) return
    // Failures surface through the status push (error dot + message).
    const result = await this._live.connect(connection)
    if (!result.success) return
    // Preserve the original behavior: only align when reconnecting the
    // already-active profile (its current child); a freshly-connected,
    // not-yet-active profile is aligned by _setActiveDb below.
    await this._alignActiveChild(id, this._ctx.activeDbId === id ? this._ctx.activeChildDb : null, { followMissing: true })
    // A successful connect becomes the in-use context, but stays on the
    // Databases view — no jumping to the Explorer uninvited.
    this._setActiveDb(id)
  }

  private async _onDbDisconnect(event: Event) {
    const { id } = (event as CustomEvent<{ id: string }>).detail
    await this._live.disconnect(id)
  }

  private _onDbCreateDatabase(event: Event) {
    const { id } = (event as CustomEvent<{ id: string }>).detail
    void this._schemaOps.createDatabase(id)
  }

  private _onDbDropDatabase(event: Event) {
    const { id, database } = (event as CustomEvent<{ id: string; database: string }>).detail
    this._schemaOps.dropDatabase(id, database)
  }

  // Switch an all-databases connection's active child from the Databases list:
  // move the working context and point the driver at it (so the ACTIVE tag follows).
  private _onDbUseChild(event: Event) {
    const { id, database } = (event as CustomEvent<{ id: string; database: string }>).detail
    this._setActiveDb(id, database)
    void this._alignActiveChild(id, database)
  }

  // Workbench cleanup after a child database is dropped on the server.
  private _onDatabaseDropped(id: string, database: string) {
    // Forget the remembered child before redirecting: it still names the dropped
    // database, and defaultChild() would resolve straight back to it.
    if (this._config.clearLastChildDb(id, database)) this._config.persist()
    // If the user was working in the dropped child, follow the driver's
    // in-use child instead of pointing at a database that no longer exists.
    // This has to happen before the context is dropped: while the dropped child
    // is active its tabs are live rather than stashed, so clearing the stash
    // first would leave them untouched and the switch would stash them back.
    if (this._ctx.activeDbId === id && this._ctx.activeChildDb === database) {
      this._setActiveDb(id, this._config.inUseChild(id) ?? undefined)
    }
    // The dropped child's working context is gone with it, including whatever
    // the switch above just stashed.
    this._ctx.dropInstance(contextKey(id, database))
    this._sweepOrphanTabState()
  }

  private _onDbRemove(event: Event) {
    const { id } = (event as CustomEvent<{ id: string }>).detail
    const profile = this._config.byId(id)
    if (!profile) return
    this._dialogs.confirm = {
      message: t('workbench.removeDatabasePrompt', { name: profile.name.trim() || t('config.newDatabase') }),
      detail: t('workbench.removeDatabaseDetail'),
      confirmLabel: t('common.remove'),
      danger: true,
      action: () => void this._removeDatabase(id),
    }
  }

  private async _removeDatabase(id: string) {
    await this._live.disconnect(id)

    // Leave the context first so _switchInstance doesn't re-stash it below.
    if (this._ctx.activeDbId === id) {
      const next = this._config.connections.find((connection) => connection.id !== id) ?? null
      this._ctx.switchInstance(next?.id ?? null, next ? this._config.defaultChild(next) : null)
    }

    this._config.remove(id)

    // Drop the profile's stashed contexts and its config tab wherever it's open.
    this._ctx.removeProfile(id)
    this._sweepOrphanTabState()

    this._workspaceFiles.setFolder(this._contextFolder())
    this._config.persist()
  }


  private _onTablesRefresh() {
    const profile = this._config.activeProfile()
    if (profile) this._live.refresh(profile.id)
  }

  private _onTableSelect(event: Event) {
    this._ctx.selectedTable = (event as CustomEvent<TableSelectDetail>).detail.key
  }

  private _onTableBrowse(event: Event) {
    const { table } = (event as CustomEvent<TableBrowseDetail>).detail
    const profile = this._config.activeProfile()
    if (profile) this._browseTable(profile, table)
  }

  private _onMatviewRefresh(event: Event) {
    this._schemaOps.refreshMatview((event as CustomEvent<TableBrowseDetail>).detail.table)
  }

  private _onTableDrop(event: Event) {
    this._schemaOps.dropTable((event as CustomEvent<TableBrowseDetail>).detail.table)
  }

  private _onTableTruncate(event: Event) {
    this._schemaOps.truncateTable((event as CustomEvent<TableBrowseDetail>).detail.table)
  }

  private async _onTableImport(event: Event) {
    const table = (event as CustomEvent<TableBrowseDetail>).detail.table
    const profile = this._config.activeProfile()
    if (!profile || table.kind !== 'table') return
    const childDb = this._ctx.activeChildDb
    const columnRefs = (this._live.columns[profile.id] ?? []).filter(
      (column) => column.table === table.name && column.schema === table.schema,
    )
    if (!columnRefs.length) {
      this._dialogs.notice(t('import.failedTitle'), t('import.noMetadata'))
      return
    }
    let result
    try {
      result = await window.sqlkit.inspectTable(profile.id, childDb, table)
    } catch (error) {
      this._dialogs.notice(t('import.failedTitle'), (error as Error).message)
      return
    }
    if (!result.success) {
      this._dialogs.notice(t('import.failedTitle'), result.error)
      return
    }
    // The context may have changed while metadata was loading; never open a
    // dialog that would write invisibly to the old database.
    if (this._ctx.activeDbId !== profile.id || this._ctx.activeChildDb !== childDb) return
    const inspected = new Map(result.inspection.columns.map((column) => [column.name, column]))
    const columns: ImportColumn[] = columnRefs.map((column) => {
      const detail = inspected.get(column.name)
      return { column, generated: detail?.generated ?? false, identity: detail?.identity ?? null }
    })
    this._csvImport = {
      table,
      profileId: profile.id,
      childDb,
      engine: profile.engine,
      columns,
    }
  }

  private _renderCsvImportDialog() {
    const state = this._csvImport
    if (!state) return ''
    return html`
      <import-dialog
        .table=${state.table}
        .columns=${state.columns}
        .run=${(detail: ImportConfirmDetail) => this._runCsvImport(state, detail)}
        @dialog-cancel=${() => (this._csvImport = null)}
        @dialog-done=${() => (this._csvImport = null)}
      ></import-dialog>
    `
  }

  private async _runCsvImport(state: CsvImportState, detail: ImportConfirmDetail): Promise<string | null> {
    let statements
    try {
      statements = buildInsertBatches({
        table: state.table,
        columns: detail.columns.map((column) => ({ name: column.name, columnMeta: column })),
        values: detail.rows,
        engine: state.engine,
      })
    } catch (error) {
      return (error as Error).message
    }
    if (statements.length > 1_000) {
      return t('import.tooManyBatches')
    }
    try {
      const result = await window.sqlkit.runBatch(state.profileId, state.childDb, statements)
      if (result.success) return null
      const error = result.failedIndex === undefined
        ? result.error
        : t('import.batchFailure', { index: result.failedIndex + 1, total: statements.length, error: result.error })
      return t('import.rolledBack', { error })
    } catch (error) {
      return (error as Error).message
    }
  }

  private _onAlterColumns(event: Event) {
    const detail = (event as CustomEvent<ColumnAlterEventDetail>).detail
    if (!detail.createTable) {
      this._schemaOps.alterColumns(detail)
      return
    }
    this._schemaOps.alterColumns({
      ...detail,
      onApplied: () => {
        detail.onApplied()
        const id = `inspect:${tableContextKey(detail.profileId, detail.childDb, detail.table)}`
        this._ctx.replaceTabInContext(detail.profileId, detail.childDb, detail.tabId, {
          id,
          kind: 'inspect',
          profileId: detail.profileId,
          table: detail.table,
        })
        this._inspectDirtyTabIds = new Set([...this._inspectDirtyTabIds].filter((dirtyId) => dirtyId !== detail.tabId))
        dropInspectDraft(detail.tabId)
      },
    })
  }

  private _onInspectDirty(event: Event) {
    const { tabId, dirty } = (event as CustomEvent<{ tabId: string; dirty: boolean }>).detail
    if (!tabId) return
    const next = new Set(this._inspectDirtyTabIds)
    if (dirty) next.add(tabId)
    else next.delete(tabId)
    this._inspectDirtyTabIds = next
  }

  private _forgetInspectDirty(tabId: string) {
    if (!this._inspectDirtyTabIds.has(tabId)) return
    const next = new Set(this._inspectDirtyTabIds)
    next.delete(tabId)
    this._inspectDirtyTabIds = next
  }

  // Bulk tab removals (a removed connection, a dropped child database, a deleted
  // file) drop tabs without closing them one by one, so every per-tab store
  // needs a pass for owners that no longer exist.
  private _sweepOrphanTabState() {
    this._queries.sweepOrphans()
    sweepInspectDrafts((tabId) => this._ctx.tabExists(tabId))
    const stale = [...this._inspectDirtyTabIds].filter((tabId) => !this._ctx.tabExists(tabId))
    if (stale.length) this._inspectDirtyTabIds = new Set([...this._inspectDirtyTabIds].filter((tabId) => this._ctx.tabExists(tabId)))
    for (const tabId of [...this._tabScroll.keys()]) {
      if (!this._ctx.tabExists(tabId)) this._tabScroll.delete(tabId)
    }
  }

  // Inspect opens (or revisits) the table's structure tab — columns,
  // constraints, indexes and friends; table-inspect fetches its own data.
  private _onTableInspect(event: Event) {
    const { table } = (event as CustomEvent<TableBrowseDetail>).detail
    const profile = this._config.activeProfile()
    if (!profile) return
    const id = `inspect:${tableContextKey(profile.id, this._ctx.activeChildDb, table)}`
    this._ctx.addTab({ id, kind: 'inspect', profileId: profile.id, table })
  }

  private _onTableCreate(event: Event) {
    const profile = this._config.activeProfile()
    if (!profile) return
    const { schema } = (event as CustomEvent<TableCreateDetail>).detail
    const id = `create-table:${profile.id}:${this._ctx.activeChildDb ?? ''}:${crypto.randomUUID()}`
    this._ctx.addTab({
      id,
      kind: 'inspect',
      profileId: profile.id,
      table: { schema, name: 'new_table', kind: 'table' },
      createTable: true,
    })
  }

  // Same for functions/types; detail (identity args) keeps overloads apart.
  private _onObjectInspect(event: Event) {
    const { object, objectKind } = (event as CustomEvent<ObjectInspectDetail>).detail
    const profile = this._config.activeProfile()
    if (!profile) return
    const id = `inspect-object:${profile.id}:${this._ctx.activeChildDb ?? ''}:${object.schema ?? ''}:${objectKind}:${object.name}:${object.detail}`
    this._ctx.addTab({ id, kind: 'inspect-object', profileId: profile.id, object, objectKind })
  }

  // "Edit" a function/view: fetch its re-runnable CREATE DDL and open it in a
  // new SQL tab. It is not auto-run — the user reviews and executes it.
  private async _onObjectEdit(event: Event) {
    const { ref } = (event as CustomEvent<ObjectEditDetail>).detail
    const profile = this._config.activeProfile()
    if (!profile) return
    const childDb = this._ctx.activeChildDb
    let result
    try {
      result = await window.sqlkit.getObjectDdl(profile.id, childDb, ref)
    } catch (error) {
      this._dialogs.notice(t('explorer.editFailedTitle'), (error as Error).message)
      return
    }
    if (!result.success) {
      this._dialogs.notice(t('explorer.editFailedTitle'), result.error)
      return
    }
    // Bail if the context changed while the DDL loaded — a stale tab would
    // belong to the wrong database.
    if (this._ctx.activeDbId !== profile.id || this._ctx.activeChildDb !== childDb) return
    const id = `edit:${profile.id}:${childDb ?? ''}:${ref.kind}:${ref.schema ?? ''}:${ref.name}`
    this._ctx.addTab({ id, kind: 'sql', name: `${ref.name}.sql`, path: null, content: result.sql, savedContent: result.sql })
  }

  // A search match opens the file and lands the cursor on the matched line.
  private async _onSearchOpen(event: Event) {
    const { file, line } = (event as CustomEvent<SearchOpenDetail>).detail
    await this._fileOps.openFile(file)
    await this.updateComplete
    // The user may have switched tabs during the awaits; only reveal if the
    // file we opened is still the active editor.
    if (this._ctx.activeSqlTab()?.path !== file.path) return
    const editor = this.shadowRoot?.querySelector('sql-editor')
    if (!editor) return
    await editor.updateComplete
    editor.revealLine(line)
  }

  private _onFileOpen(event: Event) {
    this._fileOps.openFileOrExternal((event as CustomEvent<{ file: FileInfo }>).detail.file)
  }

  private _onFileCreate(event: Event) {
    const { parent, name } = (event as CustomEvent<FileCreateDetail>).detail
    void this._fileOps.create(parent, name)
  }

  private _onFileRename(event: Event) {
    const { file, newName } = (event as CustomEvent<FileRenameDetail>).detail
    void this._fileOps.rename(file, newName)
  }

  private _onFileDelete(event: Event) {
    const { path, name } = (event as CustomEvent<FileDeleteDetail>).detail
    this._fileOps.requestDelete(path, name)
  }

  private _onFileReveal(event: Event) {
    this._fileOps.reveal((event as CustomEvent<FileRevealDetail>).detail.path)
  }

  private _onEditorChange(event: Event) {
    const { value } = (event as CustomEvent<{ value: string }>).detail
    this._ctx.setActiveContent(value)
  }

  private _onRunQuery(event: Event) {
    const { sql, line } = (event as CustomEvent<RunQueryDetail>).detail
    void this._runSql(sql, undefined, undefined, undefined, line)
  }

  // "Line N" click on a failed run: the error shown belongs to the active tab,
  // so the reveal targets the editor currently mounted.
  private _onGotoErrorLine(event: Event) {
    const { line } = (event as CustomEvent<{ line: number }>).detail
    this.renderRoot.querySelector('sql-editor')?.revealLine(line)
  }

  // The pending runQuery settles on its own with "Query cancelled." — this
  // only asks the server to interrupt the backend.
  private _onCancelQuery() {
    const run = this._queries.runFor(this._ctx.activeTabId)
    if (run.phase === 'running') void this._cancelQuery(run.profileId, run.executionId)
  }

  // Staged edits, new rows and deletions are aligned to the visible result by row
  // index, so they cannot follow the user to another result. Leaving with unsaved
  // work therefore has to be a decision rather than a silent discard.
  private _guardStagedLeave(tabId: string, intent: 'result' | 'foreignKey', leave: () => void) {
    // The results panel can hold JSON editor text that never staged (invalid,
    // or reachable only through Forward) — same unsaved work, same guard.
    const unstagedJson = this.renderRoot?.querySelector('results-panel')?.hasUnstagedJson() ?? false
    if (!this._queries.hasStaged(tabId) && !unstagedJson) {
      leave()
      return
    }
    this._dialogs.confirm = {
      message: t(intent === 'foreignKey' ? 'results.followStagedPrompt' : 'results.leaveStagedPrompt'),
      detail: t(intent === 'foreignKey' ? 'results.followStagedDetail' : 'results.leaveStagedDetail'),
      confirmLabel: t(intent === 'foreignKey' ? 'results.discardAndOpen' : 'results.discardAndLeave'),
      danger: true,
      // Discard for real before leaving: nothing on the navigation path realigns
      // staged state, and stale row-indexed edits would arm writes against
      // whatever result appears next.
      action: () => {
        this._queries.discardStaged(tabId)
        leave()
      },
    }
  }

  /** Steps the active tab's result trail. */
  private _onResultNavigate(event: Event) {
    const { direction } = (event as CustomEvent<ResultNavigateDetail>).detail
    const tabId = this._ctx.activeTabId
    if (!tabId) return
    // Refuse before prompting: confirming a discard for a step that will not
    // happen (mid-run, or nowhere to go) would throw staged work away for nothing.
    if (!(direction === 'back' ? this._queries.canGoBack(tabId) : this._queries.canGoForward(tabId))) return
    this._guardStagedLeave(tabId, 'result', () => {
      if (direction === 'back') this._queries.goBack(tabId)
      else this._queries.goForward(tabId)
    })
  }

  /** Result columns of the visible result that can be followed, by column index.
   * Memoised on the result and metadata identities: the grid reads this every
   * render, and a fresh Map each time would read as changed data. */
  private _resultForeignKeys(): ReadonlyMap<number, ColumnReference> {
    const run = this._queries.runFor(this._ctx.activeTabId)
    const columns = this._ctx.activeDbId ? (this._live.columns[this._ctx.activeDbId] ?? []) : []
    // Column sources are per result set, while this map is per column index, so a
    // multi-set run could point a column at the wrong table. Offer nothing there.
    if (run.phase !== 'done' || (run.result.resultSets?.length ?? 0) > 1) return NO_FOREIGN_KEYS
    const cached = this._foreignKeyCache
    if (cached && cached.result === run.result && cached.columns === columns) return cached.map
    const map = foreignKeyTargets(run.result, columns)
    this._foreignKeyCache = { result: run.result, columns, map }
    return map
  }

  /** Result columns declared json/jsonb, by column index. Memoised on the same
   * identities as the foreign-key map, and silent for the same reason: column
   * sources are per result set, so a multi-set run cannot be trusted. */
  private _resultJsonColumns(): ReadonlySet<number> {
    const run = this._queries.runFor(this._ctx.activeTabId)
    const columns = this._ctx.activeDbId ? (this._live.columns[this._ctx.activeDbId] ?? []) : []
    if (run.phase !== 'done' || (run.result.resultSets?.length ?? 0) > 1) return NO_JSON_COLUMNS
    const cached = this._jsonColumnCache
    if (cached && cached.result === run.result && cached.columns === columns) return cached.set
    const set = jsonColumns(run.result, columns)
    this._jsonColumnCache = { result: run.result, columns, set }
    return set
  }

  /** Result columns carrying the row's primary key, so the panel can tell a row
   * apart from the one that took its index after a save re-ran the query.
   * Memoised on the same identities, and silent for a multi-set run for the
   * same reason: column sources are per set. */
  private _resultKeyColumns(): readonly number[] {
    const run = this._queries.runFor(this._ctx.activeTabId)
    const columns = this._ctx.activeDbId ? (this._live.columns[this._ctx.activeDbId] ?? []) : []
    if (run.phase !== 'done' || (run.result.resultSets?.length ?? 0) > 1) return NO_KEY_COLUMNS
    const cached = this._keyColumnCache
    if (cached && cached.result === run.result && cached.columns === columns) return cached.keys
    const keys = this._resultEditing.keyColumns()
    this._keyColumnCache = { result: run.result, columns, keys }
    return keys
  }

  // Follows one cell's foreign key: opens the referenced row as a new trail entry
  // in this tab, so back returns to where the user came from. The value is bound,
  // never interpolated — it can be any type the column holds.
  private _onFollowForeignKey(event: Event) {
    const { row, col } = (event as CustomEvent<FollowForeignKeyDetail>).detail
    const tabId = this._ctx.activeTabId
    const profile = this._config.activeProfile()
    const run = this._queries.runFor(tabId)
    if (!tabId || !profile || run.phase !== 'done') return
    const target = this._resultForeignKeys().get(col)
    const value = run.result.rows[row]?.[col]
    // A null foreign key references nothing, and an unresolved column cannot be
    // followed; the grid hides the affordance in both cases, but the event is
    // untrusted input like any other.
    if (!target || value === null || value === undefined) return

    const dialect = dialectFor(profile.engine)
    const table: TableRef = { schema: target.schema, name: target.table, kind: 'table' }
    const sql = dialect.browseTableWhere(
      quoteQualified(table, dialect),
      dialect.quoteIdent(target.column),
      dialect.placeholder(1),
      BROWSE_ROW_LIMIT,
    )
    this._guardStagedLeave(tabId, 'foreignKey', () => {
      void this._runSql(sql, null, [value], null, undefined, { push: true, table }).then(() => {
        if (this._ctx.activeTabId === tabId) this.renderRoot.querySelector('results-panel')?.focusLandedResult()
      })
    })
  }

  // Stop is best-effort: a query still spinning up has no backend PID to target
  // yet, so the cancel reports why instead of looking like a silent no-op.
  private async _cancelQuery(profileId: string, executionId: string) {
    let result: { success: boolean; error?: string }
    try {
      result = await window.sqlkit.cancelQuery(profileId, executionId)
    } catch (error) {
      result = { success: false, error: (error as Error).message }
    }
    // A failed cancel must not be silent — the user thinks the query stopped and
    // keeps waiting. Surface why (backend still starting up, nothing running, …).
    if (!result.success && result.error) this._dialogs.notice(t('workbench.cancelFailed'), result.error)
  }

  // The results grid scrolled near the end of what's loaded: page in more rows.
  private _onLoadMore(event: Event) {
    const index = (event as CustomEvent<{ resultSetIndex?: number }>).detail?.resultSetIndex
    if (this._ctx.activeTabId) void this._queries.loadMore(this._ctx.activeTabId, index)
  }

  // While the save-review dialog is up, the statements were built from a
  // snapshot; staging anything more would be silently dropped or mis-indexed
  // by the post-commit cleanup. Freeze staging until the dialog closes.
  private _stagingFrozen() {
    return this._dialogs.review !== null
  }

  // A result-cell edit stages a pending change (committed later via ⌘S / Save),
  // mirroring how new rows are staged — no per-edit dialog.
  private _onCellEdit(event: Event) {
    if (this._stagingFrozen()) return
    const { row, col, value } = (event as CustomEvent<{ row: number; col: number; value: CellInput }>).detail
    if (this._ctx.activeTabId) this._queries.setEdit(this._ctx.activeTabId, row, col, value)
  }

  private _onCellEditClear(event: Event) {
    if (this._stagingFrozen()) return
    const { row, col } = (event as CustomEvent<{ row: number; col: number }>).detail
    if (this._ctx.activeTabId) this._queries.clearEdit(this._ctx.activeTabId, row, col)
  }

  // A multi-cell fill from the grid: stage every changed cell in one undo step.
  private _onCellsFill(event: Event) {
    if (this._stagingFrozen()) return
    const detail = (
      event as CustomEvent<{
        edits: Array<{ row: number; col: number; value: CellInput }>
        clears: Array<{ row: number; col: number }>
        draftCells: Array<{ index: number; col: number; value: CellInput | null }>
      }>
    ).detail
    if (this._ctx.activeTabId) this._queries.applyFill(this._ctx.activeTabId, detail)
  }

  private _onGridNotice(event: Event) {
    const { title, detail } = (event as CustomEvent<{ title: string; detail: string }>).detail
    this._dialogs.notice(title, detail)
  }

  // Whether the export dialog may offer a full streamed export: the current run
  // is a finished, read-only query, so re-running it to stream every row is safe.
  private _canStreamExport(): boolean {
    const run = this._queries.runFor(this._ctx.activeTabId)
    const engine = this._config.activeProfile()?.engine
    return run.phase === 'done' && !!run.sql && !!engine && isReadOnlyQuery(run.sql, engine)
  }

  // Streams the current query's full result to a file the user picks. Re-runs the
  // SQL (with any injected sort) in the main process, which re-checks read-only.
  private async _onStreamExport(event: Event) {
    const { format } = (event as CustomEvent<{ format: ExportFormat }>).detail
    const tabId = this._ctx.activeTabId
    const profile = this._config.activeProfile()
    const run = this._queries.runFor(tabId)
    if (!tabId || !profile || run.phase !== 'done' || !run.sql) return
    const tab = this._ctx.tabs.find((entry) => entry.id === tabId)
    const base = tab && 'name' in tab && typeof tab.name === 'string' ? tab.name.replace(/\.sql$/i, '') : 'results'
    // Tracked as a task so a long export is visible and stoppable; the
    // executionId is what Stop targets through cancelQuery.
    const executionId = crypto.randomUUID()
    const childDb = this._ctx.activeChildDb
    this._queries.beginExport({
      executionId,
      profileId: profile.id,
      contextLabel: childDb ? `${profile.name} / ${childDb}` : profile.name,
      sql: run.sql,
    })
    const result = await window.sqlkit.exportQuery(
      profile.id,
      childDb,
      run.sql,
      run.params,
      this._queries.sortFor(tabId),
      this._queries.filterFor(tabId),
      format,
      `${base || 'results'}.${format}`,
      executionId,
      // Only the sql format uses it; the main process names its INSERTs after
      // this table (null → a placeholder the user replaces).
      this._resultEditing.resultTable(),
    )
    this._queries.finishExport(executionId, result)
    // A stop the user asked for is not a failure; the task already shows it.
    if (!result.success && result.error && !result.cancelled) {
      this._dialogs.notice(t('workbench.exportFailed'), result.error)
    }
  }

  // Stages an empty new row in the grid (committed later via ⌘S / Save rows),
  // inserting below the selected row and expanding the panel if it was collapsed.
  private _onAddRow(event: Event) {
    if (this._stagingFrozen()) return
    const tabId = this._ctx.activeTabId
    const run = this._queries.runFor(tabId)
    if (!tabId || run.phase !== 'done') return
    const { after, index } = (event as CustomEvent<{ after?: number; index?: number }>).detail ?? {}
    this._queries.addDraft(tabId, run.result.columns.length, after, index)
    this._layout.expandPanel()
  }

  private _onDraftEdit(event: Event) {
    if (this._stagingFrozen()) return
    const { index, col, value } = (event as CustomEvent<{ index: number; col: number; value: CellInput }>).detail
    if (this._ctx.activeTabId) this._queries.setDraftCell(this._ctx.activeTabId, index, col, value)
  }

  private _onDraftRemove(event: Event) {
    if (this._stagingFrozen()) return
    const { indexes } = (event as CustomEvent<{ indexes: number[] }>).detail
    if (this._ctx.activeTabId) this._queries.dropDrafts(this._ctx.activeTabId, indexes)
  }

  private _onDuplicateRows(event: Event) {
    if (this._stagingFrozen()) return
    const { drafts } = (event as CustomEvent<{ drafts: Array<{ after: number; cells: Array<CellInput | null> }> }>).detail
    if (this._ctx.activeTabId) this._queries.addDrafts(this._ctx.activeTabId, drafts)
    this._layout.expandPanel()
  }

  private _onDiscardChanges() {
    if (this._stagingFrozen()) return
    if (this._ctx.activeTabId) this._queries.clearStaged(this._ctx.activeTabId)
  }

  // The active result's persisted column widths, keyed by the columns they were
  // set against (a differently-shaped result re-measures).
  private _resultColumnWidths() {
    const run = this._queries.runFor(this._ctx.activeTabId)
    return this._queries.columnWidthsFor(this._ctx.activeTabId, run.phase === 'done' ? run.result.columns : [])
  }

  private _onResizeColumns(event: Event) {
    const tabId = this._ctx.activeTabId
    const run = this._queries.runFor(tabId)
    if (!tabId || run.phase !== 'done') return
    const { widths } = (event as CustomEvent<{ widths: Array<[number, number]> }>).detail
    this._queries.setColumnWidths(tabId, run.result.columns, new Map(widths))
  }

  // A header sort button: re-run the result's own query with a column sort the
  // driver turns into an engine-correct ORDER BY. A null direction clears it.
  // The editor text is left untouched.
  private _onSortColumn(event: Event) {
    const { columnIndex, direction } = (event as CustomEvent<SortColumnDetail>).detail
    const run = this._queries.runFor(this._ctx.activeTabId)
    if (run.phase !== 'done' || !run.sql || !isReorderableQuery(run.sql, this._config.activeProfile()?.engine)) return
    void this._runSql(
      run.sql,
      direction ? { columnIndex, direction } : undefined,
      run.params,
      this._queries.filterFor(this._ctx.activeTabId),
      undefined,
      // Same as _refreshResults: the re-run must keep the run's editable source.
      run.table ? { table: run.table } : undefined,
    )
  }

  private _onFilterCondition(event: Event) {
    const condition = (event as CustomEvent<{ condition: string | null }>).detail.condition
    const tabId = this._ctx.activeTabId
    const run = this._queries.runFor(tabId)
    if ((run.phase !== 'done' && run.phase !== 'error') || !run.sql || !isFilterableQuery(run.sql, this._config.activeProfile()?.engine)) return
    // Same as _refreshResults: the re-run must keep the run's editable source.
    void this._runSql(run.sql, this._queries.sortFor(tabId), run.params, condition, undefined, run.table ? { table: run.table } : undefined)
  }

  private _onStageDelete(event: Event) {
    if (this._stagingFrozen()) return
    const { rows, remove } = (event as CustomEvent<{ rows: number[]; remove?: boolean }>).detail
    if (this._ctx.activeTabId) this._queries.stagePendingDeletes(this._ctx.activeTabId, rows, remove)
  }

  // Stop from the Tasks view: targets the task's own connection, which may
  // not be the active context.
  private _onTaskStop(event: Event) {
    const { profileId, taskId } = (event as CustomEvent<TaskStopDetail>).detail
    void this._cancelQuery(profileId, taskId)
  }

  // Cancelling a statement is recoverable, so it runs straight away. Ending a
  // session is not: it rolls back whatever that connection was doing, and it may
  // belong to someone else, so it always asks first.
  private _onSessionEnd(event: Event) {
    const { profileId, session, mode } = (event as CustomEvent<SessionEndDetail>).detail
    if (mode === 'cancel') {
      void this._endSession(profileId, session.id, mode)
      return
    }
    this._dialogs.confirm = {
      message: t('tasks.endSessionPrompt', { id: session.id }),
      detail: session.self
        ? t('tasks.endSessionOwn')
        : t('tasks.endSessionDetail', { user: session.user || t('tasks.sessionIdle') }),
      confirmLabel: t('tasks.endSessionConfirm'),
      danger: true,
      action: () => void this._endSession(profileId, session.id, mode),
    }
  }

  private async _endSession(profileId: string, sessionId: string, mode: SessionEndMode) {
    const result = await window.sqlkit.endSession(profileId, sessionId, mode)
    if (!result.success) {
      this._dialogs.notice(t('tasks.sessionEndFailed'), result.error ?? t('common.unknownError'))
      return
    }
    // Reflect it now rather than waiting out the poll interval.
    this.renderRoot.querySelector('tasks-view')?.refresh()
  }

  private _onTabSelect(event: Event) {
    const { tabId } = (event as CustomEvent<{ tabId: string }>).detail
    this._ctx.activeTabId = tabId
  }

  private _onTabClose(event: Event) {
    const { tabId } = (event as CustomEvent<{ tabId: string }>).detail
    this._requestCloseTab(tabId)
  }

  private _onConfigChange(event: Event) {
    const { profile } = (event as CustomEvent<{ profile: ConnectionProfile }>).detail
    this._ctx.tabs = this._ctx.tabs.map((tab) => (tab.kind === 'config' && tab.id === profile.id ? { ...tab, profile } : tab))
  }

  private async _onConfigSave(event: Event) {
    const { profile } = (event as CustomEvent<{ profile: ConnectionProfile }>).detail
    if (!(await this._config.save(profile))) return

    // The saved edit may have fixed what failed, so a stale error for these
    // now-gone settings is misleading — drop it (reconnecting will re-test).
    void this._live.clearError(profile.id)

    // Close the config tab before _loadConfig switches context — otherwise
    // switchInstance stashes the live tabs (still holding this config tab) under
    // the old context and the tab resurfaces on switch-back.
    this._ctx.closeConfigTab(profile.id)
    // Re-read rather than trusting the local copy: the save assigned the
    // profile's files folder (and created it on disk).
    await this._loadConfig()
    this._activeView = 'databases'
  }

  private _onConfigCancel() {
    if (this._ctx.activeTabId) this._ctx.closeTab(this._ctx.activeTabId)
  }

  private _onCloseWorkspace() {
    if (this._queries.hasAnyStaged()) {
      this._dialogs.confirm = {
        message: t('workbench.closeWorkspacePrompt'),
        detail: t('workbench.closeWorkspaceDetail'),
        confirmLabel: t('workbench.discardAndClose'),
        danger: true,
        action: () => this._closeWorkspaceNow(),
      }
      return
    }
    this._closeWorkspaceNow()
  }

  private _closeWorkspaceNow() {
    this.dispatchEvent(new CustomEvent('close-workspace', { bubbles: true, composed: true }))
  }

  static styles = [
    typography,
    controls,
    icons,
    scrollbars,
    tooltip,
    titlebar,
    css`
      :host {
        flex-direction: column;
        min-height: 0;
      }

      .app-titlebar {
        z-index: 30;
      }

      .titlebar-inner {
        position: relative;
        display: flex;
      }

      .titlebar-left,
      .titlebar-center,
      .titlebar-right {
        min-width: 0;
        display: flex;
        align-items: center;
      }

      .titlebar-left {
        width: calc(50% - 190px);
        gap: 5px;
        overflow: hidden;
        font-size: var(--font-size-sm);
        font-weight: 500;
        white-space: nowrap;
      }

      .title-product {
        flex-shrink: 0;
        color: var(--text-2);
      }

      .title-workspace {
        overflow: hidden;
        color: var(--text-3);
        text-overflow: ellipsis;
      }

      .titlebar-center {
        position: absolute;
        left: 50%;
        justify-content: center;
        gap: 5px;
        transform: translateX(-50%);
        -webkit-app-region: no-drag;
      }

      .titlebar-right {
        width: calc(50% - 190px);
        margin-left: auto;
        justify-content: flex-end;
        gap: 6px;
        -webkit-app-region: no-drag;
      }

      .update-preview {
        height: 24px;
        /* Reserved for the future updater integration. */
        display: none;
        align-items: center;
        gap: 6px;
        padding: 0 8px;
        color: color-mix(in srgb, var(--status-dot-warning) 78%, var(--text));
        background: color-mix(in srgb, var(--status-dot-warning) 9%, transparent);
        border: 1px solid color-mix(in srgb, var(--status-dot-warning) 28%, transparent);
        border-radius: 4px;
        font-size: var(--font-size-sm);
        white-space: nowrap;
      }

      .update-preview:hover {
        color: color-mix(in srgb, var(--status-dot-warning) 90%, var(--text));
        background: color-mix(in srgb, var(--status-dot-warning) 14%, transparent);
        border-color: color-mix(in srgb, var(--status-dot-warning) 40%, transparent);
      }

      .update-preview .icon {
        font-size: 13px;
      }

      .txn-control {
        --txn-tone: var(--staged-edit-fg);
        position: relative;
        height: 24px;
        display: flex;
        align-items: center;
        color: color-mix(in srgb, var(--txn-tone) 85%, var(--text));
        background: color-mix(in srgb, var(--txn-tone) 7%, transparent);
        border: 1px solid color-mix(in srgb, var(--txn-tone) 25%, transparent);
        border-radius: 4px;
        font-size: var(--font-size-sm);
        white-space: nowrap;
      }

      .txn-control.failed {
        --txn-tone: var(--status-dot-error);
      }

      .txn-control button {
        align-self: stretch;
        height: auto;
        display: flex;
        align-items: center;
        gap: 4px;
        padding: 0 8px;
        border: none;
        border-radius: 0;
        color: var(--text-2);
        background: transparent;
        font-size: var(--font-size-sm);
        white-space: nowrap;
      }

      .txn-control button:hover {
        background: color-mix(in srgb, var(--txn-tone) 12%, transparent);
      }

      .txn-status {
        color: color-mix(in srgb, var(--txn-tone) 90%, var(--text)) !important;
        font-weight: 600;
      }

      .txn-status[aria-expanded='true'] {
        background: color-mix(in srgb, var(--txn-tone) 14%, transparent);
      }

      .txn-status .icon {
        margin-left: -2px;
        font-size: 11px;
        transition: transform 120ms ease;
      }

      .txn-status[aria-expanded='true'] .icon {
        transform: rotate(180deg);
      }

      .txn-dot {
        width: 7px;
        height: 7px;
        flex-shrink: 0;
        border-radius: 50%;
        background: var(--txn-tone);
        box-shadow: 0 0 0 2px color-mix(in srgb, var(--txn-tone) 9%, transparent);
      }

      .txn-count {
        color: var(--text-3);
        font-size: 10px;
        font-weight: 500;
      }

      .txn-divider {
        width: 1px;
        height: 12px;
        flex-shrink: 0;
        background: color-mix(in srgb, var(--txn-tone) 21%, var(--border));
      }

      .txn-control .txn-commit:hover {
        color: var(--status-dot-connected);
      }

      .txn-control .txn-rollback:hover {
        color: var(--status-dot-error);
      }

      .txn-control button > .icon {
        font-size: 12px;
      }

      .txn-popover {
        position: absolute;
        z-index: 40;
        top: 30px;
        right: 0;
        width: min(390px, calc(100vw - 16px));
        overflow: hidden;
        color: var(--text-2);
        background: var(--overlay-bg);
        border: 1px solid var(--border-subtle);
        border-radius: 8px;
        box-shadow:
          0 12px 32px rgba(0, 0, 0, 0.38),
          0 1px 3px rgba(0, 0, 0, 0.2);
        white-space: normal;
      }

      .txn-popover-head {
        padding: 11px 12px 9px;
        border-bottom: 1px solid var(--border-subtle);
      }

      .txn-popover-title,
      .txn-context {
        display: flex;
        align-items: center;
        gap: 7px;
        min-width: 0;
      }

      .txn-popover-title strong {
        color: var(--text);
        font-size: var(--font-size-sm);
        font-weight: 600;
      }

      .txn-popover-title > span:last-child {
        margin-left: auto;
        color: var(--text-3);
        font-size: 10px;
      }

      .txn-context {
        margin-top: 5px;
        color: var(--text-3);
        font-size: 10px;
      }

      .txn-context strong {
        min-width: 0;
        overflow: hidden;
        color: var(--text-2);
        font-weight: 500;
        text-overflow: ellipsis;
      }

      .txn-runs {
        max-height: 280px;
        overflow-y: auto;
        padding: 5px;
      }

      .txn-run {
        display: grid;
        grid-template-columns: 22px minmax(0, 1fr) auto;
        gap: 7px;
        padding: 8px 7px;
        border-radius: 4px;
      }

      .txn-run:hover {
        background: color-mix(in srgb, var(--text) 4%, transparent);
      }

      .txn-run-index,
      .txn-duration {
        color: var(--text-3);
        font: 10px var(--mono-font);
      }

      .txn-run-index {
        line-height: 1.5;
        text-align: right;
      }

      .txn-run-copy {
        min-width: 0;
      }

      .txn-run-copy code {
        display: block;
        overflow: hidden;
        color: var(--text);
        font: 11px/1.45 var(--mono-font);
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .txn-run-copy > span {
        display: block;
        margin-top: 3px;
        overflow: hidden;
        color: var(--text-3);
        font-size: 10px;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .txn-outcome.ok {
        color: var(--status-dot-connected);
      }

      .txn-outcome.error {
        color: var(--status-dot-error);
      }

      .txn-duration {
        padding-top: 1px;
      }

      .txn-empty {
        padding: 18px 12px;
        color: var(--text-3);
        font-size: var(--font-size-sm);
        text-align: center;
      }

      .txn-popover-foot {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 8px 12px;
        color: var(--text-3);
        background: color-mix(in srgb, black 10%, transparent);
        border-top: 1px solid var(--border-subtle);
        font-size: 10px;
      }

      .txn-popover-foot .icon {
        font-size: 11px;
      }

      /* A fixed box whatever it carries, so switching databases never moves the
         run action next to it. */
      .database-target-wrap {
        width: min(340px, 36vw);
        max-width: 100%;
        min-width: 0;
        display: flex;
        -webkit-app-region: no-drag;
      }

      .database-target {
        width: 100%;
        min-width: 0;
        height: 24px;
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 0 10px;
        overflow: hidden;
        color: var(--text-2);
        background: var(--btn-secondary-bg);
        border: 1px solid var(--border);
        border-radius: 4px;
        font-size: var(--font-size-sm);
        text-align: left;
        white-space: nowrap;
        box-shadow: inset 0 -2px 0 var(--connection-label-color, transparent);
        -webkit-app-region: no-drag;
      }

      .database-target:hover,
      .database-target[aria-expanded='true'] {
        color: var(--text);
        background: var(--btn-secondary-hover);
      }

      .database-target[aria-expanded='true'] {
        border-color: var(--focus-border);
      }

      /* The database name keeps its own width up to a cap and never shrinks:
         the connection name is what gives way, so a short database name always
         reads in full and a long one still gets more room than its context. */
      .database-target strong {
        max-width: 14em;
        flex: 0 0 auto;
        overflow: hidden;
        color: var(--text);
        font-weight: 500;
        text-overflow: ellipsis;
      }

      .target-profile {
        min-width: 0;
        flex: 0 1 auto;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .target-separator {
        flex-shrink: 0;
        color: var(--text-3);
      }

      .database-target .icon {
        flex-shrink: 0;
        margin-left: auto;
        font-size: 13px;
        color: var(--text-3);
      }

      .connection-dot {
        width: 8px;
        height: 8px;
        flex-shrink: 0;
        border-radius: 50%;
        background: var(--text-3);
      }

      .connection-dot.connected {
        background: var(--status-dot-connected);
      }

      .connection-dot.connecting {
        background: var(--status-dot-warning);
      }

      .connection-dot.error {
        background: var(--status-dot-error);
      }

      .query-action {
        position: relative;
        width: 26px;
        height: 24px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        flex-shrink: 0;
        padding: 0;
        color: var(--text-2);
        background: transparent;
        border: 1px solid transparent;
        border-radius: 4px;
        -webkit-app-region: no-drag;
      }

      .query-action:hover:not(:disabled) {
        color: var(--text);
        background: var(--btn-secondary-hover);
      }

      .query-action.running {
        color: var(--status-dot-error);
      }

      .query-action.running:hover {
        color: color-mix(in srgb, var(--status-dot-error) 82%, white);
        background: color-mix(in srgb, var(--status-dot-error) 11%, transparent);
      }

      .query-action:disabled {
        color: color-mix(in srgb, var(--text-3) 45%, transparent);
        cursor: default;
        opacity: 1;
      }

      .query-action svg {
        width: 16px;
        height: 16px;
        fill: currentColor;
      }

      .query-action .icon {
        font-size: 16px;
      }

      @media (max-width: 1200px) {
        .txn-commit,
        .txn-rollback {
          width: 28px;
          justify-content: center;
          overflow: hidden;
          color: transparent !important;
          font-size: 0 !important;
        }

        .txn-commit .icon,
        .txn-rollback .icon {
          color: var(--text-2);
        }

        .txn-commit:hover .icon {
          color: var(--status-dot-connected);
        }

        .txn-rollback:hover .icon {
          color: var(--status-dot-error);
        }

        .update-preview span {
          display: none;
        }
      }

      @media (max-width: 1000px) {
        .titlebar-left,
        .titlebar-right {
          width: calc(50% - 140px);
        }

        .database-target-wrap {
          width: min(240px, 34vw);
        }

        .target-profile {
          display: none;
        }

        .target-profile + .target-separator {
          display: none;
        }
      }

      .body {
        flex: 1;
        display: flex;
        min-height: 0;
      }

      .activity-bar {
        width: var(--activity-bar-w);
        background: var(--activity-bar-bg);
        display: flex;
        flex-direction: column;
        align-items: center;
        padding-top: 4px;
        flex-shrink: 0;
        border-right: 1px solid var(--border);
      }

      /* Activity-bar icons are inline SVG (not the icon font) so stroke-width
         is a live knob — nudge this value to lighten/darken them. */
      .activity-bar svg {
        width: 24px;
        height: 24px;
        stroke-width: 1.5;
      }

      .sidebar {
        width: var(--sidebar-w);
        min-width: 170px;
        background: var(--sidebar-bg);
        display: flex;
        flex-direction: column;
        overflow: hidden;
        flex-shrink: 0;
      }

      .sidebar.collapsed {
        display: none;
      }

      .sidebar-resize {
        width: 1px;
        flex-shrink: 0;
        cursor: col-resize;
        background: var(--border);
        position: relative;
        z-index: 20;
        touch-action: none;
      }

      /* Wider invisible hit area than the 1px visible line. */
      .sidebar-resize::after {
        content: '';
        position: absolute;
        inset: 0 -2px;
      }

      .sidebar-resize:hover,
      .sidebar-resize.active {
        background: var(--resize-hover);
      }

      .body:has(.sidebar-resize.active) {
        cursor: col-resize;
        user-select: none;
      }

      .sidebar-title {
        height: 35px;
        display: flex;
        align-items: center;
        padding: 0 12px 0 20px;
        font-size: var(--font-size-sm);
        color: var(--text);
        letter-spacing: 0.04em;
        text-transform: uppercase;
        user-select: none;
        flex-shrink: 0;
      }

      .sidebar-title span {
        flex: 1;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .title-action {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 22px;
        height: 22px;
        padding: 0;
        flex-shrink: 0;
        border: none;
        border-radius: 3px;
        background: transparent;
        color: var(--text-2);
        cursor: pointer;
      }

      .title-action:hover:not(:disabled) {
        background: var(--btn-secondary-hover);
        color: var(--text);
      }

      .title-action:disabled {
        opacity: 0.4;
        cursor: default;
      }

      .title-action .icon {
        font-size: 14px;
      }

      .sidebar .hint {
        padding: 0 20px;
      }

      .editor-area {
        flex: 1;
        display: flex;
        flex-direction: column;
        background: var(--editor-bg);
        min-width: 0;
      }

      .tab-bar {
        height: var(--tab-h);
        background: var(--tab-bar-bg);
        display: flex;
        align-items: stretch;
        overflow-x: auto;
        flex-shrink: 0;
        /* Inset (not border-bottom) so it sits inside the scroll-clip region
           and the active tab can paint over it; covers the trailing space. */
        box-shadow: inset 0 -1px 0 var(--border);
        scrollbar-width: none;
        overscroll-behavior: none;
      }

      .editor-content {
        flex: 1;
        display: flex;
        align-items: center;
        justify-content: center;
        min-height: 0;
      }

      .editor-content.form {
        display: block;
        overflow-y: auto;
        overscroll-behavior: none;
        overflow-anchor: none;
      }

      .editor-content.inspect {
        display: block;
        min-width: 0;
      }

      .editor-content.sql {
        display: flex;
        flex-direction: column;
        align-items: stretch;
        justify-content: flex-start;
        min-width: 0;
      }

      .editor-pane {
        flex: 1;
        min-height: 0;
      }

      .panel-resize {
        height: 1px;
        flex-shrink: 0;
        cursor: row-resize;
        background: var(--border);
        position: relative;
        z-index: 10;
        touch-action: none;
      }

      .panel-resize::after {
        content: '';
        position: absolute;
        inset: -2px 0;
      }

      .panel-resize:hover,
      .panel-resize.active {
        background: var(--resize-hover);
      }

      .body:has(.panel-resize.active) {
        cursor: row-resize;
        user-select: none;
      }
    `,
  ]
}

declare global {
  interface HTMLElementTagNameMap {
    'workbench-screen': WorkbenchScreen
  }
}
