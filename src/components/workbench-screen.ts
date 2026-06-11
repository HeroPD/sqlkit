import { LitElement, css, html, type PropertyValues } from 'lit'
import { customElement, property, state } from 'lit/decorators.js'
import { codicons, controls, scrollbars, typography } from '../shared-styles'
import type { ConnectionProfile, ConnectionStatus, FileInfo, TableRef } from '../electron'
import './activity-button'
import './command-palette'
import './db-list-item'
import './db-config-form'
import './editor-empty'
import './editor-tab'
import './file-tree'
import type { EmptyAction } from './editor-empty'
import type { PaletteEntry, PaletteMode } from './command-palette'

const VIEWS = [
  { id: 'explorer', title: 'Explorer', icon: 'codicon-files', hint: 'No files yet.' },
  { id: 'search', title: 'Search', icon: 'codicon-search', hint: 'Search across your SQL files.' },
  { id: 'databases', title: 'Databases', icon: 'codicon-database', hint: 'No database connections yet.' },
  { id: 'history', title: 'History', icon: 'codicon-history', hint: 'No query history yet.' },
  { id: 'tasks', title: 'Tasks', icon: 'codicon-checklist', hint: 'No running jobs.' },
] as const

type ViewId = (typeof VIEWS)[number]['id']

// An editor tab: a connection-config form (the tab owns the unsaved draft, so
// edits survive switching tabs) or a read-only view of a workspace .sql file
// (the SQL editor replaces it later).
type EditorTabState =
  | { id: string; kind: 'config'; profile: ConnectionProfile }
  | { id: string; kind: 'file'; file: FileInfo; content: string }

const tabTitle = (tab: EditorTabState) =>
  tab.kind === 'config' ? tab.profile.name.trim() || 'New Database' : tab.file.name

const isMac = navigator.platform.startsWith('Mac')
const mod = (key: string) => (isMac ? `⌘${key}` : `Ctrl+${key}`)

const tableKey = (profileId: string, table: TableRef) => `${profileId}:${table.schema ?? ''}:${table.name}`

const tableLabel = (table: TableRef) => (table.schema ? `${table.schema}.${table.name}` : table.name)

// Commands offered by the ⌘⇧P palette; ids are dispatched to _runCommand.
const COMMANDS: ReadonlyArray<{ id: string; label: string; icon: string; keybind?: string }> = [
  { id: 'quick-open', label: 'Quick Open…', icon: 'codicon-file-code', keybind: mod('P') },
  { id: 'switch-database', label: 'Switch Database…', icon: 'codicon-database', keybind: mod('K') },
  { id: 'add-database', label: 'Add Database', icon: 'codicon-add' },
  { id: 'disconnect-all', label: 'Disconnect All Databases', icon: 'codicon-debug-disconnect' },
  { id: 'refresh-files', label: 'Refresh Files', icon: 'codicon-sync' },
  { id: 'toggle-sidebar', label: 'Toggle Sidebar', icon: 'codicon-layout-sidebar-left', keybind: mod('B') },
  ...VIEWS.map((view) => ({ id: `show-${view.id}`, label: `Show ${view.title}`, icon: view.icon })),
  { id: 'close-workspace', label: 'Close Workspace', icon: 'codicon-folder-opened' },
]

// Workbench shell: activity bar + switchable sidebar + editor area over the
// status bar. Clicking an activity button shows its view; clicking the active
// one hides the sidebar (reference behavior). Dispatches a `close-workspace`
// intent; <app-root> owns the screen switch.
@customElement('workbench-screen')
export class WorkbenchScreen extends LitElement {
  @property({ attribute: false })
  workspace: { name: string; path: string } | null = null

  @state()
  private _activeView: ViewId | null = 'explorer'

  @state()
  private _connections: ConnectionProfile[] = []

  // Live connection state, keyed by profile id; pushed from the main process.
  // Profiles without an entry are disconnected.
  @state()
  private _statuses: Record<string, ConnectionStatus> = {}

  // Table lists of connected databases, fetched once per connection.
  @state()
  private _tables: Record<string, TableRef[]> = {}

  // Workspace .sql files (and their folders), kept fresh by the main-process
  // file watcher.
  @state()
  private _files: FileInfo[] = []

