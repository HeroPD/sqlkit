// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import type { InspectColumn, InspectResult, TableInspection, TableRef } from '../electron'
import { TableInspect, type ColumnAlterEventDetail } from './table-inspect'

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
    _canEdit(field: 'name' | 'dataType' | 'comment' | 'default' | 'nullable'): boolean
    _commitText(col: InspectColumn, field: 'name' | 'dataType' | 'comment' | 'default', raw: string): void
    _setNullable(col: InspectColumn, value: boolean): void
    _fieldNullable(col: InspectColumn): boolean
    _edits: Map<string, Record<string, unknown>>
    _editing: { col: string; field: string } | null
    _typeItems(col: InspectColumn, filter?: string): Array<{ id: string; label: string; checked?: boolean }>
    _onCellMenuPick(menu: { col: InspectColumn; kind: 'nullable' | 'type' }, id: string): void
    _onCellClick(col: InspectColumn, field: 'name' | 'dataType' | 'comment' | 'default'): void
    _openTypeMenu(event: MouseEvent, col: InspectColumn): void
    _onEditKeydown(event: KeyboardEvent, col: InspectColumn, field: 'name' | 'dataType' | 'comment' | 'default'): void
    _cellMenu: { kind: string; filter?: string } | null
    _blurCommitAt: number
  }

const inspectCol = (over: Partial<InspectColumn>): InspectColumn => ({
  name: 'age',
  dataType: 'integer',
  nullable: true,
  default: null,
  primaryKey: false,
  comment: null,
  ...over,
})

