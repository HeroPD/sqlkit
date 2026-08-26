// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import type { ColumnRef, TableRef } from '../electron'
import { ExplorerView, tableKey } from './explorer-view'

type Tree = { collapsedSchemas: Set<string>; expandedTables: Set<string>; expandedObjectGroups: Set<string> }
type Layout = { filesCollapsed: boolean; tablesCollapsed: boolean; filesHeight: number | null; resizing: unknown }

const internals = (view: ExplorerView) =>
  view as never as {
    willUpdate(changed: Map<string, unknown>): void
    _tree: Tree
    _layout: Layout
    _menu: { kind: string } | null
    _toggleTable(event: Event, key: string): void
    _toggleSchema(key: string): void
    _toggleObjectGroup(key: string): void
    _tableColumns(table: TableRef): ColumnRef[] | null
    _onTableMenu(event: MouseEvent, table: TableRef): void
    _onTableMenuPick(id: string, table: TableRef): void
    _tableSort: 'name' | 'size'
  }

const table = (name: string, schema: string | null = 'public'): TableRef => ({ schema, name, kind: 'table' })

const column = (tbl: string, name: string, schema: string | null = 'public'): ColumnRef => ({
  schema,
  table: tbl,
  name,
  dataType: 'text',
  nullable: true,
  primaryKey: false,
  foreignKey: false,
})

describe('ExplorerView profile pruning', () => {
  it('drops expand/collapse state of removed profiles, keeping live ones', () => {
    const view = new ExplorerView()
    view.profileIds = ['p1']
    const inner = internals(view)
    inner._tree = {
      collapsedSchemas: new Set(['p1:public', 'p2:public']),
      expandedTables: new Set(['p2:public:users']),
      expandedObjectGroups: new Set(['p1:public:Functions']),
    }

    inner.willUpdate(new Map([['profileIds', undefined]]))

    expect(inner._tree.collapsedSchemas).toEqual(new Set(['p1:public']))
    expect(inner._tree.expandedTables).toEqual(new Set())
    expect(inner._tree.expandedObjectGroups).toEqual(new Set(['p1:public:Functions']))
  })

  it('keeps the same state object when nothing is pruned (no extra render)', () => {
    const view = new ExplorerView()
    view.profileIds = ['p1']
    const inner = internals(view)
    inner._tree = {
      collapsedSchemas: new Set(['p1:public']),
      expandedTables: new Set(),
      expandedObjectGroups: new Set(),
    }
    const before = inner._tree

    inner.willUpdate(new Map([['profileIds', undefined]]))

    expect(inner._tree).toBe(before)
  })
})

describe('ExplorerView outside selection reveal', () => {
  it('expands the Tables section and the schema group holding the selection', () => {
    const view = new ExplorerView()
    view.selectedTable = 'p1:public:users'
    const inner = internals(view)
    inner._layout = { ...inner._layout, tablesCollapsed: true }
    inner._tree = { ...inner._tree, collapsedSchemas: new Set(['p1:public', 'p1:audit']) }

    inner.willUpdate(new Map([['selectedTable', undefined]]))

    expect(inner._layout.tablesCollapsed).toBe(false)
    expect(inner._tree.collapsedSchemas).toEqual(new Set(['p1:audit']))
  })
})

describe('ExplorerView database selection', () => {
  it('hides loaded tables until an all-databases child is selected', async () => {
    const view = new ExplorerView()
    view.profileId = 'p1'
    view.tables = [table('users')]
    view.awaitingDatabaseSelection = true
    document.body.append(view)

    await view.updateComplete

    expect(view.shadowRoot?.textContent).toContain('Select a database to see its tables')
    expect(view.shadowRoot?.textContent).not.toContain('users')
    view.remove()
  })
})

describe('ExplorerView table sizes', () => {
  it('uses the same checkmark indicator for table filters and sorting', async () => {
    const view = new ExplorerView()
    view.profileId = 'p1'
    view.tables = [table('users')]
    document.body.append(view)

    await view.updateComplete
    view.shadowRoot!.querySelector<HTMLButtonElement>('button[aria-label="Table options"]')!.click()
    await view.updateComplete

    const filter = view.shadowRoot!.querySelector<HTMLButtonElement>('[role="menuitemcheckbox"]')!
    expect(filter.querySelector('.check')!.classList.contains('icon-check')).toBe(true)
    expect(filter.querySelector('.icon-square, .icon-square-check')).toBeNull()

    filter.click()
    await view.updateComplete
    expect(filter.querySelector('.check')!.classList.contains('icon-check')).toBe(false)
    filter.click()
    await view.updateComplete
    view.remove()
  })

  it('shows total size labels and marks estimated catalog values', async () => {
    const view = new ExplorerView()
    view.profileId = 'p1'
    view.tables = [table('users'), { ...table('active_users'), kind: 'view' }]
    view.tableStats = [{ schema: 'public', name: 'users', totalBytes: 12.4 * 1_024 * 1_024, approximate: true }]
    document.body.append(view)

    await view.updateComplete

    const sizes = [...view.shadowRoot!.querySelectorAll('.table-size')].map((node) => node.textContent)
    expect(sizes).toEqual(['—', '~12.4 MB'])
    expect(view.shadowRoot!.textContent).toContain('users')
    view.remove()
  })

  it('drops the size column outright when the engine reports no sizes', async () => {
    const view = new ExplorerView()
    view.profileId = 'p1'
    view.tables = [table('users')]
    view.tableStats = null
    document.body.append(view)

    await view.updateComplete

    // A column of nothing but dashes — SQLite, or a refused read — is worse
    // than no column, and the size sort would have nothing to order by.
    expect(view.shadowRoot!.querySelector('.table-size')).toBeNull()
    expect(view.shadowRoot!.textContent).toContain('users')
    view.remove()
  })

  it('keeps the row tooltip on tables whose size is unknown', async () => {
    const view = new ExplorerView()
    view.profileId = 'p1'
    view.tables = [table('users')]
    view.tableStats = []
    document.body.append(view)

    await view.updateComplete

    // An empty title would mean "no advisory information" and suppress the
    // row's own tooltip rather than letting it show through.
    expect(view.shadowRoot!.querySelector('.table-size')!.hasAttribute('title')).toBe(false)
    expect(view.shadowRoot!.querySelector('.etable-row')!.getAttribute('title')).toContain('users')
    view.remove()
  })

  it('sorts known sizes descending and leaves unavailable sizes last', async () => {
    const view = new ExplorerView()
    view.profileId = 'p1'
    view.tables = [table('small'), table('unknown'), table('large')]
    view.tableStats = [
      { schema: 'public', name: 'small', totalBytes: 10 },
      { schema: 'public', name: 'large', totalBytes: 100 },
    ]
    internals(view)._tableSort = 'size'
    document.body.append(view)

    await view.updateComplete

    const names = [...view.shadowRoot!.querySelectorAll('.table-name')].map((node) => node.textContent)
    expect(names).toEqual(['large', 'small', 'unknown'])
    view.remove()
  })
})

