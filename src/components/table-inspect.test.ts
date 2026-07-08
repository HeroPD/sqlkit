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
    _canEdit(field: 'name' | 'dataType' | 'comment' | 'default' | 'nullable', col?: InspectColumn): boolean
    _commitText(col: InspectColumn, field: 'name' | 'dataType' | 'comment' | 'default', raw: string): void
    _setNullable(col: InspectColumn, value: boolean): void
    _fieldNullable(col: InspectColumn): boolean
    _edits: Map<string, Record<string, unknown>>
    _editing: { col: string; field: string } | null
    _typeItems(col: InspectColumn, filter?: string): Array<{ id: string; label: string; checked?: boolean }>
    _defaultItems(col: InspectColumn, filter?: string): Array<{ id: string; label: string; checked?: boolean }>
    _pickType(col: InspectColumn, id: string): void
    _onCellClick(col: InspectColumn, field: 'name' | 'dataType' | 'comment' | 'default'): void
    _openTypeMenu(event: MouseEvent, col: InspectColumn): void
    _openNullablePicker(event: MouseEvent, col: InspectColumn): void
    _openDefaultMenu(event: MouseEvent, col: InspectColumn): void
    _onEditKeydown(event: KeyboardEvent, col: InspectColumn, field: 'name' | 'dataType' | 'comment' | 'default'): void
    _onEditInput(event: Event, col: InspectColumn, field: 'name' | 'dataType' | 'comment' | 'default'): void
    _cellMenu: { kind: string; x: number; y: number; width: number; active: number } | null
    _typePicker: { x: number; y: number; width: number; kind?: string; filter: string; active: number } | null
    _defaultPicker: { x: number; y: number; width: number; kind?: string; filter: string; active: number } | null
    _resetField(col: InspectColumn, field: 'name' | 'dataType' | 'comment' | 'default' | 'nullable'): void
    _resetRow(col: InspectColumn): void
    _onMenuPick(id: string, menu: { name: string; definition: string | null; col?: InspectColumn; field?: string }): void
    _menu: { x: number; y: number; name: string; definition: string | null; col?: InspectColumn; field?: string } | null
    _canAddColumn(): boolean
    _isAddition(name: string): boolean
    _addColumn(): void
    _removeAddition(key: string): void
    _additionColumns(): InspectColumn[]
    _canDropColumn(): boolean
    _isDropped(name: string): boolean
    _dropColumn(col: InspectColumn): void
    _saveError: string | null
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
const chooseOption = (button: HTMLButtonElement) => button.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))

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

    const my = new TableInspect()
    my.table = { schema: null, name: 't', kind: 'table' }
    my.engine = 'mysql'
    expect(internals(my)._canEdit('name')).toBe(true)
    expect(internals(my)._canEdit('default')).toBe(true)
    expect(internals(my)._canEdit('dataType')).toBe(false)
    expect(internals(my)._canEdit('nullable')).toBe(false)
    expect(internals(my)._canEdit('comment')).toBe(false)

    const ms = new TableInspect()
    ms.table = { schema: 'dbo', name: 't', kind: 'table' }
    ms.engine = 'sqlserver'
    expect(internals(ms)._canEdit('name')).toBe(true)
    expect(internals(ms)._canEdit('dataType')).toBe(true)
    expect(internals(ms)._canEdit('nullable')).toBe(true)
    expect(internals(ms)._canEdit('default')).toBe(false)
  })

  it('lets a staged addition edit every definable field, even on locked engines', () => {
    stubInspect()
    const lite = new TableInspect()
    lite.table = { schema: null, name: 't', kind: 'table' }
    lite.engine = 'sqlite'
    internals(lite)._addColumn()
    const added = internals(lite)._additionColumns()[0]!
    expect(internals(lite)._canEdit('dataType', added)).toBe(true)
    expect(internals(lite)._canEdit('nullable', added)).toBe(true)
    expect(internals(lite)._canEdit('default', added)).toBe(true)
    // Comments still need engine support to be expressible in the ADD DDL.
    expect(internals(lite)._canEdit('comment', added)).toBe(false)

    const my = new TableInspect()
    my.table = { schema: null, name: 't', kind: 'table' }
    my.engine = 'mysql'
    internals(my)._addColumn()
    expect(internals(my)._canEdit('comment', internals(my)._additionColumns()[0])).toBe(true)
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

  it('offers the engine types with the current one check-marked', () => {
    stubInspect()
    const view = new TableInspect()
    view.engine = 'postgresql'
    const items = internals(view)._typeItems(inspectCol({ dataType: 'integer' }))

    expect(items.find((item) => item.checked)?.label).toBe('integer')
    expect(items.some((item) => item.id === 'custom')).toBe(false)
    expect(items.length).toBeGreaterThan(10)
  })

  it('does not check-mark unrelated parameterized templates by base type name', () => {
    stubInspect()
    const view = new TableInspect()
    view.engine = 'postgresql'
    const items = internals(view)._typeItems(inspectCol({ dataType: 'character varying(64)' }))
    expect(items.find((item) => item.checked)).toBeUndefined()
  })

  it('stages a bare type pick and routes templates to the inline editor', () => {
    stubInspect()
    const view = new TableInspect()
    view.engine = 'postgresql'
    const column = inspectCol({ name: 'age', dataType: 'integer' })

    internals(view)._pickType(column, 'type:bigint')
    expect(internals(view)._edits.get('age')).toEqual({ dataType: 'bigint' })

    internals(view)._pickType(column, 'type:integer')
    expect(view.hasPendingChanges()).toBe(false)

    // A template pick doesn't commit — it opens the editor seeded for adjustment.
    internals(view)._pickType(column, 'type:numeric(10,2)')
    expect(internals(view)._editing).toEqual({ col: 'age', field: 'dataType', seed: 'numeric(10,2)' })
    expect(view.hasPendingChanges()).toBe(false)
  })

  it('edits the type inline on cell click and from the end arrow', () => {
    stubInspect()
    const view = new TableInspect()
    view.engine = 'postgresql'
    const inner = internals(view)
    const column = inspectCol({ name: 'age', dataType: 'integer' })

    inner._onCellClick(column, 'dataType')
    expect(inner._editing).toEqual({ col: 'age', field: 'dataType' })
    expect(inner._cellMenu).toBeNull()
    expect(inner._typePicker).toBeNull()

    inner._openTypeMenu(new MouseEvent('click', { clientX: 5, clientY: 6 }), column)
    expect(inner._editing).toEqual({ col: 'age', field: 'dataType' })
    expect(inner._cellMenu).toBeNull()
  })

  it('opens the full type list from the end arrow', async () => {
    const column = inspectCol({ name: 'age', dataType: 'integer' })
    const inspectTable = vi.fn(() => Promise.resolve<InspectResult>({ success: true, inspection: { columns: [column], sections: [] } }))
    ;(window as never as { sqlkit: { inspectTable: typeof inspectTable } }).sqlkit = { inspectTable }

    const view = new TableInspect()
    view.profileId = 'p1'
    view.engine = 'postgresql'
    view.table = { schema: 'public', name: 'users', kind: 'table' }
    document.body.append(view)
    await internals(view)._load()
    await view.updateComplete

    chooseOption(view.shadowRoot!.querySelectorAll<HTMLButtonElement>('.choices-btn')[0]!)
    await view.updateComplete
    await view.updateComplete

    const labels = [...view.shadowRoot!.querySelectorAll('.type-option')].map((option) => option.textContent?.trim())
    expect(labels).toContain('text')
    expect(labels).toContain('jsonb')
    expect(labels.length).toBeGreaterThan(10)
    const bigint = [...view.shadowRoot!.querySelectorAll<HTMLButtonElement>('.type-option')].find(
      (option) => option.textContent?.trim() === 'bigint',
    )
    expect(bigint).toBeDefined()
    chooseOption(bigint!)
    expect(internals(view)._edits.get('age')).toEqual({ dataType: 'bigint' })
    view.remove()
  })

  it('keeps a type picker selection when the previous input blurs', async () => {
    const column = inspectCol({ name: 'age', dataType: 'integer' })
    const inspectTable = vi.fn(() => Promise.resolve<InspectResult>({ success: true, inspection: { columns: [column], sections: [] } }))
    ;(window as never as { sqlkit: { inspectTable: typeof inspectTable } }).sqlkit = { inspectTable }

    const view = new TableInspect()
    view.profileId = 'p1'
    view.engine = 'postgresql'
    view.table = { schema: 'public', name: 'users', kind: 'table' }
    document.body.append(view)
    await internals(view)._load()
    await view.updateComplete

    chooseOption(view.shadowRoot!.querySelectorAll<HTMLButtonElement>('.choices-btn')[0]!)
    await view.updateComplete
    await view.updateComplete

    const input = view.shadowRoot!.querySelector<HTMLInputElement>('.cell-input')!
    const bigint = [...view.shadowRoot!.querySelectorAll<HTMLButtonElement>('.type-option')].find(
      (option) => option.textContent?.trim() === 'bigint',
    )
    expect(bigint).toBeDefined()
    chooseOption(bigint!)
    input.dispatchEvent(new FocusEvent('blur'))
    await view.updateComplete

    expect(internals(view)._edits.get('age')).toEqual({ dataType: 'bigint' })
    expect(view.shadowRoot!.querySelector('td.type')?.textContent?.trim()).toBe('bigint')
    view.remove()
  })

  it('keeps the type chevron visible while the type field is focused', async () => {
    const column = inspectCol({ name: 'age', dataType: 'integer' })
    const inspectTable = vi.fn(() => Promise.resolve<InspectResult>({ success: true, inspection: { columns: [column], sections: [] } }))
    ;(window as never as { sqlkit: { inspectTable: typeof inspectTable } }).sqlkit = { inspectTable }

    const view = new TableInspect()
    view.profileId = 'p1'
    view.engine = 'postgresql'
    view.table = { schema: 'public', name: 'users', kind: 'table' }
    document.body.append(view)
    await internals(view)._load()
    await view.updateComplete

    view.shadowRoot!.querySelectorAll<HTMLElement>('td.has-choices')[0]!.click()
    await view.updateComplete

    expect(view.shadowRoot!.querySelector('.cell-input')).not.toBeNull()
    expect(view.shadowRoot!.querySelector('.choices-btn')).not.toBeNull()
    view.remove()
  })

  it('clicking another editable cell immediately starts editing it', () => {
    stubInspect()
    const view = new TableInspect()
    view.engine = 'postgresql'
    const inner = internals(view)
    const column = inspectCol({ name: 'age', dataType: 'integer' })

    inner._editing = { col: 'age', field: 'dataType' }
    inner._onCellClick(column, 'name')
    expect(inner._editing).toEqual({ col: 'age', field: 'name' })

    inner._editing = { col: 'age', field: 'name' }
    inner._openTypeMenu(new MouseEvent('click'), column)
    expect(inner._editing).toEqual({ col: 'age', field: 'dataType' })
  })

  it('opens and filters the type picker under the type editor', () => {
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
        target: { value, getBoundingClientRect: () => ({ left: 4, bottom: 20, width: 140 }) },
      }) as never as KeyboardEvent
    const input = (value: string) =>
      ({ target: { value, getBoundingClientRect: () => ({ left: 4, bottom: 20, width: 140 }) } }) as never as Event

    inner._onEditInput(input('tim'), column, 'dataType')
    expect(inner._typePicker).toBeNull()
    inner._onEditKeydown(key({ key: 'ArrowDown' }, 'tim'), column, 'dataType')
    expect(inner._typePicker).toMatchObject({ filter: '', active: 0 })
    expect(inner._typeItems(column, '').length).toBeGreaterThan(10)
    inner._typePicker = null

    inner._onEditKeydown(key({ key: ' ', ctrlKey: true }, 'time'), column, 'dataType')
    expect(inner._typePicker).toMatchObject({ filter: 'time', x: 4, y: 22, width: 140, active: 0 })
    const labels = inner._typeItems(column, 'time').map((item) => item.label)
    expect(labels).toEqual(expect.arrayContaining(['time', 'time without time zone', 'time with time zone', 'timetz', 'timestamp']))

    inner._onEditInput(input('tim'), column, 'dataType')
    expect(inner._typePicker).toMatchObject({ filter: 'tim', active: -1 })
    expect(inner._typeItems(column, 'zzz')).toEqual([])

    // Arrow selection makes Enter accept a highlighted type.
    inner._onEditKeydown(key({ key: 'ArrowDown' }, 'tim'), column, 'dataType')
    expect(inner._typePicker).toMatchObject({ active: 0 })
    inner._onEditKeydown(key({ key: 'Enter' }, 'tim'), column, 'dataType')
    expect(inner._edits.get('created')).toEqual({ dataType: 'time' })

    // Without a highlighted option, Enter commits free text instead.
    inner._editing = { col: 'created', field: 'dataType' }
    inner._onEditInput(input('citext'), column, 'dataType')
    inner._onEditKeydown(key({ key: 'Enter' }, 'citext'), column, 'dataType')
    expect(inner._edits.get('created')).toEqual({ dataType: 'citext' })

    // Escape closes the completion menu but keeps the edit session alive.
    inner._editing = { col: 'created', field: 'dataType' }
    inner._onEditKeydown(key({ key: ' ', ctrlKey: true }, 'time'), column, 'dataType')
    inner._onEditKeydown(key({ key: 'Escape' }, 'time'), column, 'dataType')
    expect(inner._typePicker).toBeNull()
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

  it('opens nullable choices in the same anchored picker style', async () => {
    const column = inspectCol({ name: 'age', nullable: true })
    const inspectTable = vi.fn(() => Promise.resolve<InspectResult>({ success: true, inspection: { columns: [column], sections: [] } }))
    ;(window as never as { sqlkit: { inspectTable: typeof inspectTable } }).sqlkit = { inspectTable }

    const view = new TableInspect()
    view.profileId = 'p1'
    view.engine = 'postgresql'
    view.table = { schema: 'public', name: 'users', kind: 'table' }
    document.body.append(view)
    await internals(view)._load()
    await view.updateComplete

    view.shadowRoot!.querySelectorAll<HTMLElement>('td.has-choices')[1]!.click()
    await view.updateComplete

    const options = [...view.shadowRoot!.querySelectorAll('.type-option')].map((option) => option.textContent?.trim())
    expect(options).toEqual(['yes✓', 'no'])
    chooseOption(view.shadowRoot!.querySelectorAll<HTMLButtonElement>('.type-option')[1]!)
    expect(internals(view)._edits.get('age')).toEqual({ nullable: false })
    view.remove()
  })

  it('closes nullable choices when clicking outside', async () => {
    const column = inspectCol({ name: 'age', nullable: true })
    const inspectTable = vi.fn(() => Promise.resolve<InspectResult>({ success: true, inspection: { columns: [column], sections: [] } }))
    ;(window as never as { sqlkit: { inspectTable: typeof inspectTable } }).sqlkit = { inspectTable }

    const view = new TableInspect()
    view.profileId = 'p1'
    view.engine = 'postgresql'
    view.table = { schema: 'public', name: 'users', kind: 'table' }
    document.body.append(view)
    await internals(view)._load()
    await view.updateComplete

    view.shadowRoot!.querySelectorAll<HTMLElement>('td.has-choices')[1]!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, composed: true }))
    view.shadowRoot!.querySelectorAll<HTMLElement>('td.has-choices')[1]!.click()
    await view.updateComplete
    expect(internals(view)._cellMenu).not.toBeNull()

    window.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, composed: true }))
    await view.updateComplete
    expect(internals(view)._cellMenu).toBeNull()
    view.remove()
  })

  it('toggles the nullable picker shut on a second click of the same cell', async () => {
    const column = inspectCol({ name: 'age', nullable: true })
    const inspectTable = vi.fn(() => Promise.resolve<InspectResult>({ success: true, inspection: { columns: [column], sections: [] } }))
    ;(window as never as { sqlkit: { inspectTable: typeof inspectTable } }).sqlkit = { inspectTable }

    const view = new TableInspect()
    view.profileId = 'p1'
    view.engine = 'postgresql'
    view.table = { schema: 'public', name: 'users', kind: 'table' }
    document.body.append(view)
    await internals(view)._load()
    await view.updateComplete

    const cell = view.shadowRoot!.querySelector<HTMLElement>('td.nullable-cell')!
    cell.click()
    expect(internals(view)._cellMenu).not.toBeNull()
    cell.click()
    expect(internals(view)._cellMenu).toBeNull()
    view.remove()
  })

  it('commits a typed cell edit when a chevron opens another cell', async () => {
    const column = inspectCol({ name: 'age', dataType: 'integer', nullable: true })
    const inspectTable = vi.fn(() => Promise.resolve<InspectResult>({ success: true, inspection: { columns: [column], sections: [] } }))
    ;(window as never as { sqlkit: { inspectTable: typeof inspectTable } }).sqlkit = { inspectTable }

    const view = new TableInspect()
    view.profileId = 'p1'
    view.engine = 'postgresql'
    view.table = { schema: 'public', name: 'users', kind: 'table' }
    document.body.append(view)
    await internals(view)._load()
    await view.updateComplete

    // Edit the name cell, type a value, then open the type picker via its chevron
    // (a mousedown that suppresses blur) — the typed rename must not be lost.
    view.shadowRoot!.querySelector<HTMLElement>('td[data-field="name"]')!.click()
    await view.updateComplete
    view.shadowRoot!.querySelector<HTMLInputElement>('.cell-input')!.value = 'age_years'
    internals(view)._openTypeMenu(new MouseEvent('mousedown'), column)
    expect(internals(view)._edits.get('age')).toEqual({ name: 'age_years' })
    view.remove()
  })

  it('opens and filters the default picker under the default editor', () => {
    stubInspect()
    const view = new TableInspect()
    view.engine = 'postgresql'
    const inner = internals(view)
    const column = inspectCol({ name: 'created_at', default: 'now()' })

    const key = (init: Partial<KeyboardEvent>, value: string) =>
      ({
        ...init,
        preventDefault: () => {},
        stopPropagation: () => {},
        target: { value, getBoundingClientRect: () => ({ left: 4, bottom: 20, width: 140 }) },
      }) as never as KeyboardEvent
    const input = (value: string) =>
      ({ target: { value, getBoundingClientRect: () => ({ left: 4, bottom: 20, width: 140 }) } }) as never as Event

    expect(inner._defaultItems(column).find((item) => item.checked)?.label).toBe('now()')
    inner._onEditInput(input('cur'), column, 'default')
    expect(inner._defaultPicker).toBeNull()
    inner._onEditKeydown(key({ key: 'ArrowDown' }, 'cur'), column, 'default')
    expect(inner._defaultPicker).toMatchObject({ filter: '', active: 0 })
    inner._defaultPicker = null

    inner._onEditKeydown(key({ key: ' ', ctrlKey: true }, 'current'), column, 'default')
    expect(inner._defaultPicker).toMatchObject({ filter: 'current', active: 0 })
    expect(inner._defaultItems(column, 'current').map((item) => item.label)).toEqual([
      'CURRENT_DATE',
      'CURRENT_TIME',
      'CURRENT_TIMESTAMP',
    ])

    inner._onEditInput(input('current_t'), column, 'default')
    expect(inner._defaultPicker).toMatchObject({ filter: 'current_t', active: -1 })
    inner._onEditKeydown(key({ key: 'ArrowDown' }, 'current_t'), column, 'default')
    inner._onEditKeydown(key({ key: 'Enter' }, 'current_t'), column, 'default')
    expect(inner._edits.get('created_at')).toEqual({ default: 'CURRENT_TIME' })

    inner._editing = { col: 'created_at', field: 'default' }
    inner._onEditKeydown(key({ key: 'Enter' }, 'gen_random_uuid()'), column, 'default')
    expect(inner._edits.get('created_at')).toEqual({ default: 'gen_random_uuid()' })
  })

  it('keeps a default picker selection when the previous input blurs', async () => {
    const column = inspectCol({ name: 'created_at', default: 'now()' })
    const inspectTable = vi.fn(() => Promise.resolve<InspectResult>({ success: true, inspection: { columns: [column], sections: [] } }))
    ;(window as never as { sqlkit: { inspectTable: typeof inspectTable } }).sqlkit = { inspectTable }

    const view = new TableInspect()
    view.profileId = 'p1'
    view.engine = 'postgresql'
    view.table = { schema: 'public', name: 'users', kind: 'table' }
    document.body.append(view)
    await internals(view)._load()
    await view.updateComplete

    chooseOption(view.shadowRoot!.querySelectorAll<HTMLButtonElement>('.choices-btn')[2]!)
    await view.updateComplete
    await view.updateComplete

    const input = view.shadowRoot!.querySelector<HTMLInputElement>('.cell-input')!
    const currentTimestamp = [...view.shadowRoot!.querySelectorAll<HTMLButtonElement>('.type-option')].find(
      (option) => option.textContent?.trim() === 'CURRENT_TIMESTAMP',
    )
    expect(currentTimestamp).toBeDefined()
    chooseOption(currentTimestamp!)
    input.dispatchEvent(new FocusEvent('blur'))
    await view.updateComplete

    expect(internals(view)._edits.get('created_at')).toEqual({ default: 'CURRENT_TIMESTAMP' })
    view.remove()
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

describe('TableInspect undo/redo and reset', () => {
  it('undoes and redoes staged edits one commit at a time', () => {
    stubInspect()
    const view = new TableInspect()
    const inner = internals(view)
    const column = inspectCol({ name: 'age', dataType: 'integer' })

    inner._commitText(column, 'name', 'age_years')
    inner._commitText(column, 'dataType', 'bigint')
    expect(inner._edits.get('age')).toEqual({ name: 'age_years', dataType: 'bigint' })

    expect(view.undo()).toBe(true)
    expect(inner._edits.get('age')).toEqual({ name: 'age_years' })
    expect(view.undo()).toBe(true)
    expect(view.hasPendingChanges()).toBe(false)
    expect(view.undo()).toBe(false)

    expect(view.redo()).toBe(true)
    expect(inner._edits.get('age')).toEqual({ name: 'age_years' })
    expect(view.redo()).toBe(true)
    expect(inner._edits.get('age')).toEqual({ name: 'age_years', dataType: 'bigint' })
    expect(view.redo()).toBe(false)
  })

  it('drops the redo branch when a new edit follows an undo', () => {
    stubInspect()
    const view = new TableInspect()
    const inner = internals(view)
    const column = inspectCol({ name: 'age', dataType: 'integer' })

    inner._commitText(column, 'dataType', 'bigint')
    view.undo()
    inner._commitText(column, 'dataType', 'smallint')
    expect(view.redo()).toBe(false)
    expect(inner._edits.get('age')).toEqual({ dataType: 'smallint' })
  })

  it('defers to native input undo while a cell is being edited', () => {
    stubInspect()
    const view = new TableInspect()
    const inner = internals(view)
    const column = inspectCol({ name: 'age' })

    inner._commitText(column, 'name', 'age_years')
    inner._editing = { col: 'age', field: 'name' }
    expect(view.undo()).toBe(false)
    expect(view.redo()).toBe(false)
  })

  it('does not record a no-op commit as an undo step', () => {
    stubInspect()
    const view = new TableInspect()
    const inner = internals(view)
    const column = inspectCol({ name: 'age' })

    inner._commitText(column, 'name', 'age_years')
    // Re-committing the same value stages nothing new — one undo clears it.
    inner._commitText(column, 'name', 'age_years')
    expect(view.undo()).toBe(true)
    expect(view.hasPendingChanges()).toBe(false)
  })

  it('resets a single field to its loaded value and stays undoable', () => {
    stubInspect()
    const view = new TableInspect()
    const inner = internals(view)
    const column = inspectCol({ name: 'age', dataType: 'integer' })

    inner._commitText(column, 'name', 'age_years')
    inner._commitText(column, 'dataType', 'bigint')
    inner._resetField(column, 'dataType')
    expect(inner._edits.get('age')).toEqual({ name: 'age_years' })

    expect(view.undo()).toBe(true)
    expect(inner._edits.get('age')).toEqual({ name: 'age_years', dataType: 'bigint' })
  })

  it('resets a whole row and stays undoable', () => {
    stubInspect()
    const view = new TableInspect()
    const inner = internals(view)
    const column = inspectCol({ name: 'age', dataType: 'integer' })

    inner._commitText(column, 'name', 'age_years')
    inner._commitText(column, 'dataType', 'bigint')
    inner._resetRow(column)
    expect(view.hasPendingChanges()).toBe(false)

    expect(view.undo()).toBe(true)
    expect(inner._edits.get('age')).toEqual({ name: 'age_years', dataType: 'bigint' })
  })

  it('drops just the right-clicked field when reset from the menu', () => {
    stubInspect()
    const view = new TableInspect()
    const inner = internals(view)
    const column = inspectCol({ name: 'age', dataType: 'integer' })

    inner._commitText(column, 'name', 'age_years')
    inner._commitText(column, 'dataType', 'bigint')
    inner._onMenuPick('reset-field', { name: 'age', definition: null, col: column, field: 'dataType' })
    expect(inner._edits.get('age')).toEqual({ name: 'age_years' })
  })

  it('reads the right-clicked field from the cell into the row menu', async () => {
    const column = inspectCol({ name: 'age', dataType: 'integer' })
    const inspectTable = vi.fn(() => Promise.resolve<InspectResult>({ success: true, inspection: { columns: [column], sections: [] } }))
    ;(window as never as { sqlkit: { inspectTable: typeof inspectTable } }).sqlkit = { inspectTable }

    const view = new TableInspect()
    view.profileId = 'p1'
    view.engine = 'postgresql'
    view.table = { schema: 'public', name: 'users', kind: 'table' }
    document.body.append(view)
    await internals(view)._load()
    await view.updateComplete

    const typeCell = view.shadowRoot!.querySelector<HTMLElement>('td[data-field="dataType"]')!
    typeCell.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 5, clientY: 6 }))
    await view.updateComplete

    expect(internals(view)._menu).toMatchObject({ name: 'age', field: 'dataType' })
    view.remove()
  })

  it('clears the undo history when the tab reloads a new structure', async () => {
    const column = inspectCol({ name: 'age', dataType: 'integer' })
    const inspectTable = vi.fn(() => Promise.resolve<InspectResult>({ success: true, inspection: { columns: [column], sections: [] } }))
    ;(window as never as { sqlkit: { inspectTable: typeof inspectTable } }).sqlkit = { inspectTable }

    const view = new TableInspect()
    view.profileId = 'p1'
    view.engine = 'postgresql'
    view.table = { schema: 'public', name: 'users', kind: 'table' }
    document.body.append(view)
    await internals(view)._load()

    internals(view)._commitText(column, 'dataType', 'bigint')
    await internals(view)._load()
    expect(view.hasPendingChanges()).toBe(false)
    expect(view.undo()).toBe(false)
    view.remove()
  })
})

