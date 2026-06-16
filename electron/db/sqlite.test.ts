import { describe, expect, it } from 'vitest'
import type { ConnectionProfile } from '../../src/electron'
import { MAX_RESULT_ROWS } from './driver'
import { createSqliteDriver } from './sqlite'

// Fields the sqlite driver reads; the rest of the profile is filler so the type compiles.
const sqliteProfile = (file: string): ConnectionProfile => ({
  id: 'test',
  name: 'test',
  engine: 'sqlite',
  host: '',
  port: '',
  username: '',
  password: '',
  database: '',
  file,
  folder: '',
})

const memoryDriver = async () => {
  const driver = createSqliteDriver(sqliteProfile(':memory:'))
  await driver.connect()
  return driver
}

describe('sqlite driver: connect / disconnect', () => {
  it('refuses an empty file path', async () => {
    await expect(createSqliteDriver(sqliteProfile('')).connect()).rejects.toThrow('Choose a database file first.')
  })

  it('refuses a whitespace-only file path', async () => {
    await expect(createSqliteDriver(sqliteProfile('   ')).connect()).rejects.toThrow('Choose a database file first.')
  })

  it('fails eagerly when the file cannot be opened', async () => {
    await expect(createSqliteDriver(sqliteProfile('/no/such/dir/x.db')).connect()).rejects.toThrow()
  })

  it('connects in-memory and reports the engine version', async () => {
    const version = await createSqliteDriver(sqliteProfile(':memory:')).connect()
    expect(version).toMatch(/^SQLite \d+\.\d+/)
  })

  it('rejects work after disconnect', async () => {
    const driver = await memoryDriver()
    await driver.disconnect()
    await expect(driver.query('select 1')).rejects.toThrow('Not connected')
    await expect(driver.listTables()).rejects.toThrow('Not connected')
    await expect(driver.listColumns()).rejects.toThrow('Not connected')
    await expect(driver.inspectTable({ schema: null, name: 't', kind: 'table' })).rejects.toThrow('Not connected')
  })

  it('closes the prior handle and reopens on reconnect', async () => {
    const driver = createSqliteDriver(sqliteProfile(':memory:'))
    await driver.connect()
    await driver.query('create table t(a)')
    // A fresh :memory: database — the reconnect replaced the old handle, so
    // the earlier table is gone (and the old handle was closed, not leaked).
    await driver.connect()
    expect(await driver.listTables()).toEqual([])
  })

  it('disconnect is a no-op before connect', async () => {
    await expect(createSqliteDriver(sqliteProfile(':memory:')).disconnect()).resolves.toBeUndefined()
  })

  it('does not advertise server-oriented capabilities', () => {
    const driver = createSqliteDriver(sqliteProfile(':memory:'))
    expect(driver.cancel).toBeUndefined()
    expect(driver.listObjects).toBeUndefined()
    expect(driver.inspectObject).toBeUndefined()
    expect(driver.inspectServer).toBeUndefined()
    expect(driver.children).toBeUndefined()
    expect(driver.createDatabase).toBeUndefined()
    expect(driver.dropDatabase).toBeUndefined()
    expect(driver.useChild).toBeUndefined()
  })
})

