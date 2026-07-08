import { describe, expect, it } from 'vitest'
import type { ColumnRef, InspectColumn, TableRef } from './electron'
import { dialectFor } from './dialect'
import {
  buildBatchUpdate,
  buildColumnAdd,
  buildColumnAlter,
  buildColumnDrop,
  buildDeleteRows,
  buildInsert,
  buildInsertDefault,
  coerceValue,
  quoteLiteral,
  quoteQualified,
} from './sql-write'

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
    expect(quoteQualified(users, dialectFor('postgresql'))).toBe('"public"."users"')
    expect(quoteQualified({ schema: null, name: 'users', kind: 'table' }, dialectFor('sqlite'))).toBe('"users"')
    expect(quoteQualified({ schema: null, name: 'we"ird', kind: 'table' }, dialectFor('postgresql'))).toBe('"we""ird"')
  })

  it('uses the engine dialect: backticks for MySQL, brackets for SQL Server', () => {
    expect(quoteQualified(users, dialectFor('mysql'))).toBe('`public`.`users`')
    expect(quoteQualified(users, dialectFor('sqlserver'))).toBe('[public].[users]')
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

describe('buildBatchUpdate', () => {
  it('builds one Postgres UPDATE for multiple selected cells', () => {
    const { sql, params } = buildBatchUpdate({
      table: users,
      edits: [
        { column: 'name', columnMeta: col({ name: 'name' }), value: 'Ada', pks: [{ name: 'id', value: 1 }] },
        { column: 'name', columnMeta: col({ name: 'name' }), value: 'Ada', pks: [{ name: 'id', value: 2 }] },
        { column: 'qty', columnMeta: col({ name: 'qty', dataType: 'integer' }), value: '7', pks: [{ name: 'id', value: 1 }] },
      ],
      engine: 'postgresql',
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
      engine: 'sqlite',
    })

    expect(sql).toContain('UPDATE "notes"')
    expect(sql).toContain('WHEN "id" = ? THEN ?')
    expect(sql).toContain('WHERE ("id" = ?)')
    expect(params).toEqual([7, null, 7])
  })

  it('throws without edits or primary keys', () => {
    expect(() => buildBatchUpdate({ table: users, edits: [], engine: 'postgresql' })).toThrow()
    expect(() =>
      buildBatchUpdate({
        table: users,
        edits: [{ column: 'name', columnMeta: col({}), value: 'x', pks: [] }],
        engine: 'postgresql',
      }),
    ).toThrow()
  })
})

describe('buildInsertDefault', () => {
  it('builds an INSERT DEFAULT VALUES statement', () => {
    expect(buildInsertDefault(users, dialectFor('postgresql'))).toEqual({
      sql: 'INSERT INTO "public"."users" DEFAULT VALUES',
      params: [],
    })
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
      engine: 'postgresql',
    })

    expect(sql).toBe('INSERT INTO "public"."users" ("id", "name")\nVALUES ($1, $2)')
    expect(params).toEqual([42, 'Ada'])
  })

  it('uses ? placeholders and coerces empty nullable cells to NULL on SQLite', () => {
    const { sql, params } = buildInsert({
      table: users,
      columns: [{ name: 'name', columnMeta: col({ name: 'name', nullable: true }) }],
      values: [''],
      engine: 'sqlite',
    })

    expect(sql).toBe('INSERT INTO "public"."users" ("name")\nVALUES (?)')
    expect(params).toEqual([null])
  })

  it('falls back to DEFAULT VALUES when no columns were filled', () => {
    expect(buildInsert({ table: users, columns: [], values: [], engine: 'postgresql' })).toEqual({
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
      engine: 'postgresql',
    })

    expect(sql).toBe('DELETE FROM "public"."users"\n WHERE ("id" = $1) OR ("id" = $2)')
    expect(params).toEqual([1, 2])
  })

  it('supports SQLite placeholders and composite primary keys', () => {
    const { sql, params } = buildDeleteRows({
      table: { schema: null, name: 'line_items', kind: 'table' },
      rows: [[{ name: 'order_id', value: 10 }, { name: 'sku', value: 'A1' }]],
      engine: 'sqlite',
    })

    expect(sql).toBe('DELETE FROM "line_items"\n WHERE ("order_id" = ? AND "sku" = ?)')
    expect(params).toEqual([10, 'A1'])
  })

  it('throws without rows or primary keys', () => {
    expect(() => buildDeleteRows({ table: users, rows: [], engine: 'postgresql' })).toThrow()
    expect(() => buildDeleteRows({ table: users, rows: [[]], engine: 'postgresql' })).toThrow()
  })
})

const inspectCol = (over: Partial<InspectColumn>): InspectColumn => ({
  name: 'age',
  dataType: 'integer',
  nullable: true,
  default: null,
  primaryKey: false,
  comment: null,
  ...over,
})

