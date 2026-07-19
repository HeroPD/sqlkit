// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ReactiveControllerHost } from 'lit'
import type { ConnectionProfile, QueryResponse } from '../electron'
import type { HistoryItem } from '../components/history-view'
import { QueriesController, capHistoryPerContext } from './queries'

const historyItem = (contextKey: string, id: string): HistoryItem =>
  ({ id, contextKey, sql: id, success: true, durationMs: 0, rowCount: 0, error: '', createdAt: '' })

describe('capHistoryPerContext', () => {
  it('keeps the newest N of each context independently', () => {
    // newest-first, interleaved across two contexts.
    const items = [historyItem('A', 'a3'), historyItem('B', 'b1'), historyItem('A', 'a2'), historyItem('A', 'a1')]
    expect(capHistoryPerContext(items, 2).map((item) => item.id)).toEqual(['a3', 'b1', 'a2'])
  })

  it('does not let a busy context evict another context', () => {
    const busy = Array.from({ length: 5 }, (_, i) => historyItem('A', `a${i}`))
    const capped = capHistoryPerContext([...busy, historyItem('B', 'b0')], 3)
    expect(capped.filter((item) => item.contextKey === 'A')).toHaveLength(3)
    expect(capped.filter((item) => item.contextKey === 'B')).toHaveLength(1)
  })
})

const host = (): ReactiveControllerHost =>
  ({ addController() {}, removeController() {}, requestUpdate() {}, updateComplete: Promise.resolve(true) })

const profile = { id: 'p1', name: 'Local' } as ConnectionProfile
const result = { columns: ['n'], rows: [[1]], rowCount: 1, durationMs: 3 }
// A paged result: a first page in `rows` with more buffered behind a session.
const paged = { columns: ['n'], rows: [[0], [1]], rowCount: 5, durationMs: 1, sessionId: 'sess1', bufferedRowCount: 5 }
const runArgs = { tabId: 't1', profile, childDb: null, contextKey: 'p1', sql: 'SELECT 1', executionId: 'exec1' }

// window.sqlkit stub with the query/paging/history methods the controller calls.
function stubSqlkit(over: Partial<Record<'runQuery' | 'fetchRows' | 'closeSession' | 'readHistory' | 'writeHistory', unknown>> = {}) {
  const api = {
    runQuery: vi.fn(() => Promise.resolve({ success: true, result: paged })),
    fetchRows: vi.fn(() => Promise.resolve({ success: true, rows: [] as unknown[][] })),
    closeSession: vi.fn(() => Promise.resolve()),
    readHistory: vi.fn(() => Promise.resolve([] as HistoryItem[])),
    writeHistory: vi.fn(() => Promise.resolve({ success: true })),
    ...over,
  }
  ;(window as unknown as { sqlkit: unknown }).sqlkit = api
  return api
}

