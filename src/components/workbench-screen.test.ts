// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { render } from 'lit'
import type { ColumnRef, ConnectionProfile, QueryResponse, TableRef } from '../electron'
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

describe('WorkbenchScreen destructive preflight', () => {
  const runningScreen = () => {
    const screen = new WorkbenchScreen()
    const workbench = screen as never as {
      _config: { connections: ConnectionProfile[] }
      _ctx: { switchInstance(profileId: string | null, childDb: string | null): void; newQuery(): void }
      _live: { statuses: unknown; phase(profileId: string): string | null; refresh: ReturnType<typeof vi.fn> }
      _queries: { execute: ReturnType<typeof vi.fn> }
      _destructivePrompt: { sql: string; risks: string[]; script: boolean } | null
      _cancelDestructivePrompt(): void
      _runDestructive(): Promise<string | null>
      _runSql(
        sql: string,
        sort?: unknown,
        params?: unknown,
        filter?: unknown,
        baseLine?: unknown,
        trail?: unknown,
        preconfirmed?: boolean,
      ): Promise<void>
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

  it('holds an unqualified DELETE until the user confirms it', async () => {
    const workbench = runningScreen()

    const running = workbench._runSql('delete from users')
    expect(workbench._destructivePrompt?.risks).toEqual(['deleteAll'])
    expect(workbench._destructivePrompt?.sql).toBe('delete from users')
    expect(workbench._queries.execute).not.toHaveBeenCalled()

    await workbench._runDestructive()
    await running

    expect(workbench._destructivePrompt).toBeNull()
    expect(workbench._queries.execute).toHaveBeenCalledWith(expect.objectContaining({ sql: 'delete from users' }))
  })

  it('runs nothing when the preflight is cancelled', async () => {
    const workbench = runningScreen()

    const running = workbench._runSql('truncate table events')
    expect(workbench._destructivePrompt?.risks).toEqual(['truncate'])

    workbench._cancelDestructivePrompt()
    await running

    expect(workbench._destructivePrompt).toBeNull()
    expect(workbench._queries.execute).not.toHaveBeenCalled()
  })

  it('names every risk in a script, worst first', async () => {
    const workbench = runningScreen()

    const running = workbench._runSql('update t set a = 1;\ndrop table b;')
    expect(workbench._destructivePrompt?.risks).toEqual(['drop', 'updateAll'])
    expect(workbench._destructivePrompt?.script).toBe(true)

    workbench._cancelDestructivePrompt()
    await running
  })

  // A screen per run: the mocked execute never settles, so the one-run-per-tab
  // guard would swallow the second.
  it('lets scoped writes and reads through untouched', async () => {
    for (const sql of ['delete from users where id = 1', 'select * from users']) {
      const workbench = runningScreen()
      await workbench._runSql(sql)

      expect(workbench._destructivePrompt).toBeNull()
      expect(workbench._queries.execute).toHaveBeenCalledWith(expect.objectContaining({ sql }))
    }
  })

  // The Explorer's drop/truncate confirm themselves before handing the statement
  // over; a second dialog for the same click would train the user to click through.
  it('does not ask again for a statement the user already confirmed', async () => {
    const workbench = runningScreen()

    await workbench._runSql('DROP TABLE "public"."users";', undefined, undefined, undefined, undefined, undefined, true)

    expect(workbench._destructivePrompt).toBeNull()
    expect(workbench._queries.execute).toHaveBeenCalledTimes(1)
  })

  it('drops a stopped run when another run started while the dialog was open', async () => {
    const workbench = runningScreen()

    const stopped = workbench._runSql('delete from users')
    await workbench._runSql('select 1')

    await workbench._runDestructive()
    await stopped

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

describe('WorkbenchScreen row identity for the results panel', () => {
  const mount = (resultSets?: unknown[]) => {
    const screen = new WorkbenchScreen()
    const workbench = screen as never as {
      _ctx: { activeTabId: string | null; activeDbId: string | null }
      _queries: { runFor(tabId: string | null): unknown }
      _live: { columns: Record<string, unknown[]> }
      _resultEditing: { keyColumns(): readonly number[] }
      _resultKeyColumns(): readonly number[]
    }
    workbench._ctx.activeTabId = 'tab-a'
    workbench._ctx.activeDbId = 'db-a'
    workbench._live.columns = { 'db-a': [] }
    // One run object, as the controller holds it: the memo keys on its identity.
    const run = {
      phase: 'done',
      sql: 'select id, name from accounts',
      result: { columns: ['id', 'name'], rows: [[1, 'Ada']], rowCount: 1, durationMs: 1, ...(resultSets ? { resultSets } : {}) },
    }
    workbench._queries.runFor = () => run
    workbench._resultEditing = { keyColumns: () => [0] }
    return workbench
  }

  it('hands the panel the key columns the write path targets rows by', () => {
    const workbench = mount()
    expect(workbench._resultKeyColumns()).toEqual([0])
    // Memoised: the panel reads this every render, and a fresh array each time
    // would read as changed data.
    expect(workbench._resultKeyColumns()).toBe(workbench._resultKeyColumns())
  })

  it('offers nothing for a multi-set run, whose column sources are per set', () => {
    const workbench = mount([{ columns: ['id'], rows: [[1]], rowCount: 1 }, { columns: ['id', 'name'], rows: [[1, 'Ada']], rowCount: 1 }])
    expect(workbench._resultKeyColumns()).toEqual([])
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
    _guardStagedLeave(tabId: string, intent: 'result' | 'foreignKey', leave: () => void): void
    _onResultNavigate(event: Event): void
  }

  it('leaves at once when nothing is staged', () => {
    const workbench = new WorkbenchScreen() as never as Guard
    const leave = vi.fn()
    workbench._queries.hasStaged = () => false

    workbench._guardStagedLeave('tab-a', 'result', leave)

    expect(leave).toHaveBeenCalledTimes(1)
    expect(workbench._dialogs.confirm).toBeNull()
  })

  it('prompts for unstaged JSON editor text the staged check cannot see', () => {
    const workbench = new WorkbenchScreen() as never as Guard
    const leave = vi.fn()
    workbench._queries.hasStaged = () => false
    // A mounted results panel reporting text that lives only in the JSON editor
    // (invalid mid-edit, or a closed draft only Forward still offers).
    Object.defineProperty(workbench, 'renderRoot', {
      configurable: true,
      value: { querySelector: () => ({ hasUnstagedJson: () => true }) },
    })

    workbench._guardStagedLeave('tab-a', 'result', leave)
    expect(leave).not.toHaveBeenCalled()
    expect(workbench._dialogs.confirm).not.toBeNull()

    workbench._dialogs.confirm!.action()
    expect(leave).toHaveBeenCalledTimes(1)
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

    workbench._guardStagedLeave('tab-a', 'result', leave)
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

  // ⌘S and the app menu used to call the write controller straight past the
  // panel, so a save made from the record view or the JSON editor armed no
  // restore and always came back to the grid — the toolbar button was the only
  // way in that worked.
  it('saves staged result changes through the panel, not around it', () => {
    const screen = new WorkbenchScreen()
    screen.workspace = { name: 'Workspace', path: '/workspace' }
    const saveRows = vi.fn(() => true)
    const saveChanges = vi.fn()
    const saveActive = vi.fn()
    const workbench = screen as never as {
      _resultEditing: { hasPendingChanges(): boolean; saveChanges(): void }
      _fileOps: { saveActive(): void }
      renderRoot: { querySelector(selector: string): unknown }
      _saveActive(): void
    }
    workbench._resultEditing = { hasPendingChanges: () => true, saveChanges }
    workbench._fileOps = { saveActive }
    workbench.renderRoot = { querySelector: (selector) => (selector === 'results-panel' ? { saveRows } : null) }

    workbench._saveActive()

    expect(saveRows).toHaveBeenCalledOnce()
    expect(saveChanges).not.toHaveBeenCalled()
    expect(saveActive).not.toHaveBeenCalled()
  })

  // The panel decides, because only it can see a JSON document typed but not
  // yet flushed: nothing staged by that measure still means a save to make.
  it('saves the file only once the panel says it had nothing to save', () => {
    const screen = new WorkbenchScreen()
    screen.workspace = { name: 'Workspace', path: '/workspace' }
    const saveActive = vi.fn()
    const workbench = screen as never as {
      _resultEditing: { hasPendingChanges(): boolean; saveChanges(): void }
      _fileOps: { saveActive(): void }
      renderRoot: { querySelector(selector: string): unknown }
      _saveActive(): void
    }
    workbench._resultEditing = { hasPendingChanges: () => false, saveChanges: vi.fn() }
    workbench._fileOps = { saveActive }

    workbench.renderRoot = { querySelector: () => ({ saveRows: () => true }) }
    workbench._saveActive()
    expect(saveActive).not.toHaveBeenCalled()

    workbench.renderRoot = { querySelector: () => ({ saveRows: () => false }) }
    workbench._saveActive()
    expect(saveActive).toHaveBeenCalledOnce()
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

  it('names foreign-key navigation when staged changes block it', () => {
    const screen = new WorkbenchScreen()
    const leave = vi.fn()
    const workbench = screen as never as {
      _queries: { setEdit(tabId: string, row: number, col: number, value: string): void }
      _dialogs: { confirm: { message: string; detail: string; confirmLabel: string; danger?: boolean } | null }
      _guardStagedLeave(tabId: string, intent: 'result' | 'foreignKey', leave: () => void): void
    }
    workbench._queries.setEdit('t1', 0, 0, '2')

    workbench._guardStagedLeave('t1', 'foreignKey', leave)

    expect(leave).not.toHaveBeenCalled()
    expect(workbench._dialogs.confirm).toMatchObject({
      message: 'Discard changes and open the referenced row?',
      confirmLabel: 'Discard and open',
      danger: true,
    })
    expect(workbench._dialogs.confirm?.detail).toContain('Following this foreign key')
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

describe('WorkbenchScreen title-bar actions', () => {
  it('uses the active profile label color as a title-bar underline without changing the status dot', () => {
    const screen = new WorkbenchScreen()
    const workbench = screen as never as {
      _config: { connections: ConnectionProfile[] }
      _ctx: { switchInstance(profileId: string | null, childDb: string | null): void }
      _live: { phase: ReturnType<typeof vi.fn> }
      _renderTitlebar(): unknown
    }
    workbench._config.connections = [{ ...profile, labelColor: 'accent-04' }]
    workbench._ctx.switchInstance(profile.id, 'db_a')
    workbench._live.phase = vi.fn(() => 'connected')
    const host = document.createElement('div')

    render(workbench._renderTitlebar(), host)

    const target = host.querySelector<HTMLElement>('.database-target')
    expect(target?.style.getPropertyValue('--connection-label-color').trim()).toBe('#3f51b5')
    expect(target?.querySelector('.connection-dot.connected')).toBeTruthy()
    expect(host.querySelector<HTMLElement>('.database-target-wrap')?.dataset.tooltip).toBe('Postgres · db_a')
  })

  it('shows read-only state as a lock icon while retaining its accessible text', () => {
    const screen = new WorkbenchScreen()
    const workbench = screen as never as {
      _config: { connections: ConnectionProfile[] }
      _ctx: { switchInstance(profileId: string | null, childDb: string | null): void }
      _live: { statuses: unknown; phase: ReturnType<typeof vi.fn> }
      _renderTitlebar(): unknown
    }
    workbench._config.connections = [{ ...profile, readOnly: true }]
    workbench._ctx.switchInstance(profile.id, 'db_a')
    workbench._live.phase = vi.fn(() => 'connected')
    // The badge reports the live session's guardrail, not the saved profile.
    workbench._live.statuses = { [profile.id]: { profileId: profile.id, phase: 'connected', readOnly: true } }
    const host = document.createElement('div')

    render(workbench._renderTitlebar(), host)

    expect(host.querySelector('.target-readonly.icon-lock-keyhole')).toBeTruthy()
    expect(host.querySelector('.target-readonly')?.textContent).toBe('')
    expect(host.querySelector<HTMLElement>('.database-target-wrap')?.dataset.tooltip).toBe('Postgres · db_a · Read-only')
    expect(host.querySelector('.database-target')?.getAttribute('aria-label')).toContain('Postgres · db_a · Read-only')
  })

  it('keeps the badge on the session truth when a profile edit has not been reconnected yet', () => {
    const screen = new WorkbenchScreen()
    const workbench = screen as never as {
      _config: { connections: ConnectionProfile[] }
      _ctx: { switchInstance(profileId: string | null, childDb: string | null): void }
      _live: { statuses: unknown; phase: ReturnType<typeof vi.fn> }
      _renderTitlebar(): unknown
    }
    workbench._config.connections = [{ ...profile, readOnly: true }]
    workbench._ctx.switchInstance(profile.id, 'db_a')
    workbench._live.phase = vi.fn(() => 'connected')
    // Saved read-only, but the live session connected without it: no lock —
    // the tooltip carries the pending hint instead.
    workbench._live.statuses = { [profile.id]: { profileId: profile.id, phase: 'connected' } }
    const host = document.createElement('div')

    render(workbench._renderTitlebar(), host)

    expect(host.querySelector('.target-readonly')).toBeNull()
    expect(host.querySelector<HTMLElement>('.database-target-wrap')?.dataset.tooltip).toBe(
      'Postgres · db_a · Read-only change applies after reconnect',
    )

    // Disconnected: nothing is live, so the saved profile is the best truth.
    workbench._live.phase = vi.fn(() => null)
    workbench._live.statuses = {}
    render(workbench._renderTitlebar(), host)
    expect(host.querySelector('.target-readonly')).toBeTruthy()
  })

  it('shows the segmented transaction control while a manual transaction is open', () => {
    const screen = new WorkbenchScreen()
    const workbench = screen as never as {
      _config: { connections: ConnectionProfile[] }
      _ctx: { switchInstance(profileId: string | null, childDb: string | null): void }
      _live: { statuses: unknown; phase: ReturnType<typeof vi.fn>; endTransaction: ReturnType<typeof vi.fn> }
      _renderTitlebar(): unknown
    }
    workbench._config.connections = [profile]
    workbench._ctx.switchInstance(profile.id, 'db_a')
    workbench._live.phase = vi.fn(() => 'connected')
    workbench._live.statuses = { p1: { profileId: 'p1', phase: 'connected', transaction: { childDb: 'db_a' } } }
    workbench._live.endTransaction = vi.fn(() => Promise.resolve({ success: true }))
    const host = document.createElement('div')

    render(workbench._renderTitlebar(), host)

    const control = host.querySelector<HTMLElement>('.txn-control')
    expect(control?.textContent).toContain('Manual Tx')
    expect(control?.querySelector('.txn-count')?.textContent).toBe('0')
    expect(control?.classList.contains('failed')).toBe(false)
    expect(host.querySelector('.titlebar-right > .txn-control')).toBe(control)
    expect(host.querySelector('.titlebar-center > .database-target-wrap')).toBeTruthy()
    expect(host.querySelector('.titlebar-center > .query-action')).toBeTruthy()
    control?.querySelector<HTMLButtonElement>('.txn-commit')?.click()
    control?.querySelector<HTMLButtonElement>('.txn-rollback')?.click()
    expect(workbench._live.endTransaction).toHaveBeenNthCalledWith(1, 'p1', 'commit')
    expect(workbench._live.endTransaction).toHaveBeenNthCalledWith(2, 'p1', 'rollback')
  })

  it('marks a failed transaction, removes commit, and is absent without one', () => {
    const screen = new WorkbenchScreen()
    const workbench = screen as never as {
      _config: { connections: ConnectionProfile[] }
      _ctx: { switchInstance(profileId: string | null, childDb: string | null): void }
      _live: { statuses: unknown; phase: ReturnType<typeof vi.fn> }
      _renderTitlebar(): unknown
    }
    workbench._config.connections = [profile]
    workbench._ctx.switchInstance(profile.id, 'db_a')
    workbench._live.phase = vi.fn(() => 'connected')
    workbench._live.statuses = { p1: { profileId: 'p1', phase: 'connected', transaction: { childDb: 'db_a', failed: true } } }
    const host = document.createElement('div')
    render(workbench._renderTitlebar(), host)

    const control = host.querySelector<HTMLElement>('.txn-control')
    expect(control?.classList.contains('failed')).toBe(true)
    expect(control?.textContent).toContain('Failed Tx')
    expect(control?.textContent).toContain('Roll back')
    expect(control?.querySelector('.txn-commit')).toBeNull()

    workbench._live.statuses = { p1: { profileId: 'p1', phase: 'connected' } }
    render(workbench._renderTitlebar(), host)
    expect(host.querySelector('.txn-control')).toBeNull()
  })

  it('collapses a transaction to +1 when another profile is active', () => {
    const screen = new WorkbenchScreen()
    const workbench = screen as never as {
      _config: { connections: ConnectionProfile[] }
      _ctx: { switchInstance(profileId: string | null, childDb: string | null): void }
      _live: { statuses: unknown; phase: ReturnType<typeof vi.fn>; endTransaction: ReturnType<typeof vi.fn> }
      _transactionManagerOpen: boolean
      _expandedTransactionProfileIds: Set<string>
      _renderTitlebar(): unknown
    }
    const other: ConnectionProfile = { ...profile, id: 'p2', name: 'Other' }
    workbench._config.connections = [profile, other]
    // p2 is active, but p1 holds the open transaction. Showing the full
    // control would incorrectly imply that p2 owns it, so p1 lives under +1.
    workbench._ctx.switchInstance(other.id, 'db_a')
    workbench._live.phase = vi.fn(() => 'connected')
    workbench._live.statuses = {
      p1: { profileId: 'p1', phase: 'connected', transaction: { childDb: 'db_a' } },
      p2: { profileId: 'p2', phase: 'connected' },
    }
    workbench._live.endTransaction = vi.fn(() => Promise.resolve({ success: true }))
    workbench._transactionManagerOpen = true
    workbench._expandedTransactionProfileIds = new Set(['p1'])
    const host = document.createElement('div')
    render(workbench._renderTitlebar(), host)

    expect(host.querySelector('.txn-control')).toBeNull()
    expect(host.querySelector('.txn-overflow-trigger')?.textContent).toContain('+1')
    expect(host.querySelector('.txn-manager')?.textContent).toContain('Postgres')
    host.querySelector<HTMLButtonElement>('.txn-other .txn-rollback')?.click()
    expect(workbench._live.endTransaction).toHaveBeenCalledWith('p1', 'rollback')
  })

  it('keeps the active transaction instant and manages other transactions behind +N', () => {
    const screen = new WorkbenchScreen()
    const workbench = screen as never as {
      _config: { connections: ConnectionProfile[] }
      _ctx: { activeDbId: string | null; activeChildDb: string | null; switchInstance(profileId: string | null, childDb: string | null): void }
      _live: { statuses: unknown; phase: ReturnType<typeof vi.fn>; endTransaction: ReturnType<typeof vi.fn> }
      _transactionManagerOpen: boolean
      _expandedTransactionProfileIds: Set<string>
      _renderTitlebar(): unknown
    }
    const reporting: ConnectionProfile = { ...profile, id: 'p2', name: 'Reporting' }
    const billing: ConnectionProfile = { ...profile, id: 'p3', name: 'Billing' }
    workbench._config.connections = [profile, reporting, billing]
    workbench._ctx.switchInstance(profile.id, 'db_a')
    workbench._live.phase = vi.fn(() => 'connected')
    workbench._live.statuses = {
      p1: { profileId: 'p1', phase: 'connected', transaction: { childDb: 'db_a' } },
      p2: { profileId: 'p2', phase: 'connected', transaction: { childDb: 'analytics' } },
      p3: { profileId: 'p3', phase: 'connected', transaction: { childDb: 'billing', failed: true } },
    }
    workbench._live.endTransaction = vi.fn(() => Promise.resolve({ success: true }))
    window.sqlkit.saveWorkspaceConfig = vi.fn(() => Promise.resolve({ success: true as const }))
    workbench._transactionManagerOpen = true
    workbench._expandedTransactionProfileIds = new Set(['p2', 'p3'])
    const host = document.createElement('div')

    render(workbench._renderTitlebar(), host)

    expect(host.querySelector('.titlebar-right > .txn-control')?.textContent).toContain('Manual Tx')
    expect(host.querySelector('.txn-overflow-trigger')?.textContent).toContain('+2')
    expect(host.querySelector('.txn-manager')?.textContent).toContain('Reporting')
    expect(host.querySelector('.txn-manager')?.textContent).toContain('Billing')
    expect(host.querySelector('.txn-manager')?.textContent).toContain('Billing · Failed')
    expect(host.querySelector('.txn-manager')?.textContent).not.toContain('Postgres')
    const others = host.querySelectorAll<HTMLElement>('.txn-other')
    expect(others).toHaveLength(2)
    expect(others[0]?.querySelector('.txn-commit')).toBeTruthy()
    expect(others[0]?.querySelector('.txn-switch')?.textContent).toContain('Switch to')
    expect(others[1]?.classList.contains('failed')).toBe(true)
    expect(others[1]?.querySelector('.txn-other-copy strong')?.textContent).toBe('Billing · Failed')
    expect(others[1]?.querySelector('.txn-commit')).toBeNull()
    others[0]?.querySelector<HTMLButtonElement>('.txn-switch')?.click()
    expect(workbench._ctx.activeDbId).toBe('p2')
    expect(workbench._ctx.activeChildDb).toBe('analytics')
    expect(workbench._transactionManagerOpen).toBe(false)
    others[0]?.querySelector<HTMLButtonElement>('.txn-commit')?.click()
    others[1]?.querySelector<HTMLButtonElement>('.txn-rollback')?.click()
    expect(workbench._live.endTransaction).toHaveBeenNthCalledWith(1, 'p2', 'commit')
    expect(workbench._live.endTransaction).toHaveBeenNthCalledWith(2, 'p3', 'rollback')
  })

  it('refuses to move the UI to another child while a transaction is open', () => {
    const screen = new WorkbenchScreen()
    const workbench = screen as never as {
      _config: { connections: ConnectionProfile[] }
      _ctx: { switchInstance(profileId: string | null, childDb: string | null): void; newQuery(): void; activeTabId: string; activeChildDb: string | null }
      _live: { statuses: unknown; phase: ReturnType<typeof vi.fn> }
      _queries: { runFor(tabId: string): { phase: string; error?: string } }
      _setActiveDb(profileId: string, childDb?: string | null): void
    }
    workbench._config.connections = [profile]
    workbench._ctx.switchInstance(profile.id, 'db_a')
    workbench._ctx.newQuery()
    workbench._live.phase = vi.fn(() => 'connected')
    workbench._live.statuses = { p1: { profileId: 'p1', phase: 'connected', transaction: { childDb: 'db_a' } } }

    workbench._setActiveDb('p1', 'db_b')

    // The context stays on the transaction's database, with the refusal shown.
    expect(workbench._ctx.activeChildDb).toBe('db_a')
    const run = workbench._queries.runFor(workbench._ctx.activeTabId)
    expect(run.phase).toBe('error')
    expect(run.error).toContain('db_a')
  })

  it('shows the open transaction query session in a scrollable popover', () => {
    const screen = new WorkbenchScreen()
    const workbench = screen as never as {
      _config: { connections: ConnectionProfile[] }
      _ctx: { switchInstance(profileId: string | null, childDb: string | null): void }
      _live: { statuses: unknown; phase: ReturnType<typeof vi.fn> }
      _transactionPopoverProfileId: string | null
      _transactionSessions: Map<string, {
        childDb: string
        startedAt: string
        runs: Array<{ sql: string; tabName: string; success: boolean; durationMs: number; rowCount: number | null; error: string; createdAt: string }>
      }>
      _renderTitlebar(): unknown
    }
    workbench._config.connections = [profile]
    workbench._ctx.switchInstance(profile.id, 'db_a')
    workbench._live.phase = vi.fn(() => 'connected')
    workbench._live.statuses = { p1: { profileId: 'p1', phase: 'connected', transaction: { childDb: 'db_a' } } }
    workbench._transactionPopoverProfileId = 'p1'
    workbench._transactionSessions = new Map([['p1', {
      childDb: 'db_a',
      startedAt: '2026-08-08T12:00:00.000Z',
      runs: [
        { sql: 'BEGIN', tabName: 'customers.sql', success: true, durationMs: 2, rowCount: 0, error: '', createdAt: '2026-08-08T12:00:01.000Z' },
        { sql: 'UPDATE missing SET value = 1', tabName: 'scratch.sql', success: false, durationMs: 4, rowCount: null, error: 'relation missing', createdAt: '2026-08-08T12:00:02.000Z' },
      ],
    }]])
    const host = document.createElement('div')

    render(workbench._renderTitlebar(), host)

    expect(host.querySelector('.txn-status')?.getAttribute('aria-expanded')).toBe('true')
    expect(host.querySelector('.txn-count')?.textContent).toBe('2')
    expect(host.querySelectorAll('.txn-run')).toHaveLength(2)
    expect(host.querySelector('.txn-runs')).toBeTruthy()
    expect(host.querySelector('.txn-popover')?.textContent).toContain('customers.sql')
    expect(host.querySelector('.txn-popover')?.textContent).toContain('scratch.sql')
    expect(host.querySelector('.txn-popover')?.textContent).toContain('relation missing')
    expect(host.querySelector('.txn-outcome.error')).toBeTruthy()
  })

  it('records and clears the renderer-local transaction session', () => {
    const workbench = new WorkbenchScreen() as never as {
      _transactionSessions: Map<string, { runs: Array<{ success: boolean; tabName: string }> }>
      _updateTransactionSession(args: {
        profileId: string; childDb: string; sourceTabName: string; sql: string; response: QueryResponse
        runStartedAt: number; wasOpen: boolean; isOpen: boolean
      }): void
    }
    const success: QueryResponse = {
      success: true,
      result: { columns: [], rows: [], rowCount: 1, durationMs: 3 },
    }

    workbench._updateTransactionSession({
      profileId: 'p1', childDb: 'db_a', sourceTabName: 'customers.sql', sql: 'BEGIN', response: success,
      runStartedAt: Date.now(), wasOpen: false, isOpen: true,
    })

    expect(workbench._transactionSessions.get('p1')?.runs).toHaveLength(1)
    expect(workbench._transactionSessions.get('p1')?.runs[0]?.tabName).toBe('customers.sql')

    workbench._updateTransactionSession({
      profileId: 'p1', childDb: 'db_a', sourceTabName: 'customers.sql', sql: 'COMMIT', response: success,
      runStartedAt: Date.now(), wasOpen: true, isOpen: false,
    })
    expect(workbench._transactionSessions.has('p1')).toBe(false)
  })

  it('keeps session history when a nested SQL Server commit leaves the transaction open', async () => {
    const workbench = new WorkbenchScreen() as never as {
      _live: { endTransaction: ReturnType<typeof vi.fn> }
      _transactionSessions: Map<string, { runs: unknown[] }>
      _transactionPopoverProfileId: string | null
      _expandedTransactionProfileIds: Set<string>
      _endTransaction(profileId: string, mode: 'commit' | 'rollback'): Promise<void>
    }
    const session = { runs: [{ sql: 'BEGIN TRAN; BEGIN TRAN' }] }
    workbench._transactionSessions = new Map([['p1', session]])
    workbench._transactionPopoverProfileId = 'p1'
    workbench._expandedTransactionProfileIds = new Set(['p1'])
    workbench._live.endTransaction = vi.fn(() => Promise.resolve({
      success: true,
      transaction: { childDb: 'db_a' },
    }))

    await workbench._endTransaction('p1', 'commit')

    expect(workbench._transactionSessions.get('p1')).toBe(session)
    expect(workbench._transactionPopoverProfileId).toBe('p1')
    expect(workbench._expandedTransactionProfileIds.has('p1')).toBe(true)
  })

  it('refuses a run against another database while a transaction is open', async () => {
    const screen = new WorkbenchScreen()
    const workbench = screen as never as {
      _config: { connections: ConnectionProfile[] }
      _ctx: { switchInstance(profileId: string | null, childDb: string | null): void; newQuery(): void; activeTabId: string }
      _live: { statuses: unknown; phase: ReturnType<typeof vi.fn> }
      _queries: { execute: ReturnType<typeof vi.fn>; runFor(tabId: string): { phase: string; error?: string } }
      _runSql(sql: string): Promise<void>
    }
    workbench._config.connections = [profile]
    workbench._ctx.switchInstance(profile.id, 'db_a')
    workbench._ctx.newQuery()
    workbench._live.phase = vi.fn(() => 'connected')
    workbench._live.statuses = { p1: { profileId: 'p1', phase: 'connected', transaction: { childDb: 'db_b' } } }
    workbench._queries.execute = vi.fn(() => Promise.resolve())

    await workbench._runSql('select 1')

    expect(workbench._queries.execute).not.toHaveBeenCalled()
    const run = workbench._queries.runFor(workbench._ctx.activeTabId)
    expect(run.phase).toBe('error')
    expect(run.error).toContain('db_b')
  })

  it('opens the same database picker as Cmd/Ctrl+K', () => {
    const workbench = new WorkbenchScreen() as never as {
      _cmdPalette: { open: ReturnType<typeof vi.fn> }
      _openDatabasePicker(): void
    }
    workbench._cmdPalette.open = vi.fn()

    workbench._openDatabasePicker()

    expect(workbench._cmdPalette.open).toHaveBeenCalledWith('databases')
  })

  it('runs the editor target when idle and cancels the active run when busy', () => {
    const runExplicitQuery = vi.fn()
    const cancel = vi.fn()
    const workbench = new WorkbenchScreen() as never as {
      _ctx: { activeTabId: string | null }
      _queries: { runFor: ReturnType<typeof vi.fn> }
      _onCancelQuery: typeof cancel
      renderRoot: { querySelector: ReturnType<typeof vi.fn> }
      _onTitlebarAction(): void
    }
    workbench._ctx.activeTabId = 't1'
    workbench._queries.runFor = vi.fn(() => ({ phase: 'idle' }))
    workbench.renderRoot = { querySelector: vi.fn(() => ({ runExplicitQuery })) }
    workbench._onCancelQuery = cancel

    workbench._onTitlebarAction()
    expect(runExplicitQuery).toHaveBeenCalledOnce()

    workbench._queries.runFor = vi.fn(() => ({ phase: 'running' }))
    workbench._onTitlebarAction()
    expect(cancel).toHaveBeenCalledOnce()
    expect(runExplicitQuery).toHaveBeenCalledOnce()
  })

  it('refreshes the completed query when the results view owns the action', () => {
    const refresh = vi.fn()
    const workbench = new WorkbenchScreen() as never as {
      _ctx: { activeTabId: string | null }
      _queries: { runFor: ReturnType<typeof vi.fn> }
      _resultEditing: { hasPendingChanges: ReturnType<typeof vi.fn> }
      _activeActionSurface: 'results'
      _refreshResults: typeof refresh
      renderRoot: { querySelector: ReturnType<typeof vi.fn> }
      _onTitlebarAction(): void
    }
    workbench._ctx.activeTabId = 't1'
    workbench._queries.runFor = vi.fn(() => ({ phase: 'done', sql: 'select 1' }))
    workbench._resultEditing.hasPendingChanges = vi.fn(() => false)
    workbench._activeActionSurface = 'results'
    workbench._refreshResults = refresh
    workbench.renderRoot = { querySelector: vi.fn(() => ({ hasUnstagedJson: () => false })) }

    workbench._onTitlebarAction()

    expect(refresh).toHaveBeenCalledOnce()

    workbench._resultEditing.hasPendingChanges = vi.fn(() => true)
    workbench._onTitlebarAction()

    expect(refresh).toHaveBeenCalledOnce()
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

// Dropping the child database the user is *in* is the awkward case: its tabs are
// live rather than stashed, so the context has to be left before it is cleared.
describe('WorkbenchScreen drop of the active child database', () => {
  const setup = () => {
    // _setActiveDb persists the remembered child through this channel.
    ;(window as unknown as { sqlkit: unknown }).sqlkit = { saveWorkspaceConfig: vi.fn(() => Promise.resolve({ success: true })) }
    const screen = new WorkbenchScreen()
    Object.defineProperty(screen, 'renderRoot', { value: { querySelector: () => null } })
    const workbench = screen as never as {
      _config: { connections: ConnectionProfile[] }
      _live: { statuses: unknown }
      _ctx: {
        activeDbId: string | null
        activeChildDb: string | null
        tabs: unknown[]
        addTab(tab: unknown): void
        _instances: Map<string, { tabs: unknown[] }>
      }
      _inspectDirtyTabIds: Set<string>
      _tabScroll: Map<string, unknown>
      _onInspectDirty(event: Event): void
      _setActiveDb(profileId: string, childDb?: string | null): void
      _onDatabaseDropped(id: string, database: string): void
    }
    workbench._config.connections = [{ ...profile, databaseMode: 'all', database: 'db_a' }]
    workbench._live.statuses = {
      p1: { profileId: 'p1', phase: 'connected', children: [{ name: 'db_a', inUse: true }, { name: 'doomed', inUse: false }] },
    }
    return workbench
  }

  it('leaves no trace of the dropped child once it was the active context', () => {
    const workbench = setup()
    workbench._setActiveDb('p1', 'doomed')
    workbench._ctx.addTab({
      id: 'inspect:doomed',
      kind: 'inspect',
      profileId: 'p1',
      table: { schema: null, name: 'events', kind: 'table' },
    })
    workbench._onInspectDirty(new CustomEvent('x', { detail: { tabId: 'inspect:doomed', dirty: true } }))
    workbench._tabScroll.set('inspect:doomed', { inspectTop: 120 })
    expect(workbench._ctx.activeChildDb).toBe('doomed')

    workbench._onDatabaseDropped('p1', 'doomed')

    // Moved off the dropped child, and nothing of it stashed back.
    expect(workbench._ctx.activeChildDb).not.toBe('doomed')
    expect(workbench._ctx._instances.has('p1:doomed')).toBe(false)
    expect(workbench._inspectDirtyTabIds.has('inspect:doomed')).toBe(false)
    expect(workbench._tabScroll.has('inspect:doomed')).toBe(false)
  })

  it('does not hand a recreated same-named database the old tabs', () => {
    const workbench = setup()
    workbench._setActiveDb('p1', 'doomed')
    workbench._ctx.addTab({
      id: 'inspect:doomed',
      kind: 'inspect',
      profileId: 'p1',
      table: { schema: null, name: 'events', kind: 'table' },
    })

    workbench._onDatabaseDropped('p1', 'doomed')
    workbench._setActiveDb('p1', 'doomed') // same name created again

    expect(workbench._ctx.tabs).toEqual([])
  })
})

describe('WorkbenchScreen titlebar connection button', () => {
  type ConnectionInternals = {
    _config: { connections: ConnectionProfile[] }
    _live: {
      statuses: unknown
      phase(profileId: string): string | null
      transaction(profileId: string): { childDb: string } | undefined
      disconnect: ReturnType<typeof vi.fn>
      connect: ReturnType<typeof vi.fn>
    }
    _dialogs: { confirm: { detail: string; action: () => void } | null }
    _onTitlebarConnection(): void
  }

  const setup = (phase: string | null, transaction?: { childDb: string }) => {
    const screen = new WorkbenchScreen()
    const workbench = screen as never as ConnectionInternals
    workbench._config.connections = [profile]
    workbench._live.phase = () => phase
    workbench._live.transaction = () => transaction
    workbench._live.disconnect = vi.fn(() => Promise.resolve())
    workbench._live.connect = vi.fn(() => Promise.resolve({ success: false, error: 'nope' }))
    ;(screen as never as { _ctx: { switchInstance(a: string, b: string): void } })._ctx.switchInstance(profile.id, 'db_a')
    return workbench
  }

  it('disconnects straight away when no transaction is open', () => {
    const workbench = setup('connected')

    workbench._onTitlebarConnection()

    expect(workbench._live.disconnect).toHaveBeenCalledWith('p1')
    expect(workbench._dialogs.confirm).toBeNull()
  })

  it('names the transaction it would roll back before disconnecting', () => {
    const workbench = setup('connected', { childDb: 'db_a' })

    workbench._onTitlebarConnection()

    // Two pixels from Run: an open transaction must not die to one stray click.
    expect(workbench._live.disconnect).not.toHaveBeenCalled()
    expect(workbench._dialogs.confirm?.detail).toContain('db_a')

    workbench._dialogs.confirm!.action()
    expect(workbench._live.disconnect).toHaveBeenCalledWith('p1')
  })

  it('connects when the named database is not live', () => {
    const workbench = setup(null)

    workbench._onTitlebarConnection()

    expect(workbench._live.connect).toHaveBeenCalled()
    expect(workbench._live.disconnect).not.toHaveBeenCalled()
  })

  it('treats an errored connection as something to connect, not disconnect', () => {
    const workbench = setup('error')

    workbench._onTitlebarConnection()

    expect(workbench._live.connect).toHaveBeenCalled()
    expect(workbench._live.disconnect).not.toHaveBeenCalled()
  })
})

describe('WorkbenchScreen connect entrance', () => {
  const allDatabases: ConnectionProfile = { ...profile, databaseMode: 'all', database: 'app' }

  it('lands on the child it switched to, not the one the driver started on', async () => {
    const screen = new WorkbenchScreen()
    const workbench = screen as never as {
      _config: { connections: ConnectionProfile[] }
      _ctx: { switchInstance(a: string | null, b: string | null): void; activeChildDb: string | null }
      _live: { statuses: Record<string, unknown> }
      _connectProfile(id: string): Promise<void>
    }
    // The driver opens on db_a; the workspace restored db_b as the context.
    let inUse = 'db_a'
    const statuses = () => [
      { profileId: 'p1', phase: 'connected', children: [
        { name: 'db_a', inUse: inUse === 'db_a' },
        { name: 'db_b', inUse: inUse === 'db_b' },
      ] },
    ]
    ;(window as unknown as { sqlkit: unknown }).sqlkit = {
      saveWorkspaceConfig: vi.fn(() => Promise.resolve({ success: true })),
      connectDatabase: vi.fn(() => Promise.resolve({ success: true })),
      getConnectionStatuses: vi.fn(() => Promise.resolve(statuses())),
      // The manager moves the pin, and the next status read reports it.
      setActiveChildDb: vi.fn((_id: string, database: string) => {
        inUse = database
        return Promise.resolve({ success: true })
      }),
      listTables: vi.fn(() => Promise.resolve({ success: true, tables: [] })),
      listColumns: vi.fn(() => Promise.resolve({ success: true, columns: [] })),
      listObjects: vi.fn(() => Promise.resolve({ success: true, objects: { functions: [], types: [] } })),
      listTableStats: vi.fn(() => Promise.resolve({ success: true, stats: [] })),
    }
    workbench._config.connections = [allDatabases]
    workbench._ctx.switchInstance('p1', 'db_b')

    await workbench._connectProfile('p1')

    // Reading the in-use child before the switch's status landed used to leave
    // the context on db_a while the driver sat on db_b — the explorer then
    // judged its metadata stale and showed nothing at all.
    expect(workbench._ctx.activeChildDb).toBe('db_b')
  })
})

describe('WorkbenchScreen connect lands in the remembered database', () => {
  // Measured against the live MySQL server: an all-databases connection opens
  // on its own pick (app_db, empty) rather than the child last worked in
  // (testsqlkit, 12 tables).
  const mysqlAll = {
    ...profile, engine: 'mysql', databaseMode: 'all', database: '', lastChildDb: 'testsqlkit',
  } as ConnectionProfile

  const setup = (reportChildrenAtConnect: boolean) => {
    let inUse = 'app_db'
    let reported = reportChildrenAtConnect
    const names = ['app_db', 'test123', 'testsqlkit']
    const tableCount: Record<string, number> = { app_db: 0, test123: 0, testsqlkit: 12 }
    const listTables = vi.fn((_id: string, child: string | null) =>
      Promise.resolve({
        success: true,
        tables: Array.from({ length: tableCount[child ?? inUse] ?? 0 }, (_, i) => ({ schema: null, name: `t${i}`, kind: 'table' })),
      }))
    ;(window as unknown as { sqlkit: unknown }).sqlkit = {
      saveWorkspaceConfig: vi.fn(() => Promise.resolve({ success: true })),
      connectDatabase: vi.fn(() => Promise.resolve({ success: true })),
      getConnectionStatuses: vi.fn(() => Promise.resolve([{
        profileId: 'p1',
        phase: 'connected',
        children: reported ? names.map((name) => ({ name, inUse: name === inUse })) : [],
      }])),
      setActiveChildDb: vi.fn((_id: string, database: string) => {
        inUse = database
        reported = true
        return Promise.resolve({ success: true })
      }),
      listTables,
      listColumns: vi.fn(() => Promise.resolve({ success: true, columns: [] })),
      listObjects: vi.fn(() => Promise.resolve({ success: true, objects: { functions: [], types: [] } })),
      listTableStats: vi.fn(() => Promise.resolve({ success: true, stats: [] })),
    }
    const screen = new WorkbenchScreen()
    const workbench = screen as never as {
      _config: { connections: ConnectionProfile[] }
      _ctx: { switchInstance(a: string | null, b: string | null): void; activeChildDb: string | null }
      _live: { tables: Record<string, unknown[]> }
      _connectProfile(id: string): Promise<void>
    }
    workbench._config.connections = [mysqlAll]
    workbench._ctx.switchInstance('p1', 'testsqlkit')
    return { workbench, driverChild: () => inUse }
  }

  const settle = async () => { for (let i = 0; i < 60; i += 1) await Promise.resolve() }

  it('moves the driver off the database it opened itself', async () => {
    const { workbench, driverChild } = setup(true)
    await workbench._connectProfile('p1')
    await settle()
    expect(driverChild()).toBe('testsqlkit')
    expect(workbench._ctx.activeChildDb).toBe('testsqlkit')
    expect(workbench._live.tables.p1).toHaveLength(12)
  })

  it('still aligns when the status has not reported children yet', async () => {
    // The empty child list used to read as "nothing to align", so the driver
    // stayed on app_db while the titlebar kept naming testsqlkit — and the
    // explorer showed "No tables" for a database holding twelve.
    const { workbench, driverChild } = setup(false)
    await workbench._connectProfile('p1')
    await settle()
    expect(driverChild()).toBe('testsqlkit')
    expect(workbench._ctx.activeChildDb).toBe('testsqlkit')
    expect(workbench._live.tables.p1).toHaveLength(12)
  })
})