const loaded = async (engine: 'postgresql' | 'sqlite' | 'mysql' | 'sqlserver', cols: InspectColumn[] = [inspectCol({ name: 'age' })]) => {
  const inspectTable = vi.fn(() => Promise.resolve<InspectResult>({ success: true, inspection: { columns: cols, sections: [] } }))
  ;(window as never as { sqlkit: { inspectTable: typeof inspectTable } }).sqlkit = { inspectTable }
  const view = new TableInspect()
  view.profileId = 'p1'
  view.engine = engine
  view.table = { schema: 'public', name: 'users', kind: 'table' }
  document.body.append(view)
  await internals(view)._load()
  await view.updateComplete
  return view
}

describe('TableInspect adding columns', () => {
  it('offers add/drop on every engine for tables, never for objects', async () => {
    const pg = await loaded('postgresql')
    expect(internals(pg)._canAddColumn()).toBe(true)
    expect(internals(pg)._canDropColumn()).toBe(true)
    pg.remove()

    // ADD/DROP COLUMN are the alters SQLite does support without a rebuild.
    const lite = await loaded('sqlite')
    expect(internals(lite)._canAddColumn()).toBe(true)
    expect(internals(lite)._canDropColumn()).toBe(true)
    lite.remove()

    // An object (function/type) inspection never qualifies. Left unmounted so
    // the reactive load doesn't fire an unstubbed inspectObject.
    const obj = new TableInspect()
    obj.engine = 'postgresql'
    obj.object = { schema: 'public', name: 'mood', detail: 'enum' }
    obj.objectKind = 'type'
    expect(internals(obj)._canAddColumn()).toBe(false)
    expect(internals(obj)._canDropColumn()).toBe(false)
  })

  it('appends a placeholder row and drops straight into editing its name', async () => {
    const view = await loaded('postgresql')
    internals(view)._addColumn()

    const additions = internals(view)._additionColumns()
    expect(additions).toHaveLength(1)
    expect(internals(view)._editing?.field).toBe('name')
    expect(internals(view)._editing?.col).toBe(additions[0]!.name)
    expect(view.hasPendingChanges()).toBe(true)

    // The row renders green with a remove button; the name cell shows the placeholder.
    await view.updateComplete
    const addBtn = view.renderRoot.querySelector('h4 .add-btn')
    const addedRow = view.renderRoot.querySelector('tr.added')
    expect(addBtn).not.toBeNull()
    expect(addedRow).not.toBeNull()
    expect(addedRow!.querySelector('.remove-btn')).not.toBeNull()
    expect(view.renderRoot.querySelector<HTMLInputElement>('tr.added .cell-input')?.value).toBe('new_column')
    view.remove()
  })

  it('emits the new column in additions on save, with placeholder and edited values', async () => {
    const view = await loaded('postgresql')
    internals(view)._addColumn()
    const key = internals(view)._additionColumns()[0]!.name
    const synthetic = internals(view)._additionColumns()[0]!

    // Rename it and give it a non-null default; leave type at the placeholder.
    internals(view)._commitText(synthetic, 'name', 'nickname')
    internals(view)._commitText(synthetic, 'default', "''")

    let detail: ColumnAlterEventDetail | null = null
    view.addEventListener('alter-columns', (event) => (detail = (event as CustomEvent<ColumnAlterEventDetail>).detail))
    view.save()

    const applied = detail as unknown as ColumnAlterEventDetail
    expect(applied.edits).toEqual([])
    expect(applied.additions).toEqual([{ name: 'nickname', dataType: 'text', nullable: true, default: "''", comment: null }])
    // The row keys off a hidden sentinel, never leaked as the column's real name.
    expect(internals(view)._isAddition(key)).toBe(true)
    expect(applied.additions[0]!.name).not.toBe(key)
    view.remove()
  })

  it('reverts a blanked new-column name to the placeholder rather than the sentinel key', async () => {
    const view = await loaded('postgresql')
    internals(view)._addColumn()
    const col = internals(view)._additionColumns()[0]!
    internals(view)._commitText(col, 'name', '')

    let detail: ColumnAlterEventDetail | null = null
    view.addEventListener('alter-columns', (event) => (detail = (event as CustomEvent<ColumnAlterEventDetail>).detail))
    view.save()
    expect((detail as unknown as ColumnAlterEventDetail).additions[0]!.name).toBe('new_column')
    view.remove()
  })

  it('removes a staged new column and clears the dirty state', async () => {
    const view = await loaded('postgresql')
    internals(view)._addColumn()
    const key = internals(view)._additionColumns()[0]!.name
    expect(view.hasPendingChanges()).toBe(true)

    internals(view)._removeAddition(key)
    expect(internals(view)._additionColumns()).toHaveLength(0)
    expect(view.hasPendingChanges()).toBe(false)
    view.remove()
  })

  it('undoes and redoes an add as one step', async () => {
    const view = await loaded('postgresql')
    internals(view)._addColumn()
    expect(internals(view)._additionColumns()).toHaveLength(1)

    // The add itself is undoable; a mid-edit cell defers to native undo, so commit first.
    internals(view)._editing = null
    expect(view.undo()).toBe(true)
    expect(internals(view)._additionColumns()).toHaveLength(0)
    expect(view.redo()).toBe(true)
    expect(internals(view)._additionColumns()).toHaveLength(1)
    view.remove()
  })
})

