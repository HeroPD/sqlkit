// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import type { InspectColumn, InspectResult, TableInspection, TableRef } from '../electron'
import { clearInspectDraftCache, dropInspectDraft, exportInspectDraft, importInspectDraft, sweepInspectDrafts, TableInspect, type ColumnAlterEventDetail } from './table-inspect'
import type { AddObjectDetail } from './inspect-add-dialog'

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
    _operations: Record<string, unknown>[]
    _editing: { col: string; field: string } | null
    _typeItems(col: InspectColumn, filter?: string): Array<{ id: string; label: string; checked?: boolean }>
    _defaultItems(col: InspectColumn, filter?: string): Array<{ id: string; label: string; checked?: boolean }>
    _pickType(col: InspectColumn, id: string): void
    _startEdit(colName: string, field: 'name' | 'dataType' | 'comment' | 'default', seed?: string): void
    _openTypeMenu(event: MouseEvent, col: InspectColumn): void
    _openNullablePicker(cell: HTMLElement, col: InspectColumn): void
    _openDefaultMenu(event: MouseEvent, col: InspectColumn): void
    _sel: { grid: number; r0: number; c0: number; r1: number; c1: number } | null
    _onEditKeydown(event: KeyboardEvent, col: InspectColumn, field: 'name' | 'dataType' | 'comment' | 'default'): void
    _onEditInput(event: Event, col: InspectColumn, field: 'name' | 'dataType' | 'comment' | 'default'): void
    _cellMenu: { kind: string; x: number; y: number; width: number; active: number } | null
    _typePicker: { x: number; y: number; width: number; kind?: string; filter: string; active: number } | null
    _defaultPicker: { x: number; y: number; width: number; kind?: string; filter: string; active: number } | null
    _resetField(col: InspectColumn, field: 'name' | 'dataType' | 'comment' | 'default' | 'nullable'): void
    _resetRow(col: InspectColumn): void
    _onMenuPick(id: string, menu: { name: string; definition: string | null; col?: InspectColumn; field?: string; section?: string; operationIndex?: number }): void
    _menu: { x: number; y: number; name: string; definition: string | null; col?: InspectColumn; field?: string; section?: string; operationIndex?: number } | null
    _canAddColumn(): boolean
    _isAddition(name: string): boolean
    _addColumn(): void
    _removeAddition(key: string): void
    _toggleAutoIncrement(key: string): void
    _additionColumns(): InspectColumn[]
    _canDropColumn(): boolean
    _isDropped(name: string): boolean
    _dropColumn(col: InspectColumn): void
    _saveError: string | null
    _sectionEditing: { section: string; from: string; value: string; operationIndex?: number; seed?: string } | null
    _onAddDdl(event: CustomEvent<AddObjectDetail>): void
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