// Hands back a runQuery whose resolution the test controls, so a workspace
// switch can be injected mid-flight.
function deferRunQuery() {
  let settle!: (response: QueryResponse) => void
  const pending = new Promise<QueryResponse>((res) => (settle = res))
  const runQuery = vi.fn(() => pending)
  const writeHistory = vi.fn((_items: HistoryItem[]) => Promise.resolve({ success: true }))
  ;(window as unknown as { sqlkit: unknown }).sqlkit = { runQuery, writeHistory }
  return { settle, runQuery, writeHistory }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('QueriesController.execute', () => {
  it('records the result when no workspace switch intervenes', async () => {
    const { settle } = deferRunQuery()
    const controller = new QueriesController(host(), () => true)

    const done = controller.execute(runArgs)
    settle({ success: true, result })
    await done

    expect(controller.runFor('t1')).toEqual({ phase: 'done', result, sql: 'SELECT 1' })
    expect(controller.history).toHaveLength(1)
    expect(controller.tasks[0]?.status).toBe('done')
  })

  it('marks a task cancelled from the typed response flag, not the error text', async () => {
    const { settle } = deferRunQuery()
    const controller = new QueriesController(host(), () => true)

    const done = controller.execute(runArgs)
    settle({ success: false, error: 'anything at all', cancelled: true })
    await done

    expect(controller.tasks[0]?.status).toBe('cancelled')
  })

  it('passes the captured child database to the query IPC', async () => {
    const { settle, runQuery } = deferRunQuery()
    const controller = new QueriesController(host(), () => true)

    const done = controller.execute({ ...runArgs, childDb: 'analytics', contextKey: 'p1:analytics' })
    settle({ success: true, result })
    await done

    expect(runQuery).toHaveBeenCalledWith('p1', 'analytics', 'SELECT 1', undefined, undefined, 'exec1')
  })

  it('forwards bound query parameters and retains them with the result', async () => {
    const { settle, runQuery } = deferRunQuery()
    const controller = new QueriesController(host(), () => true)

    const done = controller.execute({ ...runArgs, params: ['42', null] })
    settle({ success: true, result })
    await done

    expect(runQuery).toHaveBeenCalledWith('p1', null, 'SELECT 1', ['42', null], undefined, 'exec1')
    expect(controller.runFor('t1')).toMatchObject({ phase: 'done', params: ['42', null] })
  })

  it('forwards a column sort to the query IPC and tracks it per tab', async () => {
    const { settle, runQuery } = deferRunQuery()
    const controller = new QueriesController(host(), () => true)

    const done = controller.execute({ ...runArgs, sort: { columnIndex: 0, direction: 'desc' } })
    settle({ success: true, result })
    await done

    expect(runQuery).toHaveBeenCalledWith('p1', null, 'SELECT 1', undefined, { columnIndex: 0, direction: 'desc' }, 'exec1')
    expect(controller.sortFor('t1')).toEqual({ columnIndex: 0, direction: 'desc' })
  })

  it('clears a previous sort when a run carries none', async () => {
    const { settle } = deferRunQuery()
    const controller = new QueriesController(host(), () => true)

    controller.sorts.set('t1', { columnIndex: 0, direction: 'asc' })
    const done = controller.execute(runArgs)
    settle({ success: true, result })
    await done

    expect(controller.sortFor('t1')).toBeNull()
  })

  it('drops a result that resolves after a workspace switch (reset)', async () => {
    const { settle } = deferRunQuery()
    const controller = new QueriesController(host(), () => true)

    const done = controller.execute(runArgs)
    controller.reset() // workspace switched while the query was in flight
    settle({ success: true, result })
    await done

    // The stale result must not land in the new workspace's state.
    expect(controller.runFor('t1')).toEqual({ phase: 'idle' })
    expect(controller.history).toHaveLength(0)
    expect(controller.tasks).toHaveLength(0)
  })

  it('marks the run errored instead of stuck when the IPC call rejects', async () => {
    ;(window as unknown as { sqlkit: unknown }).sqlkit = {
      runQuery: () => Promise.reject(new Error('channel closed')),
      writeHistory: () => Promise.resolve({ success: true }),
    }
    const controller = new QueriesController(host(), () => true)

    await controller.execute(runArgs)

    expect(controller.runFor('t1')).toEqual({ phase: 'error', error: 'channel closed' })
    expect(controller.tasks[0]?.status).toBe('error')
  })
})

describe('QueriesController history persistence', () => {
  it('writes history through after every run', async () => {
    const { settle, writeHistory } = deferRunQuery()
    const controller = new QueriesController(host(), () => true)

    const done = controller.execute(runArgs)
    settle({ success: true, result })
    await done

    expect(writeHistory).toHaveBeenCalledOnce()
    const written = writeHistory.mock.calls[0]?.[0]
    expect(written?.[0]).toMatchObject({ contextKey: 'p1', sql: 'SELECT 1', success: true })
  })

  it('loads persisted history behind entries already recorded this session', async () => {
    const api = stubSqlkit({ readHistory: vi.fn(() => Promise.resolve([historyItem('p1', 'old-run')])) })
    const controller = new QueriesController(host(), () => true)
    controller.history = [historyItem('p1', 'fresh-run')]

    await controller.loadHistory()

    expect(controller.history.map((item) => item.id)).toEqual(['fresh-run', 'old-run'])
    expect(api.readHistory).toHaveBeenCalledOnce()
  })

  it('drops a history load that resolves after a workspace switch', async () => {
    let resolve!: (items: HistoryItem[]) => void
    stubSqlkit({ readHistory: vi.fn(() => new Promise<HistoryItem[]>((res) => (resolve = res))) })
    const controller = new QueriesController(host(), () => true)

    const loading = controller.loadHistory()
    controller.reset()
    resolve([historyItem('p1', 'stale')])
    await loading

    expect(controller.history).toEqual([])
  })
})

describe('QueriesController export tasks', () => {
  it('tracks an export as a running task and settles each outcome', () => {
    stubSqlkit()
    const controller = new QueriesController(host(), () => true)
    const begin = (id: string) =>
      controller.beginExport({ executionId: id, profileId: 'p1', contextLabel: 'Local / app', sql: 'SELECT 1' })

    begin('e1')
    expect(controller.tasks[0]).toMatchObject({ id: 'e1', status: 'running', contextLabel: 'Local / app — export' })

    controller.finishExport('e1', { success: true, rowCount: 42 })
    expect(controller.tasks[0]).toMatchObject({ status: 'done', rowCount: 42 })

    begin('e2')
    controller.finishExport('e2', { success: false, cancelled: true })
    expect(controller.tasks[0]?.status).toBe('cancelled')

    // A cancelled save dialog is a cancellation, not a failure.
    begin('e3')
    controller.finishExport('e3', { success: false, canceled: true })
    expect(controller.tasks[0]?.status).toBe('cancelled')

    begin('e4')
    controller.finishExport('e4', { success: false, error: 'disk full' })
    expect(controller.tasks[0]?.status).toBe('error')
  })
})

describe('QueriesController drafts', () => {
  it('adds, edits, and drops staged new rows', () => {
    const controller = new QueriesController(host(), () => true)

    controller.addDraft('t1', 2)
    controller.addDraft('t1', 2)
    controller.setDraftCell('t1', 1, 0, 'hi')
    expect(controller.draftsFor('t1').map((row) => row.cells)).toEqual([[null, null], ['hi', null]])

    controller.removeDraft('t1', 0)
    expect(controller.draftsFor('t1').map((row) => row.cells)).toEqual([['hi', null]])

    controller.dropDrafts('t1', [0])
    expect(controller.draftsFor('t1')).toEqual([])
    expect(controller.drafts.has('t1')).toBe(false)
  })

  it('inserts a new row below its anchor at the given index, clamping out-of-range', () => {
    const controller = new QueriesController(host(), () => true)
    controller.addDraft('t1', 1, 0) // [A] anchored below result row 0
    controller.setDraftCell('t1', 0, 0, 'A')
    controller.addDraft('t1', 1, 0, 1) // append below A → [A, B]
    controller.setDraftCell('t1', 1, 0, 'B')
    controller.addDraft('t1', 1, 0, 1) // below A → [A, C, B]
    controller.setDraftCell('t1', 1, 0, 'C')
    expect(controller.draftsFor('t1').map((row) => row.cells[0])).toEqual(['A', 'C', 'B'])

    controller.addDraft('t1', 1, 0, 99) // out of range → appended
    expect(controller.draftsFor('t1')).toHaveLength(4)
    expect(controller.draftsFor('t1')[3]).toEqual({ after: 0, cells: [null] })
  })

  it('adds multiple prefilled draft rows in one update', () => {
    const controller = new QueriesController(host(), () => true)

    controller.addDrafts('t1', [
      { after: 0, cells: ['1', 'Ada'] },
      { after: 1, cells: ['2', 'Grace'] },
    ])

    expect(controller.draftsFor('t1')).toEqual([
      { after: 0, cells: ['1', 'Ada'] },
      { after: 1, cells: ['2', 'Grace'] },
    ])
  })

  it('clears a tab\'s drafts when a run returns a different column count', async () => {
    const { settle } = deferRunQuery()
    const controller = new QueriesController(host(), () => true)
    controller.addDraft('t1', 1) // staged against a 1-column result

    const done = controller.execute(runArgs)
    settle({ success: true, result: { columns: ['a', 'b'], rows: [], rowCount: 0, durationMs: 1 } })
    await done

    expect(controller.draftsFor('t1')).toEqual([])
  })

  it('keeps drafts across a same-shape refresh', async () => {
    const { settle } = deferRunQuery()
    const controller = new QueriesController(host(), () => true)
    controller.addDraft('t1', 1)

    const done = controller.execute(runArgs)
    settle({ success: true, result }) // result has 1 column ('n')
    await done

    expect(controller.draftsFor('t1')).toEqual([{ after: -1, cells: [null] }])
  })

  it('stages and clears cell edits, and clearStaged drops drafts and edits together', () => {
    const controller = new QueriesController(host(), () => true)
    controller.setEdit('t1', 0, 1, 'Grace')
    controller.setEdit('t1', 2, 0, '9')
    expect(controller.editsList('t1')).toEqual([
      { row: 0, col: 1, value: 'Grace' },
      { row: 2, col: 0, value: '9' },
    ])

    controller.clearEdit('t1', 0, 1)
    expect(controller.editsList('t1')).toEqual([{ row: 2, col: 0, value: '9' }])

    controller.addDraft('t1', 2)
    controller.clearStaged('t1')
    expect(controller.editsFor('t1').size).toBe(0)
    expect(controller.draftsFor('t1')).toEqual([])
  })

  it('clears row-indexed cell edits on a same-shape rerun', async () => {
    const { settle } = deferRunQuery()
    const controller = new QueriesController(host(), () => true)
    controller.setEdit('t1', 0, 0, 'stale')

    const done = controller.execute(runArgs)
    settle({ success: true, result })
    await done

    expect(controller.editsFor('t1').size).toBe(0)
  })

  it('drops drafts when its tab closes', () => {
    const controller = new QueriesController(host(), () => true)
    controller.addDraft('t1', 1)
    controller.dropTab('t1')
    expect(controller.draftsFor('t1')).toEqual([])
  })
})

describe('QueriesController result retention', () => {
  it('does not evict a result that owns staged changes', () => {
    stubSqlkit()
    const controller = new QueriesController(host(), () => true)
    const huge = 'x'.repeat(20 * 1024 * 1024)
    const largeResult = { columns: ['payload'], rows: [[huge], [huge]], rowCount: 2, durationMs: 1 }

    controller.setRun('t1', { phase: 'done', result: largeResult })
    controller.setEdit('t1', 0, 0, 'pending')
    controller.setRun('t2', { phase: 'done', result: largeResult })
    controller.setRun('t3', { phase: 'done', result: largeResult })

    // t1 is older than t2 but staged, so the eviction pass must skip it.
    expect(controller.runFor('t1').phase).toBe('done')
    expect(controller.editsFor('t1').size).toBe(1)
    expect(controller.runFor('t2').phase).toBe('error')
  })
})

describe('QueriesController column widths', () => {
  const cols = ['id', 'name']

  it('stores and returns widths keyed by tab', () => {
    const controller = new QueriesController(host(), () => true)
    controller.setColumnWidths('t1', cols, new Map([[0, 200]]))
    expect([...controller.columnWidthsFor('t1', cols)]).toEqual([[0, 200]])
    expect(controller.columnWidthsFor('t2', cols).size).toBe(0)
    expect(controller.columnWidthsFor(null, cols).size).toBe(0)
  })

  it('re-measures (returns empty) when the result columns differ', () => {
    const controller = new QueriesController(host(), () => true)
    controller.setColumnWidths('t1', cols, new Map([[0, 200]]))
    // Same tab, but a query with a different shape — the old widths don't apply.
    expect(controller.columnWidthsFor('t1', ['id', 'name', 'email']).size).toBe(0)
    // The identical column set still gets them (survives a sort re-run).
    expect(controller.columnWidthsFor('t1', ['id', 'name']).size).toBe(1)
  })

  it('clears a tab’s widths when set to an empty map', () => {
    const controller = new QueriesController(host(), () => true)
    controller.setColumnWidths('t1', cols, new Map([[0, 200]]))
    controller.setColumnWidths('t1', cols, new Map())
    expect(controller.columnWidthsFor('t1', cols).size).toBe(0)
  })

  it('drops widths when the tab closes and moves them on rename', () => {
    const controller = new QueriesController(host(), () => true)
    controller.setColumnWidths('t1', cols, new Map([[1, 150]]))
    controller.renameTab('t1', 't2')
    expect([...controller.columnWidthsFor('t2', cols)]).toEqual([[1, 150]])
    controller.dropTab('t2')
    expect(controller.columnWidthsFor('t2', cols).size).toBe(0)
  })
})

describe('QueriesController staged undo/redo', () => {
  it('steps cell edits back and forward one commit at a time', () => {
    const controller = new QueriesController(host(), () => true)
    controller.setEdit('t1', 0, 0, 'a')
    controller.setEdit('t1', 1, 0, 'b')
    expect(controller.editsFor('t1').size).toBe(2)

    expect(controller.undoStaged('t1')).toBe(true)
    expect(controller.editsList('t1')).toEqual([{ row: 0, col: 0, value: 'a' }])
    expect(controller.undoStaged('t1')).toBe(true)
    expect(controller.editsFor('t1').size).toBe(0)
    expect(controller.undoStaged('t1')).toBe(false)

    expect(controller.redoStaged('t1')).toBe(true)
    expect(controller.editsList('t1')).toEqual([{ row: 0, col: 0, value: 'a' }])
    expect(controller.redoStaged('t1')).toBe(true)
    expect(controller.editsFor('t1').size).toBe(2)
    expect(controller.redoStaged('t1')).toBe(false)
  })

  it('undoes across interleaved drafts and cell edits', () => {
    const controller = new QueriesController(host(), () => true)
    controller.setEdit('t1', 0, 0, 'x')
    controller.addDraft('t1', 1)
    expect(controller.draftsFor('t1')).toHaveLength(1)

    controller.undoStaged('t1') // undo the draft
    expect(controller.draftsFor('t1')).toEqual([])
    expect(controller.editsList('t1')).toEqual([{ row: 0, col: 0, value: 'x' }])

    controller.undoStaged('t1') // undo the edit
    expect(controller.editsFor('t1').size).toBe(0)
  })

  it('restores everything after undoing a discard-all, and can redo it', () => {
    const controller = new QueriesController(host(), () => true)
    controller.setEdit('t1', 0, 0, 'a')
    controller.addDraft('t1', 1)
    controller.clearStaged('t1')
    expect(controller.editsFor('t1').size).toBe(0)
    expect(controller.draftsFor('t1')).toEqual([])

    expect(controller.undoStaged('t1')).toBe(true)
    expect(controller.editsList('t1')).toEqual([{ row: 0, col: 0, value: 'a' }])
    expect(controller.draftsFor('t1')).toHaveLength(1)

    expect(controller.redoStaged('t1')).toBe(true)
    expect(controller.editsFor('t1').size).toBe(0)
    expect(controller.draftsFor('t1')).toEqual([])
  })

  it('does not record a no-op edit (same value) as an undo step', () => {
    const controller = new QueriesController(host(), () => true)
    controller.setEdit('t1', 0, 0, 'a')
    controller.setEdit('t1', 0, 0, 'a') // identical → no new step
    expect(controller.undoStaged('t1')).toBe(true)
    expect(controller.editsFor('t1').size).toBe(0)
  })

  it('drops the redo branch when a new edit follows an undo', () => {
    const controller = new QueriesController(host(), () => true)
    controller.setEdit('t1', 0, 0, 'a')
    controller.setEdit('t1', 0, 0, 'b')
    controller.undoStaged('t1')
    controller.setEdit('t1', 1, 0, 'c')
    expect(controller.redoStaged('t1')).toBe(false)
    expect(controller.editsList('t1')).toEqual([
      { row: 0, col: 0, value: 'a' },
      { row: 1, col: 0, value: 'c' },
    ])
  })

  it('invalidates undo history on a same-shape rerun (edits keyed to old rows)', async () => {
    const { settle } = deferRunQuery()
    const controller = new QueriesController(host(), () => true)
    controller.setEdit('t1', 0, 0, 'stale')

    const done = controller.execute(runArgs)
    settle({ success: true, result })
    await done

    expect(controller.undoStaged('t1')).toBe(false)
  })

  it('drops a surviving redo branch on rerun so a stale edit cannot be replayed', async () => {
    const { settle } = deferRunQuery()
    const controller = new QueriesController(host(), () => true)
    controller.setEdit('t1', 0, 0, 'stale')
    // Undo leaves the edits map empty but the redo branch still holds the edit.
    expect(controller.undoStaged('t1')).toBe(true)
    expect(controller.editsFor('t1').size).toBe(0)

    const done = controller.execute(runArgs)
    settle({ success: true, result })
    await done

    // The rerun must invalidate that history — redo cannot retarget row 0.
    expect(controller.redoStaged('t1')).toBe(false)
    expect(controller.editsFor('t1').size).toBe(0)
  })

  it('applies a multi-cell fill as a single undo step', () => {
    const controller = new QueriesController(host(), () => true)
    controller.applyFill('t1', {
      edits: [
        { row: 0, col: 0, value: 'X' },
        { row: 1, col: 0, value: 'X' },
        { row: 2, col: 0, value: 'X' },
      ],
      clears: [],
      draftCells: [],
    })
    expect(controller.editsFor('t1').size).toBe(3)
    // The whole gesture is one snapshot: one undo clears all three cells.
    expect(controller.undoStaged('t1')).toBe(true)
    expect(controller.editsFor('t1').size).toBe(0)
    expect(controller.undoStaged('t1')).toBe(false)
  })

  it('combines edits, clears, and draft cells in one fill snapshot', () => {
    const controller = new QueriesController(host(), () => true)
    controller.setEdit('t1', 0, 0, 'old')
    controller.addDraft('t1', 2)
    controller.applyFill('t1', {
      edits: [{ row: 1, col: 0, value: 'Y' }],
      clears: [{ row: 0, col: 0 }],
      draftCells: [{ index: 0, col: 1, value: 'Z' }],
    })
    expect(controller.editsList('t1')).toEqual([{ row: 1, col: 0, value: 'Y' }])
    expect(controller.draftsFor('t1')[0]!.cells).toEqual([null, 'Z'])
    // One undo reverses the whole fill: edit gone, clear restored, draft cell back.
    controller.undoStaged('t1')
    expect(controller.editsList('t1')).toEqual([{ row: 0, col: 0, value: 'old' }])
    expect(controller.draftsFor('t1')[0]!.cells).toEqual([null, null])
  })

  it('invalidates undo history at a save commit point', () => {
    const controller = new QueriesController(host(), () => true)
    controller.setEdit('t1', 0, 0, 'a')
    controller.clearStagedHistory('t1')
    expect(controller.undoStaged('t1')).toBe(false)
  })

  it('returns false with no tab or no history', () => {
    const controller = new QueriesController(host(), () => true)
    expect(controller.undoStaged(null)).toBe(false)
    expect(controller.redoStaged('never-touched')).toBe(false)
  })

  it('moves undo history with a tab rename', () => {
    const controller = new QueriesController(host(), () => true)
    controller.setEdit('old', 0, 0, 'a')
    controller.renameTab('old', 'new')
    expect(controller.undoStaged('new')).toBe(true)
    expect(controller.editsFor('new').size).toBe(0)
  })
})

describe('QueriesController paging', () => {
  it('appends a fetched page on loadMore', async () => {
    const api = stubSqlkit({ fetchRows: vi.fn(() => Promise.resolve({ success: true, rows: [[2], [3]] })) })
    const controller = new QueriesController(host(), () => true)

    await controller.execute(runArgs)
    await controller.loadMore('t1')

    expect(api.fetchRows).toHaveBeenCalledWith('sess1', 2, 200) // offset = loaded so far
    expect(controller.runFor('t1')).toMatchObject({ phase: 'done', result: { rows: [[0], [1], [2], [3]] } })
  })

  it('does not fetch for a non-paged result', async () => {
    const api = stubSqlkit({ runQuery: vi.fn(() => Promise.resolve({ success: true, result })) })
    const controller = new QueriesController(host(), () => true)

    await controller.execute(runArgs)
    await controller.loadMore('t1')

    expect(api.fetchRows).not.toHaveBeenCalled()
  })

  it('coalesces concurrent loadMore calls into one fetch', async () => {
    let settle!: (page: { success: true; rows: unknown[][] }) => void
    const pending = new Promise<{ success: true; rows: unknown[][] }>((res) => (settle = res))
    const api = stubSqlkit({ fetchRows: vi.fn(() => pending) })
    const controller = new QueriesController(host(), () => true)

    await controller.execute(runArgs)
    const a = controller.loadMore('t1')
    const b = controller.loadMore('t1')
    settle({ success: true, rows: [[2]] })
    await Promise.all([a, b])

    expect(api.fetchRows).toHaveBeenCalledTimes(1)
  })

  it('closes the buffer when its tab is dropped', async () => {
    const api = stubSqlkit()
    const controller = new QueriesController(host(), () => true)

    await controller.execute(runArgs)
    controller.dropTab('t1')

    expect(api.closeSession).toHaveBeenCalledWith('sess1')
  })

  it('closes the previous buffer when a new query runs in the tab', async () => {
    const api = stubSqlkit()
    const controller = new QueriesController(host(), () => true)

    await controller.execute(runArgs)
    await controller.execute(runArgs)

    expect(api.closeSession).toHaveBeenCalledWith('sess1')
  })

  it('closes buffers on reset', async () => {
    const api = stubSqlkit()
    const controller = new QueriesController(host(), () => true)

    await controller.execute(runArgs)
    controller.reset()

    expect(api.closeSession).toHaveBeenCalledWith('sess1')
  })

  it('closes the buffer of a response that lands after a reset', async () => {
    let settle!: (response: QueryResponse) => void
    const pending = new Promise<QueryResponse>((res) => (settle = res))
    const api = stubSqlkit({ runQuery: vi.fn(() => pending) })
    const controller = new QueriesController(host(), () => true)

    const done = controller.execute(runArgs)
    controller.reset() // workspace switched while the query was in flight
    settle({ success: true, result: paged }) // the late success still made a session in main
    await done

    expect(api.closeSession).toHaveBeenCalledWith('sess1')
  })

  it('closes the buffer of a response that lands after its tab was closed', async () => {
    let settle!: (response: QueryResponse) => void
    const pending = new Promise<QueryResponse>((res) => (settle = res))
    const api = stubSqlkit({ runQuery: vi.fn(() => pending) })
    const tabs = new Set(['t1'])
    const controller = new QueriesController(host(), (tabId) => tabs.has(tabId))

    const done = controller.execute(runArgs)
    tabs.delete('t1')
    controller.dropTab('t1')
    settle({ success: true, result: paged })
    await done

    expect(api.closeSession).toHaveBeenCalledWith('sess1')
    expect(controller.runFor('t1')).toEqual({ phase: 'idle' })
    expect(controller.tasks[0]?.status).toBe('done')
  })

  it('stops paging once the buffer has expired', async () => {
    const api = stubSqlkit({ fetchRows: vi.fn(() => Promise.resolve({ success: false, error: 'Result buffer expired' })) })
    const controller = new QueriesController(host(), () => true)

    await controller.execute(runArgs)
    await controller.loadMore('t1') // buffer gone → pin bufferedRowCount to what's loaded
    expect(controller.runFor('t1')).toMatchObject({ phase: 'done', result: { bufferedRowCount: 2 } })

    await controller.loadMore('t1') // now a no-op (loaded === buffered)
    expect(api.fetchRows).toHaveBeenCalledTimes(1)
  })
})