describe('TableInspect dropping columns', () => {
  it('stages a drop over any field edits and one undo restores them', async () => {
    const column = inspectCol({ name: 'age' })
    const view = await loaded('postgresql', [column])
    internals(view)._commitText(column, 'name', 'age_years')

    internals(view)._dropColumn(column)
    expect(internals(view)._isDropped('age')).toBe(true)
    expect(internals(view)._edits.get('age')).toEqual({ drop: true })

    expect(view.undo()).toBe(true)
    expect(internals(view)._isDropped('age')).toBe(false)
    expect(internals(view)._edits.get('age')).toEqual({ name: 'age_years' })
    view.remove()
  })

  it('locks a dropped row and renders it with a restore button', async () => {
    const column = inspectCol({ name: 'age' })
    const view = await loaded('postgresql', [column])
    internals(view)._dropColumn(column)
    await view.updateComplete

    expect(internals(view)._canEdit('name', column)).toBe(false)
    expect(internals(view)._canEdit('dataType', column)).toBe(false)
    const row = view.renderRoot.querySelector('tr.dropped')
    expect(row).not.toBeNull()
    row!.querySelector<HTMLButtonElement>('.restore-btn')!.click()
    expect(internals(view)._isDropped('age')).toBe(false)
    expect(view.hasPendingChanges()).toBe(false)
    view.remove()
  })

  it('offers Restore Column from the row menu in place of the reset items', async () => {
    const column = inspectCol({ name: 'age' })
    const view = await loaded('postgresql', [column])
    internals(view)._dropColumn(column)

    internals(view)._onMenuPick('restore-column', { name: 'age', definition: null, col: column })
    expect(view.hasPendingChanges()).toBe(false)
    view.remove()
  })

  it('emits drops on save, separate from edits and additions', async () => {
    const age = inspectCol({ name: 'age' })
    const nick = inspectCol({ name: 'nickname', dataType: 'text' })
    const view = await loaded('postgresql', [age, nick])
    internals(view)._dropColumn(age)
    internals(view)._commitText(nick, 'name', 'alias')

    let detail: ColumnAlterEventDetail | null = null
    view.addEventListener('alter-columns', (event) => (detail = (event as CustomEvent<ColumnAlterEventDetail>).detail))
    view.save()

    const applied = detail as unknown as ColumnAlterEventDetail
    expect(applied.drops).toEqual(['age'])
    expect(applied.edits).toEqual([{ original: nick, name: 'alias' }])
    expect(applied.additions).toEqual([])
    view.remove()
  })
})

