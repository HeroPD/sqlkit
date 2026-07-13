// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
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
})
