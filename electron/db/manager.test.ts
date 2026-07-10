import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConnectionProfile, QueryResult } from '../../src/electron'
import type { Driver } from './driver'
import type { Endpoint } from './transport'

// The manager builds its drivers and endpoints through createDriver/resolveEndpoint;
// mocking both lets every lifecycle path be exercised with a fake driver and no
// live socket. result-sessions stays real so paging/eviction is genuinely tested.
const hoisted = vi.hoisted(
  (): {
    driver: Driver
    endpoint: Endpoint
    resolveImpl: null | (() => Promise<Endpoint>)
    createImpl: null | (() => Driver)
  } => {
    const base: Driver = {
      connect: () => Promise.resolve('FakeDB 1.0'),
      disconnect: () => Promise.resolve(),
      query: () => Promise.resolve({ columns: [], rows: [], rowCount: 0, durationMs: 1 }),
      listTables: () => Promise.resolve([]),
      listColumns: () => Promise.resolve([]),
      inspectTable: () => Promise.resolve({ columns: [], sections: [] }),
    }
    return {
      driver: base,
      endpoint: { host: 'db.local', port: 5432, tunnel: null },
      resolveImpl: null,
      createImpl: null,
    }
  },
)

vi.mock('./transport', () => ({
  resolveEndpoint: vi.fn(() => (hoisted.resolveImpl ? hoisted.resolveImpl() : Promise.resolve(hoisted.endpoint))),
}))

vi.mock('./driver', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./driver')>()
  return { ...actual, createDriver: vi.fn(() => (hoisted.createImpl ? hoisted.createImpl() : hoisted.driver)) }
})

import { createConnectionManager } from './manager'
import { PAGE_SIZE } from './result-sessions'

const profile = (overrides: Partial<ConnectionProfile> = {}): ConnectionProfile => ({
  id: 'p1',
  name: 'p1',
  engine: 'postgresql',
  host: 'db.local',
  port: '5432',
  username: 'u',
  password: 'p',
  database: 'app',
  file: '',
  folder: '',
  ...overrides,
})

const fakeDriver = (overrides: Partial<Driver> = {}): Driver => ({
  connect: vi.fn(() => Promise.resolve('FakeDB 1.0')),
  disconnect: vi.fn(() => Promise.resolve()),
  query: vi.fn(() => Promise.resolve({ columns: [], rows: [], rowCount: 0, durationMs: 1 })),
  listTables: vi.fn(() => Promise.resolve([])),
  listColumns: vi.fn(() => Promise.resolve([])),
  inspectTable: vi.fn(() => Promise.resolve({ columns: [], sections: [] })),
  ...overrides,
})

const rowsResult = (n: number): QueryResult => ({
  columns: ['a'],
  rows: Array.from({ length: n }, (_, i) => [i]),
  rowCount: n,
  durationMs: 1,
})

const tunnelEndpoint = (close: () => Promise<void>): Endpoint => ({ host: 'h', port: 1, tunnel: { localPort: 1, close } })

beforeEach(() => {
  hoisted.driver = fakeDriver()
  hoisted.endpoint = { host: 'db.local', port: 5432, tunnel: null }
  hoisted.resolveImpl = null
  hoisted.createImpl = null
})