describe('ExplorerView tree toggles', () => {
  it('expands and collapses a table without disturbing sibling state', () => {
    const view = new ExplorerView()
    const inner = internals(view)
    const key = tableKey('p1', table('users'))
    inner._tree = { ...inner._tree, collapsedSchemas: new Set(['p1:audit']) }

    inner._toggleTable(new Event('click'), key)
    expect(inner._tree.expandedTables.has(key)).toBe(true)
    expect(inner._tree.collapsedSchemas).toEqual(new Set(['p1:audit']))

    inner._toggleTable(new Event('click'), key)
    expect(inner._tree.expandedTables.has(key)).toBe(false)
  })

  it('toggles schema and object groups independently', () => {
    const view = new ExplorerView()
    const inner = internals(view)

    inner._toggleSchema('p1:public')
    inner._toggleObjectGroup('p1:public:Functions')
    expect(inner._tree.collapsedSchemas.has('p1:public')).toBe(true)
    expect(inner._tree.expandedObjectGroups.has('p1:public:Functions')).toBe(true)

    inner._toggleSchema('p1:public')
    expect(inner._tree.collapsedSchemas.has('p1:public')).toBe(false)
    expect(inner._tree.expandedObjectGroups.has('p1:public:Functions')).toBe(true)
  })
})

describe('ExplorerView column grouping', () => {
  it('groups columns per table and reuses the map until columns change', () => {
    const view = new ExplorerView()
    view.columns = [column('users', 'id'), column('users', 'name'), column('orders', 'id')]
    const inner = internals(view)

    expect(inner._tableColumns(table('users'))?.map((c) => c.name)).toEqual(['id', 'name'])
    expect(inner._tableColumns(table('orders'))?.map((c) => c.name)).toEqual(['id'])
    expect(inner._tableColumns(table('empty'))).toEqual([])

    const first = inner._tableColumns(table('users'))
    expect(inner._tableColumns(table('users'))).toBe(first)
    view.columns = [column('users', 'id')]
    expect(inner._tableColumns(table('users'))).not.toBe(first)
  })

  it('returns null (loading) while columns have not arrived', () => {
    const view = new ExplorerView()
    view.columns = null
    expect(internals(view)._tableColumns(table('users'))).toBeNull()
  })
})

describe('ExplorerView context menu', () => {
  it('opens the table menu at the pointer, replacing any object menu', () => {
    const view = new ExplorerView()
    const inner = internals(view)
    inner._menu = { kind: 'object' }

    inner._onTableMenu(new MouseEvent('contextmenu', { clientX: 10, clientY: 20 }), table('users'))

    expect(inner._menu).toMatchObject({ kind: 'table', x: 10, y: 20 })
  })

  it('creates in the right-clicked table schema', () => {
    const view = new ExplorerView()
    const onCreate = vi.fn()
    view.addEventListener('table-create', onCreate)

    internals(view)._onTableMenuPick('create', table('users', 'billing'))

    expect((onCreate.mock.calls[0]![0] as CustomEvent).detail).toEqual({ schema: 'billing' })
  })

  it('copies an engine-correct, safely quoted browse query', () => {
    const writeText = vi.fn(() => Promise.resolve())
    Object.assign(navigator, { clipboard: { writeText } })
    const view = new ExplorerView()
    view.engine = 'sqlserver'

    internals(view)._onTableMenuPick('copy-select', table('order details', 'sales'))

    expect(writeText).toHaveBeenCalledWith('SELECT TOP 100 * FROM [sales].[order details];')
  })

  it('dispatches a CSV import for the right-clicked table', () => {
    const view = new ExplorerView()
    const onImport = vi.fn()
    const target = table('users', 'billing')
    view.addEventListener('table-import', onImport)

    internals(view)._onTableMenuPick('import', target)

    expect((onImport.mock.calls[0]![0] as CustomEvent).detail).toEqual({ table: target })
  })
})
