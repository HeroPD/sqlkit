// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ReactiveControllerHost } from 'lit'
import type { ColumnsResult, ConnectionProfile, ConnectResult, ConnectionStatus, DbObjects, ObjectsResult, TableRef, TableStatsResult, TablesResult } from '../electron'
import { ConnectionsController } from './connections'

const host = (): ReactiveControllerHost =>
  ({ addController() {}, removeController() {}, requestUpdate() {}, updateComplete: Promise.resolve(true) })

type Deferred<T> = {
  promise: Promise<T>
  resolve: (value: T) => void
}

const defer = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => (resolve = res))
  return { promise, resolve }
}

const status = (active: 'db_a' | 'db_b'): ConnectionStatus => ({
  profileId: 'p1',
  phase: 'connected',
  children: [
    { name: 'db_a', inUse: active === 'db_a' },
    { name: 'db_b', inUse: active === 'db_b' },
  ],
})

const objectsWith = (name: string): DbObjects => ({ functions: [{ schema: 'public', name, detail: '' }], types: [] })

const tableRef = (name: string): TableRef => ({ schema: 'public', name, kind: 'table' })

function stubSqlkit() {
  let listener: ((statuses: ConnectionStatus[]) => void) | null = null
  const tableCalls: Array<Deferred<TablesResult>> = []
  const columnCalls: Array<Deferred<ColumnsResult>> = []
  const objectCalls: Array<Deferred<ObjectsResult>> = []
  const statCalls: Array<Deferred<TableStatsResult>> = []

  const api = {
    onConnectionStatus: vi.fn((next: (statuses: ConnectionStatus[]) => void) => {
      listener = next
      return vi.fn()
    }),
    getConnectionStatuses: vi.fn(() => new Promise<ConnectionStatus[]>(() => {})),
    listTables: vi.fn(() => {
      const call = defer<TablesResult>()
      tableCalls.push(call)
      return call.promise
    }),
    listColumns: vi.fn(() => {
      const call = defer<ColumnsResult>()
      columnCalls.push(call)
      return call.promise
    }),
    listObjects: vi.fn(() => {
      const call = defer<ObjectsResult>()
      objectCalls.push(call)
      return call.promise
    }),
    listTableStats: vi.fn(() => {
      const call = defer<TableStatsResult>()
      statCalls.push(call)
      return call.promise
    }),
  }
  ;(window as unknown as { sqlkit: unknown }).sqlkit = api

  const emit = (statuses: ConnectionStatus[]) => listener?.(statuses)
  // Reads are issued one after another (they share a single database connection),
  // with optional table statistics last so essential metadata renders first.
  const settle = async <T>(calls: Array<Deferred<T>>, index: number, value: T) => {
    for (let i = 0; i < 50 && !calls[index]; i += 1) await Promise.resolve()
    calls[index]!.resolve(value)
    await calls[index]!.promise
    await Promise.resolve()
  }
  const resolveMetadata = async (
    index: number,
    functionName: string,
    statIndex: number | null = index,
    tables: TableRef[] = [],
  ) => {
    await settle(tableCalls, index, { success: true, tables })
    await settle(columnCalls, index, { success: true, columns: [] })
    await settle(objectCalls, index, { success: true, objects: objectsWith(functionName) })
    if (statIndex !== null) {
      await settle(statCalls, statIndex, {
        success: true,
        stats: [{ schema: 'public', name: 'users', totalBytes: index + 1 }],
      })
    }
    await Promise.resolve()
  }
  const settleStats = (index: number, result: TableStatsResult) => settle(statCalls, index, result)

  return { api, emit, resolveMetadata, settleStats }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('ConnectionsController.connect coalescing', () => {
  it('coalesces concurrent connects for one profile into a single attempt', async () => {
    const pending = defer<ConnectResult>()
    const connectDatabase = vi.fn(() => pending.promise)
    ;(window as unknown as { sqlkit: unknown }).sqlkit = {
      connectDatabase,
      getConnectionStatuses: vi.fn(() => Promise.resolve([] as ConnectionStatus[])),
      onConnectionStatus: vi.fn(() => vi.fn()),
    }
    const controller = new ConnectionsController(host())
    const profile = { id: 'p1' } as ConnectionProfile

    const first = controller.connect(profile)
    const second = controller.connect(profile)
    expect(connectDatabase).toHaveBeenCalledTimes(1)
    expect(first).toBe(second)

    pending.resolve({ success: true, serverVersion: 'PG' })
    await Promise.all([first, second])

    // Once it settles, a fresh connect starts a new attempt.
    await controller.connect(profile)
    expect(connectDatabase).toHaveBeenCalledTimes(2)
  })

  it('does not reuse an in-flight connect after a disconnect', async () => {
    const queue = [defer<ConnectResult>(), defer<ConnectResult>(), defer<ConnectResult>()]
    let next = 0
    const connectDatabase = vi.fn(() => queue[next++]!.promise)
    ;(window as unknown as { sqlkit: unknown }).sqlkit = {
      connectDatabase,
      disconnectDatabase: vi.fn(() => Promise.resolve()),
      getConnectionStatuses: vi.fn(() => Promise.resolve([] as ConnectionStatus[])),
      onConnectionStatus: vi.fn(() => vi.fn()),
    }
    const controller = new ConnectionsController(host())
    const profile = { id: 'p1' } as ConnectionProfile

    const first = controller.connect(profile)
    void controller.disconnect(profile.id)
    const second = controller.connect(profile)
    expect(second).not.toBe(first)
    expect(connectDatabase).toHaveBeenCalledTimes(2)

    // The superseded first attempt settling must not evict the newer entry:
    // a connect after it still coalesces onto the second attempt.
    queue[0]!.resolve({ success: true, serverVersion: 'PG' })
    await first
    const third = controller.connect(profile)
    expect(third).toBe(second)
    expect(connectDatabase).toHaveBeenCalledTimes(2)

    queue[1]!.resolve({ success: true, serverVersion: 'PG' })
    await Promise.all([second, third])
  })
})

describe('ConnectionsController metadata', () => {
  it('reloads function metadata when an all-databases status switches active child', async () => {
    const { api, emit, resolveMetadata } = stubSqlkit()
    const controller = new ConnectionsController(host())
    controller.hostConnected()

    emit([status('db_a')])
    expect(api.listTables).toHaveBeenCalledTimes(1)
    await resolveMetadata(0, 'fn_only_in_a')
    expect(controller.objects.p1?.functions.map((fn) => fn.name)).toEqual(['fn_only_in_a'])
    expect(controller.tableStats.p1?.[0]?.totalBytes).toBe(1)

    emit([status('db_b')])
    expect(controller.objects.p1).toBeUndefined()
    expect(api.listTables).toHaveBeenCalledTimes(2)

    await resolveMetadata(1, 'fn_only_in_b')
    expect(controller.objects.p1?.functions.map((fn) => fn.name)).toEqual(['fn_only_in_b'])
  })

  it('ignores a stale function metadata refresh after the active child changes', async () => {
    const { api, emit, resolveMetadata } = stubSqlkit()
    const controller = new ConnectionsController(host())
    controller.hostConnected()

    emit([status('db_a')])
    await resolveMetadata(0, 'fn_only_in_a')
    expect(controller.objects.p1?.functions.map((fn) => fn.name)).toEqual(['fn_only_in_a'])

    controller.refresh('p1')
    expect(api.listTables).toHaveBeenCalledTimes(2)

    emit([status('db_b')])
    expect(controller.objects.p1).toBeUndefined()
    // The child switch does not race the refresh already in flight: its read is
    // held until that one lands, so the two never target different children at
    // once and retire each other's connection pool.
    expect(api.listTables).toHaveBeenCalledTimes(2)

    await resolveMetadata(1, 'fn_only_in_a_refreshed', null)
    expect(controller.objects.p1).toBeUndefined()
    expect(api.listTables).toHaveBeenCalledTimes(3)

    await resolveMetadata(2, 'fn_only_in_b', 1)
    expect(controller.objects.p1?.functions.map((fn) => fn.name)).toEqual(['fn_only_in_b'])
  })

  it('re-reads table sizes only when the table list changed', async () => {
    const { api, emit, resolveMetadata } = stubSqlkit()
    const controller = new ConnectionsController(host())
    controller.hostConnected()

    emit([status('db_a')])
    await resolveMetadata(0, 'fn', 0, [tableRef('users')])
    expect(api.listTableStats).toHaveBeenCalledTimes(1)
    expect(controller.tableStats.p1?.[0]?.totalBytes).toBe(1)

    // Sizing every relation is the priciest metadata read there is, and
    // refresh() runs after each commit — an unchanged list keeps what it has.
    controller.refresh('p1')
    await resolveMetadata(1, 'fn', null, [tableRef('users')])
    expect(api.listTableStats).toHaveBeenCalledTimes(1)
    expect(controller.tableStats.p1?.[0]?.totalBytes).toBe(1)

    // A table appearing or vanishing does re-read them.
    controller.refresh('p1')
    await resolveMetadata(2, 'fn', 1, [tableRef('users'), tableRef('orders')])
    expect(api.listTableStats).toHaveBeenCalledTimes(2)
    expect(controller.tableStats.p1?.[0]?.totalBytes).toBe(3)
  })

  it('leaves sizes absent, not empty, when the engine cannot report them', async () => {
    const { emit, resolveMetadata, settleStats } = stubSqlkit()
    const controller = new ConnectionsController(host())
    controller.hostConnected()

    emit([status('db_a')])
    await resolveMetadata(0, 'fn', null, [tableRef('users')])
    await settleStats(0, { success: false, error: 'unsupported' })

    // Absent rather than [], so the explorer can drop its size column instead
    // of ruling a dash down every row.
    expect(controller.tableStats.p1).toBeUndefined()
  })
})

describe('ConnectionsController metadata concurrency', () => {
  it('runs one metadata read at a time, collapsing the rest into a single follow-up', async () => {
    const { api, emit } = stubSqlkit()
    const controller = new ConnectionsController(host())
    controller.hostConnected()

    emit([status('db_a')])
    expect(api.listTables).toHaveBeenCalledTimes(1)

    // A driver keeps a pool for the child in use and retires the others, so two
    // loads for different children retire each other's pool and both come back
    // "Pool is closed" for a database that has tables. Requests made mid-read
    // wait rather than racing.
    controller.refresh('p1')
    controller.refresh('p1')
    controller.refresh('p1')
    await Promise.resolve()
    expect(api.listTables).toHaveBeenCalledTimes(1)
  })
})

describe('ConnectionsController manual transactions', () => {
  it('refreshes metadata only after the transaction fully closes', async () => {
    const endTransaction = vi.fn()
      .mockResolvedValueOnce({ success: true, transaction: { childDb: 'db_a' } })
      .mockResolvedValueOnce({ success: true })
    ;(window as unknown as { sqlkit: unknown }).sqlkit = { endTransaction }
    const controller = new ConnectionsController(host())
    const refresh = vi.spyOn(controller, 'refresh').mockImplementation(() => {})

    await controller.endTransaction('p1', 'commit')
    expect(refresh).not.toHaveBeenCalled()

    await controller.endTransaction('p1', 'commit')
    expect(refresh).toHaveBeenCalledWith('p1')
  })
})

describe('ConnectionsController.clearError', () => {
  const withClear = () => {
    const clearConnectionError = vi.fn(() => Promise.resolve())
    ;(window as unknown as { sqlkit: unknown }).sqlkit = { clearConnectionError }
    return { controller: new ConnectionsController(host()), clearConnectionError }
  }

  it('clears an error status through IPC', async () => {
    const { controller, clearConnectionError } = withClear()
    controller.statuses = { p1: { profileId: 'p1', phase: 'error', error: 'boom' } }

    await controller.clearError('p1')

    expect(clearConnectionError).toHaveBeenCalledWith('p1')
  })

  it('is a no-op for a connected profile or one with no status', async () => {
    const { controller, clearConnectionError } = withClear()
    controller.statuses = { p1: { profileId: 'p1', phase: 'connected' } }

    await controller.clearError('p1')
    await controller.clearError('missing')

    expect(clearConnectionError).not.toHaveBeenCalled()
  })
})

describe('ConnectionsController.readOnly', () => {
  it('reports the live session guardrail, only while connected', () => {
    stubSqlkit()
    const controller = new ConnectionsController(host())
    controller.statuses = {
      ro: { profileId: 'ro', phase: 'connected', readOnly: true },
      rw: { profileId: 'rw', phase: 'connected' },
      err: { profileId: 'err', phase: 'error', error: 'boom' },
    }

    expect(controller.readOnly('ro')).toBe(true)
    expect(controller.readOnly('rw')).toBe(false)
    expect(controller.readOnly('err')).toBe(false)
    expect(controller.readOnly('missing')).toBe(false)
  })
})
