// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import catalogueSource from '../components/workbench-screen.ts?raw'
import dispatchSource from './command-palette.ts?raw'
import type { ReactiveControllerHost } from 'lit'
import type { ConnectionProfile, FileInfo, TableRef } from '../electron'
import type { ConnectionsController } from './connections'
import type { PaletteMode } from '../components/command-palette'
import { CommandPaletteController, type PaletteCommand } from './command-palette'

const host = (): ReactiveControllerHost =>
  ({ addController() {}, removeController() {}, requestUpdate() {}, updateComplete: Promise.resolve(true) })

const file = (name: string, relativePath: string): FileInfo => ({
  type: 'file',
  name,
  relativePath,
  path: `/abs/${relativePath}`,
})

type Opts = {
  files?: FileInfo[]
  connections?: ConnectionProfile[]
  activeProfile?: ConnectionProfile | null
  tables?: Record<string, TableRef[]>
  statuses?: Record<string, unknown>
  phase?: string
  activeDbId?: string | null
  activeChildDb?: string | null
  queryRunning?: boolean
  hasSqlTab?: boolean
  hasPendingEdits?: boolean
  hasResult?: boolean
  openTransaction?: string | null
  commands?: PaletteCommand[]
}

// Several categories, deliberately not in alphabetical order, so a test can
// tell the controller's sort from the order it was handed.
const TEST_COMMANDS: PaletteCommand[] = [
  { id: 'toggle-sidebar', category: 'view', label: 'Toggle Sidebar' },
  { id: 'new-query', category: 'file', label: 'New Query' },
  { id: 'cancel-query', category: 'run', label: 'Cancel Running Query' },
  { id: 'connect-database', category: 'connection', label: 'Connect Database' },
  { id: 'disconnect-database', category: 'connection', label: 'Disconnect Database' },
  { id: 'view:explorer', category: 'view', label: 'Show Explorer' },
  { id: 'theme:light', category: 'theme', label: 'Light' },
]

function setup(opts: Opts = {}) {
  const actions = {
    openFile: vi.fn(),
    openTable: vi.fn(),
    setActiveDb: vi.fn(),
    newQuery: vi.fn(),
    runActiveTab: vi.fn(),
    saveActiveTab: vi.fn(),
    saveActiveTabAs: vi.fn(),
    closeActiveTab: vi.fn(),
    formatActiveTab: vi.fn(),
    runSelectionCommand: vi.fn(),
    openFind: vi.fn(),
    stepTab: vi.fn(),
    endTransaction: vi.fn(),
    showTransactionManager: vi.fn(),
    refreshResults: vi.fn(),
    saveResultChanges: vi.fn(),
    discardResultChanges: vi.fn(),
    addResultRow: vi.fn(),
    exportResults: vi.fn(),
    stepEdit: vi.fn(),
    editConnection: vi.fn(),
    refreshSchema: vi.fn(),
    createDatabase: vi.fn(),
    cancelQuery: vi.fn(),
    navigateResult: vi.fn(),
    addDatabase: vi.fn(),
    connectProfile: vi.fn(),
    disconnectProfile: vi.fn(),
    showView: vi.fn(),
    refreshFiles: vi.fn(),
    toggleSidebar: vi.fn(),
    toggleResultsPanel: vi.fn(),
    switchWorkspace: vi.fn(),
    closeWorkspace: vi.fn(),
  }
  const live = {
    phase: vi.fn(() => opts.phase ?? 'connected'),
    tables: opts.tables ?? {},
    statuses: opts.statuses ?? {},
    setActiveChild: vi.fn(),
    connect: vi.fn(() => Promise.resolve({ success: true })),
    disconnect: vi.fn(),
    disconnectAll: vi.fn(),
  }
  const ctrl = new CommandPaletteController(host(), {
    live: live as unknown as ConnectionsController,
    commands: opts.commands ?? TEST_COMMANDS,
    files: () => opts.files ?? [],
    connections: () => opts.connections ?? [],
    activeProfile: () => opts.activeProfile ?? null,
    activeDbId: () => opts.activeDbId ?? null,
    activeChildDb: () => opts.activeChildDb ?? null,
    queryRunning: () => opts.queryRunning ?? false,
    hasSqlTab: () => opts.hasSqlTab ?? true,
    hasPendingEdits: () => opts.hasPendingEdits ?? false,
    hasResult: () => opts.hasResult ?? false,
    openTransaction: () => opts.openTransaction ?? null,
    ...actions,
  })
  return { ctrl, actions, live }
}