describe('TableInspect object sizes', () => {
  it('shows size metadata without changing the definition', async () => {
    const inspectTable = vi.fn(() => Promise.resolve<InspectResult>({
      success: true,
      inspection: {
        columns: [],
        sections: [{ title: 'Indexes', rows: [{ name: 'users_email_idx', definition: 'CREATE INDEX users_email_idx', sizeBytes: 2_048 }] }],
      },
    }))
    ;(window as never as { sqlkit: { inspectTable: typeof inspectTable } }).sqlkit = { inspectTable }

    const view = new TableInspect()
    view.profileId = 'p1'
    view.engine = 'postgresql'
    view.table = { schema: 'public', name: 'users', kind: 'table' }
    document.body.append(view)
    await internals(view)._load()
    await view.updateComplete

    expect(view.shadowRoot!.querySelector('.object-size')?.textContent).toBe('2 KB')
    expect(view.shadowRoot!.querySelector<HTMLElement>('[data-field="definition"]')?.title).toBe('CREATE INDEX users_email_idx\nSize: 2 KB')
    expect(internals(view)._state.inspection?.sections[0]?.rows[0]?.definition).toBe('CREATE INDEX users_email_idx')
    view.remove()
  })
})

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
  it('renders foreign-key columns with the blue key indicator', async () => {
    const column = inspectCol({ name: 'account_id', primaryKey: true, foreignKey: true })
    const inspectTable = vi.fn(() => Promise.resolve<InspectResult>({
      success: true,
      inspection: { columns: [column], sections: [] },
    }))
    ;(window as never as { sqlkit: { inspectTable: typeof inspectTable } }).sqlkit = { inspectTable }
    const view = new TableInspect()
    view.profileId = 'p1'
    view.engine = 'postgresql'
    view.table = { schema: 'public', name: 'orders', kind: 'table' }
    document.body.append(view)
    await internals(view)._load()
    await view.updateComplete

    const icon = view.shadowRoot!.querySelector<HTMLElement>('.icon-cell .fk')
    expect(icon?.classList.contains('icon-key')).toBe(true)
    expect(icon?.title).toBe('Foreign key')
    expect(view.shadowRoot!.querySelector('.icon-cell .pk')).toBeTruthy()
    view.remove()
  })

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

  it('selects and edits the type cell on a single click, and edits from the end arrow', async () => {
    const column = inspectCol({ name: 'age', dataType: 'integer' })
    const view = await loaded('postgresql', [column])
    const inner = internals(view)
    const cell = view.shadowRoot!.querySelector<HTMLElement>('td[data-field="dataType"]')!

    // The press selects; the completed click opens the editor (classic gesture).
    cell.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, composed: true }))
    expect(inner._sel).toEqual({ grid: -1, r0: 0, c0: 1, r1: 0, c1: 1 })
    expect(inner._editing).toBeNull()
    cell.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }))
    expect(inner._editing).toMatchObject({ col: 'age', field: 'dataType' })
    expect(inner._cellMenu).toBeNull()
    expect(inner._typePicker).toBeNull()

    inner._openTypeMenu(new MouseEvent('click', { clientX: 5, clientY: 6 }), column)
    expect(inner._editing).toEqual({ col: 'age', field: 'dataType' })
    expect(inner._cellMenu).toBeNull()
    view.remove()
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

    view.shadowRoot!.querySelectorAll<HTMLElement>('td.has-choices')[0]!.dispatchEvent(
      new MouseEvent('click', { bubbles: true, composed: true }),
    )
    await view.updateComplete

    expect(view.shadowRoot!.querySelector('.cell-input')).not.toBeNull()
    expect(view.shadowRoot!.querySelector('.choices-btn')).not.toBeNull()
    view.remove()
  })

  it('starting an edit on another cell immediately moves the editor there', () => {
    stubInspect()
    const view = new TableInspect()
    view.engine = 'postgresql'
    const inner = internals(view)
    const column = inspectCol({ name: 'age', dataType: 'integer' })

    inner._editing = { col: 'age', field: 'dataType' }
    inner._startEdit('age', 'name')
    expect(inner._editing).toEqual({ col: 'age', field: 'name', seed: undefined })

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

    view.shadowRoot!.querySelector<HTMLElement>('td[data-field="nullable"]')!.dispatchEvent(
      new MouseEvent('click', { bubbles: true, composed: true }),
    )
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

    view.shadowRoot!.querySelector<HTMLElement>('td[data-field="nullable"]')!.dispatchEvent(
      new MouseEvent('click', { bubbles: true, composed: true }),
    )
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
    cell.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }))
    expect(internals(view)._cellMenu).not.toBeNull()
    cell.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }))
    expect(internals(view)._cellMenu).toBeNull()

    // The cell's chevron toggles it the same way.
    const chevron = cell.querySelector<HTMLElement>('.choices-btn')!
    chevron.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, composed: true }))
    expect(internals(view)._cellMenu).not.toBeNull()
    chevron.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, composed: true }))
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
    view.shadowRoot!.querySelector<HTMLElement>('td[data-field="name"]')!.dispatchEvent(
      new MouseEvent('click', { bubbles: true, composed: true }),
    )
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
    const column = inspectCol({ name: 'created_at', dataType: 'timestamptz', default: 'now()' })

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
    const column = inspectCol({ name: 'created_at', dataType: 'timestamptz', default: 'now()' })
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
  it('keeps staged operations in the same undo history as column edits', () => {
    stubInspect()
    const view = new TableInspect()
    const inner = internals(view) as ReturnType<typeof internals> & {
      _operations: Array<{ kind: string }>
      _commitDraft(edits: Map<string, unknown>, operations: Array<{ kind: string; spec: { name: string; columns: string[] } }>): void
    }
    inner._commitDraft(new Map(), [{ kind: 'index', spec: { name: 'idx', columns: ['age'] } }])
    expect(view.hasPendingChanges()).toBe(true)

    expect(view.undo()).toBe(true)
    expect(view.hasPendingChanges()).toBe(false)
    expect(view.redo()).toBe(true)
    expect(inner._operations).toHaveLength(1)
  })

  it('restores a staged draft when its Inspect tab remounts', async () => {
    clearInspectDraftCache()
    const column = inspectCol({ name: 'age' })
    const inspectTable = vi.fn(() => Promise.resolve<InspectResult>({
      success: true,
      inspection: { columns: [column], sections: [] },
    }))
    ;(window as never as { sqlkit: { inspectTable: typeof inspectTable } }).sqlkit = { inspectTable }

    const first = new TableInspect()
    first.tabId = 'inspect:users'
    first.profileId = 'p1'
    first.engine = 'postgresql'
    first.table = { schema: 'public', name: 'users', kind: 'table' }
    document.body.append(first)
    await internals(first)._load()
    internals(first)._commitText(column, 'name', 'age_years')
    first.remove()

    const second = new TableInspect()
    second.tabId = 'inspect:users'
    second.profileId = 'p1'
    second.engine = 'postgresql'
    second.table = { schema: 'public', name: 'users', kind: 'table' }
    document.body.append(second)
    await internals(second)._load()

    expect(internals(second)._edits.get('age')).toEqual({ name: 'age_years' })
    second.remove()
    clearInspectDraftCache()
  })

  it('does not resurrect a dropped draft after its tab is closed', async () => {
    clearInspectDraftCache()
    const column = inspectCol({ name: 'age' })
    const inspectTable = vi.fn(() => Promise.resolve<InspectResult>({
      success: true,
      inspection: { columns: [column], sections: [] },
    }))
    ;(window as never as { sqlkit: { inspectTable: typeof inspectTable } }).sqlkit = { inspectTable }

    const first = new TableInspect()
    first.tabId = 'inspect:users'
    first.profileId = 'p1'
    first.engine = 'postgresql'
    first.table = { schema: 'public', name: 'users', kind: 'table' }
    document.body.append(first)
    await internals(first)._load()
    internals(first)._commitText(column, 'name', 'age_years')
    // The workbench close flow drops the cached draft, then unmounts the element.
    dropInspectDraft('inspect:users')
    first.remove()

    const second = new TableInspect()
    second.tabId = 'inspect:users'
    second.profileId = 'p1'
    second.engine = 'postgresql'
    second.table = { schema: 'public', name: 'users', kind: 'table' }
    document.body.append(second)
    await internals(second)._load()

    expect(internals(second)._edits.size).toBe(0)
    second.remove()
    clearInspectDraftCache()
  })

  // A removed connection or dropped child database takes its Inspect tabs with
  // it without closing them one at a time, so the drafts need a sweep.
  it('sweeps drafts whose Inspect tab no longer exists', async () => {
    clearInspectDraftCache()
    const column = inspectCol({ name: 'age' })
    const inspectTable = vi.fn(() => Promise.resolve<InspectResult>({
      success: true,
      inspection: { columns: [column], sections: [] },
    }))
    ;(window as never as { sqlkit: { inspectTable: typeof inspectTable } }).sqlkit = { inspectTable }

    const stage = async (tabId: string) => {
      const view = new TableInspect()
      view.tabId = tabId
      view.profileId = 'p1'
      view.engine = 'postgresql'
      view.table = { schema: 'public', name: 'users', kind: 'table' }
      document.body.append(view)
      await internals(view)._load()
      internals(view)._commitText(column, 'name', 'age_years')
      view.remove() // unmount stashes the draft, as a bulk removal would
    }
    await stage('inspect:gone')
    await stage('inspect:kept')

    sweepInspectDrafts((tabId) => tabId === 'inspect:kept')

    // The surviving tab's draft comes back; the vanished one's is released.
    const revived = new TableInspect()
    revived.tabId = 'inspect:kept'
    revived.profileId = 'p1'
    revived.engine = 'postgresql'
    revived.table = { schema: 'public', name: 'users', kind: 'table' }
    document.body.append(revived)
    await internals(revived)._load()
    expect(internals(revived)._edits.get('age')).toEqual({ name: 'age_years' })
    revived.remove()

    const orphaned = new TableInspect()
    orphaned.tabId = 'inspect:gone'
    orphaned.profileId = 'p1'
    orphaned.engine = 'postgresql'
    orphaned.table = { schema: 'public', name: 'users', kind: 'table' }
    document.body.append(orphaned)
    await internals(orphaned)._load()
    expect(internals(orphaned)._edits.size).toBe(0)
    orphaned.remove()
    clearInspectDraftCache()
  })

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

  it('copies the staged (renamed) name from the row menu, not the original', async () => {
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

    internals(view)._commitText(column, 'name', 'age_years')
    await view.updateComplete

    const nameCell = view.shadowRoot!.querySelector<HTMLElement>('td[data-field="name"]')!
    nameCell.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 5, clientY: 6 }))
    await view.updateComplete

    expect(internals(view)._menu?.name).toBe('age_years')
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

