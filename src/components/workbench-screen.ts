import { LitElement, css, html, type PropertyValues } from 'lit'
import { customElement, property, state } from 'lit/decorators.js'
import { codicons, controls, scrollbars, typography } from '../shared-styles'
import { isMac, mod } from '../platform'
import { ConnectionsController } from '../controllers/connections'
import { FilesController } from '../controllers/files'
import { QueriesController } from '../controllers/queries'
import { LayoutController } from '../controllers/layout'
import { CommandPaletteController } from '../controllers/command-palette'
import { DialogsController } from '../controllers/dialogs'
import { ResultEditingController } from '../controllers/result-editing'
import { ContextsController, type EditorTabState, type SqlTabState } from '../controllers/contexts'
import type { ConnectionProfile, FileInfo, MenuAction, TableRef } from '../electron'
import './activity-button'
import './command-palette'
import './confirm-dialog'
import './prompt-dialog'
import './review-query-dialog'
import './table-inspect'
import './databases-view'
import './db-config-form'
import './editor-empty'
import './editor-tab'
import './explorer-view'
import './history-view'
import './tasks-view'
import './server-view'
import './results-panel'
import './search-view'
import './sql-editor'
import './status-bar'
import { tableKey } from './explorer-view'
import type { EmptyAction } from './editor-empty'
import type { RunQueryDetail } from './sql-editor'
import { firstStatement } from '../codemirror/run-query'
import type { ObjectInspectDetail, TableBrowseDetail, TableSelectDetail } from './explorer-view'
import type { HistoryExplainDetail, HistoryOpenDetail } from './history-view'
import type { TaskStopDetail } from './tasks-view'
import { dialectForEngine } from '../codemirror/dialects'
import { quoteQualified } from '../sql-write'
import { stripExplain } from '../sql-types'
import { TABLE_KIND_LABELS } from '../table-kinds'
import type { SearchOpenDetail } from './search-view'
import type { FileCreateDetail, FileDeleteDetail, FileRenameDetail } from './file-tree'
import type { CellCoord } from './results-panel'

const VIEWS = [
  { id: 'explorer', title: 'Explorer', icon: 'codicon-files', hint: 'No files yet.' },
  { id: 'search', title: 'Search', icon: 'codicon-search', hint: 'Search across your SQL files.' },
  { id: 'databases', title: 'Databases', icon: 'codicon-database', hint: 'No database connections yet.' },
  { id: 'history', title: 'History', icon: 'codicon-history', hint: 'No query history yet.' },
  { id: 'tasks', title: 'Tasks', icon: 'codicon-checklist', hint: 'No running jobs.' },
  { id: 'server', title: 'Server', icon: 'codicon-server', hint: 'Connect a database to see its server.' },
] as const


type ViewId = (typeof VIEWS)[number]['id']

const tabTitle = (tab: EditorTabState) => {
  if (tab.kind === 'config') return tab.profile.name.trim() || 'New Database'
  if (tab.kind === 'inspect') return `${tab.table.name} · info`
  if (tab.kind === 'inspect-object') return `${tab.object.name} · info`
  return tab.content === tab.savedContent ? tab.name : `${tab.name} •`
}

/** Instance bucket for tabs opened before any context exists. */
// Browse/history tab names already end in .sql; don't double it.
const suggestedSqlName = (tabName: string) => `${tabName.replace(/\.sql$/i, '')}.sql`

const NO_CONTEXT = '__none__'

const contextKey = (profileId: string | null, childDb: string | null) =>
  profileId === null ? NO_CONTEXT : `${profileId}:${childDb ?? ''}`

const tableContextKey = (profileId: string, childDb: string | null, table: TableRef) =>
  `${profileId}:${childDb ?? ''}:${table.schema ?? ''}:${table.name}`

// Child database names become folder segments (connection/child/file.sql);
// strip anything that isn't a safe path character.
const childFolderSegment = (name: string) => {
  const cleaned = name.replace(/[^\w .-]/g, '_').replace(/^[. ]+/, '')
  return cleaned || 'database'
}