  // Which palette is open, if any.
  @state()
  private _palette: PaletteMode | null = null

  // The database context in use (⌘K): the connection queries will run
  // against once the SQL editor lands.
  @state()
  private _activeDbId: string | null = null

  // Explorer section collapse + table selection (tableKey of the highlighted
  // row; browsing arrives with the SQL editor).
  @state()
  private _filesCollapsed = false

  @state()
  private _tablesCollapsed = false

  @state()
  private _selectedTable: string | null = null

  // Explorer Files/Tables split: null means the default even split; a number
  // pins the Files section to that height (set by dragging the divider).
  @state()
  private _filesSectionHeight: number | null = null

  @state()
  private _sectionResizing: { startY: number; startHeight: number } | null = null

  private _unsubscribeStatus: (() => void) | null = null

  private _unsubscribeFiles: (() => void) | null = null

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

  connectedCallback() {
    super.connectedCallback()
    this._unsubscribeStatus = window.sqlkit.onConnectionStatus((statuses) => this._applyStatuses(statuses))
    this._unsubscribeFiles = window.sqlkit.onFilesChanged(() => void this._loadFiles())
    window.addEventListener('keydown', this._onGlobalKeydown)
    void window.sqlkit.getConnectionStatuses().then((statuses) => this._applyStatuses(statuses))
  }

  disconnectedCallback() {
    super.disconnectedCallback()
    this._unsubscribeStatus?.()
    this._unsubscribeStatus = null
    this._unsubscribeFiles?.()
    this._unsubscribeFiles = null
    window.removeEventListener('keydown', this._onGlobalKeydown)
  }

  protected willUpdate(changed: PropertyValues) {
    if (changed.has('workspace')) {
      this._tabs = []
      this._activeTabId = null
      this._connections = []
      this._files = []
      this._activeDbId = null
      this._palette = null
      this._selectedTable = null
      this._filesSectionHeight = null
      // Connections belong to the workspace they were opened from.
      void window.sqlkit.disconnectAllDatabases()
      if (this.workspace) void this._loadConfig()
    }
  }

  private async _loadConfig() {
    const config = await window.sqlkit.getWorkspaceConfig()
    this._connections = config.connections
    // Restore the in-use context; default to the first profile so the
    // Explorer has a files folder to show right away.
    const restored =
      config.activeDbId && config.connections.some((connection) => connection.id === config.activeDbId)
        ? config.activeDbId
        : (config.connections[0]?.id ?? null)
    this._activeDbId = restored
    void this._loadFiles()
  }

  /** The profile of the in-use database context (⌘K). */
  private _activeProfile(): ConnectionProfile | null {
    return this._connections.find((connection) => connection.id === this._activeDbId) ?? null
  }

  // Files belong to one database context: only the active profile's folder is
  // listed, so .sql files never mix between databases.
  private async _loadFiles() {
    const folder = this._activeProfile()?.folder
    if (!folder) {
      this._files = []
      return
    }
    const result = await window.sqlkit.listFiles(folder)
    // A slow response for a context the user already switched away from must
    // not clobber the current listing.
    if (result.success && this._activeProfile()?.folder === folder) this._files = result.files
  }

  private _persistConfig() {
    void window.sqlkit.saveWorkspaceConfig({
      version: 1,
      connections: this._connections,
      activeDbId: this._activeDbId,
    })
  }

  private _setActiveDb(profileId: string) {
    if (this._activeDbId === profileId) return
    this._activeDbId = profileId
    void this._loadFiles()
    this._persistConfig()
  }

  // Global shortcuts: ⌘⇧P commands, ⌘P quick open, ⌘K database switch,
  // ⌘B sidebar. Pressing a palette's own shortcut again closes it.
  private _onGlobalKeydown = (event: KeyboardEvent) => {
    if (!event.metaKey && !event.ctrlKey) return
    const key = event.key.toLowerCase()

    if (key === 'p') {
      event.preventDefault()
      this._togglePalette(event.shiftKey ? 'commands' : 'quick')
      return
    }
    if (key === 'k' && !event.shiftKey) {
      event.preventDefault()
      this._togglePalette('databases')
      return
    }
    if (key === 'b' && !event.shiftKey) {
      event.preventDefault()
      this._toggleSidebar()
    }
  }