describe('connection manager: connect lifecycle', () => {
  it('broadcasts connecting then connected and reports the version', async () => {
    hoisted.driver = fakeDriver({ connect: vi.fn(() => Promise.resolve('PostgreSQL 17')) })
    const broadcast = vi.fn()
    const manager = createConnectionManager(broadcast)

    const result = await manager.connect(profile())

    expect(result).toEqual({ success: true, serverVersion: 'PostgreSQL 17' })
    const phases = broadcast.mock.calls.map((call) => (call[0] as { phase: string }[])[0]?.phase)
    expect(phases).toContain('connecting')
    expect(manager.statuses()).toEqual([expect.objectContaining({ phase: 'connected', serverVersion: 'PostgreSQL 17' })])
  })

  it('flags an error and tears down the driver + tunnel when connect throws', async () => {
    const close = vi.fn(() => Promise.resolve())
    const disconnect = vi.fn(() => Promise.resolve())
    hoisted.endpoint = tunnelEndpoint(close)
    hoisted.driver = fakeDriver({ connect: vi.fn(() => Promise.reject(new Error('auth failed'))), disconnect })
    const manager = createConnectionManager(vi.fn())

    const result = await manager.connect(profile())

    expect(result).toEqual({ success: false, error: 'auth failed' })
    expect(manager.statuses()).toEqual([expect.objectContaining({ phase: 'error', error: 'auth failed' })])
    expect(disconnect).toHaveBeenCalled()
    expect(close).toHaveBeenCalled()
  })

  it('supersedes an in-flight connect and tears down its resources', async () => {
    const firstClose = vi.fn(() => Promise.resolve())
    const secondClose = vi.fn(() => Promise.resolve())
    let releaseFirst!: (version: string) => void
    let signalConnecting!: () => void
    const connecting = new Promise<void>((resolve) => (signalConnecting = resolve))
    const firstConnect = new Promise<string>((resolve) => (releaseFirst = resolve))

    const firstDriver = fakeDriver({
      connect: vi.fn(() => {
        signalConnecting()
        return firstConnect
      }),
    })
    const secondDriver = fakeDriver({ connect: vi.fn(() => Promise.resolve('PG second')) })
    const endpoints = [tunnelEndpoint(firstClose), tunnelEndpoint(secondClose)]
    const drivers = [firstDriver, secondDriver]
    hoisted.resolveImpl = () => Promise.resolve(endpoints.shift()!)
    hoisted.createImpl = () => drivers.shift()!

    const manager = createConnectionManager(vi.fn())
    const firstPromise = manager.connect(profile())
    await connecting // the first attempt is now hanging inside driver.connect()
    const secondResult = await manager.connect(profile())
    releaseFirst('PG first')
    const firstResult = await firstPromise

    expect(secondResult).toEqual({ success: true, serverVersion: 'PG second' })
    expect(firstResult).toEqual({ success: false, error: 'Connection superseded' })
    expect(firstClose).toHaveBeenCalled()
    expect(secondClose).not.toHaveBeenCalled()
    expect(manager.statuses()).toEqual([expect.objectContaining({ phase: 'connected', serverVersion: 'PG second' })])
  })
})

describe('connection manager: disconnect', () => {
  it('closes the driver and tunnel and drops the status', async () => {
    const close = vi.fn(() => Promise.resolve())
    const disconnect = vi.fn(() => Promise.resolve())
    hoisted.endpoint = tunnelEndpoint(close)
    hoisted.driver = fakeDriver({ disconnect })
    const manager = createConnectionManager(vi.fn())
    await manager.connect(profile())

    await manager.disconnect('p1')

    expect(disconnect).toHaveBeenCalled()
    expect(close).toHaveBeenCalled()
    expect(manager.statuses()).toEqual([])
  })

  it('disconnect is a no-op for an unknown profile', async () => {
    const manager = createConnectionManager(vi.fn())
    await expect(manager.disconnect('missing')).resolves.toBeUndefined()
  })

  it('disconnectAll tears down every connection', async () => {
    const manager = createConnectionManager(vi.fn())
    hoisted.driver = fakeDriver()
    await manager.connect(profile({ id: 'a' }))
    hoisted.driver = fakeDriver()
    await manager.connect(profile({ id: 'b' }))
    expect(manager.statuses()).toHaveLength(2)

    await manager.disconnectAll()

    expect(manager.statuses()).toEqual([])
  })
})

describe('connection manager: metadata is child-scoped', () => {
  it('forwards the requested childDb to the driver instead of relying on the active child', async () => {
    const listTables = vi.fn(() => Promise.resolve([]))
    const listColumns = vi.fn(() => Promise.resolve([]))
    const inspectTable = vi.fn(() => Promise.resolve({ columns: [], sections: [] }))
    const listObjects = vi.fn(() => Promise.resolve({ functions: [], types: [] }))
    const inspectObject = vi.fn(() => Promise.resolve({ columns: [], sections: [] }))
    const inspectServer = vi.fn(() => Promise.resolve([]))
    hoisted.driver = fakeDriver({ listTables, listColumns, inspectTable, listObjects, inspectObject, inspectServer })
    const manager = createConnectionManager(vi.fn())
    await manager.connect(profile())

    const table = { schema: 'public', name: 't', kind: 'table' as const }
    const object = { schema: 'public', name: 'f', detail: '' }
    await manager.listTables('p1', 'billing')
    await manager.listColumns('p1', 'billing')
    await manager.inspectTable('p1', table, 'billing')
    await manager.listObjects('p1', 'billing')
    await manager.inspectObject('p1', object, 'function', 'billing')
    await manager.inspectServer('p1', 'billing')

    expect(listTables).toHaveBeenCalledWith('billing')
    expect(listColumns).toHaveBeenCalledWith('billing')
    expect(inspectTable).toHaveBeenCalledWith(table, 'billing')
    expect(listObjects).toHaveBeenCalledWith('billing')
    expect(inspectObject).toHaveBeenCalledWith(object, 'function', 'billing')
    expect(inspectServer).toHaveBeenCalledWith('billing')
  })
})

