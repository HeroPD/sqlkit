// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import type { ColumnRef, ConnectionProfile, TableRef } from '../electron'
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

describe('WorkbenchScreen metadata refresh after writes', () => {
  const runningScreen = () => {
    const screen = new WorkbenchScreen()
    const workbench = screen as never as {
      _config: { connections: ConnectionProfile[] }
      _ctx: { switchInstance(profileId: string | null, childDb: string | null): void; newQuery(): void }
      _live: { statuses: unknown; phase(profileId: string): string | null; refresh: ReturnType<typeof vi.fn> }
      _queries: { execute: ReturnType<typeof vi.fn> }
      _runSql(sql: string): Promise<void>
    }
    workbench._config.connections = [profile]
    workbench._ctx.switchInstance(profile.id, 'db_a')
    workbench._ctx.newQuery()
    workbench._live.statuses = { p1: { profileId: 'p1', phase: 'connected', children: [{ name: 'db_a', inUse: true }] } }
    workbench._live.phase = vi.fn(() => 'connected')
    workbench._live.refresh = vi.fn()
    workbench._queries.execute = vi.fn(() => Promise.resolve())
    return workbench
  }

  it('refreshes schema metadata after a run that could change the schema', async () => {
    const workbench = runningScreen()
    await workbench._runSql('create table brand_new (id int)')
    expect(workbench._live.refresh).toHaveBeenCalledWith('p1')
  })

  it('does not refresh after a read-only run', async () => {
    const workbench = runningScreen()
    await workbench._runSql('select 1')
    expect(workbench._live.refresh).not.toHaveBeenCalled()
  })

  it('prompts for native placeholders and forwards bound values', async () => {
    const workbench = runningScreen() as ReturnType<typeof runningScreen> & {
      _parameterPrompt: { parameters: Array<{ label: string; position: number }> } | null
      _confirmParameterPrompt(event: Event): void
    }

    const running = workbench._runSql('select * from accounts where id = $1 and tenant_id = $2')
    await Promise.resolve()

    expect(workbench._parameterPrompt?.parameters).toEqual([
      { label: '$1', position: 0 }, { label: '$2', position: 1 },
    ])
    workbench._confirmParameterPrompt(new CustomEvent('parameters-confirm', { detail: { values: ['42', 'NULL'] } }))
    await running

    expect(workbench._queries.execute).toHaveBeenCalledWith(expect.objectContaining({ params: ['42', null] }))
  })

  it('drops a prompted run when another run started while its dialog was open', async () => {
    const workbench = runningScreen() as ReturnType<typeof runningScreen> & {
      _confirmParameterPrompt(event: Event): void
    }

    const prompted = workbench._runSql('select * from accounts where id = $1')
    await Promise.resolve()
    await workbench._runSql('select 1')

    workbench._confirmParameterPrompt(new CustomEvent('parameters-confirm', { detail: { values: ['7'] } }))
    await prompted

    expect(workbench._queries.execute).toHaveBeenCalledTimes(1)
    expect(workbench._queries.execute).toHaveBeenCalledWith(expect.objectContaining({ sql: 'select 1' }))
  })
})

