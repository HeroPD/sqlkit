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