// A never-resolving inspectTable so the reactive _load scheduled by setting
// table/engine can't reject in tests that don't drive a load.
const stubInspect = () => {
  const inspectTable = vi.fn(() => new Promise<InspectResult>(() => {}))
  ;(window as never as { sqlkit: { inspectTable: typeof inspectTable } }).sqlkit = { inspectTable }
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

describe('TableInspect column editing', () => {
  it('stages a text edit and drops it when reverted to the original', () => {
    stubInspect()
    const view = new TableInspect()
    const column = inspectCol({ name: 'age' })

    internals(view)._commitText(column, 'name', 'age_years')
    expect(view.hasPendingChanges()).toBe(true)

    // Setting it back to the loaded value un-stages the whole column.
    internals(view)._commitText(column, 'name', 'age')
    expect(view.hasPendingChanges()).toBe(false)
  })

  it('gates editable fields by engine — Postgres all fields, SQLite name only', () => {
    stubInspect()
    const pg = new TableInspect()
    pg.table = { schema: 'public', name: 't', kind: 'table' }
    pg.engine = 'postgresql'
    expect(internals(pg)._canEdit('name')).toBe(true)
    expect(internals(pg)._canEdit('dataType')).toBe(true)
    expect(internals(pg)._canEdit('comment')).toBe(true)
    expect(internals(pg)._canEdit('default')).toBe(true)
    expect(internals(pg)._canEdit('nullable')).toBe(true)

    const lite = new TableInspect()
    lite.table = { schema: null, name: 't', kind: 'table' }
    lite.engine = 'sqlite'
    expect(internals(lite)._canEdit('name')).toBe(true)
    expect(internals(lite)._canEdit('dataType')).toBe(false)
    expect(internals(lite)._canEdit('default')).toBe(false)
    expect(internals(lite)._canEdit('nullable')).toBe(false)
  })

  it('stages an emptied default as a drop, not a revert', () => {
    stubInspect()
    const view = new TableInspect()
    const column = inspectCol({ name: 'age', default: '0' })

    internals(view)._commitText(column, 'default', '')
    expect(internals(view)._edits.get('age')).toEqual({ default: '' })

    internals(view)._commitText(column, 'default', '0')
    expect(view.hasPendingChanges()).toBe(false)
  })

  it('offers the engine types with the current one check-marked, plus Custom…', () => {
    stubInspect()
    const view = new TableInspect()
    view.engine = 'postgresql'
    const items = internals(view)._typeItems(inspectCol({ dataType: 'integer' }))

    // 'integer' and the menu's 'int' entry abbreviate to the same type.
    expect(items.find((item) => item.checked)?.label).toBe('int')
    expect(items.at(-1)).toEqual({ id: 'custom', label: 'Custom…' })
    expect(items.length).toBeGreaterThan(10)
  })

  it('check-marks a parameterized template by base type name', () => {
    stubInspect()
    const view = new TableInspect()
    view.engine = 'postgresql'
    const items = internals(view)._typeItems(inspectCol({ dataType: 'character varying(64)' }))
    expect(items.find((item) => item.checked)?.label).toBe('varchar(255)')
  })

  it('stages a bare type pick and routes templates/Custom… to the inline editor', () => {
    stubInspect()
    const view = new TableInspect()
    view.engine = 'postgresql'
    const column = inspectCol({ name: 'age', dataType: 'integer' })

    internals(view)._onCellMenuPick({ col: column, kind: 'type' }, 'type:bigint')
    expect(internals(view)._edits.get('age')).toEqual({ dataType: 'bigint' })

    internals(view)._onCellMenuPick({ col: column, kind: 'type' }, 'type:integer')
    expect(view.hasPendingChanges()).toBe(false)

    // A template pick doesn't commit — it opens the editor seeded for adjustment.
    internals(view)._onCellMenuPick({ col: column, kind: 'type' }, 'type:numeric(10,2)')
    expect(internals(view)._editing).toEqual({ col: 'age', field: 'dataType', seed: 'numeric(10,2)' })
    expect(view.hasPendingChanges()).toBe(false)

    internals(view)._onCellMenuPick({ col: column, kind: 'type' }, 'custom')
    expect(internals(view)._editing).toEqual({ col: 'age', field: 'dataType' })
  })

  it('edits the type inline on cell click and opens the menu from the end arrow', () => {
    stubInspect()
    const view = new TableInspect()
    view.engine = 'postgresql'
    const inner = internals(view)
    const column = inspectCol({ name: 'age', dataType: 'integer' })

    inner._onCellClick(column, 'dataType')
    expect(inner._editing).toEqual({ col: 'age', field: 'dataType' })
    expect(inner._cellMenu).toBeNull()

    inner._openTypeMenu(new MouseEvent('click', { clientX: 5, clientY: 6 }), column)
    expect(inner._cellMenu).toMatchObject({ kind: 'type', x: 5, y: 6 })
  })

  it('swallows the click that blurred an open editor instead of opening the next cell', () => {
    stubInspect()
    const view = new TableInspect()
    view.engine = 'postgresql'
    const inner = internals(view)
    const column = inspectCol({ name: 'age', dataType: 'integer' })

    // The blur handler stamps _blurCommitAt just before this click lands.
    inner._blurCommitAt = performance.now()
    inner._onCellClick(column, 'name')
    expect(inner._editing).toBeNull()
    inner._openTypeMenu(new MouseEvent('click'), column)
    expect(inner._cellMenu).toBeNull()

    // A later, separate click edits normally.
    inner._blurCommitAt = performance.now() - 1000
    inner._onCellClick(column, 'name')
    expect(inner._editing).toEqual({ col: 'age', field: 'name' })
  })

  it('opens filtered type completion on Ctrl+Space in the type editor', () => {
    stubInspect()
    const view = new TableInspect()
    view.engine = 'postgresql'
    const inner = internals(view)
    const column = inspectCol({ name: 'created', dataType: 'timestamp' })

    // The inline editor input, faked down to what the handler reads.
    const key = (init: Partial<KeyboardEvent>, value: string) =>
      ({
        ...init,
        preventDefault: () => {},
        stopPropagation: () => {},
        target: { value, getBoundingClientRect: () => ({ left: 4, bottom: 20 }) },
      }) as never as KeyboardEvent

    inner._onEditKeydown(key({ key: ' ', ctrlKey: true }, 'time'), column, 'dataType')
    expect(inner._cellMenu).toMatchObject({ kind: 'type', filter: 'time', x: 4, y: 22 })
    const labels = inner._typeItems(column, 'time').map((item) => item.label)
    expect(labels).toEqual(['time', 'timetz', 'timestamp', 'timestamptz', 'Custom…'])

    // No prefix match falls back to the full list rather than an empty menu.
    expect(inner._typeItems(column, 'zzz').length).toBeGreaterThan(10)

    // Escape closes the completion menu but keeps the edit session alive.
    inner._editing = { col: 'created', field: 'dataType' }
    inner._onEditKeydown(key({ key: 'Escape' }, 'time'), column, 'dataType')
    expect(inner._cellMenu).toBeNull()
    expect(inner._editing).not.toBeNull()
    inner._onEditKeydown(key({ key: 'Escape' }, 'time'), column, 'dataType')
    expect(inner._editing).toBeNull()
  })

  it('stages a nullable change via the yes/no menu and drops it on revert', () => {
    stubInspect()
    const view = new TableInspect()
    const column = inspectCol({ name: 'age', nullable: true })

    internals(view)._setNullable(column, false)
    expect(internals(view)._fieldNullable(column)).toBe(false)
    expect(internals(view)._edits.get('age')).toEqual({ nullable: false })

    internals(view)._setNullable(column, true)
    expect(view.hasPendingChanges()).toBe(false)
    expect(internals(view)._fieldNullable(column)).toBe(true)
  })

  it('emits inspect-dirty when edits are staged and again when cleared (drives the tab marker)', async () => {
    const cols = [inspectCol({ name: 'age' })]
    const inspectTable = vi.fn(() => Promise.resolve<InspectResult>({ success: true, inspection: { columns: cols, sections: [] } }))
    ;(window as never as { sqlkit: { inspectTable: typeof inspectTable } }).sqlkit = { inspectTable }

    const view = new TableInspect()
    view.profileId = 'p1'
    view.engine = 'postgresql'
    view.table = { schema: 'public', name: 'users', kind: 'table' }
    const dirty: boolean[] = []
    view.addEventListener('inspect-dirty', (event) => dirty.push((event as CustomEvent<{ dirty: boolean }>).detail.dirty))
    document.body.append(view)
    await internals(view)._load()
    await view.updateComplete

    internals(view)._commitText(cols[0]!, 'name', 'age_years')
    await view.updateComplete
    expect(dirty.at(-1)).toBe(true)

    internals(view)._commitText(cols[0]!, 'name', 'age')
    await view.updateComplete
    expect(dirty.at(-1)).toBe(false)
    view.remove()
  })

  it('dispatches alter-columns on save with the staged edits and clears them when applied', async () => {
    const cols = [inspectCol({ name: 'age', dataType: 'integer', nullable: true })]
    const inspectTable = vi.fn(() => Promise.resolve<InspectResult>({ success: true, inspection: { columns: cols, sections: [] } }))
    ;(window as never as { sqlkit: { inspectTable: typeof inspectTable } }).sqlkit = { inspectTable }

    const view = new TableInspect()
    view.profileId = 'p1'
    view.engine = 'postgresql'
    view.table = { schema: 'public', name: 'users', kind: 'table' }
    document.body.append(view)
    await internals(view)._load()
    await view.updateComplete

    internals(view)._commitText(cols[0]!, 'name', 'age_years')

    let detail: ColumnAlterEventDetail | null = null
    view.addEventListener('alter-columns', (event) => (detail = (event as CustomEvent<ColumnAlterEventDetail>).detail))
    view.save()

    expect(detail).not.toBeNull()
    const applied = detail as unknown as ColumnAlterEventDetail
    expect(applied.edits).toEqual([{ original: cols[0], name: 'age_years' }])
    expect(applied.table).toEqual({ schema: 'public', name: 'users', kind: 'table' })

    // onApplied clears the staged edits.
    applied.onApplied()
    expect(view.hasPendingChanges()).toBe(false)
    view.remove()
  })
})
