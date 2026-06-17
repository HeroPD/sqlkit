// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ReactiveControllerHost } from 'lit'
import type { ConnectionProfile, QueryResponse } from '../electron'
import { QueriesController } from './queries'

const host = (): ReactiveControllerHost =>
  ({ addController() {}, removeController() {}, requestUpdate() {}, updateComplete: Promise.resolve(true) }) as unknown as ReactiveControllerHost

const profile = { id: 'p1', name: 'Local' } as ConnectionProfile
const result = { columns: ['n'], rows: [[1]], rowCount: 1, durationMs: 3 }
const runArgs = { tabId: 't1', profile, childDb: null, contextKey: 'p1', sql: 'SELECT 1' }

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

    expect(controller.runFor('t1')).toEqual({ phase: 'done', result })
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
