import { describe, expect, it } from 'vitest'
import type { ColumnRef, TableRef } from './electron'
import { buildBatchUpdate, buildDeleteRows, buildInsert, buildInsertDefault, buildUpdate, coerceValue, quoteQualified } from './sql-write'

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

  it('binds booleans as 1/0 for SQLite and as JS booleans for Postgres', () => {
    expect(coerceValue('true', col({ dataType: 'boolean' }), 'sqlite')).toBe(1)
    expect(coerceValue('0', col({ dataType: 'boolean' }), 'sqlite')).toBe(0)
    expect(coerceValue('no', col({ dataType: 'boolean' }), 'sqlite')).toBe(0)
    expect(coerceValue('true', col({ dataType: 'boolean' }), 'postgresql')).toBe(true)
    // Unrecognized boolean token still falls back to the raw text.
    expect(coerceValue('maybe', col({ dataType: 'boolean' }), 'sqlite')).toBe('maybe')
  })

  it('keeps bigint and high-scale numerics as exact strings (no Number() rounding)', () => {
    // 9007199254740993 = 2^53 + 1, the first integer a double cannot represent.
    expect(coerceValue('9007199254740993', col({ dataType: 'bigint' }))).toBe('9007199254740993')
    expect(coerceValue('1234567890123456789', col({ dataType: 'bigint' }))).toBe('1234567890123456789')
    expect(coerceValue('0.123456789012345678', col({ dataType: 'numeric' }))).toBe('0.123456789012345678')
    // Small, exactly-representable values still bind as numbers.
    expect(coerceValue('42', col({ dataType: 'integer' }))).toBe(42)
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

  it('coerces a boolean cell to 1/0 for a SQLite UPDATE', () => {
    const { params } = buildUpdate({
      table: { schema: null, name: 'flags', kind: 'table' },
      column: 'active',
      columnMeta: col({ schema: null, table: 'flags', name: 'active', dataType: 'boolean' }),
      value: 'true',
      pks: [{ name: 'id', value: 1 }],
      dialect: 'sqlite',
    })
    expect(params).toEqual([1, 1])
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

describe('buildInsertDefault', () => {
  it('builds an INSERT DEFAULT VALUES statement', () => {
    expect(buildInsertDefault(users)).toEqual({ sql: 'INSERT INTO "public"."users" DEFAULT VALUES', params: [] })
  })
})

describe('buildInsert', () => {
  it('lists only filled columns, coercing values, with Postgres placeholders', () => {
    const { sql, params } = buildInsert({
      table: users,
      columns: [
        { name: 'id', columnMeta: col({ name: 'id', dataType: 'integer', nullable: false }) },
        { name: 'name', columnMeta: col({ name: 'name' }) },
      ],
      values: ['42', 'Ada'],
      dialect: 'postgresql',
    })

    expect(sql).toBe('INSERT INTO "public"."users" ("id", "name")\nVALUES ($1, $2)')
    expect(params).toEqual([42, 'Ada'])
  })

  it('uses ? placeholders and coerces empty nullable cells to NULL on SQLite', () => {
    const { sql, params } = buildInsert({
      table: users,
      columns: [{ name: 'name', columnMeta: col({ name: 'name', nullable: true }) }],
      values: [''],
      dialect: 'sqlite',
    })

    expect(sql).toBe('INSERT INTO "public"."users" ("name")\nVALUES (?)')
    expect(params).toEqual([null])
  })

  it('falls back to DEFAULT VALUES when no columns were filled', () => {
    expect(buildInsert({ table: users, columns: [], values: [], dialect: 'postgresql' })).toEqual({
      sql: 'INSERT INTO "public"."users" DEFAULT VALUES',
      params: [],
    })
  })
})

describe('buildDeleteRows', () => {
  it('builds a Postgres DELETE for selected row keys', () => {
    const { sql, params } = buildDeleteRows({
      table: users,
      rows: [[{ name: 'id', value: 1 }], [{ name: 'id', value: 2 }]],
      dialect: 'postgresql',
    })

    expect(sql).toBe('DELETE FROM "public"."users"\n WHERE ("id" = $1) OR ("id" = $2)')
    expect(params).toEqual([1, 2])
  })

  it('supports SQLite placeholders and composite primary keys', () => {
    const { sql, params } = buildDeleteRows({
      table: { schema: null, name: 'line_items', kind: 'table' },
      rows: [[{ name: 'order_id', value: 10 }, { name: 'sku', value: 'A1' }]],
      dialect: 'sqlite',
    })

    expect(sql).toBe('DELETE FROM "line_items"\n WHERE ("order_id" = ? AND "sku" = ?)')
    expect(params).toEqual([10, 'A1'])
  })

  it('throws without rows or primary keys', () => {
    expect(() => buildDeleteRows({ table: users, rows: [], dialect: 'postgresql' })).toThrow()
    expect(() => buildDeleteRows({ table: users, rows: [[]], dialect: 'postgresql' })).toThrow()
  })
})