describe('quoteLiteral', () => {
  it('single-quotes and doubles embedded quotes', () => {
    expect(quoteLiteral('hi')).toBe("'hi'")
    expect(quoteLiteral("O'Brien")).toBe("'O''Brien'")
  })
})

describe('buildColumnAlter', () => {
  it('emits a statement only for changed properties', () => {
    const original = inspectCol({ name: 'age', dataType: 'integer', nullable: true, default: null, comment: null })
    // dataType set to the same value, comment changed — only the comment moves.
    expect(buildColumnAlter(users, [{ original, dataType: 'integer', comment: 'years old' }], 'postgresql')).toEqual([
      `COMMENT ON COLUMN "public"."users"."age" IS 'years old'`,
    ])
    // No diff at all → nothing.
    expect(buildColumnAlter(users, [{ original }], 'postgresql')).toEqual([])
  })

  it('builds Postgres type / nullable / default / comment forms', () => {
    const original = inspectCol({ name: 'age', dataType: 'integer', nullable: true, default: null, comment: null })
    expect(
      buildColumnAlter(users, [{ original, dataType: 'bigint', nullable: false, default: '0', comment: 'n' }], 'postgresql'),
    ).toEqual([
      'ALTER TABLE "public"."users" ALTER COLUMN "age" TYPE bigint',
      'ALTER TABLE "public"."users" ALTER COLUMN "age" SET NOT NULL',
      'ALTER TABLE "public"."users" ALTER COLUMN "age" SET DEFAULT 0',
      `COMMENT ON COLUMN "public"."users"."age" IS 'n'`,
    ])
  })

  it('drops default/comment and sets NOT NULL nullable via the right verbs', () => {
    const original = inspectCol({ name: 'age', nullable: false, default: '0', comment: 'old' })
    expect(
      buildColumnAlter(users, [{ original, nullable: true, default: '', comment: '' }], 'postgresql'),
    ).toEqual([
      'ALTER TABLE "public"."users" ALTER COLUMN "age" DROP NOT NULL',
      'ALTER TABLE "public"."users" ALTER COLUMN "age" DROP DEFAULT',
      'COMMENT ON COLUMN "public"."users"."age" IS NULL',
    ])
  })

  it('treats a null default the same as an empty one (no spurious DROP)', () => {
    const original = inspectCol({ default: null })
    expect(buildColumnAlter(users, [{ original, default: '' }], 'postgresql')).toEqual([])
  })

  it('orders RENAME COLUMN last so prior statements target the old name', () => {
    const original = inspectCol({ name: 'age', dataType: 'integer' })
    expect(buildColumnAlter(users, [{ original, name: 'age_years', dataType: 'bigint' }], 'postgresql')).toEqual([
      'ALTER TABLE "public"."users" ALTER COLUMN "age" TYPE bigint',
      'ALTER TABLE "public"."users" RENAME COLUMN "age" TO "age_years"',
    ])
  })

  it('escapes comment literals', () => {
    const original = inspectCol({ comment: null })
    expect(buildColumnAlter(users, [{ original, comment: "it's fine" }], 'postgresql')).toEqual([
      `COMMENT ON COLUMN "public"."users"."age" IS 'it''s fine'`,
    ])
  })

  it('supports SQLite RENAME only, ignoring type/nullable/default diffs', () => {
    const original = inspectCol({ name: 'age', dataType: 'INTEGER', nullable: true, default: null })
    const notes: TableRef = { schema: null, name: 'notes', kind: 'table' }
    expect(
      buildColumnAlter(notes, [{ original, name: 'years', dataType: 'REAL', nullable: false, default: '0' }], 'sqlite'),
    ).toEqual(['ALTER TABLE "notes" RENAME COLUMN "age" TO "years"'])
  })

  it('supports MySQL default and rename, ignoring type/nullable/comment diffs', () => {
    const original = inspectCol({ name: 'age', dataType: 'int', nullable: true, default: null, comment: null })
    expect(
      buildColumnAlter(users, [{ original, name: 'years', dataType: 'bigint', nullable: false, default: '0', comment: 'n' }], 'mysql'),
    ).toEqual([
      'ALTER TABLE `public`.`users` ALTER COLUMN `age` SET DEFAULT 0',
      'ALTER TABLE `public`.`users` RENAME COLUMN `age` TO `years`',
    ])
    expect(buildColumnAlter(users, [{ original, default: '' }], 'mysql')).toEqual([])
    expect(buildColumnAlter(users, [{ original: inspectCol({ default: '0' }), default: '' }], 'mysql')).toEqual([
      'ALTER TABLE `public`.`users` ALTER COLUMN `age` DROP DEFAULT',
    ])
  })

  it('restates the full SQL Server type and nullability in one ALTER COLUMN', () => {
    const original = inspectCol({ name: 'age', dataType: 'int', nullable: true })
    expect(buildColumnAlter(users, [{ original, dataType: 'bigint', nullable: false }], 'sqlserver')).toEqual([
      'ALTER TABLE [public].[users] ALTER COLUMN [age] bigint NOT NULL',
    ])
    // A lone nullable change re-emits the original type (with its precision).
    const stamp = inspectCol({ name: 'at', dataType: 'datetime2(3)', nullable: true })
    expect(buildColumnAlter(users, [{ original: stamp, nullable: false }], 'sqlserver')).toEqual([
      'ALTER TABLE [public].[users] ALTER COLUMN [at] datetime2(3) NOT NULL',
    ])
    // A custom collation is restated on string types, or ALTER COLUMN resets it.
    const tag = inspectCol({ name: 'tag', dataType: 'nvarchar(50)', nullable: true, collation: 'Latin1_General_CS_AS' })
    expect(buildColumnAlter(users, [{ original: tag, nullable: false }], 'sqlserver')).toEqual([
      'ALTER TABLE [public].[users] ALTER COLUMN [tag] nvarchar(50) COLLATE Latin1_General_CS_AS NOT NULL',
    ])
    // ...but never onto a non-string target type.
    expect(buildColumnAlter(users, [{ original: tag, dataType: 'int' }], 'sqlserver')).toEqual([
      'ALTER TABLE [public].[users] ALTER COLUMN [tag] int NULL',
    ])
    // Default diffs are ignored: SQL Server defaults are named constraints.
    expect(buildColumnAlter(users, [{ original, default: '0' }], 'sqlserver')).toEqual([])
  })

  it('renames SQL Server columns via sp_rename with a quoted column path', () => {
    const original = inspectCol({ name: 'age' })
    expect(buildColumnAlter(users, [{ original, name: 'years' }], 'sqlserver')).toEqual([
      `EXEC sp_rename N'[public].[users].[age]', N'years', 'COLUMN'`,
    ])
  })
})

