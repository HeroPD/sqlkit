// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import type { InspectResult, TableInspection, TableRef } from '../electron'
import { TableInspect } from './table-inspect'

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void }
const defer = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => (resolve = r))
  return { promise, resolve }
}

const internals = (view: TableInspect) =>
  view as never as {
    _load(): Promise<void>
    _state: { phase: string; inspection?: TableInspection }
    willUpdate(changed: Map<string, unknown>): void
  }

const inspection = (title: string): TableInspection => ({ columns: [], sections: [{ title, rows: [] }] })

describe('TableInspect stale-load guard', () => {
  it('ignores a result for a child the user already switched away from', async () => {
    const table: TableRef = { schema: 'public', name: 't', kind: 'table' }
    const billing = defer<InspectResult>()
    const analytics = defer<InspectResult>()
    const inspectTable = vi.fn((_profileId: string, childDb: string | null, _table: TableRef) =>
      childDb === 'billing' ? billing.promise : analytics.promise,
    )
    ;(window as never as { sqlkit: { inspectTable: typeof inspectTable } }).sqlkit = { inspectTable }

    const view = new TableInspect()
    view.profileId = 'p1'
    view.childDb = 'billing'
    view.table = table
    const first = internals(view)._load()

    // Same table ref, but the user switched child mid-flight.
    view.childDb = 'analytics'
    const second = internals(view)._load()

    analytics.resolve({ success: true, inspection: inspection('Analytics') })
    billing.resolve({ success: true, inspection: inspection('Billing') })
    await Promise.all([first, second])

    expect(internals(view)._state).toMatchObject({ phase: 'done', inspection: inspection('Analytics') })
  })
})

describe('TableInspect reload triggers', () => {
  it('reloads when only objectKind changes (object ref unchanged)', () => {
    const object = { schema: 'public', name: 'f', detail: '' }
    const inspectObject = vi.fn(() => Promise.resolve<InspectResult>({ success: true, inspection: inspection('x') }))
    ;(window as never as { sqlkit: { inspectObject: typeof inspectObject } }).sqlkit = { inspectObject }

    const view = new TableInspect()
    view.profileId = 'p1'
    view.object = object
    view.objectKind = 'function'
    const inner = internals(view)

    inner.willUpdate(new Map([['object', undefined]]))
    expect(inspectObject).toHaveBeenCalledTimes(1)
    expect(inspectObject).toHaveBeenLastCalledWith('p1', null, object, 'function')

    // A retarget that changes only objectKind (e.g. function → type, or the kind
    // arriving after the object) must still refetch.
    view.objectKind = 'type'
    inner.willUpdate(new Map([['objectKind', 'function']]))
    expect(inspectObject).toHaveBeenCalledTimes(2)
    expect(inspectObject).toHaveBeenLastCalledWith('p1', null, object, 'type')
  })
})
