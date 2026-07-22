// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import type { ReactiveControllerHost } from 'lit'
import type { ConnectionProfile, FileInfo, TableRef } from '../electron'
import type { ConnectionsController } from './connections'
import type { PaletteMode } from '../components/command-palette'
import { CommandPaletteController } from './command-palette'

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
}

function setup(opts: Opts = {}) {
  const actions = {
    openFile: vi.fn(),
    openTable: vi.fn(),
    setActiveDb: vi.fn(),
    newQuery: vi.fn(),
    runActiveTab: vi.fn(),
    saveActiveTab: vi.fn(),
    formatActiveTab: vi.fn(),
    addDatabase: vi.fn(),
    refreshFiles: vi.fn(),
    toggleSidebar: vi.fn(),
    toggleResultsPanel: vi.fn(),
    closeWorkspace: vi.fn(),
  }
  const live = {
    phase: vi.fn(() => opts.phase ?? 'connected'),
    tables: opts.tables ?? {},
    statuses: opts.statuses ?? {},
    setActiveChild: vi.fn(),
    connect: vi.fn(() => Promise.resolve({ success: true })),
    disconnectAll: vi.fn(),
  }
  const ctrl = new CommandPaletteController(host(), {
    live: live as unknown as ConnectionsController,
    commands: [
      { id: 'new-query', label: 'New Query' },
      { id: 'toggle-sidebar', label: 'Toggle Sidebar' },
    ],
    files: () => opts.files ?? [],
    connections: () => opts.connections ?? [],
    activeProfile: () => opts.activeProfile ?? null,
    activeDbId: () => null,
    activeChildDb: () => null,
    ...actions,
  })
  return { ctrl, actions, live }
}

const pick = (mode: PaletteMode, id: string) => new CustomEvent('palette-pick', { detail: { mode, id } })

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
  it('lists the commands in commands mode', () => {
    const { ctrl } = setup()
    ctrl.open('commands')
    expect(ctrl.entries().map((e) => e.id)).toEqual(['new-query', 'toggle-sidebar'])
    expect(ctrl.entries().every((entry) => entry.icon === undefined)).toBe(true)
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
    const profile = { id: 'p1', name: 'Local', engine: 'postgresql', databaseMode: 'single' } as ConnectionProfile
    const { ctrl } = setup({ connections: [profile], statuses: { p1: { phase: 'connected', children: [] } } })
    ctrl.open('databases')
    expect(ctrl.entries().map((e) => e.id)).toEqual(['db:p1'])
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
})
