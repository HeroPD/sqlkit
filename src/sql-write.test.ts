import { describe, expect, it } from 'vitest'
import type { ColumnRef, InspectColumn, TableRef } from './electron'
import { dialectFor } from './dialect'
import {
  SQL_NULL,
  buildAddConstraint,
  buildAddForeignKey,
  buildAddPartition,
  buildBatchUpdate,
  buildBatchUpdates,
  buildColumnAdd,
  buildColumnAlter,
  buildColumnDrop,
  buildCreateIndex,
  buildCreateTrigger,
  buildDeleteRows,
  buildDeleteRowBatches,
  buildInsert,
  buildInsertDefault,
  canAddConstraint,
  coerceValue,
  foreignKeyActions,
  quoteLiteral,
  quoteQualified,
  triggerCapabilities,
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

  it('keeps an empty string distinct from an explicit SQL NULL', () => {
    expect(coerceValue('', col({ nullable: true }))).toBe('')
    expect(coerceValue('', col({ nullable: false }))).toBe('')
    expect(coerceValue(SQL_NULL, col({ nullable: true }))).toBeNull()
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
    expect(sql).toContain('WHERE ("id" IS NOT DISTINCT FROM $7) OR ("id" IS NOT DISTINCT FROM $8)')
    expect(params).toEqual([1, 'Ada', 2, 'Ada', 1, 7, 1, 2])
  })

  it('uses SQLite placeholders and keeps an explicit NULL distinct from empty text', () => {
    const { sql, params } = buildBatchUpdate({
      table: { schema: null, name: 'notes', kind: 'table' },
      edits: [
        {
          column: 'body',
          columnMeta: col({ schema: null, table: 'notes', name: 'body', nullable: true }),
          value: SQL_NULL,
          pks: [{ name: 'id', value: 7 }],
        },
      ],
      engine: 'sqlite',
    })

    expect(sql).toContain('UPDATE "notes"')
    expect(sql).toContain('WHEN "id" COLLATE BINARY IS ? THEN ?')
    expect(sql).toContain('WHERE ("id" COLLATE BINARY IS ?)')
    expect(params).toEqual([7, null, 7])
  })

  it('guards edited values optimistically and requires every target row to match', () => {
    const built = buildBatchUpdate({
      table: users,
      edits: [
        { column: 'name', columnMeta: col({ name: 'name' }), value: 'new', originalValue: 'old', pks: [{ name: 'id', value: 1 }] },
        { column: 'name', columnMeta: col({ name: 'name' }), value: 'other', originalValue: null, pks: [{ name: 'id', value: 2 }] },
      ],
      engine: 'postgresql',
    })
    expect(built.sql).toContain('AND "name" IS NOT DISTINCT FROM $2')
    expect(built.sql).toContain('"name" IS NULL')
    expect(built.expectedRows).toBe(2)
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
      expectedRows: 1,
    })
    expect(buildInsertDefault(users, dialectFor('sqlite')).sql).toBe('INSERT INTO "public"."users" DEFAULT VALUES')
    expect(buildInsertDefault(users, dialectFor('sqlserver')).sql).toBe('INSERT INTO [public].[users] DEFAULT VALUES')
  })

  it('uses the empty-lists spelling on MySQL, which has no DEFAULT VALUES clause', () => {
    expect(buildInsertDefault(users, dialectFor('mysql')).sql).toBe('INSERT INTO `public`.`users` () VALUES ()')
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

  it('uses ? placeholders and binds an explicit NULL cell on SQLite', () => {
    const { sql, params } = buildInsert({
      table: users,
      columns: [{ name: 'name', columnMeta: col({ name: 'name', nullable: true }) }],
      values: [SQL_NULL],
      engine: 'sqlite',
    })

    expect(sql).toBe('INSERT INTO "public"."users" ("name")\nVALUES (?)')
    expect(params).toEqual([null])
  })

  it('inserts an intentional empty string as an empty string', () => {
    const { params } = buildInsert({
      table: users,
      columns: [{ name: 'name', columnMeta: col({ name: 'name', nullable: true }) }],
      values: [''],
      engine: 'sqlite',
    })
    expect(params).toEqual([''])
  })

  it('falls back to DEFAULT VALUES when no columns were filled', () => {
    expect(buildInsert({ table: users, columns: [], values: [], engine: 'postgresql' })).toEqual({
      sql: 'INSERT INTO "public"."users" DEFAULT VALUES',
      params: [],
      expectedRows: 1,
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

    expect(sql).toBe('DELETE FROM "public"."users"\n WHERE ("id" IS NOT DISTINCT FROM $1) OR ("id" IS NOT DISTINCT FROM $2)')
    expect(params).toEqual([1, 2])
  })

  it('supports SQLite placeholders and composite primary keys', () => {
    const { sql, params } = buildDeleteRows({
      table: { schema: null, name: 'line_items', kind: 'table' },
      rows: [[{ name: 'order_id', value: 10 }, { name: 'sku', value: 'A1' }]],
      engine: 'sqlite',
    })

    expect(sql).toBe('DELETE FROM "line_items"\n WHERE ("order_id" COLLATE BINARY IS ? AND "sku" COLLATE BINARY IS ?)')
    expect(params).toEqual([10, 'A1'])
  })

  it('uses IS NULL for optimistic row guards', () => {
    const built = buildDeleteRows({
      table: users,
      rows: [[{ name: 'id', value: 1 }, { name: 'deleted_at', value: null }]],
      engine: 'postgresql',
    })
    expect(built.sql).toContain('"deleted_at" IS NULL')
    expect(built.params).toEqual([1])
  })

  it('splits SQL Server writes below its parameter ceiling', () => {
    const edits = Array.from({ length: 700 }, (_, index) => ({
      column: 'name',
      columnMeta: col({ name: 'name', dataType: 'varchar(255)' }),
      value: `new-${index}`,
      originalValue: `old-${index}`,
      pks: [{ name: 'id', value: index }],
    }))
    const updates = buildBatchUpdates({ table: users, edits, engine: 'sqlserver' })
    expect(updates.length).toBeGreaterThan(1)
    expect(updates.every((statement) => statement.params.length <= 2_000)).toBe(true)
    expect(updates.reduce((total, statement) => total + statement.expectedRows, 0)).toBe(700)

    const deletes = buildDeleteRowBatches({
      table: users,
      rows: Array.from({ length: 1_000 }, (_, index) => [
        { name: 'id', value: index },
        { name: 'name', value: `n-${index}` },
        { name: 'version', value: index },
      ]),
      engine: 'sqlserver',
    })
    expect(deletes.length).toBeGreaterThan(1)
    expect(deletes.every((statement) => statement.params.length <= 2_000)).toBe(true)
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

describe('engine-aware optimistic predicates', () => {
  it('compares text binarily on MySQL and SQL Server', () => {
    const mysqlBuilt = buildDeleteRows({
      table: users,
      rows: [[{ name: 'id', value: 1 }, { name: 'name', value: 'Ada', columnMeta: col({ name: 'name', dataType: 'varchar(255)' }) }]],
      engine: 'mysql',
    })
    expect(mysqlBuilt.sql).toContain('BINARY `name` <=> BINARY ?')

    const mssqlBuilt = buildDeleteRows({
      table: users,
      rows: [[{ name: 'id', value: 1 }, { name: 'name', value: 'Ada', columnMeta: col({ name: 'name', dataType: 'nvarchar(50)' }) }]],
      engine: 'sqlserver',
    })
    expect(mssqlBuilt.sql).toContain('[name] COLLATE Latin1_General_100_BIN2 = @p2 COLLATE Latin1_General_100_BIN2')
  })

  it('refuses guards on types without safe equality', () => {
    expect(() => buildDeleteRows({
      table: users,
      rows: [[{ name: 'id', value: 1 }, { name: 'payload', value: '{}', columnMeta: col({ name: 'payload', dataType: 'json' }) }]],
      engine: 'postgresql',
    })).toThrow(/cannot be compared safely/i)
  })

  it('binds MySQL integer-column guard strings as bigint so they compare exactly, not as doubles', () => {
    const meta = col({ name: 'id', dataType: 'bigint unsigned' })
    const { params } = buildDeleteRows({
      table: users,
      rows: [[{ name: 'id', value: '9223372036854775807', columnMeta: meta }]],
      engine: 'mysql',
    })
    expect(params).toEqual([9223372036854775807n])
  })

  it('casts MySQL decimal-column guards back to DECIMAL so they compare exactly, not as doubles', () => {
    const built = buildDeleteRows({
      table: users,
      rows: [[{ name: 'price', value: '12345678901234567890.1234567890', columnMeta: col({ name: 'price', dataType: 'decimal(30,10)' }) }]],
      engine: 'mysql',
    })
    expect(built.sql).toContain('`price` <=> CAST(? AS DECIMAL(65,10))')
    expect(built.params).toEqual(['12345678901234567890.1234567890'])
    // Scale comes from the value's fraction length; an integer-rendered value casts at scale 0.
    const whole = buildDeleteRows({
      table: users,
      rows: [[{ name: 'price', value: '42', columnMeta: col({ name: 'price', dataType: 'numeric(10,0)' }) }]],
      engine: 'mysql',
    })
    expect(whole.sql).toContain('`price` <=> CAST(? AS DECIMAL(65,0))')
  })

  it('leaves non-integer and non-MySQL guard strings untouched', () => {
    const decimalGuard = buildDeleteRows({
      table: users,
      rows: [[{ name: 'price', value: '12.50', columnMeta: col({ name: 'price', dataType: 'decimal(10,2)' }) }]],
      engine: 'mysql',
    })
    expect(decimalGuard.params).toEqual(['12.50'])
    expect(decimalGuard.sql).toContain('CAST(? AS DECIMAL(65,2))')
    // 'point' contains "int" but is not an integer family type.
    const pointGuard = buildDeleteRows({
      table: users,
      rows: [[{ name: 'id', value: '7', columnMeta: col({ name: 'loc', dataType: 'point' }) }]],
      engine: 'mysql',
    })
    expect(pointGuard.params).toEqual(['7'])
    const pgGuard = buildDeleteRows({
      table: users,
      rows: [[{ name: 'id', value: '9223372036854775807', columnMeta: col({ name: 'id', dataType: 'bigint' }) }]],
      engine: 'postgresql',
    })
    expect(pgGuard.params).toEqual(['9223372036854775807'])
  })
})

describe('buildCreateIndex', () => {
  it('builds engine-quoted CREATE INDEX statements', () => {
    expect(buildCreateIndex(users, { name: 'idx_name', columns: ['name', 'age'], unique: false }, 'postgresql'))
      .toBe('CREATE INDEX "idx_name" ON "public"."users" ("name", "age")')
    expect(buildCreateIndex(users, { name: 'idx_name', columns: ['name'], unique: true }, 'sqlserver'))
      .toBe('CREATE UNIQUE INDEX [idx_name] ON [public].[users] ([name])')
    expect(buildCreateIndex({ schema: null, name: 'users', kind: 'table' }, { name: 'i', columns: ['a'], unique: false }, 'mysql'))
      .toBe('CREATE INDEX `i` ON `users` (`a`)')
  })

  it('emits USING only for non-default PostgreSQL methods and rejects unknown ones', () => {
    expect(buildCreateIndex(users, { name: 'i', columns: ['a'], unique: false, method: 'gin' }, 'postgresql'))
      .toBe('CREATE INDEX "i" ON "public"."users" USING gin ("a")')
    expect(buildCreateIndex(users, { name: 'i', columns: ['a'], unique: false, method: 'btree' }, 'postgresql'))
      .toBe('CREATE INDEX "i" ON "public"."users" ("a")')
    expect(() => buildCreateIndex(users, { name: 'i', columns: ['a'], unique: false, method: 'evil; drop' }, 'postgresql'))
      .toThrow(/Unknown index method/)
  })

  it('requires a name and at least one column', () => {
    expect(() => buildCreateIndex(users, { name: '  ', columns: ['a'], unique: false }, 'postgresql')).toThrow(/name/)
    expect(() => buildCreateIndex(users, { name: 'i', columns: [], unique: false }, 'postgresql')).toThrow(/column/)
  })
})

describe('buildCreateTrigger', () => {
  it('builds a PostgreSQL trigger that executes a function, appending () when missing', () => {
    expect(buildCreateTrigger(users, {
      name: 'audit', timing: 'AFTER', events: ['INSERT', 'UPDATE'], level: 'ROW', functionName: 'log_change',
    }, 'postgresql')).toBe('CREATE TRIGGER "audit"\nAFTER INSERT OR UPDATE ON "public"."users"\nFOR EACH ROW EXECUTE FUNCTION log_change()')
    expect(buildCreateTrigger(users, {
      name: 't', timing: 'BEFORE', events: ['DELETE'], level: 'STATEMENT', functionName: 'audit.log(1)',
    }, 'postgresql')).toContain('FOR EACH STATEMENT EXECUTE FUNCTION audit.log(1)')
    expect(() => buildCreateTrigger(users, { name: 't', timing: 'AFTER', events: ['INSERT'], level: 'ROW' }, 'postgresql'))
      .toThrow(/function/)
  })

  it('wraps inline bodies in BEGIN…END with a terminated last statement', () => {
    expect(buildCreateTrigger({ schema: null, name: 't', kind: 'table' }, {
      name: 'trg', timing: 'BEFORE', events: ['INSERT'], level: 'ROW', body: 'SET NEW.created_at = NOW()',
    }, 'mysql')).toBe('CREATE TRIGGER `trg`\nBEFORE INSERT ON `t`\nFOR EACH ROW\nBEGIN\nSET NEW.created_at = NOW();\nEND')
    expect(buildCreateTrigger({ schema: null, name: 't', kind: 'table' }, {
      name: 'trg', timing: 'AFTER', events: ['DELETE'], level: 'ROW', body: 'select 1;',
    }, 'sqlite')).toContain('BEGIN\nselect 1;\nEND')
  })

  it('builds SQL Server triggers with comma events and no FOR EACH clause', () => {
    expect(buildCreateTrigger(users, {
      name: 'trg', timing: 'AFTER', events: ['INSERT', 'DELETE'], level: 'STATEMENT', body: 'select 1',
    }, 'sqlserver')).toBe('CREATE TRIGGER [trg] ON [public].[users]\nAFTER INSERT, DELETE\nAS\nBEGIN\nselect 1;\nEND')
  })

  it('enforces the per-engine capability matrix', () => {
    expect(() => buildCreateTrigger(users, { name: 't', timing: 'INSTEAD OF', events: ['INSERT'], level: 'ROW', body: 'x' }, 'mysql'))
      .toThrow(/not supported/)
    expect(() => buildCreateTrigger(users, { name: 't', timing: 'BEFORE', events: ['INSERT', 'UPDATE'], level: 'ROW', body: 'x' }, 'sqlite'))
      .toThrow(/one event/)
    expect(() => buildCreateTrigger(users, { name: 't', timing: 'AFTER', events: ['INSERT'], level: 'ROW', body: 'x' }, 'sqlserver'))
      .toThrow(/FOR EACH ROW/)
    expect(triggerCapabilities('mysql').multiEvent).toBe(false)
    expect(triggerCapabilities('postgresql').usesFunction).toBe(true)
    expect(triggerCapabilities('postgresql').timings).not.toContain('INSTEAD OF')
    expect(triggerCapabilities('sqlite').timings).not.toContain('INSTEAD OF')
    expect(triggerCapabilities('sqlserver').timings).toContain('INSTEAD OF')
  })
})

describe('buildAddPartition', () => {
  it('creates a PostgreSQL child partition in the parent schema', () => {
    expect(buildAddPartition(users, { name: 'users_2026', bounds: "FROM ('2026-01-01') TO ('2027-01-01')" }, 'postgresql'))
      .toBe(`CREATE TABLE "public"."users_2026" PARTITION OF "public"."users" FOR VALUES FROM ('2026-01-01') TO ('2027-01-01')`)
    expect(buildAddPartition(users, { name: 'users_default', bounds: 'DEFAULT' }, 'postgresql'))
      .toBe('CREATE TABLE "public"."users_default" PARTITION OF "public"."users" DEFAULT')
    // A pasted FOR VALUES prefix is tolerated, not doubled.
    expect(buildAddPartition(users, { name: 'p1', bounds: 'FOR VALUES IN (1, 2)' }, 'postgresql'))
      .toBe('CREATE TABLE "public"."p1" PARTITION OF "public"."users" FOR VALUES IN (1, 2)')
  })

  it('emits ALTER TABLE … ADD PARTITION on MySQL and refuses other engines', () => {
    expect(buildAddPartition({ schema: null, name: 'events', kind: 'table' }, { name: 'p2027', bounds: 'VALUES LESS THAN (2027)' }, 'mysql'))
      .toBe('ALTER TABLE `events` ADD PARTITION (PARTITION `p2027` VALUES LESS THAN (2027))')
    expect(() => buildAddPartition(users, { name: 'p', bounds: 'x' }, 'sqlserver')).toThrow(/not supported/)
    expect(() => buildAddPartition(users, { name: 'p', bounds: '' }, 'mysql')).toThrow(/bounds/)
  })
})

describe('buildAddForeignKey', () => {
  it('builds a FK with matching column lists and referential actions', () => {
    expect(buildAddForeignKey(users, {
      name: 'fk_orders_user', columns: ['user_id'], refTable: 'public.orders', refColumns: ['id'],
      onDelete: 'CASCADE', onUpdate: 'NO ACTION',
    }, 'postgresql')).toBe(
      'ALTER TABLE "public"."users" ADD CONSTRAINT "fk_orders_user" FOREIGN KEY ("user_id") REFERENCES "public"."orders" ("id") ON DELETE CASCADE',
    )
    // NO ACTION is the default and is omitted; MSSQL brackets the qualified ref.
    expect(buildAddForeignKey(users, {
      name: 'fk', columns: ['a', 'b'], refTable: 'dbo.other', refColumns: ['x', 'y'],
    }, 'sqlserver')).toBe(
      'ALTER TABLE [public].[users] ADD CONSTRAINT [fk] FOREIGN KEY ([a], [b]) REFERENCES [dbo].[other] ([x], [y])',
    )
  })

  it('drops referential actions an engine rejects', () => {
    // MySQL has no SET DEFAULT; it must not appear in the emitted SQL.
    expect(buildAddForeignKey({ schema: null, name: 't', kind: 'table' }, {
      name: 'fk', columns: ['a'], refTable: 'other', refColumns: ['id'], onDelete: 'SET DEFAULT',
    }, 'mysql')).toBe('ALTER TABLE `t` ADD CONSTRAINT `fk` FOREIGN KEY (`a`) REFERENCES `other` (`id`)')
    expect(foreignKeyActions('mysql')).not.toContain('SET DEFAULT')
    expect(foreignKeyActions('sqlserver')).not.toContain('RESTRICT')
  })

  it('validates counts and refuses SQLite', () => {
    expect(() => buildAddForeignKey(users, { name: 'fk', columns: ['a'], refTable: 't', refColumns: ['x', 'y'] }, 'postgresql'))
      .toThrow(/match in count/)
    expect(() => buildAddForeignKey(users, { name: '', columns: ['a'], refTable: 't', refColumns: ['x'] }, 'postgresql'))
      .toThrow(/name/)
    expect(() => buildAddForeignKey({ schema: null, name: 't', kind: 'table' }, { name: 'fk', columns: ['a'], refTable: 'o', refColumns: ['id'] }, 'sqlite'))
      .toThrow(/SQLite/)
    expect(canAddConstraint('sqlite')).toBe(false)
    expect(canAddConstraint('mysql')).toBe(true)
  })
})

describe('buildAddConstraint', () => {
  it('builds CHECK and UNIQUE constraints', () => {
    expect(buildAddConstraint(users, { name: 'age_positive', type: 'CHECK', expression: 'age > 0' }, 'postgresql'))
      .toBe('ALTER TABLE "public"."users" ADD CONSTRAINT "age_positive" CHECK (age > 0)')
    expect(buildAddConstraint({ schema: null, name: 't', kind: 'table' }, { name: 'uq_email', type: 'UNIQUE', columns: ['email', 'tenant'] }, 'mysql'))
      .toBe('ALTER TABLE `t` ADD CONSTRAINT `uq_email` UNIQUE (`email`, `tenant`)')
  })

  it('validates by type and refuses SQLite', () => {
    expect(() => buildAddConstraint(users, { name: 'c', type: 'CHECK', expression: '' }, 'postgresql')).toThrow(/expression/)
    expect(() => buildAddConstraint(users, { name: 'c', type: 'UNIQUE', columns: [] }, 'postgresql')).toThrow(/column/)
    expect(() => buildAddConstraint(users, { name: 'c', type: 'CHECK', expression: 'x > 0' }, 'sqlite')).toThrow(/SQLite/)
  })
})