describe('TableInspect save validation', () => {
  it('blocks a rename that collides with an existing column', async () => {
    const age = inspectCol({ name: 'age' })
    const nick = inspectCol({ name: 'nickname', dataType: 'text' })
    const view = await loaded('postgresql', [age, nick])
    internals(view)._commitText(age, 'name', 'nickname')

    const onSave = vi.fn()
    view.addEventListener('alter-columns', onSave)
    view.save()
    expect(onSave).not.toHaveBeenCalled()
    expect(internals(view)._saveError).toContain('"nickname"')

    // The next edit clears the error; renaming away saves cleanly.
    internals(view)._commitText(age, 'name', 'age_years')
    expect(internals(view)._saveError).toBeNull()
    view.save()
    expect(onSave).toHaveBeenCalledTimes(1)
    view.remove()
  })

  it('blocks an addition named after an existing column, unless that column is dropped', async () => {
    const age = inspectCol({ name: 'age' })
    const view = await loaded('postgresql', [age])
    internals(view)._addColumn()
    const added = internals(view)._additionColumns()[0]!
    internals(view)._commitText(added, 'name', 'age')

    const onSave = vi.fn()
    view.addEventListener('alter-columns', onSave)
    view.save()
    expect(onSave).not.toHaveBeenCalled()
    expect(internals(view)._saveError).toContain('"age"')

    // Dropping the original frees the name (drops run before adds).
    internals(view)._dropColumn(age)
    view.save()
    expect(onSave).toHaveBeenCalledTimes(1)
    view.remove()
  })
})
