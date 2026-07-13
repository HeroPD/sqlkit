// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import type { ConnectionProfile } from '../electron'
import { WorkbenchScreen } from './workbench-screen'

const profile: ConnectionProfile = {
  id: 'p1',
  name: 'Postgres',
  engine: 'postgresql',
  host: '',
  port: '',
  username: '',
  password: '',
  database: 'db_a',
  databaseMode: 'all',
  file: '',
  folder: '',
}

describe('WorkbenchScreen query orchestration', () => {
  it('deduplicates run requests while child database alignment is pending', async () => {
    const screen = new WorkbenchScreen()
    const workbench = screen as never as {
      _config: { connections: ConnectionProfile[] }
      _ctx: { switchInstance(profileId: string | null, childDb: string | null): void; newQuery(): void; activeTabId: string | null; tabs: Array<{ id: string; kind: string; content: string; savedContent: string }> }
      _live: { statuses: unknown; phase(profileId: string): string | null; setActiveChild: (profileId: string, database: string) => Promise<{ success: boolean }> }
      _queries: { execute: ReturnType<typeof vi.fn> }
      _runSql(sql: string): Promise<void>
    }
    let releaseAlign!: () => void
    const align = new Promise<{ success: boolean }>((resolve) => (releaseAlign = () => resolve({ success: true })))
    workbench._config.connections = [profile]
    workbench._ctx.switchInstance(profile.id, 'db_a')
    workbench._ctx.newQuery()
    workbench._ctx.tabs = workbench._ctx.tabs.map((tab) =>
      tab.id === workbench._ctx.activeTabId && tab.kind === 'sql' ? { ...tab, content: 'select 1', savedContent: 'select 1' } : tab,
    )
    workbench._live.statuses = {
      p1: { profileId: 'p1', phase: 'connected', children: [{ name: 'db_a', inUse: false }, { name: 'db_b', inUse: true }] },
    }
    workbench._live.phase = vi.fn(() => 'connected')
    workbench._live.setActiveChild = vi.fn(() => align)
    workbench._queries.execute = vi.fn(() => Promise.resolve())

    const first = workbench._runSql('select 1')
    const second = workbench._runSql('select 1')
    await Promise.resolve()

    expect(workbench._live.setActiveChild).toHaveBeenCalledTimes(1)
    expect(workbench._queries.execute).not.toHaveBeenCalled()

    releaseAlign()
    await Promise.all([first, second])
    expect(workbench._queries.execute).toHaveBeenCalledTimes(1)
  })
})

describe('WorkbenchScreen tab scroll state', () => {
  it('restores inspect and result scroll offsets for each tab', async () => {
    const screen = new WorkbenchScreen()
    const inspectScroll = { scrollTop: 140 }
    const resultsScroll = { scrollTop: 260, scrollLeft: 90 }
    const inspectHost = { updateComplete: Promise.resolve(true), shadowRoot: { querySelector: () => inspectScroll } }
    const resultsHost = { updateComplete: Promise.resolve(true), shadowRoot: { querySelector: () => resultsScroll } }
    const workbench = screen as never as {
      _ctx: { activeTabId: string | null }
      renderRoot: { querySelector(selector: string): unknown }
      _captureTabScroll(tabId: string): void
      _restoreTabScroll(tabId: string): Promise<void>
    }
    workbench._ctx.activeTabId = 'tab-a'
    workbench.renderRoot = {
      querySelector: (selector) => selector === 'table-inspect' ? inspectHost : selector === 'results-panel' ? resultsHost : null,
    }

    workbench._captureTabScroll('tab-a')
    inspectScroll.scrollTop = 0
    resultsScroll.scrollTop = 0
    resultsScroll.scrollLeft = 0
    await workbench._restoreTabScroll('tab-a')

    expect(inspectScroll.scrollTop).toBe(140)
    expect(resultsScroll).toEqual({ scrollTop: 260, scrollLeft: 90 })
  })
})