describe('sqlite driver: query', () => {
  it('returns columns, rows, rowCount and a duration for a select', async () => {
    const driver = await memoryDriver()
    await driver.query('create table t(a, b)')
    await driver.query('insert into t values (1, 2), (3, 4)')

    const result = await driver.query('select a, b from t order by a')
    expect(result.columns).toEqual(['a', 'b'])
    expect(result.rows).toEqual([
      [1, 2],
      [3, 4],
    ])
    expect(result.rowCount).toBe(2)
    expect(result.truncated).toBe(false)
    expect(typeof result.durationMs).toBe('number')
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('binds positional parameters', async () => {
    const driver = await memoryDriver()
    const result = await driver.query('select ? as x, ? as y', [7, 'hi'])
    expect(result.columns).toEqual(['x', 'y'])
    expect(result.rows).toEqual([[7, 'hi']])
  })

  it('returns an empty row set when a select matches nothing', async () => {
    const driver = await memoryDriver()
    await driver.query('create table t(a)')
    const result = await driver.query('select a from t')
    expect(result.columns).toEqual(['a'])
    expect(result.rows).toEqual([])
    expect(result.rowCount).toBe(0)
    expect(result.truncated).toBe(false)
  })

  it('reports affected-row count for writes (no result columns)', async () => {
    const driver = await memoryDriver()
    await driver.query('create table t(a)')
    await driver.query('insert into t values (1), (2), (3)')
    const result = await driver.query('delete from t where a > 1')
    expect(result.columns).toEqual([])
    expect(result.rows).toEqual([])
    expect(result.rowCount).toBe(2)
  })

  it('preserves duplicate column values via setReturnArrays', async () => {
    const driver = await memoryDriver()
    const result = await driver.query('select 1 as id, 2 as id')
    expect(result.columns).toEqual(['id', 'id'])
    expect(result.rows).toEqual([[1, 2]])
  })

  it('caps retained rows at MAX_RESULT_ROWS but counts them all', async () => {
    const driver = await memoryDriver()
    await driver.query('create table nums(n)')
    await driver.query(
      `with recursive seq(n) as (select 1 union all select n + 1 from seq where n < ${MAX_RESULT_ROWS + 25})
       insert into nums select n from seq`,
    )

    const result = await driver.query('select n from nums')
    expect(result.rows).toHaveLength(MAX_RESULT_ROWS)
    expect(result.rowCount).toBe(MAX_RESULT_ROWS + 25)
    expect(result.truncated).toBe(true)
  })

  it('does not flag exactly MAX_RESULT_ROWS as truncated', async () => {
    const driver = await memoryDriver()
    await driver.query('create table nums(n)')
    await driver.query(
      `with recursive seq(n) as (select 1 union all select n + 1 from seq where n < ${MAX_RESULT_ROWS})
       insert into nums select n from seq`,
    )

    const result = await driver.query('select n from nums')
    expect(result.rows).toHaveLength(MAX_RESULT_ROWS)
    expect(result.rowCount).toBe(MAX_RESULT_ROWS)
    expect(result.truncated).toBe(false)
  })

  it('surfaces SQL errors', async () => {
    const driver = await memoryDriver()
    await expect(driver.query('select * from missing')).rejects.toThrow(/no such table|missing/i)
  })
})

describe('sqlite driver: listTables', () => {
  it('is empty for a fresh database', async () => {
    const driver = await memoryDriver()
    expect(await driver.listTables()).toEqual([])
  })

  it('lists tables and views sorted by name with a null schema', async () => {
    const driver = await memoryDriver()
    await driver.query('create table beta(a)')
    await driver.query('create table alpha(a)')
    await driver.query('create view gamma as select a from alpha')

    expect(await driver.listTables()).toEqual([
      { schema: null, name: 'alpha', kind: 'table' },
      { schema: null, name: 'beta', kind: 'table' },
      { schema: null, name: 'gamma', kind: 'view' },
    ])
  })

  it('excludes internal sqlite_* tables', async () => {
    const driver = await memoryDriver()
    // AUTOINCREMENT spawns the internal sqlite_sequence table.
    await driver.query('create table t(id integer primary key autoincrement, v)')
    await driver.query('insert into t(v) values (1)')

    expect((await driver.listTables()).map((table) => table.name)).toEqual(['t'])
  })
})

describe('sqlite driver: listColumns', () => {
  it('reports type, nullability and key flags across every table, ordered', async () => {
    const driver = await memoryDriver()
    await driver.query('create table parent(id integer primary key, name text not null)')
    await driver.query('create table child(id integer primary key, parent_id integer references parent(id), note text)')

    expect(await driver.listColumns()).toEqual([
      { schema: null, table: 'child', name: 'id', dataType: 'INTEGER', nullable: true, primaryKey: true, foreignKey: false },
      { schema: null, table: 'child', name: 'parent_id', dataType: 'INTEGER', nullable: true, primaryKey: false, foreignKey: true },
      { schema: null, table: 'child', name: 'note', dataType: 'TEXT', nullable: true, primaryKey: false, foreignKey: false },
      { schema: null, table: 'parent', name: 'id', dataType: 'INTEGER', nullable: true, primaryKey: true, foreignKey: false },
      { schema: null, table: 'parent', name: 'name', dataType: 'TEXT', nullable: false, primaryKey: false, foreignKey: false },
    ])
  })

  it('defaults a missing column type to "any" and includes view columns', async () => {
    const driver = await memoryDriver()
    await driver.query('create table untyped(x)')
    await driver.query('create view v as select x as y from untyped')

    const columns = await driver.listColumns()
    expect(columns.find((c) => c.table === 'untyped' && c.name === 'x')?.dataType).toBe('any')
    expect(columns.some((c) => c.table === 'v' && c.name === 'y')).toBe(true)
  })
})

describe('sqlite driver: inspectTable', () => {
  it('returns columns with type, nullability, default and primary key; no sections when there are none', async () => {
    const driver = await memoryDriver()
    await driver.query('create table t(id integer primary key, a integer default 5, b text not null)')

    const inspection = await driver.inspectTable({ schema: null, name: 't', kind: 'table' })
    expect(inspection.columns).toEqual([
      { name: 'id', dataType: 'INTEGER', nullable: true, default: null, primaryKey: true },
      { name: 'a', dataType: 'INTEGER', nullable: true, default: '5', primaryKey: false },
      { name: 'b', dataType: 'TEXT', nullable: false, default: null, primaryKey: false },
    ])
    expect(inspection.sections).toEqual([])
  })

  it('groups foreign keys, indexes and triggers into non-empty sections', async () => {
    const driver = await memoryDriver()
    await driver.query('create table parent(id integer primary key, name text not null)')
    await driver.query('create table child(id integer primary key, parent_id integer references parent(id), note text)')
    await driver.query('create index idx_note on child(note)')
    await driver.query("create trigger trg after insert on child begin update parent set name='x'; end")

    const inspection = await driver.inspectTable({ schema: null, name: 'child', kind: 'table' })
    expect(inspection.columns).toEqual([
      { name: 'id', dataType: 'INTEGER', nullable: true, default: null, primaryKey: true },
      { name: 'parent_id', dataType: 'INTEGER', nullable: true, default: null, primaryKey: false },
      { name: 'note', dataType: 'TEXT', nullable: true, default: null, primaryKey: false },
    ])
    expect(inspection.sections).toEqual([
      {
        title: 'Foreign Keys',
        rows: [{ name: 'parent_id', definition: 'REFERENCES parent(id) ON UPDATE NO ACTION ON DELETE NO ACTION' }],
      },
      { title: 'Indexes', rows: [{ name: 'idx_note', definition: 'CREATE INDEX idx_note on child(note)' }] },
      {
        title: 'Triggers',
        rows: [{ name: 'trg', definition: "CREATE TRIGGER trg after insert on child begin update parent set name='x'; end" }],
      },
    ])
  })

  it('falls back to rowid for an implicit foreign-key target', async () => {
    const driver = await memoryDriver()
    await driver.query('create table parent(id integer primary key, name text)')
    await driver.query('create table c2(pid references parent)')

    const inspection = await driver.inspectTable({ schema: null, name: 'c2', kind: 'table' })
    expect(inspection.sections).toEqual([
      {
        title: 'Foreign Keys',
        rows: [{ name: 'pid', definition: 'REFERENCES parent(rowid) ON UPDATE NO ACTION ON DELETE NO ACTION' }],
      },
    ])
  })

  it('labels auto-created indexes behind UNIQUE/PK constraints', async () => {
    const driver = await memoryDriver()
    await driver.query('create table uq(a unique)')

    const inspection = await driver.inspectTable({ schema: null, name: 'uq', kind: 'table' })
    expect(inspection.sections).toEqual([
      { title: 'Indexes', rows: [{ name: 'sqlite_autoindex_uq_1', definition: '(auto: unique/primary key)' }] },
    ])
  })
})