describe('TableInspect cell selection', () => {
  const cellOf = (view: TableInspect, row: number, field: string) =>
    view.shadowRoot!.querySelector<HTMLElement>(`tr[data-row="${row}"] td[data-field="${field}"]`)!
  const press = (el: HTMLElement, init: MouseEventInit = {}) =>
    el.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, composed: true, ...init }))
  const key = (view: TableInspect, init: KeyboardEventInit) =>
    view.shadowRoot!.querySelector<HTMLElement>('.columns-table')!.dispatchEvent(new KeyboardEvent('keydown', init))
  // Attaches onto the live window.sqlkit, so call it after the component's setup
  // (loaded/_load reassigns window.sqlkit).
  const stubClipboard = () => {
    const writeText = vi.fn(() => Promise.resolve())
    ;(window as unknown as { sqlkit: Record<string, unknown> }).sqlkit.writeClipboardText = writeText
    return writeText
  }
  const twoCols = () => [inspectCol({ name: 'age' }), inspectCol({ name: 'nick', dataType: 'text', nullable: false })]

  it('selects on click, extends with shift-click, and marks the cells', async () => {
    const view = await loaded('postgresql', twoCols())
    const inner = internals(view)

    press(cellOf(view, 0, 'name'))
    expect(inner._sel).toEqual({ grid: -1, r0: 0, c0: 0, r1: 0, c1: 0 })
    press(cellOf(view, 1, 'dataType'), { shiftKey: true })
    expect(inner._sel).toEqual({ grid: -1, r0: 0, c0: 0, r1: 1, c1: 1 })

    // A shift-click stays selection-only: no editor opens on the completed click.
    cellOf(view, 1, 'dataType').dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true, shiftKey: true }))
    expect(inner._editing).toBeNull()

    await view.updateComplete
    expect(view.shadowRoot!.querySelectorAll('td.selected')).toHaveLength(4)
    view.remove()
  })

  it('moves the selection with arrows and grows it with shift', async () => {
    const view = await loaded('postgresql', twoCols())
    const inner = internals(view)
    press(cellOf(view, 0, 'name'))

    key(view, { key: 'ArrowDown' })
    expect(inner._sel).toEqual({ grid: -1, r0: 1, c0: 0, r1: 1, c1: 0 })
    key(view, { key: 'ArrowRight', shiftKey: true })
    expect(inner._sel).toEqual({ grid: -1, r0: 1, c0: 0, r1: 1, c1: 1 })
    // Clamped at the grid edges.
    key(view, { key: 'ArrowDown' })
    expect(inner._sel).toEqual({ grid: -1, r0: 1, c0: 1, r1: 1, c1: 1 })
    key(view, { key: 'Escape' })
    expect(inner._sel).toBeNull()
    view.remove()
  })

  it('copies the selected rectangle as TSV of the staged values', async () => {
    const cols = twoCols()
    const view = await loaded('postgresql', cols)
    const writeText = stubClipboard()
    internals(view)._commitText(cols[1]!, 'dataType', 'varchar(80)')

    press(cellOf(view, 0, 'name'))
    press(cellOf(view, 1, 'nullable'), { shiftKey: true })
    key(view, { key: 'c', metaKey: true })
    expect(writeText).toHaveBeenCalledWith('age\tinteger\tyes\nnick\tvarchar(80)\tno')
    view.remove()
  })

  it('copies a single multi-line cell as raw text, without TSV quoting', async () => {
    const body = "CREATE FUNCTION f() RETURNS void AS $$\nBEGIN\n  RAISE NOTICE 'hi \"q\"';\nEND;\n$$"
    const inspectTable = vi.fn(() =>
      Promise.resolve<InspectResult>({
        success: true,
        inspection: { columns: [inspectCol({ name: 'age' })], sections: [{ title: 'Constraints', rows: [{ name: 'f', definition: body }] }] },
      }),
    )
    ;(window as never as { sqlkit: { inspectTable: typeof inspectTable } }).sqlkit = { inspectTable }
    const view = new TableInspect()
    view.profileId = 'p1'
    view.engine = 'postgresql'
    view.table = { schema: 'public', name: 'users', kind: 'table' }
    document.body.append(view)
    await internals(view)._load()
    await view.updateComplete
    const writeText = stubClipboard()

    const defCell = view.shadowRoot!.querySelector<HTMLElement>('table[data-grid="1"] tr[data-row="0"] td[data-field="definition"]')!
    press(defCell)
    view.shadowRoot!.querySelector<HTMLElement>('table[data-grid="1"]')!.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'c', metaKey: true }),
    )
    expect(writeText).toHaveBeenCalledWith(body)
    view.remove()
  })

  it('type-to-edit opens the editor seeded with the typed character', async () => {
    const view = await loaded('postgresql')
    const inner = internals(view)
    press(cellOf(view, 0, 'name'))

    key(view, { key: 'b' })
    expect(inner._editing).toEqual({ col: 'age', field: 'name', seed: 'b' })
    await view.updateComplete
    expect(view.shadowRoot!.querySelector<HTMLInputElement>('.cell-input')?.value).toBe('b')
    view.remove()
  })

  it('Enter edits the anchor cell; locked cells stay selectable and copyable', async () => {
    const view = await loaded('sqlite')
    const writeText = stubClipboard()
    const inner = internals(view)

    // SQLite can't alter an existing column's type — Enter must not open an editor…
    press(cellOf(view, 0, 'dataType'))
    key(view, { key: 'Enter' })
    expect(inner._editing).toBeNull()
    // …but the cell still copies.
    key(view, { key: 'c', metaKey: true })
    expect(writeText).toHaveBeenCalledWith('integer')

    // The name cell is editable, so Enter opens it.
    press(cellOf(view, 0, 'name'))
    key(view, { key: 'Enter' })
    expect(inner._editing).toMatchObject({ col: 'age', field: 'name' })
    view.remove()
  })

  it('selects and copies section cells (indexes, constraints) too', async () => {
    const rows = [
      { name: 'users_pkey', definition: 'PRIMARY KEY (id)' },
      { name: 'users_email_key', definition: 'UNIQUE (email)' },
    ]
    const inspectTable = vi.fn(() =>
      Promise.resolve<InspectResult>({
        success: true,
        inspection: { columns: [inspectCol({ name: 'age' })], sections: [{ title: 'Constraints', rows }] },
      }),
    )
    ;(window as never as { sqlkit: { inspectTable: typeof inspectTable } }).sqlkit = { inspectTable }
    const view = new TableInspect()
    view.profileId = 'p1'
    view.engine = 'postgresql'
    view.table = { schema: 'public', name: 'users', kind: 'table' }
    document.body.append(view)
    await internals(view)._load()
    await view.updateComplete
    const writeText = stubClipboard()
    const inner = internals(view)

    const nameCell = view.shadowRoot!.querySelector<HTMLElement>('table[data-grid="1"] tr[data-row="0"] td[data-field="name"]')!
    expect(nameCell.textContent?.trim()).toBe('users_pkey')
    expect(view.shadowRoot!.querySelector<HTMLElement>('table[data-grid="1"] tr[data-row="1"] td[data-field="name"]')!.textContent?.trim())
      .toBe('users_email_key')
    press(nameCell)
    expect(inner._sel).toEqual({ grid: 1, r0: 0, c0: 0, r1: 0, c1: 0 })

    // Extend into the second row's definition and copy: raw names, not display-trimmed.
    press(view.shadowRoot!.querySelector<HTMLElement>('table[data-grid="1"] tr[data-row="1"] td[data-field="definition"]')!, {
      shiftKey: true,
    })
    view.shadowRoot!.querySelector<HTMLElement>('table[data-grid="1"]')!.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'c', metaKey: true }),
    )
    expect(writeText).toHaveBeenCalledWith('users_pkey\tPRIMARY KEY (id)\nusers_email_key\tUNIQUE (email)')

    // Section definitions stay read-only even though supported object names can be renamed.
    press(view.shadowRoot!.querySelector<HTMLElement>('table[data-grid="1"] tr[data-row="0"] td[data-field="definition"]')!)
    view.shadowRoot!.querySelector<HTMLElement>('table[data-grid="1"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))
    view.shadowRoot!.querySelector<HTMLElement>('table[data-grid="1"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'x' }))
    expect(inner._editing).toBeNull()
    expect(inner._sectionEditing).toBeNull()

    // A click in the columns table moves the selection between grids.
    press(cellOf(view, 0, 'name'))
    expect(inner._sel).toEqual({ grid: -1, r0: 0, c0: 0, r1: 0, c1: 0 })
    view.remove()
  })

  it('keeps typing in the inline editor out of the grid gestures', async () => {
    const view = await loaded('postgresql')
    const inner = internals(view)
    press(cellOf(view, 0, 'name'))
    key(view, { key: 'Enter' })
    await view.updateComplete

    // Keys bubbling from the editor input must not re-enter type-to-edit.
    const input = view.shadowRoot!.querySelector<HTMLInputElement>('.cell-input')!
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'x', bubbles: true, composed: true }))
    expect(inner._editing).toMatchObject({ col: 'age', field: 'name' })
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

