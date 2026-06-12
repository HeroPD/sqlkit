import { LitElement, css, html, type PropertyValues } from 'lit'
import { customElement, property, state } from 'lit/decorators.js'
import { codicons, controls, scrollbars, typography } from '../shared-styles'
import { isMac, mod } from '../platform'
import { ConnectionsController } from '../controllers/connections'
import { FilesController } from '../controllers/files'
import type { ConnectionProfile, FileInfo, FileSaveResult, MenuAction, TableRef } from '../electron'
import './activity-button'
import './command-palette'
import './confirm-dialog'
import './databases-view'
import './db-config-form'
import './editor-empty'
import './editor-tab'
import './explorer-view'
import './history-view'
import './results-panel'
import './search-view'
import './sql-editor'
import './status-bar'
import { tableKey } from './explorer-view'
import type { EmptyAction } from './editor-empty'
import type { PaletteEntry, PaletteMode } from './command-palette'
import type { QueryRun } from './results-panel'
import type { RunQueryDetail } from './sql-editor'
import type { TableBrowseDetail, TableSelectDetail } from './explorer-view'
import type { HistoryItem, HistoryOpenDetail } from './history-view'
import type { SearchOpenDetail } from './search-view'
import type { FileCreateDetail, FileDeleteDetail, FileRenameDetail } from './file-tree'

const VIEWS = [
  { id: 'explorer', title: 'Explorer', icon: 'codicon-files', hint: 'No files yet.' },
  { id: 'search', title: 'Search', icon: 'codicon-search', hint: 'Search across your SQL files.' },
  { id: 'databases', title: 'Databases', icon: 'codicon-database', hint: 'No database connections yet.' },
  { id: 'history', title: 'History', icon: 'codicon-history', hint: 'No query history yet.' },
  { id: 'tasks', title: 'Tasks', icon: 'codicon-checklist', hint: 'No running jobs.' },
] as const

// Reference behavior: keep the most recent runs, drop the tail.
const MAX_HISTORY = 200

type ViewId = (typeof VIEWS)[number]['id']

// An editor tab: a connection-config form (the tab owns the unsaved draft, so
// edits survive switching tabs) or a SQL editor over a workspace file —
// path is null for untitled queries until the first save.
type SqlTabState = {
  id: string
  kind: 'sql'
  name: string
  path: string | null
  content: string
  savedContent: string
  /**
   * VS Code-style preview tab: single-click opens recycle it instead of
   * stacking tabs. Editing or double-clicking promotes it to permanent.
   */
  preview?: boolean
}

type EditorTabState = { id: string; kind: 'config'; profile: ConnectionProfile } | SqlTabState

const tabTitle = (tab: EditorTabState) => {
  if (tab.kind === 'config') return tab.profile.name.trim() || 'New Database'
  return tab.content === tab.savedContent ? tab.name : `${tab.name} •`
}

// Every database context (⌘K) is its own working instance: open tabs, the
// active tab, the latest query result, and the Explorer's table selection.
// A context is a connection *and* its child database (all-databases mode) —
// x1/analytics and x1/billing are separate instances. Switching contexts
// stashes the live fields here and restores the target's.
type ContextInstance = {
  tabs: EditorTabState[]
  activeTabId: string | null
  queryRun: QueryRun
  selectedTable: string | null
}

/** Instance bucket for tabs opened before any context exists. */
// Browse/history tab names already end in .sql; don't double it.
const suggestedSqlName = (tabName: string) => `${tabName.replace(/\.sql$/i, '')}.sql`

const NO_CONTEXT = '__none__'

const contextKey = (profileId: string | null, childDb: string | null) =>
  profileId === null ? NO_CONTEXT : `${profileId}:${childDb ?? ''}`

// Child database names become folder segments (connection/child/file.sql);
// strip anything that isn't a safe path character.
const childFolderSegment = (name: string) => {
  const cleaned = name.replace(/[^\w .-]/g, '_').replace(/^[. ]+/, '')
  return cleaned || 'database'
}

