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
const runArgs = { tabId: 't1', profile, childDb: null, contextKey: 'p1', sql: 'SELECT 1' }

// window.sqlkit stub with the query/paging methods the controller calls.
function stubSqlkit(over: Partial<Record<'runQuery' | 'fetchRows' | 'closeSession', unknown>> = {}) {
  const api = {
    runQuery: vi.fn(() => Promise.resolve({ success: true, result: paged })),
    fetchRows: vi.fn(() => Promise.resolve({ success: true, rows: [] as unknown[][] })),
    closeSession: vi.fn(() => Promise.resolve()),
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
  ;(window as unknown as { sqlkit: unknown }).sqlkit = { runQuery }
  return { settle, runQuery }
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

  it('passes the captured child database to the query IPC', async () => {
    const { settle, runQuery } = deferRunQuery()
    const controller = new QueriesController(host(), () => true)

    const done = controller.execute({ ...runArgs, childDb: 'analytics', contextKey: 'p1:analytics' })
    settle({ success: true, result })
    await done

    expect(runQuery).toHaveBeenCalledWith('p1', 'analytics', 'SELECT 1')
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
    }
    const controller = new QueriesController(host(), () => true)

    await controller.execute(runArgs)

    expect(controller.runFor('t1')).toEqual({ phase: 'error', error: 'channel closed' })
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
