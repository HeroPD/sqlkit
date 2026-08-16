import type { ReactiveController, ReactiveControllerHost } from 'lit'
import type { ConnectionProfile, FileInfo, ThemeId } from '../electron'
import type { SelectionCommandId } from '../codemirror/selection-commands'
import type { ConnectionsController } from './connections'
import type { PaletteEntry, PaletteMode } from '../components/command-palette'
import { tableKey } from '../components/explorer-view'
import { t } from '../i18n'
import { connectionLabelColorValue } from '../connection-label-colors'

/** What a command's name is prefixed with, so `File: Save` reads and filters as
 * one string. Categories are not sections: the list stays flat. */
export type PaletteCategory =
  | 'file' | 'editor' | 'edit' | 'run' | 'results' | 'tabs' | 'connection' | 'transaction' | 'view' | 'theme'

/** A ⌘⇧P command as configured; the controller composes its displayed name. */
export type PaletteCommand = { id: string; category: PaletteCategory; label: string; keybind?: string }

const CATEGORY_LABELS: Record<PaletteCategory, string> = {
  file: t('palette.category.file'),
  editor: t('palette.category.editor'),
  edit: t('palette.category.edit'),
  run: t('palette.category.run'),
  results: t('palette.category.results'),
  tabs: t('palette.category.tabs'),
  connection: t('palette.category.connection'),
  transaction: t('palette.category.transaction'),
  view: t('palette.category.view'),
  theme: t('palette.category.theme'),
}

// How many of the last-run commands ⌘⇧P floats to the top before the rest.
const RECENT_LIMIT = 5
const RECENT_KEY = 'sqlkit-recent-commands'

// Commands that act on the SQL under the caret, so they are offered only with a
// SQL tab open. The `selection:` ones are checked by prefix alongside these.
const EDITOR_COMMANDS = new Set([
  'run-query', 'format-sql', 'find', 'save-file', 'save-file-as', 'close-tab',
])

// Commands that only mean something once the grid or a DDL draft holds an edit.
const PENDING_EDIT_COMMANDS = new Set([
  'save-result-changes', 'discard-result-changes', 'undo-change', 'redo-change',
])

// Commands that reach the server, so they wait for the context to be live.
const CONNECTED_COMMANDS = new Set(['refresh-schema', 'create-database'])

type Deps = {
  live: ConnectionsController
  commands: readonly PaletteCommand[]
  files: () => FileInfo[]
  connections: () => ConnectionProfile[]
  activeProfile: () => ConnectionProfile | null
  activeDbId: () => string | null
  activeChildDb: () => string | null
  queryRunning: () => boolean
  hasSqlTab: () => boolean
  /** Whether the grid or a DDL draft is holding an unsaved edit. */
  hasPendingEdits: () => boolean
  /** Whether a result has landed for the active tab. */
  hasResult: () => boolean
  /** The name of the connection holding an open transaction, or null. */
  openTransaction: () => string | null
  openFile: (file: FileInfo) => void
  openTable: (key: string) => void
  setActiveDb: (profileId: string, childDb?: string | null) => void
  newQuery: () => void
  runActiveTab: () => void
  saveActiveTab: () => void
  saveActiveTabAs: () => void
  closeActiveTab: () => void
  formatActiveTab: () => void
  runSelectionCommand: (id: SelectionCommandId) => void
  openFind: () => void
  stepTab: (delta: 1 | -1) => void
  endTransaction: (mode: 'commit' | 'rollback') => void
  showTransactionManager: () => void
  refreshResults: () => void
  saveResultChanges: () => void
  discardResultChanges: () => void
  addResultRow: () => void
  exportResults: () => void
  stepEdit: (direction: 'undo' | 'redo') => void
  editConnection: (profileId: string) => void
  refreshSchema: (profileId: string) => void
  createDatabase: (profileId: string) => void
  cancelQuery: () => void
  navigateResult: (direction: 'back' | 'forward') => void
  addDatabase: () => void
  connectProfile: (profileId: string) => void
  disconnectProfile: (profileId: string) => void
  showView: (view: string) => void
  refreshFiles: () => void
  toggleSidebar: () => void
  toggleResultsPanel: () => void
  switchWorkspace: () => void
  closeWorkspace: () => void
}