describe('buildColumnAdd', () => {
  it('builds a plain nullable ADD COLUMN', () => {
    expect(buildColumnAdd(users, [{ name: 'nickname', dataType: 'text', nullable: true, default: null, comment: null }], 'postgresql')).toEqual([
      'ALTER TABLE "public"."users" ADD COLUMN "nickname" text',
    ])
  })

  it('adds DEFAULT then NOT NULL, and a separate COMMENT statement', () => {
    expect(
      buildColumnAdd(users, [{ name: 'score', dataType: 'integer', nullable: false, default: '0', comment: "player's score" }], 'postgresql'),
    ).toEqual([
      'ALTER TABLE "public"."users" ADD COLUMN "score" integer DEFAULT 0 NOT NULL',
      `COMMENT ON COLUMN "public"."users"."score" IS 'player''s score'`,
    ])
  })

  it('skips a row with a blank name or type', () => {
    expect(buildColumnAdd(users, [{ name: '', dataType: 'text', nullable: true, default: null, comment: null }], 'postgresql')).toEqual([])
    expect(buildColumnAdd(users, [{ name: 'x', dataType: '  ', nullable: true, default: null, comment: null }], 'postgresql')).toEqual([])
  })

  it('rides the comment inline on MySQL and drops it where unsupported', () => {
    const add = { name: 'score', dataType: 'int', nullable: false, default: '0', comment: "the player's score" }
    expect(buildColumnAdd(users, [add], 'mysql')).toEqual([
      "ALTER TABLE `public`.`users` ADD COLUMN `score` int DEFAULT 0 NOT NULL COMMENT 'the player''s score'",
    ])
    expect(buildColumnAdd({ schema: null, name: 'notes', kind: 'table' }, [add], 'sqlite')).toEqual([
      'ALTER TABLE "notes" ADD COLUMN "score" int DEFAULT 0 NOT NULL',
    ])
  })

  it('spells SQL Server ADD without the COLUMN keyword', () => {
    expect(buildColumnAdd(users, [{ name: 'score', dataType: 'int', nullable: true, default: null, comment: null }], 'sqlserver')).toEqual([
      'ALTER TABLE [public].[users] ADD [score] int',
    ])
  })
})

describe('buildColumnDrop', () => {
  it('emits one DROP COLUMN per name in the engine quoting style', () => {
    expect(buildColumnDrop(users, ['age', 'nickname'], 'postgresql')).toEqual([
      'ALTER TABLE "public"."users" DROP COLUMN "age"',
      'ALTER TABLE "public"."users" DROP COLUMN "nickname"',
    ])
    expect(buildColumnDrop(users, ['age'], 'sqlserver')).toEqual(['ALTER TABLE [public].[users] DROP COLUMN [age]'])
    expect(buildColumnDrop(users, [], 'mysql')).toEqual([])
  })
})
