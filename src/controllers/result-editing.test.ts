// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ColumnRef, ConnectionProfile, QueryResult, TableRef } from '../electron'
import type { SqlTabState } from './contexts'
import { DialogsController } from './dialogs'
import { ResultEditingController } from './result-editing'

const accounts: TableRef = { schema: 'public', name: 'accounts', kind: 'table' }

const profile: ConnectionProfile = {
  id: 'p1',
  name: 'Postgres',
  engine: 'postgresql',
  host: '',
  port: '',
  username: '',
  password: '',
  database: '',
  file: '',
  folder: '',
}

const columns: ColumnRef[] = [
  { schema: 'public', table: 'accounts', name: 'id', dataType: 'integer', nullable: false, primaryKey: true, foreignKey: false },
  { schema: 'public', table: 'accounts', name: 'name', dataType: 'text', nullable: true, primaryKey: false, foreignKey: false },
]

const result: QueryResult = {
  columns: ['id', 'name'],
  columnSources: [
    { schema: 'public', table: 'accounts', column: 'id' },
    { schema: 'public', table: 'accounts', column: 'name' },
  ],
  rows: [[1, 'Ada']],
  rowCount: 1,
  durationMs: 1,
}

const tab = (id: string, content: string): SqlTabState => ({
  id,
  kind: 'sql',
  name: `${id}.sql`,
  path: null,
  content,
  savedContent: content,
  table: accounts,
})

function make() {
  let activeChildDb: string | null = 'db_a'
  let activeTab: SqlTabState | null = tab('tab-a', 'select id, name from accounts')
  const dialogs = new DialogsController({ addController() {}, removeController() {}, requestUpdate() {}, updateComplete: Promise.resolve(true) })
  const runSql = vi.fn(() => Promise.resolve())
  const ctrl = new ResultEditingController({
    activeTab: () => activeTab,
    activeDbId: () => profile.id,
    activeChildDb: () => activeChildDb,
    activeProfile: () => profile,
    run: () => ({ phase: 'done', result, sql: activeTab?.content ?? '' }),
    tables: () => [accounts],
    columns: () => columns,
    dialogs,
    runSql,
  })
  return {
    ctrl,
    dialogs,
    runSql,
    setActiveChild: (next: string | null) => (activeChildDb = next),
    setActiveTab: (next: SqlTabState | null) => (activeTab = next),
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('ResultEditingController', () => {
  it('executes a reviewed cell write against the child database captured during review', async () => {
    const runQuery = vi.fn(() => Promise.resolve({ success: true, result: { columns: [], rows: [], rowCount: 1, durationMs: 1 } }))
    ;(window as unknown as { sqlkit: unknown }).sqlkit = { runQuery }
    const { ctrl, dialogs, runSql, setActiveChild, setActiveTab } = make()

    ctrl.cellEdit({ row: 0, col: 1, value: 'Grace' })
    setActiveChild('db_b')
    setActiveTab(tab('tab-b', 'select * from other_table'))
    dialogs.acceptReview()

    await vi.waitFor(() => expect(runQuery).toHaveBeenCalled())
    expect(runQuery).toHaveBeenCalledWith('p1', 'db_a', expect.stringContaining('UPDATE'), expect.any(Array))
    expect(runSql).not.toHaveBeenCalled()
  })
})