// Owns the ⌘⇧P / ⌘P / ⌘K palette: open/close state, the entry list per mode,
// and dispatch of a pick. Everything it acts on is injected via deps, so the
// workbench keeps its own methods private and the palette stays self-contained.
// `mode` isn't reactive on its own, so transitions call host.requestUpdate().
export class CommandPaletteController implements ReactiveController {
  mode: PaletteMode | null = null

  // All-mode profile connected via a ⌘K parent pick whose child hasn't been
  // chosen yet; dismissing the palette lands on its in-use database instead
  // of leaving the fresh connection without a context.
  private pendingAllConnect: string | null = null

  private host: ReactiveControllerHost
  private deps: Deps

  constructor(host: ReactiveControllerHost, deps: Deps) {
    this.host = host
    this.deps = deps
    host.addController(this)
  }

  // Drop a palette left open when the workbench unmounts.
  hostDisconnected() {
    this.mode = null
    this.pendingAllConnect = null
  }

  open(mode: PaletteMode) {
    // Leaving databases mode abandons the child pick like a close would.
    if (this.mode === 'databases' && mode !== 'databases') this.settlePendingConnect()
    this.mode = mode
    this.host.requestUpdate()
  }

  close() {
    this.mode = null
    this.settlePendingConnect()
    this.host.requestUpdate()
  }

  // Pressing a palette's own shortcut again closes it.
  toggle(mode: PaletteMode) {
    if (this.mode === mode) this.close()
    else this.open(mode)
  }

  entries(): PaletteEntry[] {
    if (this.mode === 'commands') {
      const available = this.deps.commands.flatMap(({ id, category, label, keybind }): PaletteEntry[] => {
        const detail = this.commandDetail(id)
        if (detail === null) return []
        const name = t('palette.command', { category: CATEGORY_LABELS[category], label })
        return [{ id, label: name, keybind, ...(detail ? { detail } : {}) }]
      })
      // Alphabetical by the composed name, so a category's commands sit
      // together without a header having to say so.
      available.sort((a, b) => a.label.localeCompare(b.label))
      const recent = this.recent
        .flatMap((id) => available.filter((entry) => entry.id === id))
        .slice(0, RECENT_LIMIT)
      if (!recent.length) return available
      // The only two labels ⌘⇧P shows; the component drops them the moment
      // something is typed, which is where a flat ranked list belongs.
      const rest = available.filter((entry) => !recent.includes(entry))
      return [
        { id: 'group:recent', label: t('palette.recentlyUsed'), header: true },
        ...recent,
        ...(rest.length ? [{ id: 'group:other', label: t('palette.otherCommands'), header: true }, ...rest] : []),
      ]
    }

    if (this.mode === 'quick') {
      const files = this.deps
        .files()
        .filter((file) => file.type === 'file')
        .map((file) => ({ id: `file:${file.relativePath}`, label: file.name, detail: file.relativePath, icon: 'icon-file-code' }))

      // Tables of the in-use context only — ⌘P must not mix databases;
      // switching context is ⌘K's job.
      const context = this.deps.activeProfile()
      const tables =
        context && this.deps.live.phase(context.id) === 'connected'
          ? (this.deps.live.tables[context.id] ?? []).map((table) => ({
              id: `table:${tableKey(context.id, table)}`,
              label: table.name,
              detail: table.schema ?? '',
              icon: 'icon-table',
            }))
          : []

      return [...files, ...tables]
    }

    if (this.mode === 'databases') {
      return this.deps.connections().flatMap((connection): PaletteEntry[] => {
        const phase = this.deps.live.phase(connection.id)
        const children = this.deps.live.statuses[connection.id]?.children ?? []

        // An all-databases connection with discovered children: the parent
        // stays visible as a group header (it isn't a single database, so it
        // can't be picked) and its children nest underneath as the pickable
        // contexts.
        if (children.length > 1) {
          return [
            {
              id: `hdr:${connection.id}`,
              label: connection.name,
              engine: connection.engine,
              flavor: connection.flavor,
              connection: true,
              accentColor: connectionLabelColorValue(connection.labelColor) ?? undefined,
              status: 'connected',
              statusLabel: t('palette.connected'),
              header: true,
              action: { id: 'disconnect', label: t('action.disconnectDatabase'), icon: 'icon-unplug' },
            },
            ...children.map((child) => ({
              id: `child:${connection.id}:${child.name}`,
              label: child.name,
              icon: 'icon-package',
              connection: true,
              accentColor: connectionLabelColorValue(connection.labelColor) ?? undefined,
              inUse: this.deps.activeDbId() === connection.id && this.deps.activeChildDb() === child.name,
              indent: true,
            })),
          ]
        }

        const label =
          phase === 'connected'
            ? t('palette.connected')
            : phase === 'connecting'
              ? t('palette.connecting')
              : phase === 'error'
                ? t('common.error')
                : t('palette.disconnected')
        return [
          {
            id: `db:${connection.id}`,
            label: connection.name,
            engine: connection.engine,
            flavor: connection.flavor,
            connection: true,
            accentColor: connectionLabelColorValue(connection.labelColor) ?? undefined,
            status: phase ?? 'disconnected',
            statusLabel: label,
            statusError: phase === 'error' ? this.deps.live.statuses[connection.id]?.error : undefined,
            inUse: this.deps.activeDbId() === connection.id,
            ...(phase === 'connected'
              ? { action: { id: 'disconnect', label: t('action.disconnectDatabase'), icon: 'icon-unplug' } }
              : {}),
          },
        ]
      })
    }

    return []
  }

