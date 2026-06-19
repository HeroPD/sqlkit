import { describe, expect, it } from 'vitest'
import type { TableRef } from './electron'
import { inferEditableTable } from './sql-edit-context'

const tables: TableRef[] = [
  { schema: 'public', name: 'users', kind: 'table' },
  { schema: 'public', name: 'orders', kind: 'table' },
  { schema: 'audit', name: 'users', kind: 'table' },
  { schema: null, name: 'notes', kind: 'table' },
]

describe('inferEditableTable', () => {
  it('infers an unambiguous single-table select', () => {
    expect(inferEditableTable('  select id, body from notes where id = 1', tables)).toEqual({
      schema: null,
      name: 'notes',
      kind: 'table',
    })
  })

  it('infers a quoted schema-qualified table', () => {
    expect(inferEditableTable('SELECT * FROM "public"."users" LIMIT 20', tables)).toEqual({
      schema: 'public',
      name: 'users',
      kind: 'table',
    })
  })

  it('ignores FROM inside strings and comments', () => {
    expect(inferEditableTable("select 'from nowhere' as label -- from fake\nfrom notes", tables)?.name).toBe('notes')
  })

  it('rejects joins, comma sources and set operations', () => {
    expect(inferEditableTable('select * from users join orders on orders.user_id = users.id', tables)).toBeNull()
    expect(inferEditableTable('select * from users, orders', tables)).toBeNull()
    expect(inferEditableTable('select * from notes union select * from notes', tables)).toBeNull()
  })

  it('rejects ambiguous unqualified table names and subquery sources', () => {
    expect(inferEditableTable('select * from users', tables)).toBeNull()
    expect(inferEditableTable('select * from (select * from notes) n', tables)).toBeNull()
  })
})