describe('TableInspect section add buttons', () => {
  it('synthesizes empty Indexes/Triggers sections so a bare table can still add them', async () => {
    const inspectTable = vi.fn(() =>
      Promise.resolve<InspectResult>({ success: true, inspection: { columns: [inspectCol({ name: 'id' })], sections: [] } }),
    )
    ;(window as never as { sqlkit: { inspectTable: typeof inspectTable } }).sqlkit = { inspectTable }

    const view = new TableInspect()
    view.profileId = 'p1'
    view.engine = 'sqlite'
    view.table = { schema: null, name: 'users', kind: 'table' }
    document.body.append(view)
    await internals(view)._load()
    await view.updateComplete

    // The full sqlite scaffold shows at 0; Partitions/Storage stay presence-only.
    const headers = [...view.shadowRoot!.querySelectorAll('h4')].map((h) => h.textContent?.trim() ?? '')
    for (const title of ['Foreign Keys', 'Indexes', 'Triggers']) {
      expect(headers.some((text) => text.startsWith(title))).toBe(true)
    }
    expect(headers.some((text) => text.startsWith('Partitions'))).toBe(false)
    expect(view.shadowRoot!.querySelectorAll('.add-btn').length).toBeGreaterThanOrEqual(2)
    // Empty synthesized sections render a section-specific hint, not a table.
    expect(view.shadowRoot!.querySelectorAll('.section-table').length).toBe(0)
    const empties = [...view.shadowRoot!.querySelectorAll('.section-empty')].map((p) => p.textContent?.trim() ?? '')
    expect(empties.some((text) => text.startsWith('No indexes yet'))).toBe(true)
    expect(empties.some((text) => text.startsWith('No triggers yet'))).toBe(true)
    expect(empties.some((text) => text.startsWith('No foreign keys'))).toBe(true)
    view.remove()
  })

  it('does not synthesize add sections for views', async () => {
    const inspectTable = vi.fn(() =>
      Promise.resolve<InspectResult>({ success: true, inspection: { columns: [inspectCol({ name: 'id' })], sections: [] } }),
    )
    ;(window as never as { sqlkit: { inspectTable: typeof inspectTable } }).sqlkit = { inspectTable }

    const view = new TableInspect()
    view.profileId = 'p1'
    view.engine = 'postgresql'
    view.table = { schema: 'public', name: 'v', kind: 'view' }
    document.body.append(view)
    await internals(view)._load()
    await view.updateComplete

    const headers = [...view.shadowRoot!.querySelectorAll('h4')].map((h) => h.textContent?.trim() ?? '')
    expect(headers.some((text) => text.startsWith('Indexes'))).toBe(false)
    expect(headers.some((text) => text.startsWith('Triggers'))).toBe(false)
    view.remove()
  })

  it('stages an add-dialog operation until the combined save', async () => {
    const inspectTable = vi.fn(() =>
      Promise.resolve<InspectResult>({ success: true, inspection: { columns: [inspectCol({ name: 'id' })], sections: [] } }),
    )
    ;(window as never as { sqlkit: { inspectTable: typeof inspectTable } }).sqlkit = { inspectTable }

    const view = new TableInspect()
    view.profileId = 'p1'
    view.childDb = null
    view.engine = 'sqlite'
    view.table = { schema: null, name: 'users', kind: 'table' }
    document.body.append(view)
    await internals(view)._load()
    await view.updateComplete

    const onSave = vi.fn()
    view.addEventListener('alter-columns', onSave)
    // The columns table also has an .add-btn; pick the Indexes section button.
    const indexBtn = [...view.shadowRoot!.querySelectorAll<HTMLButtonElement>('.add-btn')]
      .find((btn) => btn.getAttribute('aria-label') === 'Add Indexes')!
    indexBtn.click()
    await view.updateComplete

    const dialog = view.shadowRoot!.querySelector('inspect-add-dialog')!
    expect(dialog).toBeTruthy()
    dialog.dispatchEvent(new CustomEvent('add-ddl', {
      detail: { operation: { kind: 'index', spec: { name: 'i', columns: ['id'] } } },
      bubbles: true,
      composed: true,
    }))
    await view.updateComplete
    expect(view.shadowRoot!.querySelector('inspect-add-dialog')).toBeNull()
    expect(onSave).not.toHaveBeenCalled()
    expect(view.shadowRoot!.querySelector('.staged-add')?.textContent).toContain('i')

    view.save()
    expect(onSave).toHaveBeenCalledOnce()
    expect((onSave.mock.calls[0]![0] as CustomEvent<ColumnAlterEventDetail>).detail.operations).toEqual([
      { kind: 'index', spec: { name: 'i', columns: ['id'] } },
    ])
    view.remove()
  })
})