  onPick = (event: Event) => {
    const { mode, id } = (event as CustomEvent<{ mode: PaletteMode; id: string }>).detail

    // An explicit pick supersedes the land-on-in-use fallback.
    this.pendingAllConnect = null

    if (mode === 'commands') {
      this.close()
      this.runCommand(id)
      return
    }
    if (mode === 'quick') {
      this.close()
      if (id.startsWith('file:')) {
        const relativePath = id.slice('file:'.length)
        const file = this.deps.files().find((entry) => entry.type === 'file' && entry.relativePath === relativePath)
        if (file) this.deps.openFile(file)
        return
      }
      // Reveal the picked table in the Explorer and open its browse tab — same
      // as double-clicking it in the sidebar.
      this.deps.openTable(id.slice('table:'.length))
      return
    }

    // databases mode: a child pick switches the active child database; a parent
    // pick is a whole single-db connection, or a not-yet-connected one that
    // keeps the palette open while it loads.
    if (id.startsWith('child:')) {
      const body = id.slice('child:'.length)
      const separator = body.indexOf(':')
      const profileId = body.slice(0, separator)
      const database = body.slice(separator + 1)
      this.close()
      this.deps.setActiveDb(profileId, database)
      void this.deps.live.setActiveChild(profileId, database)
      return
    }

    const profileId = id.slice('db:'.length)
    const profile = this.deps.connections().find((connection) => connection.id === profileId)
    if (!profile) {
      this.close()
      return
    }
    const phase = this.deps.live.phase(profileId)
    if (phase === 'connecting') return // already loading; stay open
    if (phase === 'connected') {
      // Single-db connection (connected all-mode ones render as children).
      this.close()
      this.deps.setActiveDb(profileId)
      return
    }
    void this.connect(profile)
  }

  onAction = (event: Event) => {
    const { mode, id, action } = (event as CustomEvent<{ mode: PaletteMode; id: string; action: string }>).detail
    if (mode !== 'databases' || action !== 'disconnect') return
    const separator = id.indexOf(':')
    const profileId = separator < 0 ? '' : id.slice(separator + 1)
    if (profileId && this.deps.live.phase(profileId) === 'connected') void this.deps.live.disconnect(profileId)
  }

