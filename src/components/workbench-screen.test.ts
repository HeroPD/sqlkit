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
