import { describe, expect, it } from 'vitest'
import type { ColumnRef, QueryResult } from './electron'
import { jsonColumns } from './json-columns'

const column = (table: string, name: string, dataType: string, schema: string | null = 'public'): ColumnRef => ({
  schema,
  table,
  name,
  dataType,
  nullable: true,
  primaryKey: false,
  foreignKey: false,
})

const source = (table: string | null, name: string | null, schema: string | null = 'public') =>
  ({ schema, table, column: name })

const result = (columns: string[], sources?: ReturnType<typeof source>[]): QueryResult => ({
  columns,
  rows: [],
  rowCount: 0,
  durationMs: 1,
  ...(sources ? { columnSources: sources } : {}),
})

describe('jsonColumns', () => {
  it('finds json and jsonb columns by result index', () => {
    const found = jsonColumns(
      result(['id', 'payload', 'settings'], [source('events', 'id'), source('events', 'payload'), source('events', 'settings')]),
      [column('events', 'id', 'integer'), column('events', 'payload', 'jsonb'), column('events', 'settings', 'json')],
    )
    expect([...found]).toEqual([1, 2])
  })

  it('ignores text columns that merely hold JSON', () => {
    const found = jsonColumns(
      result(['note'], [source('events', 'note')]),
      [column('events', 'note', 'text')],
    )
    expect(found.size).toBe(0)
  })

  it('does not mistake jsonpath or json arrays for a document column', () => {
    const found = jsonColumns(
      result(['path', 'many'], [source('events', 'path'), source('events', 'many')]),
      [column('events', 'path', 'jsonpath'), column('events', 'many', 'jsonb[]')],
    )
    expect(found.size).toBe(0)
  })

  it('offers nothing without column sources, since no column can be traced to a table', () => {
    expect(jsonColumns(result(['payload']), [column('events', 'payload', 'jsonb')]).size).toBe(0)
  })

  it('ignores expression columns, which belong to no table', () => {
    const found = jsonColumns(result(['count'], [source(null, null)]), [column('events', 'payload', 'jsonb')])
    expect(found.size).toBe(0)
  })

  it('matches case-exactly before folding, so a quoted twin binds correctly', () => {
    const found = jsonColumns(
      result(['Payload', 'payload'], [source('events', 'Payload'), source('events', 'payload')]),
      [column('events', 'Payload', 'text'), column('events', 'payload', 'jsonb')],
    )
    expect([...found]).toEqual([1])
  })

  it('falls back to a folded match when the source case differs from the metadata', () => {
    const found = jsonColumns(
      result(['payload'], [source('EVENTS', 'PAYLOAD', 'PUBLIC')]),
      [column('events', 'payload', 'jsonb')],
    )
    expect([...found]).toEqual([0])
  })
})