  // Whether a command belongs in the list right now, and what it says on the
  // right: null hides it, '' shows it plain, anything else is its detail. Only
  // commands that would be a no-op or a wrong offer are hidden.
  private commandDetail(id: string): string | null {
    const active = this.deps.activeProfile()
    const phase = active ? this.deps.live.phase(active.id) : null
    if (id === 'connect-database') {
      return active && phase !== 'connected' && phase !== 'connecting' ? active.name : null
    }
    if (id === 'disconnect-database') return active && phase === 'connected' ? active.name : null
    if (id === 'cancel-query') return this.deps.queryRunning() ? '' : null
    if (id.startsWith('selection:')) return this.deps.hasSqlTab() ? '' : null
    // Nothing to write, discard or step back through until an edit is staged.
    if (PENDING_EDIT_COMMANDS.has(id)) return this.deps.hasPendingEdits() ? '' : null
    // Add Row and Export both need a landed result to act on.
    if (id === 'add-result-row' || id === 'export-results') return this.deps.hasResult() ? '' : null
    if (CONNECTED_COMMANDS.has(id)) return active && phase === 'connected' ? active.name : null
    if (id === 'edit-connection') return active ? active.name : null
    if (id === 'transaction-manager') return this.deps.openTransaction()
    // A transaction is only commitable while one is open, and naming it keeps
    // the row honest about which connection it would end.
    if (id === 'commit-transaction' || id === 'rollback-transaction') return this.deps.openTransaction()
    // Everything that edits or runs SQL needs a SQL tab under the caret.
    if (EDITOR_COMMANDS.has(id)) return this.deps.hasSqlTab() ? '' : null
    return ''
  }