  private _togglePalette(mode: PaletteMode) {
    this._palette = this._palette === mode ? null : mode
  }

  private _toggleSidebar() {
    this._activeView = this._activeView === null ? 'explorer' : null
  }

  private _paletteEntries(): PaletteEntry[] {
    if (this._palette === 'commands') return [...COMMANDS]

    if (this._palette === 'quick') {
      const files = this._files
        .filter((file) => file.type === 'file')
        .map((file) => ({ id: `file:${file.relativePath}`, label: file.name, detail: file.relativePath, icon: 'codicon-file-code' }))

      // Tables of every connected database, so ⌘P reaches across contexts.
      const tables = this._connections.flatMap((connection) =>
        (this._tables[connection.id] ?? []).map((table) => ({
          id: `table:${tableKey(connection.id, table)}`,
          label: table.name,
          detail: [table.schema, connection.name].filter(Boolean).join(' · '),
          icon: 'codicon-table',
        })),
      )

      return [...files, ...tables]
    }

    if (this._palette === 'databases') {
      return this._connections.map((connection) => {
        const status = this._statuses[connection.id]
        const phase =
          status?.phase === 'connected'
            ? 'Connected'
            : status?.phase === 'connecting'
              ? 'Connecting…'
              : status?.phase === 'error'
                ? 'Error'
                : 'Disconnected'
        const parts = [connection.engine, phase]
        if (this._activeDbId === connection.id) parts.push('In use')
        return { id: connection.id, label: connection.name, detail: parts.join(' · '), icon: 'codicon-database' }
      })
    }

    return []
  }

  private _onPalettePick(event: Event) {
    const { mode, id } = (event as CustomEvent<{ mode: PaletteMode; id: string }>).detail
    this._palette = null

    if (mode === 'commands') {
      this._runCommand(id)
      return
    }
    if (mode === 'quick') {
      if (id.startsWith('file:')) {
        const relativePath = id.slice('file:'.length)
        const file = this._files.find((entry) => entry.type === 'file' && entry.relativePath === relativePath)
        if (file) void this._openFileTab(file)
        return
      }
      // Tables can't be browsed yet; reveal the pick in the Explorer. The
      // key's profile id also becomes the in-use context so the Tables
      // section shows the right database.
      const key = id.slice('table:'.length)
      this._selectedTable = key
      const profileId = key.split(':')[0]
      if (profileId) this._setActiveDb(profileId)
      this._activeView = 'explorer'
      this._tablesCollapsed = false
      return
    }
    void this._switchDatabase(id)
  }

  private _runCommand(id: string) {
    if (id.startsWith('show-')) {
      this._activeView = id.slice('show-'.length) as ViewId
      return
    }
    switch (id) {
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
        this._activeDbId = null
        void window.sqlkit.disconnectAllDatabases()
        break
      case 'refresh-files':
        void this._loadFiles()
        break
      case 'toggle-sidebar':
        this._toggleSidebar()
        break
      case 'close-workspace':
        this._onCloseWorkspace()
        break
    }
  }

