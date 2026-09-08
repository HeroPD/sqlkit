// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import type { ReactiveController, ReactiveControllerHost } from 'lit'
import type { ConnectionProfile, QueryResponse } from '../electron'
import { TransactionsController, type OpenTransaction } from './transactions'

const profile = (id: string, name: string): ConnectionProfile => ({
  id,
  name,
  engine: 'postgresql',
  host: '',
  port: '',
  username: '',
  password: '',
  database: 'db_a',
  databaseMode: 'all',
  file: '',
  folder: '',
})

const fakeHost = (): ReactiveControllerHost => ({
  addController: (_controller: ReactiveController) => {},
  removeController: (_controller: ReactiveController) => {},
  requestUpdate: () => {},
  updateComplete: Promise.resolve(true),
})

type Overrides = {
  connections?: ConnectionProfile[]
  activeProfile?: ConnectionProfile | null
  open?: Record<string, OpenTransaction>
  endTransaction?: (profileId: string, mode: 'commit' | 'rollback') => Promise<{ success: boolean; transaction?: unknown; error?: string }>
}

const build = (overrides: Overrides = {}) => {
  const connections = overrides.connections ?? [profile('p1', 'Postgres')]
  const open = overrides.open ?? {}
  const notice = vi.fn()
  const setActiveDb = vi.fn()
  const endTransaction = overrides.endTransaction ?? vi.fn(() => Promise.resolve({ success: true }))
  const controller = new TransactionsController(fakeHost(), {
    connections: () => connections,
    activeProfile: () => overrides.activeProfile ?? connections[0] ?? null,
    profileById: (id) => connections.find((entry) => entry.id === id) ?? null,
    openOn: (id) => open[id],
    endTransaction,
    notice,
    setActiveDb,
  })
  return { controller, notice, setActiveDb, endTransaction }
}

const ok: QueryResponse = { success: true, result: { columns: [], rows: [], rowCount: 1, durationMs: 3 } }

describe('TransactionsController sessions', () => {
  it('records and clears the renderer-local transaction session', () => {
    const { controller } = build()

    controller.recordRun({
      profileId: 'p1', childDb: 'db_a', sourceTabName: 'customers.sql', sql: 'BEGIN', response: ok,
      runStartedAt: Date.now(), wasOpen: false, isOpen: true, restarted: false,
    })

    expect(controller.runsFor('p1')).toHaveLength(1)
    expect(controller.runsFor('p1')[0]?.tabName).toBe('customers.sql')

    controller.recordRun({
      profileId: 'p1', childDb: 'db_a', sourceTabName: 'customers.sql', sql: 'COMMIT', response: ok,
      runStartedAt: Date.now(), wasOpen: true, isOpen: false, restarted: false,
    })
    expect(controller.sessionFor('p1')).toBeUndefined()
  })

  // 'COMMIT; BEGIN' closes one transaction and opens another: the new session
  // must not inherit the runs of the one that just committed.
  it('starts a fresh session when a run restarts the transaction', () => {
    const { controller } = build()
    const args = {
      profileId: 'p1', childDb: 'db_a', sourceTabName: 'q.sql', response: ok,
      runStartedAt: Date.now(), isOpen: true,
    }
    controller.recordRun({ ...args, sql: 'BEGIN', wasOpen: false, restarted: false })
    controller.recordRun({ ...args, sql: 'COMMIT; BEGIN', wasOpen: true, restarted: true })
    expect(controller.runsFor('p1')).toHaveLength(1)
    expect(controller.runsFor('p1')[0]?.sql).toBe('COMMIT; BEGIN')
  })

  it('keeps session history when a nested SQL Server commit leaves the transaction open', async () => {
    const { controller } = build({
      endTransaction: vi.fn(() => Promise.resolve({ success: true, transaction: { childDb: 'db_a' } })),
    })
    controller.recordRun({
      profileId: 'p1', childDb: 'db_a', sourceTabName: 'q.sql', sql: 'BEGIN TRAN; BEGIN TRAN', response: ok,
      runStartedAt: Date.now(), wasOpen: false, isOpen: true, restarted: false,
    })
    controller.togglePopover('p1')
    controller.toggleExpanded('p1')

    await controller.end('p1', 'commit')

    expect(controller.runsFor('p1')).toHaveLength(1)
    expect(controller.popoverProfileId).toBe('p1')
    expect(controller.isExpanded('p1')).toBe(true)
  })

  it('drops the session, popover and disclosure once nothing is left open', async () => {
    const { controller } = build()
    controller.recordRun({
      profileId: 'p1', childDb: 'db_a', sourceTabName: 'q.sql', sql: 'BEGIN', response: ok,
      runStartedAt: Date.now(), wasOpen: false, isOpen: true, restarted: false,
    })
    controller.togglePopover('p1')
    controller.toggleExpanded('p1')

    await controller.end('p1', 'rollback')

    expect(controller.sessionFor('p1')).toBeUndefined()
    expect(controller.popoverProfileId).toBeNull()
    expect(controller.isExpanded('p1')).toBe(false)
  })

  it('reports a refused commit where run errors show', async () => {
    const { controller, notice } = build({
      endTransaction: vi.fn(() => Promise.resolve({ success: false, error: 'could not serialize access' })),
    })
    await controller.end('p1', 'commit')
    expect(notice).toHaveBeenCalledWith('could not serialize access')
  })
})

describe('TransactionsController popovers', () => {
  const two = [profile('p1', 'Postgres'), profile('p2', 'Reporting')]

  it('lists only the connections actually holding a transaction', () => {
    const { controller } = build({ connections: two, open: { p2: { childDb: 'analytics' } } })
    expect(controller.owners().map((owner) => owner.profile.id)).toEqual(['p2'])
  })

  it('opens one popover at a time, and closes the manager behind it', () => {
    const { controller } = build()
    controller.toggleManager(true)
    controller.togglePopover('p1')
    expect(controller.managerOpen).toBe(false)
    expect(controller.popoverProfileId).toBe('p1')
    controller.toggleManager()
    expect(controller.popoverProfileId).toBeNull()
  })

  // An open disclosure over a transaction that has ended, or a connection that
  // is no longer active, would keep claiming a session that is not there.
  it('closes a popover whose transaction is gone', () => {
    const { controller } = build({ open: { p1: { childDb: 'db_a' } } })
    controller.togglePopover('p1')
    controller.reconcile()
    expect(controller.popoverProfileId).toBe('p1')

    const gone = build()
    gone.controller.togglePopover('p1')
    gone.controller.reconcile()
    expect(gone.controller.popoverProfileId).toBeNull()
  })

  it('closes the manager when no other connection is left behind it', () => {
    const { controller } = build({ connections: two, open: { p1: { childDb: 'db_a' } } })
    controller.toggleManager(true)
    controller.reconcile()
    expect(controller.managerOpen).toBe(false)
  })

  it('switches the active database and stands the manager down', () => {
    const { controller, setActiveDb } = build({ connections: two, open: { p2: { childDb: 'analytics' } } })
    controller.toggleManager(true)
    controller.switchTo('p2', 'analytics')
    expect(setActiveDb).toHaveBeenCalledWith('p2', 'analytics')
    expect(controller.managerOpen).toBe(false)
  })
})