describe('TableInspect section drop menus', () => {
  const withSection = async (engine: 'postgresql' | 'sqlite', title: string, name: string) => {
    const inspectTable = vi.fn(() => Promise.resolve<InspectResult>({
      success: true,
      inspection: { columns: [inspectCol({ name: 'id' })], sections: [{ title, rows: [{ name, definition: 'existing definition' }] }] },
    }))
    ;(window as never as { sqlkit: { inspectTable: typeof inspectTable } }).sqlkit = { inspectTable }
    const view = new TableInspect()
    view.profileId = 'p1'
    view.engine = engine
    view.table = { schema: engine === 'sqlite' ? null : 'public', name: 'users', kind: 'table' }
    document.body.append(view)
    await internals(view)._load()
    await view.updateComplete
    return view
  }

  it('offers a destructive Drop action and stages it until Save', async () => {
    const view = await withSection('postgresql', 'Indexes', 'users_email_idx')
    const row = view.shadowRoot!.querySelector<HTMLElement>('.section-table tr')!
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 5, clientY: 6 }))
    await view.updateComplete

    const menu = view.shadowRoot!.querySelector('context-menu')!
    expect(menu.items).toContainEqual({ id: 'drop-object', label: 'Drop Index', danger: true })
    menu.dispatchEvent(new CustomEvent('menu-pick', { detail: { id: 'drop-object' }, bubbles: true, composed: true }))
    await view.updateComplete

    expect(view.hasPendingChanges()).toBe(true)
    expect(view.shadowRoot!.querySelector('.staged-delete')?.textContent).toContain('users_email_idx')
    expect(view.shadowRoot!.textContent).toContain('DROP INDEX')

    const onSave = vi.fn()
    view.addEventListener('alter-columns', onSave)
    view.save()
    expect((onSave.mock.calls[0]![0] as CustomEvent<ColumnAlterEventDetail>).detail.operations).toEqual([
      { kind: 'drop', target: 'index', name: 'users_email_idx' },
    ])
    view.remove()
  })

  it('does not offer unsupported SQLite foreign-key drops', async () => {
    const view = await withSection('sqlite', 'Foreign Keys', 'users_team_fk')
    view.shadowRoot!.querySelector<HTMLElement>('.section-table tr')!
      .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }))
    await view.updateComplete

    expect(view.shadowRoot!.querySelector('context-menu')!.items.some((item) => item.id === 'drop-object')).toBe(false)
    view.remove()
  })

  it('edits supported object names inline and stages the rename until Save', async () => {
    const view = await withSection('postgresql', 'Indexes', 'users_email_idx')
    const nameCell = view.shadowRoot!.querySelector<HTMLElement>('.section-table td[data-field="name"]')!
    nameCell.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await view.updateComplete

    const input = view.shadowRoot!.querySelector<HTMLInputElement>('.object-name-input')!
    expect(input.value).toBe('users_email_idx')
    expect(input.closest('td')?.classList.contains('selected')).toBe(false)
    expect(input.closest('td')?.classList.contains('editable')).toBe(false)
    input.value = 'users_contact_idx'
    input.dispatchEvent(new FocusEvent('blur'))
    await view.updateComplete

    expect(view.shadowRoot!.querySelector('.staged-edit')?.textContent).toContain('users_contact_idx')
    const onSave = vi.fn()
    view.addEventListener('alter-columns', onSave)
    view.save()
    expect((onSave.mock.calls[0]![0] as CustomEvent<ColumnAlterEventDetail>).detail.operations).toEqual([
      { kind: 'rename', target: 'index', from: 'users_email_idx', to: 'users_contact_idx' },
    ])
    view.remove()
  })

  it('opens an inline editor only in the clicked object row', async () => {
    const inspectTable = vi.fn(() => Promise.resolve<InspectResult>({
      success: true,
      inspection: {
        columns: [inspectCol({ name: 'id' })],
        sections: [{
          title: 'Indexes',
          rows: [
            { name: 'users_email_idx', definition: 'CREATE INDEX users_email_idx' },
            { name: 'users_team_idx', definition: 'CREATE INDEX users_team_idx' },
          ],
        }],
      },
    }))
    ;(window as never as { sqlkit: { inspectTable: typeof inspectTable } }).sqlkit = { inspectTable }
    const view = new TableInspect()
    view.profileId = 'p1'
    view.engine = 'postgresql'
    view.table = { schema: 'public', name: 'users', kind: 'table' }
    document.body.append(view)
    await internals(view)._load()
    await view.updateComplete

    view.shadowRoot!.querySelector<HTMLElement>('.section-table tr:first-child td[data-field="name"]')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await view.updateComplete

    expect(view.shadowRoot!.querySelectorAll('.object-name-input')).toHaveLength(1)
    expect(view.shadowRoot!.querySelector<HTMLInputElement>('.object-name-input')!.value).toBe('users_email_idx')
    expect(view.shadowRoot!.querySelectorAll('.section-table tr')[1]!.textContent).toContain('users_team_idx')
    view.remove()
  })

  it('keeps SQLite object names read-only', async () => {
    const view = await withSection('sqlite', 'Indexes', 'users_email_idx')
    view.shadowRoot!.querySelector<HTMLElement>('.section-table td[data-field="name"]')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await view.updateComplete
    expect(view.shadowRoot!.querySelector('.object-name-input')).toBeNull()
    expect(internals(view)._sectionEditing).toBeNull()
    view.remove()
  })

  it('shows an existing primary key read-only in Constraints (no inline edit, no drop/rename menu)', async () => {
    const inspectTable = vi.fn(() => Promise.resolve<InspectResult>({
      success: true,
      inspection: {
        columns: [inspectCol({ name: 'id', primaryKey: true })],
        sections: [{
          title: 'Constraints',
          rows: [
            { name: 'users_pkey', definition: 'PRIMARY KEY (id)' },
            { name: 'uq_email', definition: 'UNIQUE (email)' },
          ],
        }],
      },
    }))
    ;(window as never as { sqlkit: { inspectTable: typeof inspectTable } }).sqlkit = { inspectTable }
    const view = new TableInspect()
    view.profileId = 'p1'
    view.engine = 'postgresql'
    view.table = { schema: 'public', name: 'users', kind: 'table' }
    document.body.append(view)
    await internals(view)._load()
    await view.updateComplete

    const rows = view.shadowRoot!.querySelectorAll('.section-table tr')
    const pkCell = rows[0]!.querySelector<HTMLElement>('td[data-field="name"]')!
    expect(pkCell.classList.contains('editable')).toBe(false)
    pkCell.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await view.updateComplete
    expect(internals(view)._sectionEditing).toBeNull()

    const menuLabels = () =>
      [...view.shadowRoot!.querySelector('context-menu')!.shadowRoot!.querySelectorAll('[role="menuitem"]')]
        .map((item) => item.textContent?.trim())
    pkCell.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 5, clientY: 5 }))
    await view.updateComplete
    expect(menuLabels()).not.toContain('Drop Constraint')
    expect(menuLabels()).not.toContain('Rename')

    // A regular UNIQUE constraint in the same section stays fully manageable.
    rows[1]!.querySelector<HTMLElement>('td[data-field="name"]')!
      .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 5, clientY: 5 }))
    await view.updateComplete
    expect(menuLabels()).toContain('Drop Constraint')
    view.remove()
  })
})

