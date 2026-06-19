import { describe, expect, it } from 'vitest'
import type { ColumnRef, TableRef } from './electron'
import { buildBatchUpdate, buildUpdate, coerceValue, quoteQualified } from './sql-write'

const users: TableRef = { schema: 'public', name: 'users', kind: 'table' }
const col = (over: Partial<ColumnRef>): ColumnRef => ({
  schema: 'public',
  table: 'users',
  name: 'name',
  dataType: 'text',
  nullable: true,
  primaryKey: false,
  foreignKey: false,
  ...over,
})

describe('quoteQualified', () => {
  it('quotes schema.table, and just the name when schema is null', () => {
    expect(quoteQualified(users)).toBe('"public"."users"')
    expect(quoteQualified({ schema: null, name: 'users', kind: 'table' })).toBe('"users"')
    expect(quoteQualified({ schema: null, name: 'we"ird', kind: 'table' })).toBe('"we""ird"')
  })
})

describe('coerceValue', () => {
  it('parses numeric and boolean columns, passes text through', () => {
    expect(coerceValue('42', col({ dataType: 'integer' }))).toBe(42)
    expect(coerceValue('3.5', col({ dataType: 'numeric' }))).toBe(3.5)
    expect(coerceValue('true', col({ dataType: 'boolean' }))).toBe(true)
    expect(coerceValue('Ada', col({ dataType: 'text' }))).toBe('Ada')
  })

  it('maps an empty string to NULL only when the column is nullable', () => {
    expect(coerceValue('', col({ nullable: true }))).toBeNull()
    expect(coerceValue('', col({ nullable: false }))).toBe('')
  })

  it('falls back to text for unparseable numeric input', () => {
    expect(coerceValue('N/A', col({ dataType: 'integer' }))).toBe('N/A')
  })
})

describe('buildUpdate', () => {
  it('builds a Postgres UPDATE with $-placeholders', () => {
    const { sql, params } = buildUpdate({
      table: users,
      column: 'name',
      columnMeta: col({}),
      value: 'Ada',
      pks: [{ name: 'id', value: 42 }],
      dialect: 'postgresql',
    })
    expect(sql).toContain('UPDATE "public"."users"')
    expect(sql).toContain('SET "name" = $1')
    expect(sql).toContain('WHERE "id" = $2')
    expect(params).toEqual(['Ada', 42])
  })

  it('uses ? placeholders for SQLite', () => {
    const { sql, params } = buildUpdate({
      table: { schema: null, name: 'notes', kind: 'table' },
      column: 'body',
      columnMeta: col({ schema: null, table: 'notes', name: 'body' }),
      value: 'hi',
      pks: [{ name: 'id', value: 7 }],
      dialect: 'sqlite',
    })
    expect(sql).toContain('UPDATE "notes"')
    expect(sql).toContain('SET "body" = ?')
    expect(sql).toContain('WHERE "id" = ?')
    expect(params).toEqual(['hi', 7])
  })

  it('ANDs every column of a composite primary key', () => {
    const { sql, params } = buildUpdate({
      table: users,
      column: 'qty',
      columnMeta: col({ name: 'qty', dataType: 'integer' }),
      value: '5',
      pks: [
        { name: 'order_id', value: 10 },
        { name: 'sku', value: 'A1' },
      ],
      dialect: 'postgresql',
    })
    expect(sql).toContain('WHERE "order_id" = $2 AND "sku" = $3')
    expect(params).toEqual([5, 10, 'A1'])
  })

  it('throws without a primary key', () => {
    expect(() =>
      buildUpdate({ table: users, column: 'name', columnMeta: col({}), value: 'x', pks: [], dialect: 'postgresql' }),
    ).toThrow()
  })
})

describe('buildBatchUpdate', () => {
  it('builds one Postgres UPDATE for multiple selected cells', () => {
    const { sql, params } = buildBatchUpdate({
      table: users,
      edits: [
        { column: 'name', columnMeta: col({ name: 'name' }), value: 'Ada', pks: [{ name: 'id', value: 1 }] },
        { column: 'name', columnMeta: col({ name: 'name' }), value: 'Ada', pks: [{ name: 'id', value: 2 }] },
        { column: 'qty', columnMeta: col({ name: 'qty', dataType: 'integer' }), value: '7', pks: [{ name: 'id', value: 1 }] },
      ],
      dialect: 'postgresql',
    })

    expect(sql).toContain('UPDATE "public"."users"')
    expect(sql).toContain('"name" = CASE')
    expect(sql).toContain('"qty" = CASE')
    expect(sql).toContain('WHERE ("id" = $7) OR ("id" = $8) OR ("id" = $9)')
    expect(params).toEqual([1, 'Ada', 2, 'Ada', 1, 7, 1, 2, 1])
  })

  it('uses SQLite placeholders and coerces nullable empty values per column', () => {
    const { sql, params } = buildBatchUpdate({
      table: { schema: null, name: 'notes', kind: 'table' },
      edits: [
        {
          column: 'body',
          columnMeta: col({ schema: null, table: 'notes', name: 'body', nullable: true }),
          value: '',
          pks: [{ name: 'id', value: 7 }],
        },
      ],
      dialect: 'sqlite',
    })

    expect(sql).toContain('UPDATE "notes"')
    expect(sql).toContain('WHEN "id" = ? THEN ?')
    expect(sql).toContain('WHERE ("id" = ?)')
    expect(params).toEqual([7, null, 7])
  })

  it('throws without edits or primary keys', () => {
    expect(() => buildBatchUpdate({ table: users, edits: [], dialect: 'postgresql' })).toThrow()
    expect(() =>
      buildBatchUpdate({
        table: users,
        edits: [{ column: 'name', columnMeta: col({}), value: 'x', pks: [] }],
        dialect: 'postgresql',
      }),
    ).toThrow()
  })
})