// Commands offered by the ⌘⇧P palette; ids are dispatched to _runCommand.
const COMMANDS: ReadonlyArray<{ id: string; label: string; icon: string; keybind?: string }> = [
  { id: 'new-query', label: 'New Query', icon: 'codicon-new-file', keybind: mod('N') },
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

  // The database context in use (⌘K): queries run against it, and the
  // Explorer shows its folder + tables.
  @state()
  private _activeDbId: string | null = null

  // The child database of the active context (all-databases mode); part of
  // the context's identity.
  @state()
  private _activeChildDb: string | null = null

  @state()
  private _selectedTable: string | null = null

  @state()
  private _palette: PaletteMode | null = null

  @state()
  private _queryRun: QueryRun = { phase: 'idle' }

  // null = the default split: results take half of the editor area.
  @state()
  private _panelHeight: number | null = null

  @state()
  private _panelResizing: { startY: number; startHeight: number } | null = null

  @state()
  private _confirm: { message: string; detail: string; confirmLabel: string; action: () => void } | null = null

  // Query history of every context in this workspace (runtime-only, like the
  // reference); the History view filters it to the active context.
  @state()
  private _history: HistoryItem[] = []

  @state()
  private _tabs: EditorTabState[] = []

  @state()
  private _activeTabId: string | null = null

  @state()
  private _sidebarWidth = 280

  @state()
  private _resizing: { startX: number; startWidth: number } | null = null

  // True while a drag is below the collapse threshold: the sidebar hides live
  // but the handle stays mounted so the drag (pointer capture) survives, and
  // dragging back out restores it. Committed on release.
  @state()
  private _sidebarCollapsing = false

  // Stashed working instances of inactive contexts, keyed by profile id.
  private _instances = new Map<string, ContextInstance>()

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
    switch (action) {
      case 'new-query':
        this._newQuery()
        break
      case 'save':
        void this._saveActiveTab()
        break
      case 'save-as':
        void this._saveActiveTabAs()
        break
      case 'close-tab':
        if (this._activeTabId) this._requestCloseTab(this._activeTabId)
        break
    }
  }

  protected willUpdate(changed: PropertyValues) {
    if (changed.has('workspace')) {
      this._tabs = []
      this._activeTabId = null
      this._connections = []
      this._activeDbId = null
      this._activeChildDb = null
      this._palette = null
      this._selectedTable = null
      this._queryRun = { phase: 'idle' }
      this._history = []
      this._instances.clear()
      this._workspaceFiles.setFolder(null)
      // Connections belong to the workspace they were opened from.
      void this._live.disconnectAll()
      if (this.workspace) void this._loadConfig()
    }
  }

  // --- workspace config + context -----------------------------------------

  private async _loadConfig() {
    const config = await window.sqlkit.getWorkspaceConfig()
    this._connections = config.connections
    // Restore the in-use context; default to the first profile so the
    // Explorer has a files folder to show right away.
    const restored =
      config.activeDbId && config.connections.some((connection) => connection.id === config.activeDbId)
        ? config.activeDbId
        : (config.connections[0]?.id ?? null)
    const restoredProfile = restored ? (config.connections.find((c) => c.id === restored) ?? null) : null
    this._switchInstance(restored, restoredProfile ? this._defaultChild(restoredProfile) : null)
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
    return this._activeChildDb ? `${folder}/${childFolderSegment(this._activeChildDb)}` : folder
  }

  /** The child the connection currently targets, when it has several. */
  private _inUseChild(profileId: string): string | null {
    const children = this._live.statuses[profileId]?.children ?? []
    if (children.length < 2) return null
    return children.find((child) => child.inUse)?.name ?? null
  }

  // Swaps the working instance: stashes the live tabs/result/selection under
  // the outgoing context and restores (or initializes) the incoming one.
  private _switchInstance(profileId: string | null, childDb: string | null) {
    const fromKey = contextKey(this._activeDbId, this._activeChildDb)
    const toKey = contextKey(profileId, childDb)
    if (fromKey === toKey) return

    this._instances.set(fromKey, {
      tabs: this._tabs,
      activeTabId: this._activeTabId,
      queryRun: this._queryRun,
      selectedTable: this._selectedTable,
    })

    this._activeDbId = profileId
    this._activeChildDb = childDb
    const incoming = this._instances.get(toKey)
    this._tabs = incoming?.tabs ?? []
    this._activeTabId = incoming?.activeTabId ?? null
    this._queryRun = incoming?.queryRun ?? { phase: 'idle' }
    this._selectedTable = incoming?.selectedTable ?? null
  }

  /** The profile of the in-use database context (⌘K). */
  private _activeProfile(): ConnectionProfile | null {
    return this._connections.find((connection) => connection.id === this._activeDbId) ?? null
  }

  private _persistConfig() {
    void window.sqlkit.saveWorkspaceConfig({
      version: 1,
      connections: this._connections,
      activeDbId: this._activeDbId,
    })
  }

  // Without an explicit child, a profile-level switch (⌘P table pick,
  // single-db connect) resolves the default child so all-databases contexts
  // never land on the parent folder.
  private _setActiveDb(profileId: string, childDb?: string | null) {
    const profile = this._connections.find((connection) => connection.id === profileId)
    if (!profile) return
    const child = childDb === undefined ? this._defaultChild(profile) : childDb

    if (this._activeDbId === profileId && this._activeChildDb === child) return

    // Remember the pick so reopening the workspace lands on the same child.
    if (child && profile.lastChildDb !== child) {
      this._connections = this._connections.map((connection) =>
        connection.id === profileId ? { ...connection, lastChildDb: child } : connection,
      )
    }

    this._switchInstance(profileId, child)
    this._workspaceFiles.setFolder(this._contextFolder())
    this._persistConfig()
  }

  // After a connect, the driver targets the discovery database; if the
  // context remembers a different child, point the driver at it (or follow
  // the driver when the remembered child no longer exists).
  private async _alignActiveChild(profileId: string) {
    if (this._activeDbId !== profileId || !this._activeChildDb) return
    const children = this._live.statuses[profileId]?.children ?? []
    if (children.length < 2) return
    const inUse = children.find((child) => child.inUse)?.name
    if (inUse === this._activeChildDb) return
    if (children.some((child) => child.name === this._activeChildDb)) {
      await this._live.setActiveChild(profileId, this._activeChildDb)
    } else if (inUse) {
      this._setActiveDb(profileId, inUse)
    }
  }

  // ⌘K parent pick on a not-yet-connected connection: the palette stays open
  // and shows the connecting spinner (status pushes drive it). Once live, an
  // all-databases connection expands into its children in place for the real
  // pick; a single-db connection becomes the context and the palette closes.
  private async _connectFromPalette(profile: ConnectionProfile) {
    const result = await this._live.connect(profile)
    if (!result.success) return // the entry shows the error state
    if (this._palette !== 'databases') return // closed meanwhile: treat as canceled
    if (profile.databaseMode === 'all') return // children just appeared; keep picking

    this._setActiveDb(profile.id)
    this._palette = null
  }

  // --- global shortcuts -----------------------------------------------------

  // ⌘⇧P commands, ⌘P quick open, ⌘K database switch, ⌘B sidebar, ⌘N new
  // query, ⌘S save, ⌘↵ run. Pressing a palette's own shortcut again closes it.
  private _onGlobalKeydown = (event: KeyboardEvent) => {
    // The editor's own keymap (Mod-Enter) prevents default when it handles a
    // chord; don't run it twice.
    if (event.defaultPrevented) return
    if (!event.metaKey && !event.ctrlKey) return
    const key = event.key.toLowerCase()

    if (key === 'p') {
      event.preventDefault()
      this._togglePalette(event.shiftKey ? 'commands' : 'quick')
      return
    }
    if (event.shiftKey) return
    if (key === 'k') {
      event.preventDefault()
      this._togglePalette('databases')
      return
    }
    if (key === 'b') {
      event.preventDefault()
      this._toggleSidebar()
      return
    }
    if (key === 'n') {
      event.preventDefault()
      this._newQuery()
      return
    }
    if (key === 's') {
      event.preventDefault()
      void this._saveActiveTab()
      return
    }
    if (key === 'enter') {
      const tab = this._activeSqlTab()
      if (tab?.content.trim()) {
        event.preventDefault()
        void this._runSql(tab.content.trim())
      }
    }
  }

  private _togglePalette(mode: PaletteMode) {
    this._palette = this._palette === mode ? null : mode
  }

  private _toggleSidebar() {
    this._activeView = this._activeView === null ? 'explorer' : null
  }

  // --- tabs ------------------------------------------------------------------

  private _activeSqlTab(): SqlTabState | null {
    const tab = this._tabs.find((entry) => entry.id === this._activeTabId)
    return tab?.kind === 'sql' ? tab : null
  }

  private _openConfigTab(profile: ConnectionProfile) {
    if (!this._tabs.some((tab) => tab.id === profile.id)) {
      this._tabs = [...this._tabs, { id: profile.id, kind: 'config', profile: { ...profile } }]
    }
    this._activeTabId = profile.id
  }

  private async _openFileTab(file: FileInfo) {
    // Keyed by absolute path: same-named files in different database
    // folders are distinct tabs.
    const id = `file:${file.path}`
    if (!this._tabs.some((tab) => tab.id === id)) {
      const result = await window.sqlkit.readFile(file.path)
      if (!result.success) {
        console.error('Failed to read file:', result.error)
        return
      }
      this._tabs = [
        ...this._tabs,
        { id, kind: 'sql', name: file.name, path: file.path, content: result.content, savedContent: result.content },
      ]
    }
    this._activeTabId = id
  }

  private _newQuery() {
    const untitled = this._tabs.filter((tab) => tab.kind === 'sql' && tab.path === null).length
    const tab: SqlTabState = {
      id: crypto.randomUUID(),
      kind: 'sql',
      name: `Untitled-${untitled + 1}`,
      path: null,
      content: '',
      savedContent: '',
    }
    this._tabs = [...this._tabs, tab]
    this._activeTabId = tab.id
  }

  private _closeTab(id: string) {
    const index = this._tabs.findIndex((tab) => tab.id === id)
    if (index < 0) return

    this._tabs = this._tabs.filter((tab) => tab.id !== id)
    if (this._activeTabId === id) {
      this._activeTabId = this._tabs[Math.min(index, this._tabs.length - 1)]?.id ?? null
    }
  }

  // Close via ⌘W, the tab ✕, etc.: dirty editors get a confirmation first.
  private _requestCloseTab(id: string) {
    const tab = this._tabs.find((entry) => entry.id === id)
    if (tab?.kind === 'sql' && tab.content !== tab.savedContent) {
      this._confirm = {
        message: `Close "${tab.name}" without saving?`,
        detail: 'Unsaved changes will be lost.',
        confirmLabel: 'Close Without Saving',
        action: () => this._closeTab(id),
      }
      return
    }
    this._closeTab(id)
  }

  private async _saveActiveTab() {
    const tab = this._activeSqlTab()
    if (!tab) return

    // Untitled queries go through the native dialog, defaulting into the
    // active context's folder.
    const result = tab.path
      ? await window.sqlkit.saveFile(tab.path, tab.content)
      : await window.sqlkit.saveFileAs(this._contextFolder() ?? '', suggestedSqlName(tab.name), tab.content)
    this._applySaveResult(tab, result)
  }

  // File > Save As…: always the dialog, even for files that have a path.
  private async _saveActiveTabAs() {
    const tab = this._activeSqlTab()
    if (!tab) return
    const result = await window.sqlkit.saveFileAs(this._contextFolder() ?? '', suggestedSqlName(tab.name), tab.content)
    this._applySaveResult(tab, result)
  }

  private _applySaveResult(tab: SqlTabState, result: FileSaveResult) {
    if (!result.success) {
      if (!result.canceled) console.error('Save failed:', result.error)
      return
    }
    this._tabs = this._tabs.map((entry) =>
      entry.id === tab.id && entry.kind === 'sql'
        ? { ...entry, path: result.path, name: result.name, savedContent: tab.content }
        : entry,
    )
  }

  // --- query running ----------------------------------------------------------

  // Runs against the in-use context (⌘K), connecting it first if needed.
  private async _runSql(sqlText: string) {
    const profile = this._activeProfile()
    if (!profile) {
      this._queryRun = { phase: 'error', error: `No database selected — press ${mod('K')} to pick one.` }
      return
    }

    const runKey = contextKey(profile.id, this._activeChildDb)

    if (this._live.phase(profile.id) !== 'connected') {
      this._applyQueryRun(runKey, { phase: 'running', note: `Connecting to ${profile.name}…` })
      const connected = await this._live.connect(profile)
      if (!connected.success) {
        this._applyQueryRun(runKey, { phase: 'error', error: connected.error })
        return
      }
    }
    // The driver may be targeting the discovery database; the run belongs to
    // the context's child.
    await this._alignActiveChild(profile.id)

    this._applyQueryRun(runKey, { phase: 'running' })
    const response = await window.sqlkit.runQuery(profile.id, sqlText)
    this._applyQueryRun(
      runKey,
      response.success ? { phase: 'done', result: response.result } : { phase: 'error', error: response.error },
    )

    this._history = [
      {
        id: crypto.randomUUID(),
        contextKey: runKey,
        sql: sqlText,
        success: response.success,
        durationMs: response.success ? response.result.durationMs : 0,
        rowCount: response.success ? response.result.rowCount : null,
        error: response.success ? '' : response.error,
        createdAt: new Date().toISOString(),
      },
      ...this._history,
    ].slice(0, MAX_HISTORY)
  }

  // A run that finishes after the user switched contexts belongs to the
  // instance that started it, not the one on screen.
  private _applyQueryRun(runKey: string, run: QueryRun) {
    if (contextKey(this._activeDbId, this._activeChildDb) === runKey) {
      this._queryRun = run
      return
    }
    const stashed = this._instances.get(runKey)
    if (stashed) this._instances.set(runKey, { ...stashed, queryRun: run })
  }

  // Double-click browse (reference behavior): a query tab named after the
  // table, pre-filled with a capped SELECT and run immediately. Browsing the
  // same table again reuses its tab and re-runs whatever it now contains.
  private _browseTable(profile: ConnectionProfile, table: TableRef) {
    const quote = (identifier: string) => `"${identifier.replaceAll('"', '""')}"`
    const qualified = table.schema ? `${quote(table.schema)}.${quote(table.name)}` : quote(table.name)
    const sqlText = `SELECT * FROM ${qualified} LIMIT 200`

    const id = `browse:${tableKey(profile.id, table)}`
    const existing = this._tabs.find((tab) => tab.id === id)
    if (!existing) {
      this._tabs = [
        ...this._tabs,
        { id, kind: 'sql', name: `${table.name}.sql`, path: null, content: sqlText, savedContent: sqlText },
      ]
    }
    this._activeTabId = id
    void this._runSql(existing?.kind === 'sql' ? existing.content : sqlText)
  }

  // --- command palette ---------------------------------------------------------

  private _paletteEntries(): PaletteEntry[] {
    if (this._palette === 'commands') return [...COMMANDS]

    if (this._palette === 'quick') {
      const files = this._workspaceFiles.files
        .filter((file) => file.type === 'file')
        .map((file) => ({ id: `file:${file.relativePath}`, label: file.name, detail: file.relativePath, icon: 'codicon-file-code' }))

      // Tables of the in-use context only — ⌘P must not mix databases;
      // switching context is ⌘K's job.
      const context = this._activeProfile()
      const tables =
        context && this._live.phase(context.id) === 'connected'
          ? (this._live.tables[context.id] ?? []).map((table) => ({
              id: `table:${tableKey(context.id, table)}`,
              label: table.name,
              detail: table.schema ?? '',
              icon: 'codicon-table',
            }))
          : []

      return [...files, ...tables]
    }

    if (this._palette === 'databases') {
      return this._connections.flatMap((connection) => {
        const phase = this._live.phase(connection.id)
        const children = this._live.statuses[connection.id]?.children ?? []

        // An all-databases connection with discovered children: the parent
        // stays visible as a group header (it isn't a single database, so it
        // can't be picked) and its children nest underneath as the pickable
        // contexts.
        if (children.length > 1) {
          return [
            {
              id: `hdr:${connection.id}`,
              label: connection.name,
              detail: `${connection.engine} · Connected`,
              icon: 'codicon-database',
              header: true,
            },
            ...children.map((child) => ({
              id: `child:${connection.id}:${child.name}`,
              label: child.name,
              detail: this._activeDbId === connection.id && this._activeChildDb === child.name ? 'In use' : '',
              icon: 'codicon-symbol-namespace',
              indent: true,
            })),
          ]
        }

        const label =
          phase === 'connected'
            ? 'Connected'
            : phase === 'connecting'
              ? 'Connecting…'
              : phase === 'error'
                ? `Error — ${this._live.statuses[connection.id]?.error ?? ''}`
                : 'Disconnected'
        const parts = [connection.engine, label]
        if (this._activeDbId === connection.id) parts.push('In use')
        // The children of a disconnected all-databases connection aren't
        // known yet; picking it connects and discovers them.
        if (connection.databaseMode === 'all' && phase !== 'connected' && phase !== 'connecting') {
          parts.push('connect to list databases')
        }
        return [
          {
            id: `db:${connection.id}`,
            label: connection.name,
            detail: parts.join(' · '),
            icon: phase === 'connecting' ? 'codicon-loading codicon-modifier-spin' : 'codicon-database',
          },
        ]
      })
    }

    return []
  }

  private _onPalettePick(event: Event) {
    const { mode, id } = (event as CustomEvent<{ mode: PaletteMode; id: string }>).detail

    if (mode === 'commands') {
      this._palette = null
      this._runCommand(id)
      return
    }
    if (mode === 'quick') {
      this._palette = null
      if (id.startsWith('file:')) {
        const relativePath = id.slice('file:'.length)
        const file = this._workspaceFiles.files.find((entry) => entry.type === 'file' && entry.relativePath === relativePath)
        if (file) void this._openFileTab(file)
        return
      }
      // Reveal the picked table in the Explorer and open its browse tab —
      // same as double-clicking it in the sidebar. Entries are scoped to the
      // in-use context, so the _setActiveDb below is normally a no-op.
      const key = id.slice('table:'.length)
      this._selectedTable = key
      const profileId = key.split(':')[0]
      if (profileId) this._setActiveDb(profileId)
      this._activeView = 'explorer'
      const profile = this._connections.find((connection) => connection.id === profileId)
      const table = (this._live.tables[profileId] ?? []).find((entry) => tableKey(profileId, entry) === key)
      if (profile && table) this._browseTable(profile, table)
      return
    }

    // databases mode: a child pick switches the active child database; a
    // parent pick is a whole single-db connection, or a not-yet-connected one
    // that keeps the palette open while it loads.
    if (id.startsWith('child:')) {
      const body = id.slice('child:'.length)
      const separator = body.indexOf(':')
      const profileId = body.slice(0, separator)
      const database = body.slice(separator + 1)
      this._palette = null
      this._setActiveDb(profileId, database)
      void this._live.setActiveChild(profileId, database)
      return
    }

    const profileId = id.slice('db:'.length)
    const profile = this._connections.find((connection) => connection.id === profileId)
    if (!profile) {
      this._palette = null
      return
    }
    const phase = this._live.phase(profileId)
    if (phase === 'connecting') return // already loading; stay open
    if (phase === 'connected') {
      // Single-db connection (connected all-mode ones render as children).
      this._palette = null
      this._setActiveDb(profileId)
      return
    }
    void this._connectFromPalette(profile)
  }

  private _runCommand(id: string) {
    if (id.startsWith('show-')) {
      this._activeView = id.slice('show-'.length) as ViewId
      return
    }
    switch (id) {
      case 'new-query':
        this._newQuery()
        break
      case 'run-query': {
        const tab = this._activeSqlTab()
        if (tab?.content.trim()) void this._runSql(tab.content.trim())
        break
      }
      case 'save-file':
        void this._saveActiveTab()
        break
      case 'quick-open':
        this._palette = 'quick'
        break
      case 'switch-database':
        this._palette = 'databases'
        break
      case 'add-database':
        this._onAddDatabase()
        break
      case 'disconnect-all':
        void this._live.disconnectAll()
        break
      case 'refresh-files':
        void this._workspaceFiles.reload()
        break
      case 'toggle-sidebar':
        this._toggleSidebar()
        break
      case 'close-workspace':
        this._onCloseWorkspace()
        break
    }
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
        @add-database=${this._onAddDatabase}
        @table-select=${this._onTableSelect}
        @table-browse=${this._onTableBrowse}
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
              <activity-button view=${view.id} title=${view.title} .active=${view.id === this._activeView}>
                <i class="codicon ${view.icon}" aria-hidden="true"></i>
              </activity-button>
            `,
          )}
        </nav>

        ${activeView
          ? html`
              <aside class="sidebar ${this._sidebarCollapsing ? 'collapsed' : ''}" style="width: ${this._sidebarWidth}px">
                <div class="sidebar-title">
                  <span>${activeView.title}</span>
                  ${this._renderTitleActions(activeView)}
                </div>
                ${this._renderSidebarView(activeView)}
              </aside>
              <div
                class="sidebar-resize ${this._resizing ? 'active' : ''}"
                role="separator"
                aria-label="Resize sidebar"
                title="Resize sidebar"
                @pointerdown=${this._onResizeStart}
                @pointermove=${this._onResizeMove}
                @pointerup=${this._onResizeEnd}
                @pointercancel=${this._onResizeEnd}
                @dblclick=${() => (this._sidebarWidth = 280)}
              ></div>
            `
          : ''}

        <div class="editor-area">
          ${this._tabs.length
            ? html`
                <div class="tab-bar">
                  ${this._tabs.map(
                    (tab) => html`
                      <editor-tab
                        tabId=${tab.id}
                        name=${tabTitle(tab)}
                        .active=${tab.id === this._activeTabId}
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
        .open=${this._palette !== null}
        .mode=${this._palette ?? 'commands'}
        .entries=${this._paletteEntries()}
        @palette-close=${() => (this._palette = null)}
        @palette-pick=${this._onPalettePick}
      ></command-palette>

      ${this._confirm
        ? html`
            <confirm-dialog
              .message=${this._confirm.message}
              .detail=${this._confirm.detail}
              .confirmLabel=${this._confirm.confirmLabel}
              @dialog-cancel=${() => (this._confirm = null)}
              @dialog-confirm=${this._onConfirmAccept}
            ></confirm-dialog>
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
    return this._activeChildDb ? `${profile.name} · ${this._activeChildDb}` : profile.name
  }

  private _connectedName() {
    const connected = this._live.connected()
    if (connected.length !== 1) return ''
    return this._connections.find((profile) => profile.id === connected[0].profileId)?.name ?? ''
  }

  // View-specific actions level with the sidebar title (reference layout).
  private _renderTitleActions(view: (typeof VIEWS)[number]) {
    if (view.id !== 'history') return ''
    const key = contextKey(this._activeDbId, this._activeChildDb)
    const count = this._history.filter((item) => item.contextKey === key).length
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

  private _renderSidebarView(view: (typeof VIEWS)[number]) {
    if (view.id === 'databases') {
      return html`
        <databases-view
          .connections=${this._connections}
          .statuses=${this._live.statuses}
          .activeTabId=${this._activeTabId}
        ></databases-view>
      `
    }
    if (view.id === 'explorer') {
      const activeTab = this._tabs.find((tab) => tab.id === this._activeTabId)
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
          .activeChildName=${activeChild}
          .selectedTable=${this._selectedTable}
        ></explorer-view>
      `
    }
    if (view.id === 'search') {
      return html`<search-view .files=${this._workspaceFiles.files}></search-view>`
    }
    if (view.id === 'history') {
      const key = contextKey(this._activeDbId, this._activeChildDb)
      return html`
        <history-view
          .items=${this._history.filter((item) => item.contextKey === key)}
          @history-open=${this._onHistoryOpen}
          @history-open-permanent=${this._onHistoryOpenPermanent}
          @history-clear=${this._onHistoryClear}
        ></history-view>
      `
    }
    return html`<p class="muted hint">${view.hint}</p>`
  }

  // Single click: open the SQL in the preview tab (recycled across picks, so
  // browsing history doesn't stack tabs). Never auto-runs.
  private _onHistoryOpen(event: Event) {
    const { sql } = (event as CustomEvent<HistoryOpenDetail>).detail
    const preview = this._tabs.find((tab) => tab.kind === 'sql' && tab.preview)

    if (preview) {
      this._tabs = this._tabs.map((tab) =>
        tab.id === preview.id && tab.kind === 'sql' ? { ...tab, content: sql, savedContent: sql } : tab,
      )
      this._activeTabId = preview.id
      return
    }

    const tab: SqlTabState = {
      id: crypto.randomUUID(),
      kind: 'sql',
      name: 'History.sql',
      path: null,
      content: sql,
      savedContent: sql,
      preview: true,
    }
    this._tabs = [...this._tabs, tab]
    this._activeTabId = tab.id
  }

  // Double click: pin it. The preceding single clicks already recycled the
  // preview to this SQL, so promotion is just clearing the flag.
  private _onHistoryOpenPermanent(event: Event) {
    const { sql } = (event as CustomEvent<HistoryOpenDetail>).detail
    const preview = this._tabs.find((tab) => tab.kind === 'sql' && tab.preview && tab.content === sql)
    if (preview) {
      this._tabs = this._tabs.map((tab) => (tab.id === preview.id ? { ...tab, preview: false } : tab))
      this._activeTabId = preview.id
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
    this._tabs = [...this._tabs, tab]
    this._activeTabId = tab.id
  }

  private _onHistoryClear() {
    const key = contextKey(this._activeDbId, this._activeChildDb)
    this._history = this._history.filter((item) => item.contextKey !== key)
  }

  private _renderEditorContent() {
    const activeTab = this._tabs.find((tab) => tab.id === this._activeTabId)
    if (activeTab?.kind === 'config') {
      return html`
        <div class="editor-content form">
          <db-config-form .profile=${activeTab.profile}></db-config-form>
        </div>
      `
    }
    if (activeTab?.kind === 'sql') {
      const tables = (this._activeDbId ? (this._live.tables[this._activeDbId] ?? []) : []).map((table) => table.name)
      const columns = this._activeDbId ? (this._live.columns[this._activeDbId] ?? null) : null
      return html`
        <div class="editor-content sql">
          <div class="editor-pane">
            <sql-editor
              .tabId=${activeTab.id}
              .value=${activeTab.content}
              .tables=${tables}
              .columns=${columns}
            ></sql-editor>
          </div>
          <div
            class="panel-resize ${this._panelResizing ? 'active' : ''}"
            role="separator"
            aria-label="Resize results panel"
            title="Resize results panel"
            @pointerdown=${this._onPanelResizeStart}
            @pointermove=${this._onPanelResizeMove}
            @pointerup=${this._onPanelResizeEnd}
            @pointercancel=${this._onPanelResizeEnd}
            @dblclick=${() => (this._panelHeight = null)}
          ></div>
          <results-panel
            .run=${this._queryRun}
            style="height: ${this._panelHeight === null ? '50%' : `${this._panelHeight}px`}"
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
    if (action === 'new-query') this._newQuery()
    if (action === 'quick-open') this._palette = 'quick'
    if (action === 'switch-database') this._palette = 'databases'
    if (action === 'command-palette') this._palette = 'commands'
    if (action === 'add-database') this._onAddDatabase()
    if (action === 'close-workspace') this._onCloseWorkspace()
  }

  private _onAddDatabase() {
    this._openConfigTab({
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
    if (connection) this._openConfigTab(connection)
  }

  private async _onDbConnect(event: Event) {
    const { id } = (event as CustomEvent<{ id: string }>).detail
    const connection = this._connections.find((profile) => profile.id === id)
    if (!connection) return
    // Failures surface through the status push (error dot + message).
    const result = await this._live.connect(connection)
    if (!result.success) return
    await this._alignActiveChild(id)
    // A successful connect becomes the in-use context, but stays on the
    // Databases view — no jumping to the Explorer uninvited.
    this._setActiveDb(id)
  }

  private async _onDbDisconnect(event: Event) {
    const { id } = (event as CustomEvent<{ id: string }>).detail
    await this._live.disconnect(id)
  }


  private _onTablesRefresh() {
    const profile = this._activeProfile()
    if (profile) this._live.refresh(profile.id)
  }

  private _onTableSelect(event: Event) {
    this._selectedTable = (event as CustomEvent<TableSelectDetail>).detail.key
  }

  private _onTableBrowse(event: Event) {
    const { table } = (event as CustomEvent<TableBrowseDetail>).detail
    const profile = this._activeProfile()
    if (profile) this._browseTable(profile, table)
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
    this._tabs = this._tabs.map((tab) =>
      tab.id === oldId && tab.kind === 'sql' ? { ...tab, id: newId, name: result.name, path: result.path } : tab,
    )
    if (this._activeTabId === oldId) this._activeTabId = newId
    void this._workspaceFiles.reload()
  }

  private _onFileDelete(event: Event) {
    const { path: targetPath, name } = (event as CustomEvent<FileDeleteDetail>).detail
    this._confirm = {
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
    this._tabs = this._tabs.filter(
      (tab) => !(tab.kind === 'sql' && tab.path && (tab.path === targetPath || tab.path.startsWith(`${targetPath}/`))),
    )
    if (this._activeTabId && !this._tabs.some((tab) => tab.id === this._activeTabId)) {
      this._activeTabId = this._tabs[this._tabs.length - 1]?.id ?? null
    }
    void this._workspaceFiles.reload()
  }

  private _onConfirmAccept = () => {
    const action = this._confirm?.action
    this._confirm = null
    action?.()
  }

  private _onEditorChange(event: Event) {
    const { value } = (event as CustomEvent<{ value: string }>).detail
    // Editing a preview tab promotes it to permanent (VS Code behavior) —
    // a later history pick must not recycle away someone's edits.
    this._tabs = this._tabs.map((tab) =>
      tab.id === this._activeTabId && tab.kind === 'sql' ? { ...tab, content: value, preview: false } : tab,
    )
  }

  private _onRunQuery(event: Event) {
    const { sql } = (event as CustomEvent<RunQueryDetail>).detail
    void this._runSql(sql)
  }

  private _onTabSelect(event: Event) {
    const { tabId } = (event as CustomEvent<{ tabId: string }>).detail
    this._activeTabId = tabId
  }

  private _onTabClose(event: Event) {
    const { tabId } = (event as CustomEvent<{ tabId: string }>).detail
    this._requestCloseTab(tabId)
  }

  private _onConfigChange(event: Event) {
    const { profile } = (event as CustomEvent<{ profile: ConnectionProfile }>).detail
    this._tabs = this._tabs.map((tab) => (tab.kind === 'config' && tab.id === profile.id ? { ...tab, profile } : tab))
  }

  private async _onConfigSave(event: Event) {
    const { profile } = (event as CustomEvent<{ profile: ConnectionProfile }>).detail
    const existing = this._connections.findIndex((connection) => connection.id === profile.id)
    const connections =
      existing >= 0
        ? this._connections.map((connection) => (connection.id === profile.id ? profile : connection))
        : [...this._connections, profile]

    const result = await window.sqlkit.saveWorkspaceConfig({ version: 1, connections, activeDbId: this._activeDbId })
    if (!result.success) {
      console.error('Failed to save workspace config:', result.error)
      return
    }

    // Re-read rather than trusting the local copy: the save assigned the
    // profile's files folder (and created it on disk).
    await this._loadConfig()
    this._closeTab(profile.id)
    this._activeView = 'databases'
  }

  private _onConfigCancel() {
    if (this._activeTabId) this._closeTab(this._activeTabId)
  }

  private _onCloseWorkspace() {
    this.dispatchEvent(new CustomEvent('close-workspace', { bubbles: true, composed: true }))
  }

  // --- sidebar resize -----------------------------------------------------------

  private _onResizeStart(event: PointerEvent) {
    ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
    this._resizing = { startX: event.clientX, startWidth: this._sidebarWidth }
    event.preventDefault()
  }

  private _onResizeMove(event: PointerEvent) {
    if (!this._resizing) return
    const raw = this._resizing.startWidth + (event.clientX - this._resizing.startX)

    // Dragged under the minimum with a little intent margin: snap closed.
    // Dragging back out reopens at the minimum.
    if (raw < 110) {
      this._sidebarCollapsing = true
      return
    }

    this._sidebarCollapsing = false
    this._sidebarWidth = Math.max(170, Math.min(500, raw))
  }

  private _onResizeEnd(event: PointerEvent) {
    if (!this._resizing) return
    this._resizing = null
    ;(event.currentTarget as HTMLElement).releasePointerCapture(event.pointerId)

    if (this._sidebarCollapsing) {
      this._sidebarCollapsing = false
      this._activeView = null
      this._sidebarWidth = 280
    }
  }

  private _onPanelResizeStart(event: PointerEvent) {
    const panel = this.shadowRoot?.querySelector<HTMLElement>('results-panel')
    if (!panel) return
    ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
    this._panelResizing = { startY: event.clientY, startHeight: panel.offsetHeight }
    event.preventDefault()
  }

  private _onPanelResizeMove(event: PointerEvent) {
    if (!this._panelResizing) return
    // Dragging up grows the panel.
    const raw = this._panelResizing.startHeight - (event.clientY - this._panelResizing.startY)
    this._panelHeight = Math.max(80, Math.min(600, raw))
  }

  private _onPanelResizeEnd(event: PointerEvent) {
    if (!this._panelResizing) return
    this._panelResizing = null
    ;(event.currentTarget as HTMLElement).releasePointerCapture(event.pointerId)
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