describe('TableInspect create-table mode', () => {
  it('starts a local draft, stages a primary key, and emits the created table after apply', async () => {
    clearInspectDraftCache()
    const inspectTable = vi.fn()
    ;(window as never as { sqlkit: { inspectTable: typeof inspectTable } }).sqlkit = { inspectTable }
    const view = new TableInspect()
    view.tabId = 'create-1'
    view.profileId = 'p1'
    view.engine = 'sqlite'
    view.table = { schema: null, name: 'new_table', kind: 'table' }
    view.createTable = true
    document.body.append(view)
    await view.updateComplete

    expect(inspectTable).not.toHaveBeenCalled()
    expect(internals(view)._additionColumns()).toHaveLength(1)
    // The Columns section is always shown in create mode, seeded with the id row.
    const columnsHeading = [...view.shadowRoot!.querySelectorAll('h4')].find((heading) => heading.textContent?.includes('Columns'))
    expect(columnsHeading?.querySelector('.count')?.textContent).toBe('1')
    expect(view.shadowRoot!.querySelector('.columns-table')?.textContent).toContain('id')
    expect([...view.shadowRoot!.querySelectorAll('h4')].some((heading) => heading.textContent?.includes('Constraints'))).toBe(true)

    view.shadowRoot!.querySelector<HTMLElement>('.create-table-name')!.click()
    await view.updateComplete
    const name = view.shadowRoot!.querySelector<HTMLInputElement>('.table-name-input')!
    name.value = 'projects'
    name.dispatchEvent(new FocusEvent('blur'))
    await view.updateComplete

    const onSave = vi.fn()
    view.addEventListener('alter-columns', onSave)
    view.save()

    const detail = (onSave.mock.calls[0]![0] as CustomEvent<ColumnAlterEventDetail>).detail
    expect(detail.createTable).toBe(true)
    expect(detail.tabId).toBe('create-1')
    expect(detail.table).toEqual({ schema: null, name: 'projects', kind: 'table' })
    // The seeded id is an auto-increment column; its PK constraint tracks the rename.
    expect(detail.additions).toEqual([{ name: 'id', dataType: 'integer', nullable: false, default: null, comment: null, autoIncrement: true }])
    expect(detail.operations).toEqual([
      { kind: 'constraint', spec: { name: 'projects_pkey', type: 'PRIMARY KEY', columns: ['id'] } },
    ])

    detail.onApplied()
    expect(view.hasPendingChanges()).toBe(true) // create tabs stay drafts until the workbench swaps the tab
    view.remove()
  })

  it('seeds the id column as bigint on server engines and integer on sqlite', async () => {
    clearInspectDraftCache()
    ;(window as never as { sqlkit: { inspectTable: () => void } }).sqlkit = { inspectTable: vi.fn() }
    const seedType = async (engine: 'postgresql' | 'sqlite') => {
      const view = new TableInspect()
      view.tabId = `create-${engine}`
      view.profileId = 'p1'
      view.engine = engine
      view.table = { schema: engine === 'sqlite' ? null : 'public', name: 'new_table', kind: 'table' }
      view.createTable = true
      document.body.append(view)
      await view.updateComplete
      const type = view.shadowRoot!.querySelector('.columns-table .type')?.textContent?.trim()
      view.remove()
      return type
    }
    expect(await seedType('postgresql')).toBe('bigint')
    expect(await seedType('sqlite')).toBe('integer')
  })

  it('seeds the id column as an auto-increment primary key by default', async () => {
    clearInspectDraftCache()
    ;(window as never as { sqlkit: { inspectTable: () => void } }).sqlkit = { inspectTable: vi.fn() }
    const view = new TableInspect()
    view.tabId = 'create-ai'
    view.profileId = 'p1'
    view.engine = 'postgresql'
    view.table = { schema: 'public', name: 'new_table', kind: 'table' }
    view.createTable = true
    document.body.append(view)
    await view.updateComplete

    // The id row reads as the primary key and shows the identity keyword as its default.
    expect(view.shadowRoot!.querySelector('.columns-table .icon-key.pk')).toBeTruthy()
    expect(view.shadowRoot!.querySelector('.columns-table')?.textContent).toContain('IDENTITY')
    // The primary key is a staged constraint, so it also appears in the Constraints section.
    expect([...view.shadowRoot!.querySelectorAll('h4')].some((h) => h.textContent?.includes('Constraints'))).toBe(true)

    const onSave = vi.fn()
    view.addEventListener('alter-columns', onSave)
    view.save()
    const detail = (onSave.mock.calls[0]![0] as CustomEvent<ColumnAlterEventDetail>).detail
    expect(detail.additions).toEqual([
      { name: 'id', dataType: 'bigint', nullable: false, default: null, comment: null, autoIncrement: true },
    ])
    expect(detail.operations).toEqual([
      { kind: 'constraint', spec: { name: 'new_table_pkey', type: 'PRIMARY KEY', columns: ['id'] } },
    ])
    view.remove()
  })

  const stagedConstraintView = async () => {
    clearInspectDraftCache()
    ;(window as never as { sqlkit: { inspectTable: () => void } }).sqlkit = { inspectTable: vi.fn() }
    const view = new TableInspect()
    view.tabId = 'create-edit'
    view.profileId = 'p1'
    view.engine = 'sqlite'
    view.table = { schema: null, name: 'projects', kind: 'table' }
    view.createTable = true
    document.body.append(view)
    await view.updateComplete
    // The draft auto-seeds a PRIMARY KEY constraint named "projects_pkey" on id.
    return view
  }

  it('inline-renames a staged constraint by clicking its name', async () => {
    const view = await stagedConstraintView()
    view.shadowRoot!.querySelector<HTMLElement>('.section-table td[data-field="name"]')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await view.updateComplete
    const input = view.shadowRoot!.querySelector<HTMLInputElement>('.object-name-input')!
    expect(input).toBeTruthy()
    input.value = 'pk_projects'
    input.dispatchEvent(new FocusEvent('blur'))
    await view.updateComplete

    const onSave = vi.fn()
    view.addEventListener('alter-columns', onSave)
    view.save()
    expect((onSave.mock.calls[0]![0] as CustomEvent<ColumnAlterEventDetail>).detail.operations).toEqual([
      { kind: 'constraint', spec: { name: 'pk_projects', type: 'PRIMARY KEY', columns: ['id'] } },
    ])
    view.remove()
  })

  it('edits a staged operation in place via the row context menu (replaces, not appends)', async () => {
    const view = await stagedConstraintView()

    // The staged constraint's menu offers Edit (full dialog), not Rename.
    view.shadowRoot!.querySelector<HTMLElement>('.section-table td[data-field="name"]')!
      .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 5, clientY: 5 }))
    await view.updateComplete
    const labels = [...view.shadowRoot!.querySelector('context-menu')!.shadowRoot!.querySelectorAll('[role="menuitem"]')]
      .map((item) => item.textContent?.trim())
    expect(labels).toContain('Edit')
    expect(labels).not.toContain('Rename')

    // Edit opens the add dialog pre-filled with the staged operation.
    internals(view)._onMenuPick('edit-object', { name: 'projects_pkey', definition: null, section: 'Constraints', operationIndex: 0 })
    await view.updateComplete
    const dialog = view.shadowRoot!.querySelector('inspect-add-dialog')!
    expect((dialog as unknown as { operation: unknown }).operation).toMatchObject({ kind: 'constraint', spec: { name: 'projects_pkey' } })

    // Saving the edited op replaces the staged one rather than adding a second.
    internals(view)._onAddDdl(new CustomEvent<AddObjectDetail>('add-ddl', {
      detail: { operation: { kind: 'constraint', spec: { name: 'pk_projects', type: 'PRIMARY KEY', columns: ['id'] } } },
    }))
    await view.updateComplete

    const onSave = vi.fn()
    view.addEventListener('alter-columns', onSave)
    view.save()
    const detail = (onSave.mock.calls[0]![0] as CustomEvent<ColumnAlterEventDetail>).detail
    expect(detail.operations).toEqual([
      { kind: 'constraint', spec: { name: 'pk_projects', type: 'PRIMARY KEY', columns: ['id'] } },
    ])
    view.remove()
  })
})