describe('WorkbenchScreen CSV import', () => {
  const table: TableRef = { schema: 'public', name: 'users', kind: 'table' }
  const columns: ColumnRef[] = [
    { schema: 'public', table: 'users', name: 'id', dataType: 'integer', nullable: false, primaryKey: true, foreignKey: false },
    { schema: 'public', table: 'users', name: 'name', dataType: 'text', nullable: true, primaryKey: false, foreignKey: false },
  ]

  it('loads detailed metadata and marks identity/generated columns for the dialog', async () => {
    const inspectTable = vi.fn(() => Promise.resolve({
      success: true as const,
      inspection: {
        columns: [
          { name: 'id', dataType: 'integer', nullable: false, default: 'identity', primaryKey: true, comment: null, identity: 'always' as const },
          { name: 'name', dataType: 'text', nullable: true, default: null, primaryKey: false, comment: null, generated: true },
        ],
        sections: [],
      },
    }))
    ;(window as unknown as { sqlkit: unknown }).sqlkit = { inspectTable }
    const screen = new WorkbenchScreen()
    const workbench = screen as never as {
      _config: { connections: ConnectionProfile[] }
      _ctx: { switchInstance(profileId: string | null, childDb: string | null): void }
      _live: { columns: Record<string, ColumnRef[]> }
      _csvImport: { columns: Array<{ column: ColumnRef; generated: boolean; identity: string | null }> } | null
      _onTableImport(event: Event): Promise<void>
    }
    workbench._config.connections = [profile]
    workbench._ctx.switchInstance(profile.id, 'db_a')
    workbench._live.columns = { p1: columns }

    await workbench._onTableImport(new CustomEvent('table-import', { detail: { table } }))

    expect(inspectTable).toHaveBeenCalledWith('p1', 'db_a', table)
    expect(workbench._csvImport?.columns).toEqual([
      { column: columns[0], generated: false, identity: 'always' },
      { column: columns[1], generated: true, identity: null },
    ])
  })

  it('executes generated batches against the context captured when the dialog opened', async () => {
    const runBatch = vi.fn(() => Promise.resolve({ success: true as const }))
    ;(window as unknown as { sqlkit: unknown }).sqlkit = { runBatch }
    const workbench = new WorkbenchScreen() as never as {
      _runCsvImport(state: unknown, detail: unknown): Promise<string | null>
    }

    const error = await workbench._runCsvImport(
      { table, profileId: 'p1', childDb: 'analytics', engine: 'postgresql', columns },
      { columns, rows: [['1', 'Ada'], ['2', 'Bob']] },
    )

    expect(error).toBeNull()
    expect(runBatch).toHaveBeenCalledWith('p1', 'analytics', [expect.objectContaining({ expectedRows: 2 })])
  })

  it('keeps a failed import in the dialog with rollback context', async () => {
    const runBatch = vi.fn(() => Promise.resolve({ success: false as const, failedIndex: 0, error: 'duplicate key' }))
    ;(window as unknown as { sqlkit: unknown }).sqlkit = { runBatch }
    const workbench = new WorkbenchScreen() as never as {
      _runCsvImport(state: unknown, detail: unknown): Promise<string | null>
    }

    const error = await workbench._runCsvImport(
      { table, profileId: 'p1', childDb: null, engine: 'postgresql', columns },
      { columns, rows: [['1', 'Ada']] },
    )

    expect(error).toContain('duplicate key')
    expect(error).toContain('rolled back')
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
      _ctx: { activeTabId: string | null; switchInstance(profileId: string | null, childDb: string | null): void; newQuery(): void }
      renderRoot: { querySelector(selector: string): unknown }
      _captureTabScroll(tabId: string): void
      _restoreTabScroll(tabId: string): Promise<void>
    }
    // A real open tab: capture skips ids that no longer exist.
    workbench._ctx.switchInstance('p1', null)
    workbench._ctx.newQuery()
    const tabId = workbench._ctx.activeTabId!
    workbench.renderRoot = {
      querySelector: (selector) => selector === 'table-inspect' ? inspectHost : selector === 'results-panel' ? resultsHost : null,
    }

    workbench._captureTabScroll(tabId)
    inspectScroll.scrollTop = 0
    resultsScroll.scrollTop = 0
    resultsScroll.scrollLeft = 0
    await workbench._restoreTabScroll(tabId)

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

    expect(runSql).toHaveBeenCalledWith('select id from accounts', { columnIndex: 0, direction: 'asc' }, undefined, null, undefined, undefined)
    expect(workbench._dialogs.confirm).toBeNull()
  })

  // A followed result belongs to another table than its tab. A re-run that
  // dropped run.table would fall back to the tab's, retargeting grid writes.
  it('carries the run table through a sort re-run', () => {
    const screen = new WorkbenchScreen()
    const runSql = vi.fn()
    const table: TableRef = { schema: 'public', name: 'authors', kind: 'table' }
    const workbench = screen as never as {
      _ctx: { activeTabId: string | null }
      _queries: { runFor(tabId: string | null): unknown }
      _runSql: typeof runSql
      _onSortColumn(event: Event): void
    }
    workbench._ctx.activeTabId = 'tab-a'
    workbench._queries.runFor = () => ({
      phase: 'done',
      sql: 'select id from authors where id = $1',
      params: [7],
      table,
      result: { columns: ['id'], rows: [[7]], rowCount: 1, durationMs: 1 },
    })
    workbench._runSql = runSql

    workbench._onSortColumn(new CustomEvent('sort-column', { detail: { columnIndex: 0, direction: 'asc' } }))

    expect(runSql).toHaveBeenCalledWith(
      'select id from authors where id = $1',
      { columnIndex: 0, direction: 'asc' },
      [7],
      null,
      undefined,
      { table },
    )
  })

  it('re-runs the base SQL with a condition while preserving sort and params', () => {
    const screen = new WorkbenchScreen()
    const runSql = vi.fn()
    const workbench = screen as never as {
      _ctx: { activeTabId: string | null }
      _queries: {
        runFor(tabId: string | null): unknown
        sortFor(tabId: string | null): { columnIndex: number; direction: 'asc' | 'desc' } | null
      }
      _runSql: typeof runSql
      _onFilterCondition(event: Event): void
    }
    workbench._ctx.activeTabId = 'tab-a'
    workbench._queries.runFor = () => ({
      phase: 'done',
      sql: 'select id from accounts',
      params: ['bound'],
      result: { columns: ['id'], rows: [[1]], rowCount: 1, durationMs: 1 },
    })
    workbench._queries.sortFor = () => ({ columnIndex: 0, direction: 'desc' })
    workbench._runSql = runSql

    workbench._onFilterCondition(new CustomEvent('filter-condition', { detail: { condition: 'id > 10' } }))

    expect(runSql).toHaveBeenCalledWith(
      'select id from accounts',
      { columnIndex: 0, direction: 'desc' },
      ['bound'],
      'id > 10',
      undefined,
      undefined,
    )
  })
})