describe('connection manager: query + paging', () => {
  it('rejects a query when the profile is not connected', async () => {
    const manager = createConnectionManager(vi.fn())
    expect(await manager.query('p1', null, 'select 1')).toEqual({ success: false, error: 'Not connected' })
  })

  it('returns a small result inline without opening a session', async () => {
    hoisted.driver = fakeDriver({ query: vi.fn(() => Promise.resolve(rowsResult(3))) })
    const manager = createConnectionManager(vi.fn())
    await manager.connect(profile())

    const response = await manager.query('p1', null, 'select 1')
    if (!response.success) throw new Error(response.error)
    expect(response.result.rows).toHaveLength(3)
    expect(response.result.sessionId).toBeUndefined()
  })

  it('opens a session for a large result and pages the rest', async () => {
    hoisted.driver = fakeDriver({ query: vi.fn(() => Promise.resolve(rowsResult(PAGE_SIZE + 50))) })
    const manager = createConnectionManager(vi.fn())
    await manager.connect(profile())

    const response = await manager.query('p1', null, 'select * from t')
    if (!response.success) throw new Error(response.error)
    expect(response.result.rows).toHaveLength(PAGE_SIZE)
    expect(response.result.bufferedRowCount).toBe(PAGE_SIZE + 50)
    const sessionId = response.result.sessionId
    expect(sessionId).toBeDefined()

    const page = manager.fetchRows(sessionId!, PAGE_SIZE, PAGE_SIZE)
    expect(page).toEqual({ success: true, rows: Array.from({ length: 50 }, (_, i) => [PAGE_SIZE + i]) })
  })

  it('returns a single sessionless page when disconnected mid-query', async () => {
    let release!: (result: QueryResult) => void
    const pending = new Promise<QueryResult>((resolve) => (release = resolve))
    hoisted.driver = fakeDriver({ query: vi.fn(() => pending) })
    const manager = createConnectionManager(vi.fn())
    await manager.connect(profile())

    const queryPromise = manager.query('p1', null, 'select * from big')
    await manager.disconnect('p1') // the connection drops while the query is in flight
    release(rowsResult(PAGE_SIZE + 100))
    const response = await queryPromise

    if (!response.success) throw new Error(response.error)
    expect(response.result.rows).toHaveLength(PAGE_SIZE)
    expect(response.result.sessionId).toBeUndefined() // no buffer registered that nobody could free
  })

  it('does not attach an old query result after reconnecting the same profile', async () => {
    let release!: (result: QueryResult) => void
    const pending = new Promise<QueryResult>((resolve) => (release = resolve))
    const firstDriver = fakeDriver({ query: vi.fn(() => pending) })
    const secondDriver = fakeDriver()
    const drivers = [firstDriver, secondDriver]
    hoisted.createImpl = () => drivers.shift()!
    const manager = createConnectionManager(vi.fn())
    await manager.connect(profile())

    const queryPromise = manager.query('p1', null, 'select * from old_driver')
    await manager.disconnect('p1')
    await manager.connect(profile())
    release(rowsResult(PAGE_SIZE + 100))
    const response = await queryPromise

    if (!response.success) throw new Error(response.error)
    expect(response.result.rows).toHaveLength(PAGE_SIZE)
    expect(response.result.sessionId).toBeUndefined()
  })

  it('fetchRows fails for an unknown or evicted session', () => {
    const manager = createConnectionManager(vi.fn())
    expect(manager.fetchRows('gone', 0, 10)).toEqual({ success: false, error: expect.stringContaining('expired') })
  })
})