// Hot exit carries staged schema edits across a restart, so they have to
// survive the round trip through the session file.
describe('TableInspect session drafts', () => {
  const stageDraft = async (tabId: string) => {
    const column = inspectCol({ name: 'age' })
    const inspectTable = vi.fn(() => Promise.resolve<InspectResult>({
      success: true,
      inspection: { columns: [column], sections: [] },
    }))
    ;(window as never as { sqlkit: { inspectTable: typeof inspectTable } }).sqlkit = { inspectTable }

    const view = new TableInspect()
    view.tabId = tabId
    view.profileId = 'p1'
    view.engine = 'postgresql'
    view.table = { schema: 'public', name: 'users', kind: 'table' }
    document.body.append(view)
    await internals(view)._load()
    internals(view)._commitText(column, 'name', 'age_years')
    view.remove()
    return { column, inspectTable }
  }

  const mount = async (tabId: string, inspectTable: unknown) => {
    ;(window as never as { sqlkit: unknown }).sqlkit = { inspectTable }
    const view = new TableInspect()
    view.tabId = tabId
    view.profileId = 'p1'
    view.engine = 'postgresql'
    view.table = { schema: 'public', name: 'users', kind: 'table' }
    document.body.append(view)
    await internals(view)._load()
    return view
  }

  it('exports a staged edit as plain data and brings it back', async () => {
    clearInspectDraftCache()
    const { inspectTable } = await stageDraft('inspect:users')

    const exported = exportInspectDraft('inspect:users')
    expect(exported?.edits).toEqual([['age', { name: 'age_years' }]])
    // Plain JSON, or it would never survive the trip through the session file.
    expect(JSON.parse(JSON.stringify(exported))).toEqual(exported)

    clearInspectDraftCache()
    expect(importInspectDraft('inspect:users', exported!)).toBe(true)

    const restored = await mount('inspect:users', inspectTable)
    expect(internals(restored)._edits.get('age')).toEqual({ name: 'age_years' })
    restored.remove()
    clearInspectDraftCache()
  })

  it('has nothing to export for a tab with no staged edits', () => {
    clearInspectDraftCache()
    expect(exportInspectDraft('inspect:untouched')).toBeUndefined()
  })

  it('refuses an empty draft rather than marking the tab dirty for nothing', () => {
    clearInspectDraftCache()
    expect(importInspectDraft('inspect:users', { edits: [], operations: [], tableName: null, addSeq: 0 })).toBe(false)
  })

  it('drops operations a hand-edited session file mangled', async () => {
    clearInspectDraftCache()
    const { inspectTable } = await stageDraft('inspect:users')
    const exported = exportInspectDraft('inspect:users')!
    clearInspectDraftCache()

    importInspectDraft('inspect:users', {
      ...exported,
      operations: [
        { kind: 'nonsense' },
        // A real kind, but missing the columns the section renderer reads.
        { kind: 'index', spec: { name: 'users_half_idx' } },
        { kind: 'index', spec: { name: 'users_email_idx', columns: ['email'], unique: true } },
      ],
    })

    const restored = await mount('inspect:users', inspectTable)
    expect(internals(restored)._operations).toEqual([
      { kind: 'index', spec: { name: 'users_email_idx', columns: ['email'], unique: true } },
    ])
    restored.remove()
    clearInspectDraftCache()
  })
})