describe('WorkbenchScreen leaving a result with staged work', () => {
  type Guard = {
    _ctx: { activeTabId: string | null }
    _queries: {
      hasStaged(tabId: string | null): boolean
      discardStaged(tabId: string): void
      canGoBack(tabId: string | null): boolean
      canGoForward(tabId: string | null): boolean
      goBack(tabId: string | null): boolean
    }
    _dialogs: { confirm: { action(): void } | null }
    _guardStagedLeave(tabId: string, leave: () => void): void
    _onResultNavigate(event: Event): void
  }

  it('leaves at once when nothing is staged', () => {
    const workbench = new WorkbenchScreen() as never as Guard
    const leave = vi.fn()
    workbench._queries.hasStaged = () => false

    workbench._guardStagedLeave('tab-a', leave)

    expect(leave).toHaveBeenCalledTimes(1)
    expect(workbench._dialogs.confirm).toBeNull()
  })

  // Confirming the prompt must discard for real: nothing on the navigation path
  // realigns staged state, and stale row-indexed edits would arm writes against
  // whatever result appears next.
  it('discards staged work when the user confirms, then leaves', () => {
    const workbench = new WorkbenchScreen() as never as Guard
    const leave = vi.fn()
    const discardStaged = vi.fn()
    workbench._queries.hasStaged = () => true
    workbench._queries.discardStaged = discardStaged

    workbench._guardStagedLeave('tab-a', leave)
    expect(leave).not.toHaveBeenCalled()
    expect(discardStaged).not.toHaveBeenCalled()

    workbench._dialogs.confirm!.action()
    expect(discardStaged).toHaveBeenCalledWith('tab-a')
    expect(leave).toHaveBeenCalledTimes(1)
  })

  it('does not offer a discard for a navigation that will not happen', () => {
    const workbench = new WorkbenchScreen() as never as Guard
    const goBack = vi.fn()
    workbench._ctx.activeTabId = 'tab-a'
    workbench._queries.hasStaged = () => true
    workbench._queries.canGoBack = () => false
    workbench._queries.goBack = goBack

    workbench._onResultNavigate(new CustomEvent('result-navigate', { detail: { direction: 'back' } }))

    expect(workbench._dialogs.confirm).toBeNull()
    expect(goBack).not.toHaveBeenCalled()
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

  it('switches the sidebar view on ⌘⇧<letter>, toggling, without hijacking menu chords', () => {
    const workbench = setup() as unknown as { _onGlobalKeydown(e: KeyboardEvent): void; _activeView: string | null }
    const press = (key: string) => {
      const event = keydown({ key, metaKey: true, shiftKey: true })
      workbench._onGlobalKeydown(event)
      return event
    }

    expect(press('D').defaultPrevented).toBe(true)
    expect(workbench._activeView).toBe('databases')
    expect(press('H').defaultPrevented).toBe(true)
    expect(workbench._activeView).toBe('history')
    // Pressing the active view's chord again collapses the sidebar.
    press('H')
    expect(workbench._activeView).toBeNull()

    // ⌘⇧S (menu Save As) and ⌘⇧R (force reload) are not claimed as view chords.
    expect(press('S').defaultPrevented).toBe(false)
    expect(press('R').defaultPrevented).toBe(false)
  })

  it('leaves Cmd/Ctrl+Enter to the focused SQL editor', () => {
    const workbench = setup()
    const ctrl = keydown({ key: 'Enter', ctrlKey: true })
    const meta = keydown({ key: 'Enter', metaKey: true })

    workbench._onGlobalKeydown(ctrl)
    workbench._onGlobalKeydown(meta)

    expect(ctrl.defaultPrevented).toBe(false)
    expect(meta.defaultPrevented).toBe(false)
    expect(workbench._refreshResults).not.toHaveBeenCalled()
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

describe('WorkbenchScreen per-tab scroll memory', () => {
  // The map is keyed by tab id and only cleared wholesale on workspace close,
  // so a closed tab's entry must be pruned — and must not come back via the
  // capture that the follow-on tab switch triggers.
  const setup = () => {
    const screen = new WorkbenchScreen()
    // _captureTabScroll reaches into renderRoot; an unmounted element has none.
    Object.defineProperty(screen, 'renderRoot', { value: { querySelector: () => null } })
    return screen as never as {
      _ctx: { switchInstance(profileId: string | null, childDb: string | null): void; newQuery(): void; activeTabId: string | null; closeTab(id: string): void }
      _tabScroll: Map<string, unknown>
      _captureTabScroll(tabId: string | null): void
    }
  }

  it('records scroll for a live tab', () => {
    const workbench = setup()
    workbench._ctx.switchInstance('p1', null)
    workbench._ctx.newQuery()
    const id = workbench._ctx.activeTabId!

    workbench._captureTabScroll(id)

    expect(workbench._tabScroll.has(id)).toBe(true)
  })

  it('forgets a tab\'s scroll when it closes, and does not re-record it', () => {
    const workbench = setup()
    workbench._ctx.switchInstance('p1', null)
    workbench._ctx.newQuery()
    const id = workbench._ctx.activeTabId!
    workbench._captureTabScroll(id)

    workbench._ctx.closeTab(id)
    expect(workbench._tabScroll.has(id)).toBe(false)

    // The switch-away that follows a close captures the outgoing tab id.
    workbench._captureTabScroll(id)
    expect(workbench._tabScroll.has(id)).toBe(false)
    expect(workbench._tabScroll.size).toBe(0)
  })
})

// _requestCloseTab (the ⌘W / ✕ path) cleaned up inspect state itself, so closes
// that bypass it — a removed connection, a deleted file, a cancelled config tab
// — used to leave the draft and the dirty dot behind.
describe('WorkbenchScreen inspect state follows any close path', () => {
  const setup = () => {
    const screen = new WorkbenchScreen()
    Object.defineProperty(screen, 'renderRoot', { value: { querySelector: () => null } })
    return screen as never as {
      _ctx: {
        switchInstance(profileId: string | null, childDb: string | null): void
        addTab(tab: unknown): void
        closeTab(id: string): void
        activeTabId: string | null
      }
      _inspectDirtyTabIds: Set<string>
      _onInspectDirty(event: Event): void
      _sweepOrphanTabState(): void
    }
  }

  const inspectTab = (id: string) => ({
    id,
    kind: 'inspect' as const,
    profileId: 'p1',
    table: { schema: 'public', name: 'users', kind: 'table' as const },
  })

  const markDirty = (workbench: ReturnType<typeof setup>, tabId: string) =>
    workbench._onInspectDirty(new CustomEvent('inspect-dirty', { detail: { tabId, dirty: true } }))

  it('clears the dirty flag when the tab closes without the confirm path', () => {
    const workbench = setup()
    workbench._ctx.switchInstance('p1', null)
    workbench._ctx.addTab(inspectTab('inspect:users'))
    markDirty(workbench, 'inspect:users')
    expect(workbench._inspectDirtyTabIds.has('inspect:users')).toBe(true)

    workbench._ctx.closeTab('inspect:users')

    expect(workbench._inspectDirtyTabIds.has('inspect:users')).toBe(false)
  })

  it('sweeps dirty flags of tabs removed in bulk', () => {
    const workbench = setup()
    workbench._ctx.switchInstance('p1', null)
    workbench._ctx.addTab(inspectTab('inspect:kept'))
    markDirty(workbench, 'inspect:kept')
    markDirty(workbench, 'inspect:vanished') // never a real tab, as a bulk drop leaves it

    workbench._sweepOrphanTabState()

    expect(workbench._inspectDirtyTabIds.has('inspect:kept')).toBe(true)
    expect(workbench._inspectDirtyTabIds.has('inspect:vanished')).toBe(false)
  })
})
