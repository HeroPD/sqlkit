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
  let drafts: Array<{ after: number; cells: Array<string | null> }> = []
  let edits: Array<{ row: number; col: number; value: string }> = []
  const dialogs = new DialogsController({ addController() {}, removeController() {}, requestUpdate() {}, updateComplete: Promise.resolve(true) })
  const runSql = vi.fn(() => Promise.resolve())
  const dropDrafts = vi.fn((_tabId: string, indexes: number[]) => {
    const drop = new Set(indexes)
    drafts = drafts.filter((_, i) => !drop.has(i))
  })
  const clearEdits = vi.fn(() => {
    edits = []
  })
  const clearStagedHistory = vi.fn()
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
    drafts: () => drafts,
    dropDrafts,
    edits: () => edits,
    clearEdits,
    clearStagedHistory,
  })
  return {
    ctrl,
    dialogs,
    runSql,
    dropDrafts,
    clearEdits,
    clearStagedHistory,
    setActiveChild: (next: string | null) => (activeChildDb = next),
    setActiveTab: (next: SqlTabState | null) => (activeTab = next),
    setDrafts: (next: Array<{ after: number; cells: Array<string | null> }>) => (drafts = next),
    setEdits: (next: Array<{ row: number; col: number; value: string }>) => (edits = next),
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('ResultEditingController', () => {
  it('commits a staged cell edit as one atomic batch against the child captured at review', async () => {
    const runBatch = vi.fn(() => Promise.resolve({ success: true }))
    ;(window as unknown as { sqlkit: unknown }).sqlkit = { runBatch }
    const { ctrl, dialogs, runSql, clearEdits, setEdits, setActiveChild, setActiveTab } = make()

    setEdits([{ row: 0, col: 1, value: 'Grace' }])
    ctrl.saveChanges()
    setActiveChild('db_b')
    setActiveTab(tab('tab-b', 'select * from other_table'))
    await dialogs.review!.run()

    expect(runBatch).toHaveBeenCalledWith('p1', 'db_a', [expect.objectContaining({ sql: expect.stringContaining('UPDATE') })])
    expect(clearEdits).toHaveBeenCalledWith('tab-a')
    // The active tab moved away before accepting, so no refresh runs there.
    expect(runSql).not.toHaveBeenCalled()
  })

  it('keeps staged edits when the batch reports a zero-row change', async () => {
    const runBatch = vi.fn(() =>
      Promise.resolve({ success: false, failedIndex: 0, error: 'A change affected no rows; the row may have been modified or removed.' }),
    )
    ;(window as unknown as { sqlkit: unknown }).sqlkit = { runBatch }
    const { ctrl, dialogs, runSql, clearEdits, setEdits } = make()

    setEdits([{ row: 0, col: 1, value: 'Grace' }])
    ctrl.saveChanges()
    const error = await dialogs.review!.run()

    expect(runBatch).toHaveBeenCalledOnce()
    expect(clearEdits).not.toHaveBeenCalled()
    expect(runSql).not.toHaveBeenCalled()
    expect(error).toContain('affected no rows')
  })

  it('saves edits and new rows together as one batch: UPDATE then an INSERT per row', async () => {
    const runBatch = vi.fn(() => Promise.resolve({ success: true }))
    ;(window as unknown as { sqlkit: unknown }).sqlkit = { runBatch }
    const { ctrl, dialogs, runSql, dropDrafts, clearEdits, clearStagedHistory, setDrafts, setEdits } = make()

    setEdits([{ row: 0, col: 1, value: 'Grace' }])
    // Row 1 fills only name (id untouched → DB default); row 2 fills both.
    setDrafts([
      { after: -1, cells: [null, 'Bob'] },
      { after: -1, cells: ['7', 'Cy'] },
    ])
    ctrl.saveChanges()

    expect(dialogs.review?.sql).toContain('UPDATE "public"."accounts"')
    expect(dialogs.review?.sql).toContain('INSERT INTO "public"."accounts" ("name")')
    expect(dialogs.review?.sql).toContain('INSERT INTO "public"."accounts" ("id", "name")')
    await dialogs.review!.run()

    expect(runBatch).toHaveBeenCalledOnce()
    // One transaction carrying all three statements, in order.
    expect(runBatch).toHaveBeenCalledWith('p1', 'db_a', [
      expect.objectContaining({ sql: expect.stringContaining('UPDATE') }),
      expect.objectContaining({ sql: expect.stringContaining('INSERT'), params: ['Bob'] }),
      expect.objectContaining({ sql: expect.stringContaining('INSERT'), params: [7, 'Cy'] }),
    ])
    expect(clearEdits).toHaveBeenCalledWith('tab-a')
    expect(dropDrafts).toHaveBeenCalledWith('tab-a', [0, 1])
    // A committed batch invalidates undo history so ⌘Z can't restore saved rows.
    expect(clearStagedHistory).toHaveBeenCalledWith('tab-a')
    expect(runSql).toHaveBeenCalledOnce()
  })

  it('rolls the whole batch back and keeps every change when one statement fails', async () => {
    const runBatch = vi.fn(() =>
      Promise.resolve({ success: false, failedIndex: 1, error: 'duplicate key value violates unique constraint' }),
    )
    ;(window as unknown as { sqlkit: unknown }).sqlkit = { runBatch }
    const { ctrl, dialogs, runSql, dropDrafts, clearEdits, setDrafts } = make()

    setDrafts([{ after: -1, cells: ['1', 'A'] }, { after: -1, cells: ['2', 'B'] }])
    ctrl.saveChanges()
    const error = await dialogs.review!.run()

    expect(runBatch).toHaveBeenCalledOnce()
    // Atomic: nothing committed, so nothing is cleared, dropped, or refreshed.
    expect(dropDrafts).not.toHaveBeenCalled()
    expect(clearEdits).not.toHaveBeenCalled()
    expect(runSql).not.toHaveBeenCalled()
    expect(error).toContain('rolled back')
  })
})