describe('WorkbenchScreen result sorting', () => {
  it('re-runs immediately without opening a confirmation dialog', () => {
    const screen = new WorkbenchScreen()
    const runSql = vi.fn()
    const workbench = screen as never as {
      _ctx: { activeTabId: string | null }
      _queries: { runFor(tabId: string | null): unknown }
      _dialogs: { confirm: unknown }
      _runSql: typeof runSql
      _onSortColumn(event: Event): void
    }
    workbench._ctx.activeTabId = 'tab-a'
    workbench._queries.runFor = () => ({
      phase: 'done',
      sql: 'select id from accounts',
      result: { columns: ['id'], rows: [[1]], rowCount: 1, durationMs: 1 },
    })
    workbench._runSql = runSql

    workbench._onSortColumn(new CustomEvent('sort-column', { detail: { columnIndex: 0, direction: 'asc' } }))

    expect(runSql).toHaveBeenCalledWith('select id from accounts', { columnIndex: 0, direction: 'asc' })
    expect(workbench._dialogs.confirm).toBeNull()
  })
})

describe('WorkbenchScreen child alignment', () => {
  type Child = { name: string; inUse: boolean }
  const alignInternals = (screen: WorkbenchScreen) =>
    screen as never as {
      _live: { statuses: Record<string, { children: Child[] }>; setActiveChild: ReturnType<typeof vi.fn> }
      _setActiveDb: ReturnType<typeof vi.fn>
      _alignActiveChild(
        profileId: string,
        childDb: string | null,
        options?: { followMissing?: boolean },
      ): Promise<'aligned' | 'redirected' | 'unavailable'>
    }
  const setup = (children: Child[]) => {
    const workbench = alignInternals(new WorkbenchScreen())
    workbench._live.statuses = { p1: { profileId: 'p1', phase: 'connected', children } } as never
    workbench._live.setActiveChild = vi.fn(() => Promise.resolve({ success: true }))
    workbench._setActiveDb = vi.fn()
    return workbench
  }

  it('is a no-op without a target child or on single-database connections', async () => {
    const workbench = setup([{ name: 'db_a', inUse: true }])
    expect(await workbench._alignActiveChild('p1', null)).toBe('aligned')
    expect(await workbench._alignActiveChild('p1', 'db_a')).toBe('aligned')
    expect(workbench._live.setActiveChild).not.toHaveBeenCalled()
  })

  it('switches the driver when the target child exists but is not in use', async () => {
    const workbench = setup([{ name: 'db_a', inUse: false }, { name: 'db_b', inUse: true }])
    expect(await workbench._alignActiveChild('p1', 'db_a')).toBe('aligned')
    expect(workbench._live.setActiveChild).toHaveBeenCalledWith('p1', 'db_a')
  })

  it('reports unavailable when the driver refuses the switch', async () => {
    const workbench = setup([{ name: 'db_a', inUse: false }, { name: 'db_b', inUse: true }])
    workbench._live.setActiveChild = vi.fn(() => Promise.resolve({ success: false }))
    expect(await workbench._alignActiveChild('p1', 'db_a')).toBe('unavailable')
  })

  it('redirects to the in-use child when the target is gone and followMissing is set', async () => {
    const workbench = setup([{ name: 'db_b', inUse: true }, { name: 'db_c', inUse: false }])
    expect(await workbench._alignActiveChild('p1', 'db_dropped', { followMissing: true })).toBe('redirected')
    expect(workbench._setActiveDb).toHaveBeenCalledWith('p1', 'db_b')
    expect(workbench._live.setActiveChild).not.toHaveBeenCalled()
  })

  it('reports unavailable for a missing child without followMissing', async () => {
    const workbench = setup([{ name: 'db_b', inUse: true }, { name: 'db_c', inUse: false }])
    expect(await workbench._alignActiveChild('p1', 'db_dropped')).toBe('unavailable')
    expect(workbench._setActiveDb).not.toHaveBeenCalled()
  })
})