describe('connection manager: cancelQuery', () => {
  const connected = async (overrides: Partial<Driver>) => {
    hoisted.driver = fakeDriver(overrides)
    const manager = createConnectionManager(vi.fn())
    await manager.connect(profile())
    return manager
  }

  it('reports when cancellation is unsupported by the driver', async () => {
    const manager = await connected({}) // no cancel method
    expect(await manager.cancelQuery('p1')).toEqual({ success: false, error: expect.stringContaining('not supported') })
  })

  it('reports nothing-running when no backend is in flight', async () => {
    const manager = await connected({ cancel: vi.fn(() => Promise.resolve({ running: 0, cancelled: 0 })) })
    expect(await manager.cancelQuery('p1')).toEqual({ success: false, error: expect.stringContaining('No query') })
  })

  it('distinguishes a running-but-untargetable query from an idle one', async () => {
    const manager = await connected({ cancel: vi.fn(() => Promise.resolve({ running: 1, cancelled: 0 })) })
    const result = await manager.cancelQuery('p1')
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/could not be cancelled yet/)
  })

  it('succeeds when a backend was actually targeted', async () => {
    const cancel = vi.fn(() => Promise.resolve({ running: 1, cancelled: 1 }))
    const manager = await connected({ cancel })
    expect(await manager.cancelQuery('p1', 'query-7')).toEqual({ success: true })
    expect(cancel).toHaveBeenCalledWith('query-7')
  })
})

describe('connection manager: database mutations', () => {
  it('switches the active child and rebroadcasts', async () => {
    const useChild = vi.fn((database: string) => database === 'billing')
    hoisted.driver = fakeDriver({ useChild, children: vi.fn(() => []) })
    const broadcast = vi.fn()
    const manager = createConnectionManager(broadcast)
    await manager.connect(profile())
    broadcast.mockClear()

    expect(manager.setActiveChild('p1', 'billing')).toEqual({ success: true })
    expect(useChild).toHaveBeenCalledWith('billing')
    expect(broadcast).toHaveBeenCalled()
  })

  it('reports an unknown child', async () => {
    hoisted.driver = fakeDriver({ useChild: vi.fn(() => false), children: vi.fn(() => []) })
    const manager = createConnectionManager(vi.fn())
    await manager.connect(profile())
    expect(manager.setActiveChild('p1', 'nope')).toEqual({ success: false, error: expect.stringContaining('not available') })
  })

  it('runs create/drop database through the driver', async () => {
    const createDatabase = vi.fn(() => Promise.resolve())
    const dropDatabase = vi.fn(() => Promise.resolve())
    hoisted.driver = fakeDriver({ createDatabase, dropDatabase, children: vi.fn(() => []) })
    const manager = createConnectionManager(vi.fn())
    await manager.connect(profile())

    expect(await manager.createDatabase('p1', 'newdb')).toEqual({ success: true })
    expect(createDatabase).toHaveBeenCalledWith('newdb')
    expect(await manager.dropDatabase('p1', 'olddb')).toEqual({ success: true })
    expect(dropDatabase).toHaveBeenCalledWith('olddb')
  })

  it('surfaces a driver error from a mutation', async () => {
    hoisted.driver = fakeDriver({
      createDatabase: vi.fn(() => Promise.reject(new Error('already exists'))),
      children: vi.fn(() => []),
    })
    const manager = createConnectionManager(vi.fn())
    await manager.connect(profile())
    expect(await manager.createDatabase('p1', 'dup')).toEqual({ success: false, error: 'already exists' })
  })

  it('reports unsupported when the engine has no create-database', async () => {
    hoisted.driver = fakeDriver() // file-based engine, no createDatabase
    const manager = createConnectionManager(vi.fn())
    await manager.connect(profile())
    expect(await manager.createDatabase('p1', 'x')).toEqual({ success: false, error: expect.stringContaining('Not supported') })
  })
})

describe('connection manager: runBatch', () => {
  it('forwards statements to the connected driver', async () => {
    const runBatch = vi.fn(() => Promise.resolve({ success: true as const }))
    hoisted.driver = fakeDriver({ runBatch })
    const manager = createConnectionManager(vi.fn())
    await manager.connect(profile())

    const statements = [{ sql: 'update t set a = $1 where id = $2', params: [1, 2] }]
    expect(await manager.runBatch('p1', 'child', statements)).toEqual({ success: true })
    expect(runBatch).toHaveBeenCalledWith(statements, 'child')
  })

  it('reports not connected for an unknown profile', async () => {
    const manager = createConnectionManager(vi.fn())
    expect(await manager.runBatch('missing', null, [])).toEqual({ success: false, error: 'Not connected' })
  })

  it('reports unsupported when the driver cannot run batches', async () => {
    hoisted.driver = fakeDriver() // no runBatch
    const manager = createConnectionManager(vi.fn())
    await manager.connect(profile())
    expect(await manager.runBatch('p1', null, [])).toEqual({
      success: false,
      error: 'Atomic writes are not supported on this connection',
    })
  })
})