// Commands offered by the ⌘⇧P palette; ids are dispatched to _runCommand.
const COMMANDS: ReadonlyArray<{ id: string; label: string; icon: string; keybind?: string }> = [
  { id: 'new-query', label: 'New Query', icon: 'codicon-new-file', keybind: mod('N') },
  { id: 'new-window', label: 'New Window', icon: 'codicon-window', keybind: `${isMac ? '⇧⌘' : 'Shift+Ctrl+'}N` },
  { id: 'run-query', label: 'Run Query', icon: 'codicon-play', keybind: isMac ? '⌘↵' : 'Ctrl+↵' },
  { id: 'save-file', label: 'Save File', icon: 'codicon-save', keybind: mod('S') },
  { id: 'quick-open', label: 'Quick Open…', icon: 'codicon-file-code', keybind: mod('P') },
  { id: 'switch-database', label: 'Switch Database…', icon: 'codicon-database', keybind: mod('K') },
  { id: 'add-database', label: 'Add Database', icon: 'codicon-add' },
  { id: 'disconnect-all', label: 'Disconnect All Databases', icon: 'codicon-debug-disconnect' },
  { id: 'refresh-files', label: 'Refresh Files', icon: 'codicon-sync' },
  { id: 'toggle-sidebar', label: 'Toggle Sidebar', icon: 'codicon-layout-sidebar-left', keybind: mod('B') },
  ...VIEWS.map((view) => ({ id: `show-${view.id}`, label: `Show ${view.title}`, icon: view.icon })),
  { id: 'close-workspace', label: 'Close Workspace', icon: 'codicon-folder-opened' },
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

  @state()
  private _activeView: ViewId | null = 'explorer'

  @state()
  private _connections: ConnectionProfile[] = []

  // ⌘⇧P / ⌘P / ⌘K palette: open/close state, entry list, and pick dispatch.
  private _cmdPalette = new CommandPaletteController(this, {
    live: this._live,
    commands: COMMANDS,
    files: () => this._workspaceFiles.files,
    connections: () => this._connections,
    activeProfile: () => this._activeProfile(),
    activeDbId: () => this._ctx.activeDbId,
    activeChildDb: () => this._ctx.activeChildDb,
    openFile: (file) => void this._openFileTab(file),
    openTable: (key) => this._openTableFromPalette(key),
    setActiveDb: (profileId, childDb) => this._setActiveDb(profileId, childDb),
    showView: (viewId) => {
      this._activeView = viewId as ViewId
    },
    newQuery: () => this._ctx.newQuery(),
    runActiveTab: () => {
      const tab = this._ctx.activeSqlTab()
      if (tab?.content.trim()) void this._runSql(tab.content.trim())
    },
    saveActiveTab: () => void this._saveActiveTab(),
    addDatabase: () => this._onAddDatabase(),
    refreshFiles: () => void this._workspaceFiles.reload(),
    toggleSidebar: () => this._toggleSidebar(),
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
    dropQuery: (tabId) => this._queries.dropTab(tabId),
  })

  private _resultEditing = new ResultEditingController({
    activeTab: () => this._ctx.activeSqlTab(),
    activeDbId: () => this._ctx.activeDbId,
    activeChildDb: () => this._ctx.activeChildDb,
    activeProfile: () => this._activeProfile(),
    run: () => this._queries.runFor(this._ctx.activeTabId),
    tables: () => (this._ctx.activeDbId ? (this._live.tables[this._ctx.activeDbId] ?? []) : []),
    columns: () => (this._ctx.activeDbId ? (this._live.columns[this._ctx.activeDbId] ?? []) : []),
    dialogs: this._dialogs,
    runSql: (sql) => this._runSql(sql),
  })

  private _unsubscribeMenu: (() => void) | null = null

  connectedCallback() {
    super.connectedCallback()
    this._unsubscribeMenu = window.sqlkit.onMenuAction((action) => this._onMenuAction(action))
    window.addEventListener('keydown', this._onGlobalKeydown)
  }

  disconnectedCallback() {
    super.disconnectedCallback()
    this._unsubscribeMenu?.()
    this._unsubscribeMenu = null
    window.removeEventListener('keydown', this._onGlobalKeydown)
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
        void this._saveActiveTab()
        break
      case 'save-as':
        void this._saveActiveTabAs()
        break
      case 'close-tab':
        if (this._ctx.activeTabId) this._requestCloseTab(this._ctx.activeTabId)
        break
    }
  }

  protected willUpdate(changed: PropertyValues) {
    if (changed.has('workspace')) {
      this._ctx.reset()
      this._connections = []
      this._cmdPalette.close()
      this._queries.reset()
      this._workspaceFiles.setFolder(null)
      // Connections belong to the workspace they were opened from.
      void this._live.disconnectAll()
      if (this.workspace) void this._loadConfig()
    }
  }

  // --- workspace config + context -----------------------------------------

  private async _loadConfig() {
    const { config, error } = await window.sqlkit.getWorkspaceConfig()
    if (error) {
      this._dialogs.notice(
        'Workspace config could not be read',
        `${error}\n\nThe file was left untouched, so your saved connections are still on disk. ` +
          'Fix or restore .sqlkit/config.json and reopen the workspace — saving new connections now would overwrite it.',
      )
    }
    this._connections = config.connections
    // Restore the in-use context; default to the first profile so the
    // Explorer has a files folder to show right away.
    const restored =
      config.activeDbId && config.connections.some((connection) => connection.id === config.activeDbId)
        ? config.activeDbId
        : (config.connections[0]?.id ?? null)
    const restoredProfile = restored ? (config.connections.find((c) => c.id === restored) ?? null) : null
    this._ctx.switchInstance(restored, restoredProfile ? this._defaultChild(restoredProfile) : null)
    this._workspaceFiles.setFolder(this._contextFolder())
  }

  // An all-databases context always resolves to a child — the parent folder
  // never holds files. Preference order: the connection's live child, the
  // last child the user worked in, then the discovery database.
  private _defaultChild(profile: ConnectionProfile): string | null {
    if ((profile.databaseMode ?? 'single') !== 'all') return null
    return this._inUseChild(profile.id) ?? profile.lastChildDb ?? (profile.database.trim() || 'postgres')
  }

  // Files nest per context: connection-folder/child-folder for all-databases
  // children, just the connection folder otherwise.
  private _contextFolder(): string | null {
    const folder = this._activeProfile()?.folder
    if (!folder) return null
    return this._ctx.activeChildDb ? `${folder}/${childFolderSegment(this._ctx.activeChildDb)}` : folder
  }

  /** The child the connection currently targets, when it has several. */
  private _inUseChild(profileId: string): string | null {
    const children = this._live.statuses[profileId]?.children ?? []
    if (children.length < 2) return null
    return children.find((child) => child.inUse)?.name ?? null
  }

  /** The profile of the in-use database context (⌘K). */
  private _activeProfile(): ConnectionProfile | null {
    return this._connections.find((connection) => connection.id === this._ctx.activeDbId) ?? null
  }

  private _persistConfig() {
    void window.sqlkit.saveWorkspaceConfig({
      version: 1,
      connections: this._connections,
      activeDbId: this._ctx.activeDbId,
    })
  }

  // Without an explicit child, a profile-level switch (⌘P table pick,
  // single-db connect) resolves the default child so all-databases contexts
  // never land on the parent folder.
  private _setActiveDb(profileId: string, childDb?: string | null) {
    const profile = this._connections.find((connection) => connection.id === profileId)
    if (!profile) return
    const child = childDb === undefined ? this._defaultChild(profile) : childDb

    if (this._ctx.activeDbId === profileId && this._ctx.activeChildDb === child) return

    // Remember the pick so reopening the workspace lands on the same child.
    if (child && profile.lastChildDb !== child) {
      this._connections = this._connections.map((connection) =>
        connection.id === profileId ? { ...connection, lastChildDb: child } : connection,
      )
    }

    this._ctx.switchInstance(profileId, child)
    this._workspaceFiles.setFolder(this._contextFolder())
    this._persistConfig()
  }

  // After a connect, the driver targets the discovery database; if the
  // context remembers a different child, point the driver at it.
  // Points profileId's driver at `childDb` (all-databases mode). Takes the
  // target explicitly rather than reading this._ctx.activeChildDb, so a run that
  // captured its context can align that exact child even after the active
  // selection has drifted.
  private async _alignActiveChild(
    profileId: string,
    childDb: string | null,
    options: { followMissing?: boolean } = {},
  ): Promise<boolean> {
    if (!childDb) return true
    const children = this._live.statuses[profileId]?.children ?? []
    if (children.length < 2) return true
    const inUse = children.find((child) => child.inUse)?.name
    if (inUse === childDb) return true
    if (children.some((child) => child.name === childDb)) {
      return (await this._live.setActiveChild(profileId, childDb)).success
    } else if (options.followMissing && inUse) {
      this._setActiveDb(profileId, inUse)
    }
    return false
  }

  // --- global shortcuts -----------------------------------------------------

  // ⌘⇧P commands, ⌘P quick open, ⌘K database switch, ⌘B sidebar, ⌘N new
  // query, ⌘S save, ⌘↵ run. Pressing a palette's own shortcut again closes it.
  private _onGlobalKeydown = (event: KeyboardEvent) => {
    // Mounted but hidden on the welcome screen; ignore global keys until a
    // workspace is open.
    if (!this.workspace) return
    // The editor's own keymap (Mod-Enter) prevents default when it handles a
    // chord; don't run it twice.
    if (event.defaultPrevented) return
    if (!event.metaKey && !event.ctrlKey) return
    const key = event.key.toLowerCase()

    if (key === 'p') {
      event.preventDefault()
      this._cmdPalette.toggle(event.shiftKey ? 'commands' : 'quick')
      return
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
    if (key === 'n') {
      event.preventDefault()
      this._ctx.newQuery()
      return
    }
    if (key === 's') {
      event.preventDefault()
      void this._saveActiveTab()
      return
    }
    if (key === 'enter') {
      const tab = this._ctx.activeSqlTab()
      if (tab?.content.trim()) {
        event.preventDefault()
        void this._runSql(tab.content.trim())
      }
    }
  }

  private _toggleSidebar() {
    this._activeView = this._activeView === null ? 'explorer' : null
  }

  // --- tabs ------------------------------------------------------------------

  private async _openFileTab(file: FileInfo) {
    // Keyed by absolute path: same-named files in different database
    // folders are distinct tabs.
    const id = `file:${file.path}`
    if (this._ctx.tabs.some((tab) => tab.id === id)) {
      this._ctx.activeTabId = id
      return
    }
    const result = await window.sqlkit.readFile(file.path)
    if (!result.success) {
      console.error('Failed to read file:', result.error)
      return
    }
    this._ctx.addTab({ id, kind: 'sql', name: file.name, path: file.path, content: result.content, savedContent: result.content })
  }

  // Close via ⌘W, the tab ✕, etc.: dirty editors get a confirmation first.
  private _requestCloseTab(id: string) {
    const tab = this._ctx.tabs.find((entry) => entry.id === id)
    if (tab?.kind === 'sql' && tab.content !== tab.savedContent) {
      this._dialogs.confirm = {
        message: `Close "${tab.name}" without saving?`,
        detail: 'Unsaved changes will be lost.',
        confirmLabel: 'Close Without Saving',
        action: () => this._ctx.closeTab(id),
      }
      return
    }
    this._ctx.closeTab(id)
  }

  private async _saveActiveTab() {
    const tab = this._ctx.activeSqlTab()
    if (!tab) return

    // Untitled queries go through the native dialog, defaulting into the
    // active context's folder.
    const result = tab.path
      ? await window.sqlkit.saveFile(tab.path, tab.content)
      : await window.sqlkit.saveFileAs(this._contextFolder() ?? '', suggestedSqlName(tab.name), tab.content)
    this._ctx.applySaveResult(tab, result)
  }

  // File > Save As…: always the dialog, even for files that have a path.
  private async _saveActiveTabAs() {
    const tab = this._ctx.activeSqlTab()
    if (!tab) return
    const result = await window.sqlkit.saveFileAs(this._contextFolder() ?? '', suggestedSqlName(tab.name), tab.content)
    this._ctx.applySaveResult(tab, result)
  }

  // --- query running ----------------------------------------------------------

  // Runs against the in-use context (⌘K), connecting it first if needed.
  private async _runSql(sqlText: string) {
    // The run belongs to the tab it started from, even if the user switches
    // tabs or contexts before it finishes.
    const tabId = this._ctx.activeTabId
    if (!tabId) return
    // One run per tab: ignore re-triggers while this tab's query is in flight.
    if (this._queries.runFor(tabId).phase === 'running') return

    const profile = this._activeProfile()
    if (!profile) {
      this._queries.setRun(tabId, { phase: 'error', error: `No database selected — press ${mod('K')} to pick one.` })
      return
    }

    // Capture the context the run started in. The connect/align below await,
    // and the user may switch child or profile meanwhile; the run must target
    // and be logged under the context Run was pressed in, not the current one.
    const childDb = this._ctx.activeChildDb
    const runContextKey = contextKey(profile.id, childDb)

    if (this._live.phase(profile.id) !== 'connected') {
      this._queries.setRun(tabId, { phase: 'running', note: `Connecting to ${profile.name}…` })
      const connected = await this._live.connect(profile)
      if (!connected.success) {
        this._queries.setRun(tabId, { phase: 'error', error: connected.error })
        return
      }
    }
    // The driver may be targeting the discovery database; point it at the
    // captured child before running.
    if (!(await this._alignActiveChild(profile.id, childDb))) {
      this._queries.setRun(tabId, { phase: 'error', error: `Database "${childDb}" is not available on this connection` })
      return
    }

    await this._queries.execute({
      tabId,
      profile,
      childDb,
      contextKey: runContextKey,
      sql: sqlText,
    })
  }

  // Double-click browse: a tab named after the table, pre-filled with a capped SELECT and run.
  // Re-browsing reuses the tab and runs its first statement, so trailing half-written SQL doesn't error.
  private _browseTable(profile: ConnectionProfile, table: TableRef) {
    const sqlText = `SELECT * FROM ${quoteQualified(table)} LIMIT 200`

    const id = `browse:${tableContextKey(profile.id, this._ctx.activeChildDb, table)}`
    const existing = this._ctx.tabs.find((tab) => tab.id === id)
    if (!existing) {
      this._ctx.tabs = [
        ...this._ctx.tabs,
        { id, kind: 'sql', name: `${table.name}.sql`, path: null, content: sqlText, savedContent: sqlText, table },
      ]
    }
    this._ctx.activeTabId = id
    void this._runSql(existing?.kind === 'sql' ? firstStatement(existing.content) || sqlText : sqlText)
  }

  // Quick-open table pick: reveal it in the Explorer (switching context if
  // needed) and open its browse tab, as if double-clicked in the sidebar.
  private _openTableFromPalette(key: string) {
    this._ctx.selectedTable = key
    const profileId = key.split(':')[0]
    if (profileId) this._setActiveDb(profileId)
    this._activeView = 'explorer'
    const profile = this._connections.find((connection) => connection.id === profileId)
    const table = (this._live.tables[profileId] ?? []).find((entry) => tableKey(profileId, entry) === key)
    if (profile && table) this._browseTable(profile, table)
  }

  // --- render -------------------------------------------------------------------

  render() {
    const activeView = VIEWS.find((view) => view.id === this._activeView)
    return html`
      <div
        class="body"
        @db-select=${this._onDbSelect}
        @db-connect=${this._onDbConnect}
        @db-disconnect=${this._onDbDisconnect}
        @db-remove=${this._onDbRemove}
        @db-create-database=${this._onDbCreateDatabase}
        @db-drop-database=${this._onDbDropDatabase}
        @add-database=${this._onAddDatabase}
        @table-select=${this._onTableSelect}
        @table-browse=${this._onTableBrowse}
        @table-inspect=${this._onTableInspect}
        @object-inspect=${this._onObjectInspect}
        @matview-refresh=${this._onMatviewRefresh}
        @table-truncate=${this._onTableTruncate}
        @table-drop=${this._onTableDrop}
        @tables-refresh=${this._onTablesRefresh}
        @search-open=${this._onSearchOpen}
        @file-open=${this._onFileOpen}
        @file-create=${this._onFileCreate}
        @file-rename=${this._onFileRename}
        @file-delete=${this._onFileDelete}
        @config-change=${this._onConfigChange}
        @config-save=${this._onConfigSave}
        @config-cancel=${this._onConfigCancel}
        @tab-select=${this._onTabSelect}
        @tab-close=${this._onTabClose}
        @editor-change=${this._onEditorChange}
        @run-query=${this._onRunQuery}
      >
        <nav class="activity-bar" @activity-select=${this._onActivitySelect}>
          ${VIEWS.map(
            (view) => html`
              <activity-button
                view=${view.id}
                title=${view.title}
                .active=${view.id === this._activeView}
                .badge=${view.id === 'tasks' ? this._queries.longRunningCount() : 0}
              >
                <i class="codicon ${view.icon}" aria-hidden="true"></i>
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
                aria-label="Resize sidebar"
                title="Resize sidebar"
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
                        name=${tabTitle(tab)}
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
              @dialog-cancel=${() => (this._dialogs.confirm = null)}
              @dialog-confirm=${this._dialogs.acceptConfirm}
            ></confirm-dialog>
          `
        : ''}
      ${this._dialogs.prompt
        ? html`
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
          `
        : ''}
      ${this._dialogs.review
        ? html`
            <review-query-dialog
              .sql=${this._dialogs.review.sql}
              .params=${this._dialogs.review.params}
              @dialog-cancel=${() => (this._dialogs.review = null)}
              @dialog-confirm=${this._dialogs.acceptReview}
            ></review-query-dialog>
          `
        : ''}

      <status-bar
        .workspaceName=${this.workspace?.name ?? ''}
        .contextName=${this._contextLabel()}
        .connectedCount=${this._live.connected().length}
        .connectedName=${this._connectedName()}
      ></status-bar>
    `
  }

  private _contextLabel() {
    const profile = this._activeProfile()
    if (!profile) return ''
    return this._ctx.activeChildDb ? `${profile.name} · ${this._ctx.activeChildDb}` : profile.name
  }

  private _connectedName() {
    const connected = this._live.connected()
    if (connected.length !== 1) return ''
    return this._connections.find((profile) => profile.id === connected[0].profileId)?.name ?? ''
  }

  // View-specific actions level with the sidebar title (reference layout).
  private _renderTitleActions(view: (typeof VIEWS)[number]) {
    if (view.id === 'history') {
      const key = contextKey(this._ctx.activeDbId, this._ctx.activeChildDb)
      const count = this._queries.history.filter((item) => item.contextKey === key).length
      return html`
        <button
          class="title-action"
          title="Clear history"
          aria-label="Clear history"
          ?disabled=${!count}
          @click=${this._onHistoryClear}
        >
          <i class="codicon codicon-clear-all" aria-hidden="true"></i>
        </button>
      `
    }
    if (view.id === 'tasks') {
      const finished = this._queries.tasks.some((task) => task.status !== 'running')
      return html`
        <button
          class="title-action"
          title="Clear finished tasks"
          aria-label="Clear finished tasks"
          ?disabled=${!finished}
          @click=${this._onTasksClear}
        >
          <i class="codicon codicon-clear-all" aria-hidden="true"></i>
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
          .connections=${this._connections}
          .statuses=${this._live.statuses}
          .activeTabId=${this._ctx.activeTabId}
        ></databases-view>
      `
    }
    if (view.id === 'explorer') {
      const activeTab = this._ctx.tabs.find((tab) => tab.id === this._ctx.activeTabId)
      const context = this._activeProfile()
      const connected = context !== null && this._live.phase(context.id) === 'connected'
      const children = connected && context ? (this._live.statuses[context.id]?.children ?? []) : []
      const activeChild = children.length > 1 ? (children.find((child) => child.inUse)?.name ?? null) : null
      return html`
        <explorer-view
          .files=${this._workspaceFiles.files}
          .activePath=${activeTab?.kind === 'sql' ? activeTab.path : null}
          .contextName=${context ? this._contextLabel() : null}
          .profileId=${context?.id ?? null}
          .engine=${context?.engine ?? null}
          .tables=${connected && context ? (this._live.tables[context.id] ?? []) : null}
          .columns=${connected && context ? (this._live.columns[context.id] ?? null) : null}
          .objects=${connected && context ? (this._live.objects[context.id] ?? null) : null}
          .activeChildName=${activeChild}
          .selectedTable=${this._ctx.selectedTable}
        ></explorer-view>
      `
    }
    if (view.id === 'search') {
      return html`<search-view .files=${this._workspaceFiles.files}></search-view>`
    }
    if (view.id === 'history') {
      const key = contextKey(this._ctx.activeDbId, this._ctx.activeChildDb)
      return html`
        <history-view
          .items=${this._queries.history.filter((item) => item.contextKey === key)}
          .engine=${this._activeProfile()?.engine ?? null}
          @history-open=${this._onHistoryOpen}
          @history-open-permanent=${this._onHistoryOpenPermanent}
          @history-explain=${this._onHistoryExplain}
          @history-clear=${this._onHistoryClear}
        ></history-view>
      `
    }
    if (view.id === 'tasks') {
      return html`<tasks-view .items=${this._queries.tasks} @task-stop=${this._onTaskStop}></tasks-view>`
    }
    // Every view id is handled above; 'server' is the last one.
    const context = this._activeProfile()
    const connected = context !== null && this._live.phase(context.id) === 'connected'
    return html`<server-view .profileId=${connected && context ? context.id : null}></server-view>`
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
    const profile = this._activeProfile()
    if (!profile) return
    const prefix = profile.engine === 'sqlite' ? 'explain query plan ' : analyze ? 'explain analyze ' : 'explain '
    const statement = prefix + stripExplain(sql)
    this._ctx.openPreview(statement)
    void this._runSql(statement)
  }

  // Double click: pin it. The preceding single clicks already recycled the
  // preview to this SQL, so promotion is just clearing the flag.
  private _onHistoryOpenPermanent(event: Event) {
    const { sql } = (event as CustomEvent<HistoryOpenDetail>).detail
    const preview = this._ctx.tabs.find((tab) => tab.kind === 'sql' && tab.preview && tab.content === sql)
    if (preview) {
      this._ctx.tabs = this._ctx.tabs.map((tab) => (tab.id === preview.id ? { ...tab, preview: false } : tab))
      this._ctx.activeTabId = preview.id
      return
    }
    const tab: SqlTabState = {
      id: crypto.randomUUID(),
      kind: 'sql',
      name: 'History.sql',
      path: null,
      content: sql,
      savedContent: sql,
    }
    this._ctx.tabs = [...this._ctx.tabs, tab]
    this._ctx.activeTabId = tab.id
  }

  private _onHistoryClear() {
    this._queries.clearHistory(contextKey(this._ctx.activeDbId, this._ctx.activeChildDb))
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
            .profileId=${activeTab.profileId}
            .table=${activeTab.table}
            .engine=${this._connections.find((connection) => connection.id === activeTab.profileId)?.engine ?? null}
          ></table-inspect>
        </div>
      `
    }
    if (activeTab?.kind === 'inspect-object') {
      return html`
        <div class="editor-content inspect">
          <table-inspect
            .profileId=${activeTab.profileId}
            .object=${activeTab.object}
            .objectKind=${activeTab.objectKind}
            .engine=${this._connections.find((connection) => connection.id === activeTab.profileId)?.engine ?? null}
          ></table-inspect>
        </div>
      `
    }
    if (activeTab?.kind === 'sql') {
      const tables = (this._ctx.activeDbId ? (this._live.tables[this._ctx.activeDbId] ?? []) : []).map((table) => table.name)
      const columns = this._ctx.activeDbId ? (this._live.columns[this._ctx.activeDbId] ?? null) : null
      const dialect = dialectForEngine[this._activeProfile()?.engine ?? 'postgresql']
      return html`
        <div class="editor-content sql">
          <div class="editor-pane">
            <sql-editor
              .tabId=${activeTab.id}
              .value=${activeTab.content}
              .dialect=${dialect}
              .tables=${tables}
              .columns=${columns}
            ></sql-editor>
          </div>
          <div
            class="panel-resize ${this._layout.panelResizing ? 'active' : ''}"
            role="separator"
            aria-label="Resize results panel"
            title="Resize results panel"
            @pointerdown=${this._layout.onPanelResizeStart}
            @dblclick=${this._layout.resetPanelHeight}
          ></div>
          <results-panel
            .run=${this._queries.runFor(this._ctx.activeTabId)}
            .canCancel=${this._activeProfile()?.engine === 'postgresql'}
            .editable=${this._resultEditing.hasResultCells()}
            .rowEditable=${this._resultEditing.rowEditable()}
            @cancel-query=${this._onCancelQuery}
            @load-more=${this._onLoadMore}
            @cell-edit=${this._onCellEdit}
            @cells-edit=${this._onCellsEdit}
            @add-row=${this._onAddRow}
            @delete-rows=${this._onDeleteRows}
            style="height: ${this._layout.panelHeight === null ? '70%' : `${this._layout.panelHeight}px`}"
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
    this._ctx.openConfigTab({
      id: crypto.randomUUID(),
      name: '',
      engine: 'postgresql',
      host: 'localhost',
      port: '5432',
      username: '',
      password: '',
      database: '',
      file: '',
      folder: '',
    })
  }

  private _onDbSelect(event: Event) {
    const { id } = (event as CustomEvent<{ id: string }>).detail
    const connection = this._connections.find((profile) => profile.id === id)
    if (connection) this._ctx.openConfigTab(connection)
  }

  private async _onDbConnect(event: Event) {
    const { id } = (event as CustomEvent<{ id: string }>).detail
    const connection = this._connections.find((profile) => profile.id === id)
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
    this._dialogs.prompt = {
      message: 'Create Database',
      detail: 'Name of the new database on this server.',
      confirmLabel: 'Create',
      placeholder: 'my_database',
      action: (name) => void this._createDatabase(id, name),
    }
  }

  private async _createDatabase(id: string, name: string) {
    const result = await window.sqlkit.createDatabase(id, name)
    if (!result.success) this._dialogs.notice(`Could not create "${name}"`, result.error ?? 'Unknown error')
  }

  private _onDbDropDatabase(event: Event) {
    const { id, database } = (event as CustomEvent<{ id: string; database: string }>).detail
    this._dialogs.confirm = {
      message: `Drop database "${database}"?`,
      detail: 'All data in it is permanently deleted on the server. This cannot be undone.',
      confirmLabel: 'Drop Database',
      action: () => void this._dropDatabase(id, database),
    }
  }

  private async _dropDatabase(id: string, database: string) {
    const result = await window.sqlkit.dropDatabase(id, database)
    if (!result.success) {
      this._dialogs.notice(`Could not drop "${database}"`, result.error ?? 'Unknown error')
      return
    }

    // The dropped child's working context is gone with it.
    this._ctx.dropInstance(contextKey(id, database))
    this._queries.sweepOrphans()
    if (this._connections.some((connection) => connection.id === id && connection.lastChildDb === database)) {
      this._connections = this._connections.map((connection) =>
        connection.id === id && connection.lastChildDb === database
          ? { ...connection, lastChildDb: undefined }
          : connection,
      )
      this._persistConfig()
    }
    // If the user was working in the dropped child, follow the driver's
    // in-use child instead of pointing at a database that no longer exists.
    if (this._ctx.activeDbId === id && this._ctx.activeChildDb === database) {
      this._setActiveDb(id, this._inUseChild(id) ?? undefined)
    }
  }

  private _onDbRemove(event: Event) {
    const { id } = (event as CustomEvent<{ id: string }>).detail
    const profile = this._connections.find((connection) => connection.id === id)
    if (!profile) return
    this._dialogs.confirm = {
      message: `Remove "${profile.name.trim() || 'New Database'}"?`,
      detail: 'The connection is removed from this workspace. Its files folder stays on disk.',
      confirmLabel: 'Remove',
      action: () => void this._removeDatabase(id),
    }
  }

  private async _removeDatabase(id: string) {
    await this._live.disconnect(id)

    // Leave the context first so _switchInstance doesn't re-stash it below.
    if (this._ctx.activeDbId === id) {
      const next = this._connections.find((connection) => connection.id !== id) ?? null
      this._ctx.switchInstance(next?.id ?? null, next ? this._defaultChild(next) : null)
    }

    this._connections = this._connections.filter((connection) => connection.id !== id)

    // Drop the profile's stashed contexts and its config tab wherever it's open.
    this._ctx.removeProfile(id)
    this._queries.sweepOrphans()

    this._workspaceFiles.setFolder(this._contextFolder())
    this._persistConfig()
  }


  private _onTablesRefresh() {
    const profile = this._activeProfile()
    if (profile) this._live.refresh(profile.id)
  }

  private _onTableSelect(event: Event) {
    this._ctx.selectedTable = (event as CustomEvent<TableSelectDetail>).detail.key
  }

  private _onTableBrowse(event: Event) {
    const { table } = (event as CustomEvent<TableBrowseDetail>).detail
    const profile = this._activeProfile()
    if (profile) this._browseTable(profile, table)
  }

  // Refresh runs as a visible statement: it lands in the preview tab and
  // through the normal query path, so it shows in results, Tasks (matview
  // refreshes are classic long-runners), and history.
  private _onMatviewRefresh(event: Event) {
    const { table } = (event as CustomEvent<TableBrowseDetail>).detail
    const statement = `REFRESH MATERIALIZED VIEW ${quoteQualified(table)};`
    this._ctx.openPreview(statement)
    void this._runSql(statement)
  }

  private _onTableDrop(event: Event) {
    const { table } = (event as CustomEvent<TableBrowseDetail>).detail
    const profile = this._activeProfile()
    if (!profile) return
    const verbs: Record<TableRef['kind'], string> = {
      table: 'DROP TABLE',
      view: 'DROP VIEW',
      matview: 'DROP MATERIALIZED VIEW',
      foreign: 'DROP FOREIGN TABLE',
    }
    const statement = `${verbs[table.kind]} ${quoteQualified(table)};`
    this._dialogs.confirm = {
      message: `Drop ${TABLE_KIND_LABELS[table.kind]} "${table.name}"?`,
      detail: 'It is permanently deleted on the server. This cannot be undone.',
      confirmLabel: 'Drop',
      action: () => {
        this._ctx.openPreview(statement)
        // The schema changed: re-fetch tables/columns once the drop lands.
        void this._runSql(statement).then(() => this._live.refresh(profile.id))
      },
    }
  }

  private _onTableTruncate(event: Event) {
    const { table } = (event as CustomEvent<TableBrowseDetail>).detail
    const profile = this._activeProfile()
    if (!profile) return
    // SQLite has no TRUNCATE; an unqualified DELETE is its idiom.
    const statement =
      profile.engine === 'sqlite'
        ? `DELETE FROM ${quoteQualified(table)};`
        : `TRUNCATE TABLE ${quoteQualified(table)};`
    this._dialogs.confirm = {
      message: `Truncate "${table.name}"?`,
      detail: `All rows are permanently deleted (${statement}). This cannot be undone.`,
      confirmLabel: 'Truncate',
      action: () => {
        this._ctx.openPreview(statement)
        void this._runSql(statement)
      },
    }
  }

  // Inspect opens (or revisits) the table's structure tab — columns,
  // constraints, indexes and friends; table-inspect fetches its own data.
  private _onTableInspect(event: Event) {
    const { table } = (event as CustomEvent<TableBrowseDetail>).detail
    const profile = this._activeProfile()
    if (!profile) return
    const id = `inspect:${tableContextKey(profile.id, this._ctx.activeChildDb, table)}`
    if (!this._ctx.tabs.some((tab) => tab.id === id)) {
      this._ctx.tabs = [...this._ctx.tabs, { id, kind: 'inspect', profileId: profile.id, table }]
    }
    this._ctx.activeTabId = id
  }

  // Same for functions/types; detail (identity args) keeps overloads apart.
  private _onObjectInspect(event: Event) {
    const { object, objectKind } = (event as CustomEvent<ObjectInspectDetail>).detail
    const profile = this._activeProfile()
    if (!profile) return
    const id = `inspect-object:${profile.id}:${this._ctx.activeChildDb ?? ''}:${object.schema ?? ''}:${objectKind}:${object.name}:${object.detail}`
    if (!this._ctx.tabs.some((tab) => tab.id === id)) {
      this._ctx.tabs = [...this._ctx.tabs, { id, kind: 'inspect-object', profileId: profile.id, object, objectKind }]
    }
    this._ctx.activeTabId = id
  }

  // A search match opens the file and lands the cursor on the matched line.
  private async _onSearchOpen(event: Event) {
    const { file, line } = (event as CustomEvent<SearchOpenDetail>).detail
    await this._openFileTab(file)
    await this.updateComplete
    const editor = this.shadowRoot?.querySelector('sql-editor')
    if (!editor) return
    await editor.updateComplete
    editor.revealLine(line)
  }

  private _onFileOpen(event: Event) {
    const { file } = (event as CustomEvent<{ file: FileInfo }>).detail
    // Only .sql opens in the editor; spreadsheets, exports etc. go to the
    // system default app.
    if (file.name.toLowerCase().endsWith('.sql')) {
      void this._openFileTab(file)
      return
    }
    void window.sqlkit.openExternal(file.path).then((result) => {
      if (!result.success) console.error('Open failed:', result.error)
    })
  }

  private async _onFileCreate(event: Event) {
    const { parent, name } = (event as CustomEvent<FileCreateDetail>).detail
    const folder = this._contextFolder()
    if (!folder) return

    const result = await window.sqlkit.createFile(folder, parent ? `${parent}/${name}` : name)
    if (!result.success) {
      console.error('Create failed:', result.error)
      return
    }
    await this._workspaceFiles.reload()
    const created = this._workspaceFiles.files.find((file) => file.path === result.path)
    if (created) void this._openFileTab(created)
  }

  private async _onFileRename(event: Event) {
    const { file, newName } = (event as CustomEvent<FileRenameDetail>).detail
    const result = await window.sqlkit.renameFile(file.path, newName)
    if (!result.success) {
      console.error('Rename failed:', result.error)
      return
    }

    // Retarget any open tab; tab ids are keyed by absolute path.
    const oldId = `file:${file.path}`
    const newId = `file:${result.path}`
    this._ctx.tabs = this._ctx.tabs.map((tab) =>
      tab.id === oldId && tab.kind === 'sql' ? { ...tab, id: newId, name: result.name, path: result.path } : tab,
    )
    this._queries.renameTab(oldId, newId)
    if (this._ctx.activeTabId === oldId) this._ctx.activeTabId = newId
    void this._workspaceFiles.reload()
  }

  private _onFileDelete(event: Event) {
    const { path: targetPath, name } = (event as CustomEvent<FileDeleteDetail>).detail
    this._dialogs.confirm = {
      message: `Delete "${name}"?`,
      detail: 'It will be moved to the Trash.',
      confirmLabel: 'Move to Trash',
      action: () => void this._performDelete(targetPath),
    }
  }

  private async _performDelete(targetPath: string) {
    const result = await window.sqlkit.deleteFile(targetPath)
    if (!result.success) {
      console.error('Delete failed:', result.error)
      return
    }

    // Close tabs of the deleted file — or of everything under a deleted folder.
    this._ctx.tabs = this._ctx.tabs.filter(
      (tab) => !(tab.kind === 'sql' && tab.path && (tab.path === targetPath || tab.path.startsWith(`${targetPath}/`))),
    )
    this._queries.sweepOrphans()
    if (this._ctx.activeTabId && !this._ctx.tabs.some((tab) => tab.id === this._ctx.activeTabId)) {
      this._ctx.activeTabId = this._ctx.tabs[this._ctx.tabs.length - 1]?.id ?? null
    }
    void this._workspaceFiles.reload()
  }

  private _onEditorChange(event: Event) {
    const { value } = (event as CustomEvent<{ value: string }>).detail
    this._ctx.setActiveContent(value)
  }

  private _onRunQuery(event: Event) {
    const { sql } = (event as CustomEvent<RunQueryDetail>).detail
    void this._runSql(sql)
  }

  // The pending runQuery settles on its own with "Query cancelled." — this
  // only asks the server to interrupt the backend.
  private _onCancelQuery() {
    const profile = this._activeProfile()
    if (profile) void window.sqlkit.cancelQuery(profile.id)
  }

  // The results grid scrolled near the end of what's loaded: page in more rows.
  private _onLoadMore() {
    if (this._ctx.activeTabId) void this._queries.loadMore(this._ctx.activeTabId)
  }

  private _onCellEdit(event: Event) {
    const { row, col, value } = (event as CustomEvent<{ row: number; col: number; value: string }>).detail
    this._resultEditing.cellEdit({ row, col, value })
  }

  private _onCellsEdit(event: Event) {
    const { cells } = (event as CustomEvent<{ cells: CellCoord[] }>).detail
    this._resultEditing.promptCellsEdit(cells)
  }

  private _onAddRow() {
    this._resultEditing.addRow()
  }

  private _onDeleteRows(event: Event) {
    const { rows } = (event as CustomEvent<{ rows: number[] }>).detail
    this._resultEditing.deleteRows(rows)
  }

  // Stop from the Tasks view: targets the task's own connection, which may
  // not be the active context.
  private _onTaskStop(event: Event) {
    const { profileId } = (event as CustomEvent<TaskStopDetail>).detail
    void window.sqlkit.cancelQuery(profileId)
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
    const existing = this._connections.findIndex((connection) => connection.id === profile.id)
    const connections =
      existing >= 0
        ? this._connections.map((connection) => (connection.id === profile.id ? profile : connection))
        : [...this._connections, profile]

    const result = await window.sqlkit.saveWorkspaceConfig({ version: 1, connections, activeDbId: this._ctx.activeDbId })
    if (!result.success) {
      console.error('Failed to save workspace config:', result.error)
      return
    }

    // Re-read rather than trusting the local copy: the save assigned the
    // profile's files folder (and created it on disk).
    await this._loadConfig()
    this._ctx.closeTab(profile.id)
    this._activeView = 'databases'
  }

  private _onConfigCancel() {
    if (this._ctx.activeTabId) this._ctx.closeTab(this._ctx.activeTabId)
  }

  private _onCloseWorkspace() {
    this.dispatchEvent(new CustomEvent('close-workspace', { bubbles: true, composed: true }))
  }

  static styles = [
    typography,
    controls,
    codicons,
    scrollbars,
    css`
      :host {
        flex-direction: column;
        min-height: 0;
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

      .activity-bar .codicon {
        font-size: 24px;
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

      .title-action .codicon {
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
        border-bottom: 1px solid var(--border);
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
