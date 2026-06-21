// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ReactiveControllerHost } from 'lit'
import type { ColumnsResult, ConnectionProfile, ConnectResult, ConnectionStatus, DbObjects, ObjectsResult, TablesResult } from '../electron'
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

function stubSqlkit() {
  let listener: ((statuses: ConnectionStatus[]) => void) | null = null
  const tableCalls: Array<Deferred<TablesResult>> = []
  const columnCalls: Array<Deferred<ColumnsResult>> = []
  const objectCalls: Array<Deferred<ObjectsResult>> = []

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
  }
  ;(window as unknown as { sqlkit: unknown }).sqlkit = api

  const emit = (statuses: ConnectionStatus[]) => listener?.(statuses)
  const resolveMetadata = async (index: number, functionName: string) => {
    tableCalls[index]!.resolve({ success: true, tables: [] })
    columnCalls[index]!.resolve({ success: true, columns: [] })
    objectCalls[index]!.resolve({ success: true, objects: objectsWith(functionName) })
    await Promise.all([tableCalls[index]!.promise, columnCalls[index]!.promise, objectCalls[index]!.promise])
    await Promise.resolve()
  }

  return { api, emit, resolveMetadata }
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
    expect(api.listObjects).toHaveBeenCalledTimes(1)
    await resolveMetadata(0, 'fn_only_in_a')
    expect(controller.objects.p1?.functions.map((fn) => fn.name)).toEqual(['fn_only_in_a'])

    emit([status('db_b')])
    expect(controller.objects.p1).toBeUndefined()
    expect(api.listObjects).toHaveBeenCalledTimes(2)

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
    expect(api.listObjects).toHaveBeenCalledTimes(2)

    emit([status('db_b')])
    expect(controller.objects.p1).toBeUndefined()
    expect(api.listObjects).toHaveBeenCalledTimes(3)

    await resolveMetadata(1, 'fn_only_in_a_refreshed')
    expect(controller.objects.p1).toBeUndefined()

    await resolveMetadata(2, 'fn_only_in_b')
    expect(controller.objects.p1?.functions.map((fn) => fn.name)).toEqual(['fn_only_in_b'])
  })
})
