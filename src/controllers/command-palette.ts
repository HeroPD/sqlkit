import type { ReactiveController, ReactiveControllerHost } from 'lit'
import type { ConnectionProfile, FileInfo } from '../electron'
import type { ConnectionsController } from './connections'
import type { PaletteEntry, PaletteMode } from '../components/command-palette'
import { tableKey } from '../components/explorer-view'
import { t } from '../i18n'
import { connectionLabelColorValue } from '../connection-label-colors'

type Deps = {
  live: ConnectionsController
  commands: readonly PaletteEntry[]
  files: () => FileInfo[]
  connections: () => ConnectionProfile[]
  activeProfile: () => ConnectionProfile | null
  activeDbId: () => string | null
  activeChildDb: () => string | null
  openFile: (file: FileInfo) => void
  openTable: (key: string) => void
  setActiveDb: (profileId: string, childDb?: string | null) => void
  newQuery: () => void
  runActiveTab: () => void
  saveActiveTab: () => void
  formatActiveTab: () => void
  addDatabase: () => void
  refreshFiles: () => void
  toggleSidebar: () => void
  toggleResultsPanel: () => void
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
    if (this.mode === 'commands') return [...this.deps.commands]

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

  private runCommand(id: string) {
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
      case 'format-sql':
        this.deps.formatActiveTab()
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