  // ⌘K pick: make the connection the in-use context, connecting it first if
  // it isn't live yet.
  private async _switchDatabase(profileId: string) {
    this._setActiveDb(profileId)
    const phase = this._statuses[profileId]?.phase
    if (phase === 'connected' || phase === 'connecting') return
    const profile = this._connections.find((connection) => connection.id === profileId)
    if (profile) await window.sqlkit.connectDatabase(profile)
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
      this._tabs = [...this._tabs, { id, kind: 'file', file, content: result.content }]
    }
    this._activeTabId = id
  }

  private _applyStatuses(statuses: ConnectionStatus[]) {
    const byId: Record<string, ConnectionStatus> = {}
    for (const status of statuses) byId[status.profileId] = status
    this._statuses = byId

    // Keep table lists only for still-connected databases, and fetch for
    // freshly connected ones.
    const tables: Record<string, TableRef[]> = {}
    for (const [id, list] of Object.entries(this._tables)) {
      if (byId[id]?.phase === 'connected') tables[id] = list
    }
    this._tables = tables
    for (const status of statuses) {
      if (status.phase === 'connected' && !(status.profileId in this._tables)) {
        void this._loadTables(status.profileId)
      }
    }
  }

  private async _loadTables(profileId: string) {
    const result = await window.sqlkit.listTables(profileId)
    if (result.success && this._statuses[profileId]?.phase === 'connected') {
      this._tables = { ...this._tables, [profileId]: result.tables }
    }
  }

  render() {
    const activeView = VIEWS.find((view) => view.id === this._activeView)
    return html`
      <div
        class="body"
        @db-select=${this._onDbSelect}
        @db-connect=${this._onDbConnect}
        @db-disconnect=${this._onDbDisconnect}
        @file-open=${this._onFileOpen}
        @config-change=${this._onConfigChange}
        @config-save=${this._onConfigSave}
        @config-cancel=${this._onConfigCancel}
        @tab-select=${this._onTabSelect}
        @tab-close=${this._onTabClose}
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
                <div class="sidebar-title">${activeView.title}</div>
                ${activeView.id === 'databases'
                  ? this._renderDatabasesView()
                  : activeView.id === 'explorer'
                    ? this._renderExplorerView()
                    : html`<p class="muted hint">${activeView.hint}</p>`}
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
                @dblclick=${this._onResizeReset}
              ></div>
            `
          : ''}

        <div class="editor-area">
          ${this._tabs.length
            ? html`
                <div class="tab-bar">
                  ${this._tabs.map(
                    (tab) => html`
                      <editor-tab tabId=${tab.id} name=${tabTitle(tab)} .active=${tab.id === this._activeTabId}></editor-tab>
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

      ${this._renderStatusBar()}
    `
  }

  // VS Code-style split: each section is a flex region with its own
  // scrolling body, so both headers stay visible no matter how long the
  // lists get. The 1px divider drags the split; double-click resets it.
  private _renderExplorerView() {
    const activeTab = this._tabs.find((tab) => tab.id === this._activeTabId)
    const source = this._explorerTablesSource()
    const context = this._activeProfile()
    const filesStyle =
      !this._filesCollapsed && this._filesSectionHeight !== null ? `flex: 0 0 ${this._filesSectionHeight}px` : ''

    return html`
      <div class="explorer">
        <div class="x-section ${this._filesCollapsed ? 'collapsed' : ''}" style=${filesStyle}>
          <button class="section-head-row" @click=${() => (this._filesCollapsed = !this._filesCollapsed)}>
            <i class="codicon codicon-chevron-right chevron ${this._filesCollapsed ? '' : 'expanded'}" aria-hidden="true"></i>
            <span>Files</span>
            ${context ? html`<span class="section-detail">${context.name}</span>` : ''}
          </button>
          ${this._filesCollapsed
            ? ''
            : html`
                <div class="section-body">
                  ${context
                    ? html`
                        <file-tree
                          .files=${this._files}
                          .activePath=${activeTab?.kind === 'file' ? activeTab.file.path : null}
                        ></file-tree>
                      `
                    : html`<p class="muted hint">Add a database to get its files folder.</p>`}
                </div>
              `}
        </div>

        ${!this._filesCollapsed && !this._tablesCollapsed
          ? html`
              <div
                class="x-resize ${this._sectionResizing ? 'active' : ''}"
                role="separator"
                aria-label="Resize Files and Tables"
                title="Resize Files and Tables"
                @pointerdown=${this._onSectionResizeStart}
                @pointermove=${this._onSectionResizeMove}
                @pointerup=${this._onSectionResizeEnd}
                @pointercancel=${this._onSectionResizeEnd}
                @dblclick=${() => (this._filesSectionHeight = null)}
              ></div>
            `
          : ''}

        <div
          class="x-section ${this._tablesCollapsed ? 'collapsed' : ''} ${this._tablesCollapsed && !this._filesCollapsed ? 'pin-bottom' : ''}"
        >
          <button class="section-head-row" @click=${() => (this._tablesCollapsed = !this._tablesCollapsed)}>
            <i class="codicon codicon-chevron-right chevron ${this._tablesCollapsed ? '' : 'expanded'}" aria-hidden="true"></i>
            <span>Tables</span>
            ${source ? html`<span class="section-detail">${source.profile.name}</span>` : ''}
          </button>
          ${this._tablesCollapsed ? '' : html`<div class="section-body">${this._renderExplorerTables(source)}</div>`}
        </div>
      </div>
    `
  }

  private _onSectionResizeStart(event: PointerEvent) {
    const files = this.shadowRoot?.querySelector<HTMLElement>('.explorer .x-section')
    if (!files) return
    ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
    this._sectionResizing = { startY: event.clientY, startHeight: files.offsetHeight }
    event.preventDefault()
  }

  private _onSectionResizeMove(event: PointerEvent) {
    if (!this._sectionResizing) return
    const explorer = this.shadowRoot?.querySelector<HTMLElement>('.explorer')
    if (!explorer) return

    // Keep at least a header-plus-a-few-rows visible on both sides.
    const minSection = 72
    const max = Math.max(minSection, explorer.clientHeight - 1 - minSection)
    const raw = this._sectionResizing.startHeight + (event.clientY - this._sectionResizing.startY)
    this._filesSectionHeight = Math.max(minSection, Math.min(max, raw))
  }

  private _onSectionResizeEnd(event: PointerEvent) {
    if (!this._sectionResizing) return
    this._sectionResizing = null
    ;(event.currentTarget as HTMLElement).releasePointerCapture(event.pointerId)
  }

  // The Explorer is scoped to the in-use context: its tables show only while
  // that database is connected.
  private _explorerTablesSource(): { profile: ConnectionProfile; tables: TableRef[] } | null {
    const profile = this._activeProfile()
    if (!profile || this._statuses[profile.id]?.phase !== 'connected') return null
    return { profile, tables: this._tables[profile.id] ?? [] }
  }

  private _renderExplorerTables(source: { profile: ConnectionProfile; tables: TableRef[] } | null) {
    if (!source) return html`<p class="muted hint">Connect a database to see tables (${mod('K')}).</p>`
    if (!source.tables.length) return html`<p class="muted hint">No tables.</p>`
    return html`
      <div class="etable-list">
        ${source.tables.map((table) => {
          const key = tableKey(source.profile.id, table)
          return html`
            <div
              class="etable-row ${this._selectedTable === key ? 'selected' : ''}"
              title=${tableLabel(table)}
              @click=${() => (this._selectedTable = key)}
            >
              <i class="codicon codicon-table" aria-hidden="true"></i>
              <span>${tableLabel(table)}</span>
            </div>
          `
        })}
      </div>
    `
  }

  private _onFileOpen(event: Event) {
    const { file } = (event as CustomEvent<{ file: FileInfo }>).detail
    void this._openFileTab(file)
  }

  private _renderStatusBar() {
    const connected = Object.values(this._statuses).filter((status) => status.phase === 'connected')
    const summary =
      connected.length === 0
        ? 'Not connected'
        : connected.length === 1
          ? (this._connections.find((profile) => profile.id === connected[0].profileId)?.name ?? '1 connected')
          : `${connected.length} connected`
    const activeDb = this._connections.find((profile) => profile.id === this._activeDbId)
    return html`
      <footer class="status-bar ${connected.length ? 'connected' : ''}">
        <span>${this.workspace?.name ?? 'SqlKit'}</span>
        ${activeDb ? html`<span><i class="codicon codicon-database" aria-hidden="true"></i> ${activeDb.name}</span>` : ''}
        <span class="spacer"></span>
        <span>${summary}</span>
      </footer>
    `
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
    if (activeTab?.kind === 'file') {
      return html`
        <div class="editor-content file">
          <pre class="file-view">${activeTab.content}</pre>
        </div>
      `
    }

    return html`
      <div class="editor-content">
        <editor-empty @empty-action=${this._onEmptyAction}></editor-empty>
      </div>
    `
  }

  private _onEmptyAction(event: Event) {
    const { action } = (event as CustomEvent<{ action: EmptyAction }>).detail
    if (action === 'quick-open') this._palette = 'quick'
    if (action === 'switch-database') this._palette = 'databases'
    if (action === 'command-palette') this._palette = 'commands'
    if (action === 'add-database') this._onAddDatabase()
    if (action === 'close-workspace') this._onCloseWorkspace()
  }

  private _renderDatabasesView() {
    return html`
      <div class="db-list">
        ${this._connections.length
          ? this._connections.map((connection) => this._renderDatabaseItem(connection))
          : html`<p class="muted hint">No database connections yet.</p>`}
      </div>
      <button class="link sidebar-action" @click=${this._onAddDatabase}>
        <i class="codicon codicon-add" aria-hidden="true"></i>
        <span>Add Database</span>
      </button>
    `
  }

  private _renderDatabaseItem(connection: ConnectionProfile) {
    const status = this._statuses[connection.id]
    const detail =
      status?.phase === 'error'
        ? status.error
        : status?.phase === 'connected'
          ? `${status.serverVersion}${status.tunneled ? ' · SSH' : ''}`
          : connection.engine
    return html`
      <db-list-item
        dbId=${connection.id}
        name=${connection.name}
        detail=${detail ?? connection.engine}
        status=${status?.phase ?? ''}
        .active=${this._activeTabId === connection.id}
      ></db-list-item>
      ${status?.phase === 'connected' ? this._renderTables(connection.id) : ''}
    `
  }

  private _renderTables(profileId: string) {
    const tables = this._tables[profileId]
    if (!tables) return ''
    if (!tables.length) return html`<p class="muted hint table-hint">No tables.</p>`
    return html`
      <div class="table-list">
        ${tables.map(
          (table) => html`
            <div class="table-row" title=${table.schema ? `${table.schema}.${table.name}` : table.name}>
              <i class="codicon codicon-table" aria-hidden="true"></i>
              <span>${table.schema ? `${table.schema}.${table.name}` : table.name}</span>
            </div>
          `,
        )}
      </div>
    `
  }

  private _onActivitySelect(event: Event) {
    const { view } = (event as CustomEvent<{ view: ViewId }>).detail
    this._activeView = this._activeView === view ? null : view
  }

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

  private _onResizeReset() {
    this._sidebarWidth = 280
  }

  private _openTab(profile: ConnectionProfile) {
    if (!this._tabs.some((tab) => tab.id === profile.id)) {
      this._tabs = [...this._tabs, { id: profile.id, kind: 'config', profile: { ...profile } }]
    }
    this._activeTabId = profile.id
  }

  private _closeTab(id: string) {
    const index = this._tabs.findIndex((tab) => tab.id === id)
    if (index < 0) return

    this._tabs = this._tabs.filter((tab) => tab.id !== id)
    if (this._activeTabId === id) {
      this._activeTabId = this._tabs[Math.min(index, this._tabs.length - 1)]?.id ?? null
    }
  }

  private _onAddDatabase() {
    this._openTab({
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
    if (connection) this._openTab(connection)
  }

  private async _onDbConnect(event: Event) {
    const { id } = (event as CustomEvent<{ id: string }>).detail
    const connection = this._connections.find((profile) => profile.id === id)
    // Failures surface through the status push (error dot + message).
    if (connection) await window.sqlkit.connectDatabase(connection)
  }

  private async _onDbDisconnect(event: Event) {
    const { id } = (event as CustomEvent<{ id: string }>).detail
    await window.sqlkit.disconnectDatabase(id)
  }

  private _onTabSelect(event: Event) {
    const { tabId } = (event as CustomEvent<{ tabId: string }>).detail
    this._activeTabId = tabId
  }

  private _onTabClose(event: Event) {
    const { tabId } = (event as CustomEvent<{ tabId: string }>).detail
    this._closeTab(tabId)
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
        padding: 0 20px;
        font-size: var(--font-size-sm);
        color: var(--text);
        letter-spacing: 0.04em;
        text-transform: uppercase;
        user-select: none;
        flex-shrink: 0;
      }

      .sidebar .hint {
        padding: 0 20px;
      }

      .db-list {
        display: flex;
        flex-direction: column;
        overflow-y: auto;
        min-height: 0;
        overscroll-behavior: none;
        overflow-anchor: none;
      }

      .explorer {
        flex: 1;
        display: flex;
        flex-direction: column;
        min-height: 0;
        overflow: hidden;
      }

      /* Expanded sections split the height evenly (or per the dragged
         divider) and never grow past it: their bodies scroll instead. */
      .x-section {
        flex: 1;
        display: flex;
        flex-direction: column;
        overflow: hidden;
        min-height: 72px;
      }

      .x-section.collapsed {
        flex: 0 0 auto;
        min-height: 0;
      }

      .x-section.pin-bottom {
        margin-top: auto;
      }

      .section-body {
        flex: 1;
        display: flex;
        flex-direction: column;
        overflow: hidden;
        min-height: 0;
      }

      .section-body > file-tree,
      .section-body > .etable-list {
        flex: 1;
        overflow-y: auto;
        min-height: 0;
        overscroll-behavior: none;
        overflow-anchor: none;
      }

      .x-resize {
        height: 1px;
        flex-shrink: 0;
        cursor: row-resize;
        background: var(--border-subtle);
        position: relative;
        z-index: 10;
        touch-action: none;
      }

      /* Wider invisible hit area than the 1px visible line. */
      .x-resize::after {
        content: '';
        position: absolute;
        inset: -2px 0;
      }

      .x-resize:hover,
      .x-resize.active {
        background: var(--resize-hover);
      }

      .body:has(.x-resize.active) {
        cursor: row-resize;
        user-select: none;
      }

      .section-head-row {
        display: flex;
        align-items: center;
        gap: 4px;
        width: 100%;
        height: auto;
        padding: 4px 10px;
        border: none;
        border-radius: 0;
        background: transparent;
        color: var(--text);
        font-size: var(--font-size-sm);
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        text-align: left;
        cursor: pointer;
        flex-shrink: 0;
      }

      .section-head-row:hover {
        background: var(--list-hover);
      }

      .section-head-row .chevron {
        font-size: 14px;
        transition: transform 0.1s ease;
      }

      .section-head-row .chevron.expanded {
        transform: rotate(90deg);
      }

      .section-detail {
        margin-left: auto;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        color: var(--text-3);
        font-weight: 400;
        text-transform: none;
        letter-spacing: normal;
      }

      .etable-list {
        display: flex;
        flex-direction: column;
      }

      .etable-row {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 3px 10px 3px 24px;
        font-size: var(--font-size);
        color: var(--text);
        white-space: nowrap;
        cursor: pointer;
        user-select: none;
      }

      .etable-row:hover {
        background: var(--list-hover);
      }

      .etable-row.selected {
        background: var(--list-selection);
        color: var(--list-selection-fg);
      }

      .etable-row .codicon {
        font-size: 14px;
        flex-shrink: 0;
        color: var(--text-2);
      }

      .etable-row.selected .codicon {
        color: var(--list-selection-fg);
      }

      .etable-row span {
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .table-list {
        display: flex;
        flex-direction: column;
        padding: 2px 0 6px;
      }

      .table-row {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 2px 10px 2px 36px;
        font-size: var(--font-size-sm);
        color: var(--text-2);
        white-space: nowrap;
      }

      .table-row span {
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .table-row .codicon {
        font-size: 13px;
        flex-shrink: 0;
      }

      .table-hint {
        padding: 2px 10px 6px 36px;
        font-size: var(--font-size-sm);
      }

      .sidebar-action {
        width: auto;
        margin: 4px 10px;
      }

      .sidebar-action .codicon {
        font-size: 14px;
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

      .editor-content.file {
        display: block;
        overflow: auto;
        overscroll-behavior: none;
        overflow-anchor: none;
      }

      .file-view {
        margin: 0;
        padding: 16px 20px;
        font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
        font-size: 13px;
        line-height: 1.5;
        color: var(--text);
        tab-size: 4;
      }

      .status-bar .codicon {
        font-size: 12px;
        vertical-align: -1px;
      }

      .status-bar {
        height: var(--status-bar-h);
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 0 10px;
        font-size: var(--font-size-sm);
        color: var(--status-bar-fg);
        background: var(--status-bar-disconnected);
      }

      .status-bar.connected {
        background: var(--status-bar-bg);
      }

      .spacer {
        flex: 1;
      }
    `,
  ]
}

declare global {
  interface HTMLElementTagNameMap {
    'workbench-screen': WorkbenchScreen
  }
}