describe('WorkbenchScreen staged result changes', () => {
  it('routes app-menu Save to staged result changes before file save', () => {
    const screen = new WorkbenchScreen()
    screen.workspace = { name: 'Workspace', path: '/workspace' }
    const saveChanges = vi.fn()
    const saveActive = vi.fn()
    const workbench = screen as never as {
      _resultEditing: { hasPendingChanges(): boolean; saveChanges(): void }
      _fileOps: { saveActive(): void }
      _onMenuAction(action: 'save'): void
    }
    workbench._resultEditing = { hasPendingChanges: () => true, saveChanges }
    workbench._fileOps = { saveActive }

    workbench._onMenuAction('save')

    expect(saveChanges).toHaveBeenCalledOnce()
    expect(saveActive).not.toHaveBeenCalled()
  })

  it('confirms before closing a tab with staged result changes', () => {
    const screen = new WorkbenchScreen()
    const workbench = screen as never as {
      _ctx: { tabs: Array<{ id: string; kind: 'sql'; name: string; path: null; content: string; savedContent: string }> }
      _queries: { setEdit(tabId: string, row: number, col: number, value: string): void }
      _dialogs: { confirm: { message: string; confirmLabel: string } | null; acceptConfirm(): void }
      _requestCloseTab(id: string): void
    }
    workbench._ctx.tabs = [{ id: 't1', kind: 'sql', name: 'Query.sql', path: null, content: 'select 1', savedContent: 'select 1' }]
    workbench._queries.setEdit('t1', 0, 0, '2')

    workbench._requestCloseTab('t1')

    expect(workbench._ctx.tabs).toHaveLength(1)
    expect(workbench._dialogs.confirm?.message).toContain('Query.sql')
    expect(workbench._dialogs.confirm?.confirmLabel).toBe('Discard and Close')

    workbench._dialogs.acceptConfirm()
    expect(workbench._ctx.tabs).toHaveLength(0)
  })

  it('confirms before closing a workspace with staged result changes', () => {
    const screen = new WorkbenchScreen()
    const closed = vi.fn()
    screen.addEventListener('close-workspace', closed)
    const workbench = screen as never as {
      _queries: { setEdit(tabId: string, row: number, col: number, value: string): void }
      _dialogs: { confirm: { message: string; confirmLabel: string } | null; acceptConfirm(): void }
      _onCloseWorkspace(): void
    }
    workbench._queries.setEdit('t1', 0, 0, '2')

    workbench._onCloseWorkspace()

    expect(closed).not.toHaveBeenCalled()
    expect(workbench._dialogs.confirm?.message).toContain('Close workspace')
    expect(workbench._dialogs.confirm?.confirmLabel).toBe('Discard and Close')

    workbench._dialogs.acceptConfirm()
    expect(closed).toHaveBeenCalledOnce()
  })
})

describe('WorkbenchScreen result refresh shortcuts', () => {
  const setup = () => {
    const screen = new WorkbenchScreen()
    screen.workspace = { name: 'Workspace', path: '/workspace' }
    const workbench = screen as never as {
      _refreshResults: ReturnType<typeof vi.fn>
      _onGlobalKeydown(event: KeyboardEvent): void
    }
    workbench._refreshResults = vi.fn()
    return workbench
  }

  const keydown = (init: KeyboardEventInit) => new KeyboardEvent('keydown', { cancelable: true, ...init })

  it('refreshes results on F5', () => {
    const workbench = setup()
    const event = keydown({ key: 'F5' })

    workbench._onGlobalKeydown(event)

    expect(workbench._refreshResults).toHaveBeenCalledOnce()
    expect(event.defaultPrevented).toBe(true)
  })

  it('refreshes results on Ctrl/Cmd+R without hijacking force reload', () => {
    const workbench = setup()
    const ctrl = keydown({ key: 'r', ctrlKey: true })
    const meta = keydown({ key: 'R', metaKey: true })
    const forceReload = keydown({ key: 'r', ctrlKey: true, shiftKey: true })

    workbench._onGlobalKeydown(ctrl)
    workbench._onGlobalKeydown(meta)
    workbench._onGlobalKeydown(forceReload)

    expect(workbench._refreshResults).toHaveBeenCalledTimes(2)
    expect(ctrl.defaultPrevented).toBe(true)
    expect(meta.defaultPrevented).toBe(true)
    expect(forceReload.defaultPrevented).toBe(false)
  })
})

