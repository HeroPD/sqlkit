// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ReactiveControllerHost } from 'lit'
import type { ConnectionProfile, QueryResponse } from '../electron'
import { QueriesController } from './queries'

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