const pick = (mode: PaletteMode, id: string) => new CustomEvent('palette-pick', { detail: { mode, id } })

// The recently-used order persists, so each case starts with none.
beforeEach(() => localStorage.clear())

// The catalogue lives in workbench-screen and the dispatch here, so only a scan
// pairs them: a command listed without a case renders as a row that does
// nothing. Prefixed ids (view:, theme:) are routed ahead of the switch and
// carry a colon, so this deliberately does not capture them.
describe('CommandPaletteController catalogue', () => {
  const listed = [...catalogueSource.matchAll(/\{ id: '([a-z-]+)', category:/g)].map((match) => match[1] ?? '')

  it('handles every plain command the workbench lists, exactly once', () => {
    const handled = new Set([...dispatchSource.matchAll(/case '([a-z-]+)':/g)].map((match) => match[1]))
    expect(listed.length).toBeGreaterThan(20)
    expect(listed.filter((id) => !handled.has(id))).toEqual([])
    expect(listed.filter((id, index) => listed.indexOf(id) !== index)).toEqual([])
  })
})

describe('CommandPaletteController open/close', () => {
  it('toggles the same mode shut and opens others', () => {
    const { ctrl } = setup()
    expect(ctrl.mode).toBeNull()
    ctrl.toggle('commands')
    expect(ctrl.mode).toBe('commands')
    ctrl.toggle('commands')
    expect(ctrl.mode).toBeNull()
    ctrl.open('quick')
    expect(ctrl.mode).toBe('quick')
    ctrl.close()
    expect(ctrl.mode).toBeNull()
  })
})

describe('CommandPaletteController entries', () => {
  it('names each command by its category and sorts the flat list', () => {
    const { ctrl } = setup()
    ctrl.open('commands')
    // no headers with nothing recently used, and no leftover section order
    expect(ctrl.entries().map((e) => e.label)).toEqual([
      'File: New Query', 'Theme: Light', 'View: Show Explorer', 'View: Toggle Sidebar',
    ])
    expect(ctrl.entries().some((entry) => entry.header)).toBe(false)
    expect(ctrl.entries().every((entry) => entry.icon === undefined)).toBe(true)
  })

  it('floats the last-run commands above the rest, once anything has run', () => {
    const { ctrl } = setup()
    ctrl.onPick(pick('commands', 'toggle-sidebar'))
    ctrl.onPick(pick('commands', 'view:explorer'))
    ctrl.open('commands')
    expect(ctrl.entries().map((e) => e.id)).toEqual([
      'group:recent', 'view:explorer', 'toggle-sidebar',
      'group:other', 'new-query', 'theme:light',
    ])
    // most recent first, and neither repeats below its own header
    expect(ctrl.entries().filter((entry) => entry.header).map((entry) => entry.label))
      .toEqual(['recently used', 'other commands'])
  })

  it('drops a recently used command that is no longer available', () => {
    const { ctrl } = setup({ queryRunning: true })
    ctrl.onPick(pick('commands', 'cancel-query'))
    expect(setup().ctrl.entries().map((entry) => entry.id)).not.toContain('group:recent')
  })

  it('offers cancel only while the active tab is running', () => {
    expect(setup().ctrl.entries().some((entry) => entry.id === 'cancel-query')).toBe(false)
    const { ctrl } = setup({ queryRunning: true })
    ctrl.open('commands')
    expect(ctrl.entries()).toContainEqual({ id: 'cancel-query', label: 'Run: Cancel Running Query', keybind: undefined })
  })

  it('offers the editor commands only with a SQL tab open', () => {
    const commands: PaletteCommand[] = [
      { id: 'format-sql', category: 'editor', label: 'Format SQL' },
      { id: 'selection:expand', category: 'editor', label: 'Expand Selection' },
      { id: 'toggle-sidebar', category: 'view', label: 'Toggle Sidebar' },
    ]
    const withTab = setup({ commands, hasSqlTab: true })
    withTab.ctrl.open('commands')
    expect(withTab.ctrl.entries()).toHaveLength(3)

    const without = setup({ commands, hasSqlTab: false })
    without.ctrl.open('commands')
    expect(without.ctrl.entries().map((entry) => entry.id)).toEqual(['toggle-sidebar'])
  })

  it('offers the result-edit commands only once something is staged', () => {
    const commands: PaletteCommand[] = [
      { id: 'save-result-changes', category: 'results', label: 'Save changes' },
      { id: 'discard-result-changes', category: 'results', label: 'Discard changes' },
      { id: 'undo-change', category: 'edit', label: 'Undo Change' },
      { id: 'add-result-row', category: 'results', label: 'Add new row' },
    ]
    const clean = setup({ commands, hasResult: true })
    clean.ctrl.open('commands')
    // a landed result can take a row; nothing is staged, so nothing to save
    expect(clean.ctrl.entries().map((entry) => entry.id)).toEqual(['add-result-row'])

    const staged = setup({ commands, hasResult: true, hasPendingEdits: true })
    staged.ctrl.open('commands')
    expect(staged.ctrl.entries()).toHaveLength(4)
  })

  it('offers the server-bound connection commands only while connected', () => {
    const commands: PaletteCommand[] = [
      { id: 'refresh-schema', category: 'connection', label: 'Refresh Schema' },
      { id: 'create-database', category: 'connection', label: 'Create Database…' },
      { id: 'edit-connection', category: 'connection', label: 'Edit Connection' },
    ]
    const profile = { id: 'p1', name: 'Local' } as ConnectionProfile
    const offline = setup({ commands, activeProfile: profile, phase: 'disconnected' })
    offline.ctrl.open('commands')
    // the profile can still be edited offline; the other two reach the server
    expect(offline.ctrl.entries().map((entry) => entry.id)).toEqual(['edit-connection'])

    const online = setup({ commands, activeProfile: profile, phase: 'connected' })
    online.ctrl.open('commands')
    expect(online.ctrl.entries().every((entry) => entry.detail === 'Local')).toBe(true)
    expect(online.ctrl.entries()).toHaveLength(3)
  })

  it('offers the transaction commands only while one is open, and names it', () => {
    const commands: PaletteCommand[] = [{ id: 'commit-transaction', category: 'transaction', label: 'Commit' }]
    expect(setup({ commands }).ctrl.entries()).toEqual([])

    const { ctrl } = setup({ commands, openTransaction: 'Production' })
    ctrl.open('commands')
    expect(ctrl.entries()).toEqual([
      { id: 'commit-transaction', label: 'Transaction: Commit', keybind: undefined, detail: 'Production' },
    ])
  })

  it('offers disconnect for the active connected profile', () => {
    const profile = { id: 'p1', name: 'Production' } as ConnectionProfile
    const { ctrl } = setup({ activeProfile: profile, connections: [profile], phase: 'connected' })
    ctrl.open('commands')

    expect(ctrl.entries()).toContainEqual({
      id: 'disconnect-database', label: 'Connection: Disconnect Database', keybind: undefined, detail: 'Production',
    })
    expect(ctrl.entries().some((entry) => entry.id === 'connect-database')).toBe(false)
  })

  it('offers connect for the active disconnected profile', () => {
    const profile = { id: 'p1', name: 'Local' } as ConnectionProfile
    const { ctrl } = setup({ activeProfile: profile, connections: [profile], phase: 'disconnected' })
    ctrl.open('commands')

    expect(ctrl.entries()).toContainEqual({
      id: 'connect-database', label: 'Connection: Connect Database', keybind: undefined, detail: 'Local',
    })
    expect(ctrl.entries().some((entry) => entry.id === 'disconnect-database')).toBe(false)
  })

  it('lists files and the in-use context tables in quick mode', () => {
    const profile = { id: 'p1', name: 'Local' } as ConnectionProfile
    const { ctrl } = setup({
      files: [file('a.sql', 'a.sql'), { type: 'folder', name: 'd', relativePath: 'd', path: '/abs/d' }],
      activeProfile: profile,
      tables: { p1: [{ name: 'users', schema: 'public' } as TableRef] },
    })
    ctrl.open('quick')
    // The directory is filtered out; the table key is profileId:schema:name.
    expect(ctrl.entries().map((e) => e.id)).toEqual(['file:a.sql', 'table:p1:public:users'])
  })

  it('lists connections in databases mode', () => {
    const profile = {
      id: 'p1',
      name: 'Local',
      engine: 'postgresql',
      databaseMode: 'single',
      labelColor: 'accent-01',
    } as ConnectionProfile
    const { ctrl } = setup({
      connections: [profile],
      statuses: { p1: { phase: 'connected', children: [] } },
      activeDbId: 'p1',
    })
    ctrl.open('databases')
    expect(ctrl.entries()).toEqual([
      expect.objectContaining({
        id: 'db:p1',
        engine: 'postgresql',
        connection: true,
        accentColor: '#b2054c',
        status: 'connected',
        statusLabel: 'Connected',
        inUse: true,
        action: { id: 'disconnect', label: 'Disconnect Database', icon: 'icon-unplug' },
      }),
    ])
  })

  it('marks the active child without mixing identity and status colors', () => {
    const profile = {
      id: 'p1',
      name: 'Cluster',
      engine: 'postgresql',
      databaseMode: 'all',
      labelColor: 'accent-10',
    } as ConnectionProfile
    const statuses = { p1: { phase: 'connected', children: [{ name: 'app' }, { name: 'analytics' }] } }
    const { ctrl } = setup({
      connections: [profile],
      statuses,
      activeDbId: 'p1',
      activeChildDb: 'analytics',
    })
    ctrl.open('databases')

    expect(ctrl.entries()).toEqual([
      expect.objectContaining({
        id: 'hdr:p1',
        accentColor: '#c45b18',
        status: 'connected',
        statusLabel: 'Connected',
        action: { id: 'disconnect', label: 'Disconnect Database', icon: 'icon-unplug' },
      }),
      expect.objectContaining({ id: 'child:p1:app', inUse: false }),
      expect.objectContaining({ id: 'child:p1:analytics', inUse: true }),
    ])
  })

  it('keeps connection errors searchable without placing the full error in the row', () => {
    const profile = { id: 'p1', name: 'Broken', engine: 'mysql', databaseMode: 'single' } as ConnectionProfile
    const statuses = { p1: { phase: 'error', error: 'Connection refused', children: [] } }
    const { ctrl } = setup({ connections: [profile], statuses, phase: 'error' })
    ctrl.open('databases')

    expect(ctrl.entries()[0]).toEqual(expect.objectContaining({
      status: 'error',
      statusLabel: 'Error',
      statusError: 'Connection refused',
    }))
  })
})

describe('CommandPaletteController pick dispatch', () => {
  it('runs a command and closes on a commands pick', () => {
    const { ctrl, actions } = setup()
    ctrl.open('commands')
    ctrl.onPick(pick('commands', 'new-query'))
    expect(actions.newQuery).toHaveBeenCalledOnce()
    expect(ctrl.mode).toBeNull()
  })

  it('quick-open command re-opens the palette in quick mode', () => {
    const { ctrl } = setup()
    ctrl.onPick(pick('commands', 'quick-open'))
    expect(ctrl.mode).toBe('quick')
  })

  it('routes the prefixed view, theme and selection commands by their suffix', () => {
    const setTheme = vi.fn(() => Promise.resolve())
    vi.stubGlobal('sqlkit', { ...window.sqlkit, setTheme })
    const { ctrl, actions } = setup()
    ctrl.onPick(pick('commands', 'view:tasks'))
    expect(actions.showView).toHaveBeenCalledWith('tasks')
    ctrl.onPick(pick('commands', 'theme:midnight-blue'))
    expect(setTheme).toHaveBeenCalledWith('midnight-blue')
    ctrl.onPick(pick('commands', 'selection:add-next-occurrence'))
    expect(actions.runSelectionCommand).toHaveBeenCalledWith('add-next-occurrence')
    vi.unstubAllGlobals()
  })

  it('dispatches the editor and result commands to their deps', () => {
    const { ctrl, actions } = setup()
    ctrl.onPick(pick('commands', 'save-file-as'))
    ctrl.onPick(pick('commands', 'close-tab'))
    ctrl.onPick(pick('commands', 'refresh-results'))
    ctrl.onPick(pick('commands', 'cancel-query'))
    ctrl.onPick(pick('commands', 'previous-result'))
    ctrl.onPick(pick('commands', 'next-result'))
    ctrl.onPick(pick('commands', 'switch-workspace'))
    ctrl.onPick(pick('commands', 'find'))
    ctrl.onPick(pick('commands', 'next-tab'))
    ctrl.onPick(pick('commands', 'previous-tab'))
    ctrl.onPick(pick('commands', 'commit-transaction'))
    ctrl.onPick(pick('commands', 'rollback-transaction'))
    expect(actions.saveActiveTabAs).toHaveBeenCalledOnce()
    expect(actions.closeActiveTab).toHaveBeenCalledOnce()
    expect(actions.refreshResults).toHaveBeenCalledOnce()
    expect(actions.cancelQuery).toHaveBeenCalledOnce()
    expect(actions.navigateResult).toHaveBeenNthCalledWith(1, 'back')
    expect(actions.navigateResult).toHaveBeenNthCalledWith(2, 'forward')
    expect(actions.switchWorkspace).toHaveBeenCalledOnce()
    expect(actions.openFind).toHaveBeenCalledOnce()
    expect(actions.stepTab).toHaveBeenNthCalledWith(1, 1)
    expect(actions.stepTab).toHaveBeenNthCalledWith(2, -1)
    expect(actions.endTransaction).toHaveBeenNthCalledWith(1, 'commit')
    expect(actions.endTransaction).toHaveBeenNthCalledWith(2, 'rollback')
  })

  it('dispatches the result-edit and connection commands to their deps', () => {
    const profile = { id: 'p1', name: 'Local' } as ConnectionProfile
    const { ctrl, actions } = setup({ activeProfile: profile })
    for (const id of [
      'save-result-changes', 'discard-result-changes', 'add-result-row', 'export-results',
      'undo-change', 'redo-change', 'transaction-manager',
      'edit-connection', 'refresh-schema', 'create-database',
    ]) ctrl.onPick(pick('commands', id))

    expect(actions.saveResultChanges).toHaveBeenCalledOnce()
    expect(actions.discardResultChanges).toHaveBeenCalledOnce()
    expect(actions.addResultRow).toHaveBeenCalledOnce()
    expect(actions.exportResults).toHaveBeenCalledOnce()
    expect(actions.stepEdit).toHaveBeenNthCalledWith(1, 'undo')
    expect(actions.stepEdit).toHaveBeenNthCalledWith(2, 'redo')
    expect(actions.showTransactionManager).toHaveBeenCalledOnce()
    // the three profile-scoped ones all target the in-use connection
    expect(actions.editConnection).toHaveBeenCalledWith('p1')
    expect(actions.refreshSchema).toHaveBeenCalledWith('p1')
    expect(actions.createDatabase).toHaveBeenCalledWith('p1')
  })

  it('runs no profile-scoped command without an active connection', () => {
    const { ctrl, actions } = setup({ activeProfile: null })
    ctrl.onPick(pick('commands', 'refresh-schema'))
    ctrl.onPick(pick('commands', 'create-database'))
    expect(actions.refreshSchema).not.toHaveBeenCalled()
    expect(actions.createDatabase).not.toHaveBeenCalled()
  })

  it('connects or disconnects the active profile directly', () => {
    const profile = { id: 'p1', name: 'Local', engine: 'postgresql' } as ConnectionProfile
    const disconnected = setup({ activeProfile: profile, connections: [profile], phase: 'disconnected' })
    disconnected.ctrl.onPick(pick('commands', 'connect-database'))
    expect(disconnected.actions.connectProfile).toHaveBeenCalledWith('p1')

    const connected = setup({ activeProfile: profile, connections: [profile], phase: 'connected' })
    connected.ctrl.onPick(pick('commands', 'disconnect-database'))
    expect(connected.actions.disconnectProfile).toHaveBeenCalledWith('p1')
  })

  it('opens the picked file', () => {
    const f = file('a.sql', 'a.sql')
    const { ctrl, actions } = setup({ files: [f] })
    ctrl.open('quick')
    ctrl.onPick(pick('quick', 'file:a.sql'))
    expect(actions.openFile).toHaveBeenCalledWith(f)
    expect(ctrl.mode).toBeNull()
  })

  it('opens the picked table by key', () => {
    const { ctrl, actions } = setup()
    ctrl.open('quick')
    ctrl.onPick(pick('quick', 'table:p1:public:users'))
    expect(actions.openTable).toHaveBeenCalledWith('p1:public:users')
  })

  it('switches the child database on a child pick', () => {
    const { ctrl, actions, live } = setup()
    ctrl.open('databases')
    ctrl.onPick(pick('databases', 'child:p1:analytics'))
    expect(actions.setActiveDb).toHaveBeenCalledWith('p1', 'analytics')
    expect(live.setActiveChild).toHaveBeenCalledWith('p1', 'analytics')
    expect(ctrl.mode).toBeNull()
  })

  it('disconnects a connected profile from a database-switcher row action', () => {
    const { ctrl, live } = setup({ phase: 'connected' })

    ctrl.onAction(new CustomEvent('palette-action', {
      detail: { mode: 'databases', id: 'hdr:p1', action: 'disconnect' },
    }))

    expect(live.disconnect).toHaveBeenCalledWith('p1')
  })

  it('ignores database row actions after the connection is no longer connected', () => {
    const { ctrl, live } = setup({ phase: 'disconnected' })

    ctrl.onAction(new CustomEvent('palette-action', {
      detail: { mode: 'databases', id: 'db:p1', action: 'disconnect' },
    }))

    expect(live.disconnect).not.toHaveBeenCalled()
  })

  it('activates a connected single-db connection', () => {
    const profile = { id: 'p1', name: 'Local' } as ConnectionProfile
    const { ctrl, actions } = setup({ connections: [profile], phase: 'connected' })
    ctrl.open('databases')
    ctrl.onPick(pick('databases', 'db:p1'))
    expect(actions.setActiveDb).toHaveBeenCalledWith('p1')
    expect(ctrl.mode).toBeNull()
  })

  it('connects a disconnected connection, then activates it', async () => {
    const profile = { id: 'p1', name: 'Local', databaseMode: 'single' } as ConnectionProfile
    const { ctrl, actions, live } = setup({ connections: [profile], phase: 'disconnected' })
    ctrl.open('databases')
    ctrl.onPick(pick('databases', 'db:p1'))
    await new Promise((resolve) => setTimeout(resolve)) // let the async connect settle

    expect(live.connect).toHaveBeenCalledWith(profile)
    expect(actions.setActiveDb).toHaveBeenCalledWith('p1')
    expect(ctrl.mode).toBeNull()
  })

  it('lands on the remembered child when the palette closes without a pick after an all-mode connect', async () => {
    const profile = { id: 'p1', name: 'Local', databaseMode: 'all', database: '', lastChildDb: 'appdb' } as ConnectionProfile
    const statuses = { p1: { phase: 'connected', children: [{ name: 'postgres', inUse: true }, { name: 'appdb' }] } }
    const { ctrl, actions, live } = setup({ connections: [profile], phase: 'disconnected', statuses })
    ctrl.open('databases')
    ctrl.onPick(pick('databases', 'db:p1'))
    await new Promise((resolve) => setTimeout(resolve))
    expect(actions.setActiveDb).not.toHaveBeenCalled() // children listed; still picking

    live.phase.mockReturnValue('connected')
    ctrl.close()
    expect(actions.setActiveDb).toHaveBeenCalledWith('p1', 'appdb')
    expect(live.setActiveChild).toHaveBeenCalledWith('p1', 'appdb') // driver follows off the discovery db
  })

  it('falls back to the discovery child when nothing is remembered', async () => {
    const profile = { id: 'p1', name: 'Local', databaseMode: 'all', database: '' } as ConnectionProfile
    const statuses = { p1: { phase: 'connected', children: [{ name: 'postgres', inUse: true }] } }
    const { ctrl, actions, live } = setup({ connections: [profile], phase: 'disconnected', statuses })
    ctrl.open('databases')
    ctrl.onPick(pick('databases', 'db:p1'))
    ctrl.close() // dismissed before the connect resolved
    live.phase.mockReturnValue('connected')
    await new Promise((resolve) => setTimeout(resolve))

    expect(actions.setActiveDb).toHaveBeenCalledWith('p1', 'postgres')
    expect(live.setActiveChild).not.toHaveBeenCalled() // driver is already there
  })

  it('does not auto-land when a child was picked explicitly', async () => {
    const profile = { id: 'p1', name: 'Local', databaseMode: 'all' } as ConnectionProfile
    const statuses = { p1: { phase: 'connected', children: [{ name: 'postgres', inUse: true }, { name: 'appdb' }] } }
    const { ctrl, actions, live } = setup({ connections: [profile], phase: 'disconnected', statuses })
    ctrl.open('databases')
    ctrl.onPick(pick('databases', 'db:p1'))
    await new Promise((resolve) => setTimeout(resolve))

    live.phase.mockReturnValue('connected')
    ctrl.onPick(pick('databases', 'child:p1:appdb'))
    expect(actions.setActiveDb).toHaveBeenCalledTimes(1)
    expect(actions.setActiveDb).toHaveBeenCalledWith('p1', 'appdb')
  })
})