  // Last-run command ids, most recent first. Persisted like the theme is: a
  // palette that forgets what you just did is the one you stop reaching for.
  private get recent(): string[] {
    try {
      const stored: unknown = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]')
      return Array.isArray(stored) ? stored.filter((id): id is string => typeof id === 'string') : []
    } catch {
      return []
    }
  }

  private remember(id: string) {
    const next = [id, ...this.recent.filter((seen) => seen !== id)].slice(0, RECENT_LIMIT)
    try {
      localStorage.setItem(RECENT_KEY, JSON.stringify(next))
    } catch {
      // A full or blocked store only costs the ordering, never the command.
    }
  }

  private withActiveProfile(run: (profileId: string) => void) {
    const active = this.deps.activeProfile()
    if (active) run(active.id)
  }

  private runCommand(id: string) {
    // Remembered before it runs: quick-open re-enters the palette, and closing
    // a workspace tears this controller down.
    this.remember(id)
    if (id.startsWith('selection:')) {
      this.deps.runSelectionCommand(id.slice('selection:'.length) as SelectionCommandId)
      return
    }
    if (id.startsWith('view:')) {
      this.deps.showView(id.slice('view:'.length))
      return
    }
    if (id.startsWith('theme:')) {
      void window.sqlkit.setTheme(id.slice('theme:'.length) as ThemeId)
      return
    }
    switch (id) {
      case 'new-query':
        this.deps.newQuery()
        break
      case 'new-window':
        void window.sqlkit.newWindow()
        break
      case 'run-query':
        this.deps.runActiveTab()
        break
      case 'save-file':
        this.deps.saveActiveTab()
        break
      case 'save-file-as':
        this.deps.saveActiveTabAs()
        break
      case 'close-tab':
        this.deps.closeActiveTab()
        break
      case 'format-sql':
        this.deps.formatActiveTab()
        break
      case 'refresh-results':
        this.deps.refreshResults()
        break
      case 'cancel-query':
        this.deps.cancelQuery()
        break
      case 'previous-result':
        this.deps.navigateResult('back')
        break
      case 'next-result':
        this.deps.navigateResult('forward')
        break
      case 'quick-open':
        this.open('quick')
        break
      case 'switch-database':
        this.open('databases')
        break
      case 'add-database':
        this.deps.addDatabase()
        break
      case 'connect-database': {
        const active = this.deps.activeProfile()
        if (active && this.deps.live.phase(active.id) !== 'connected' && this.deps.live.phase(active.id) !== 'connecting') {
          this.deps.connectProfile(active.id)
        }
        break
      }
      case 'disconnect-database': {
        const active = this.deps.activeProfile()
        if (active && this.deps.live.phase(active.id) === 'connected') this.deps.disconnectProfile(active.id)
        break
      }
      case 'disconnect-all':
        void this.deps.live.disconnectAll()
        break
      case 'refresh-files':
        this.deps.refreshFiles()
        break
      case 'toggle-sidebar':
        this.deps.toggleSidebar()
        break
      case 'toggle-results-panel':
        this.deps.toggleResultsPanel()
        break
      case 'find':
        this.deps.openFind()
        break
      case 'next-tab':
        this.deps.stepTab(1)
        break
      case 'previous-tab':
        this.deps.stepTab(-1)
        break
      case 'commit-transaction':
        this.deps.endTransaction('commit')
        break
      case 'rollback-transaction':
        this.deps.endTransaction('rollback')
        break
      case 'transaction-manager':
        this.deps.showTransactionManager()
        break
      case 'save-result-changes':
        this.deps.saveResultChanges()
        break
      case 'discard-result-changes':
        this.deps.discardResultChanges()
        break
      case 'add-result-row':
        this.deps.addResultRow()
        break
      case 'export-results':
        this.deps.exportResults()
        break
      case 'undo-change':
        this.deps.stepEdit('undo')
        break
      case 'redo-change':
        this.deps.stepEdit('redo')
        break
      case 'edit-connection':
        this.withActiveProfile((profileId) => this.deps.editConnection(profileId))
        break
      case 'refresh-schema':
        this.withActiveProfile((profileId) => this.deps.refreshSchema(profileId))
        break
      case 'create-database':
        this.withActiveProfile((profileId) => this.deps.createDatabase(profileId))
        break
      case 'reveal-workspace':
        void window.sqlkit.revealWorkspace()
        break
      case 'switch-workspace':
        this.deps.switchWorkspace()
        break
      case 'close-workspace':
        this.deps.closeWorkspace()
        break
    }
  }

  // ⌘K parent pick on a not-yet-connected connection: the palette stays open
  // showing the connecting spinner (status pushes drive it). Once live, an
  // all-databases connection expands into its children in place for the real
  // pick; a single-db connection becomes the context and the palette closes.
  private async connect(profile: ConnectionProfile) {
    const result = await this.deps.live.connect(profile)
    if (!result.success) return // the entry shows the error state
    if (profile.databaseMode === 'all') {
      // Children just appeared; keep picking. If the palette is already gone,
      // no pick is coming — land on the database the driver is using.
      if (this.mode === 'databases') this.pendingAllConnect = profile.id
      else this.activateInUse(profile.id)
      return
    }
    if (this.mode !== 'databases') return // closed meanwhile: treat as canceled
    this.deps.setActiveDb(profile.id)
    this.close()
  }

  private settlePendingConnect() {
    const profileId = this.pendingAllConnect
    this.pendingAllConnect = null
    if (profileId) this.activateInUse(profileId)
  }

  // Make the connection the context. A fresh all-mode connect sits on the
  // discovery database, so prefer the child the user last worked in (then the
  // configured one) and point the driver at it; the discovery child is only
  // the last resort.
  private activateInUse(profileId: string) {
    if (this.deps.live.phase(profileId) !== 'connected') return
    const profile = this.deps.connections().find((connection) => connection.id === profileId)
    const children = this.deps.live.statuses[profileId]?.children ?? []
    const known = (name: string | null | undefined) =>
      name && children.some((child) => child.name === name) ? name : null
    const inUse = children.find((child) => child.inUse)?.name ?? null
    const target = known(profile?.lastChildDb) ?? known(profile?.database.trim()) ?? inUse
    this.deps.setActiveDb(profileId, target ?? undefined)
    if (target && target !== inUse) void this.deps.live.setActiveChild(profileId, target)
  }
}