describe('WorkbenchScreen undo/redo shortcut', () => {
  const setup = (
    opts: { tabKind?: string; undoRet?: boolean; redoRet?: boolean; collapsed?: boolean; hasSqlTab?: boolean } = {},
  ) => {
    const screen = new WorkbenchScreen()
    screen.workspace = { name: 'Workspace', path: '/workspace' }
    const inspectUndo = vi.fn(() => opts.undoRet ?? true)
    const inspectRedo = vi.fn(() => opts.redoRet ?? true)
    const undoStaged = vi.fn(() => opts.undoRet ?? true)
    const redoStaged = vi.fn(() => opts.redoRet ?? true)
    const workbench = screen as never as {
      _ctx: { activeTabId: string | null; tabs: Array<{ id: string; kind: string }>; activeSqlTab: () => unknown }
      _layout: { panelCollapsed: boolean }
      _queries: { undoStaged: typeof undoStaged; redoStaged: typeof redoStaged }
      renderRoot: { querySelector: (sel: string) => unknown }
      _onGlobalKeydown(event: KeyboardEvent): void
    }
    workbench._ctx.activeTabId = 't1'
    workbench._ctx.tabs = [{ id: 't1', kind: opts.tabKind ?? 'inspect' }]
    workbench._ctx.activeSqlTab = () => (opts.hasSqlTab === false ? null : { id: 't1', kind: 'sql' })
    workbench._layout.panelCollapsed = opts.collapsed ?? false
    workbench._queries.undoStaged = undoStaged
    workbench._queries.redoStaged = redoStaged
    workbench.renderRoot = { querySelector: () => ({ undo: inspectUndo, redo: inspectRedo }) }
    return { workbench, inspectUndo, inspectRedo, undoStaged, redoStaged }
  }

  const keydown = (init: KeyboardEventInit, fromEditor = false) => {
    const event = new KeyboardEvent('keydown', { cancelable: true, ...init })
    if (fromEditor) Object.defineProperty(event, 'composedPath', { value: () => [document.createElement('sql-editor')] })
    return event
  }

  it('routes ⌘Z to inspect undo and ⌘⇧Z to redo on an Inspect tab', () => {
    const { workbench, inspectUndo, inspectRedo } = setup({ tabKind: 'inspect' })

    const z = keydown({ key: 'z', metaKey: true })
    workbench._onGlobalKeydown(z)
    expect(inspectUndo).toHaveBeenCalledOnce()
    expect(z.defaultPrevented).toBe(true)

    const shiftZ = keydown({ key: 'z', metaKey: true, shiftKey: true })
    workbench._onGlobalKeydown(shiftZ)
    expect(inspectRedo).toHaveBeenCalledOnce()
    expect(shiftZ.defaultPrevented).toBe(true)
  })

  it('leaves the event for native undo when inspect declines it (mid cell-edit)', () => {
    const { workbench, inspectUndo } = setup({ tabKind: 'inspect', undoRet: false, redoRet: false })
    const z = keydown({ key: 'z', metaKey: true })

    workbench._onGlobalKeydown(z)
    expect(inspectUndo).toHaveBeenCalledOnce()
    expect(z.defaultPrevented).toBe(false)
  })

  it('routes ⌘Z / ⌘⇧Z to the result grid on a SQL tab, from anywhere in the workbench', () => {
    const { workbench, undoStaged, redoStaged } = setup({ tabKind: 'sql' })

    const z = keydown({ key: 'z', metaKey: true })
    workbench._onGlobalKeydown(z)
    expect(undoStaged).toHaveBeenCalledWith('t1')
    expect(z.defaultPrevented).toBe(true)

    const shiftZ = keydown({ key: 'z', metaKey: true, shiftKey: true })
    workbench._onGlobalKeydown(shiftZ)
    expect(redoStaged).toHaveBeenCalledWith('t1')
    expect(shiftZ.defaultPrevented).toBe(true)
  })

  it('leaves ⌘Z alone when the keystroke came from the editor', () => {
    const { workbench, undoStaged } = setup({ tabKind: 'sql' })
    const z = keydown({ key: 'z', metaKey: true }, true)

    workbench._onGlobalKeydown(z)
    expect(undoStaged).not.toHaveBeenCalled()
    expect(z.defaultPrevented).toBe(false)
  })

  it('does not touch the result grid when the panel is collapsed', () => {
    const { workbench, undoStaged } = setup({ tabKind: 'sql', collapsed: true })
    const z = keydown({ key: 'z', metaKey: true })

    workbench._onGlobalKeydown(z)
    expect(undoStaged).not.toHaveBeenCalled()
    expect(z.defaultPrevented).toBe(false)
  })
})
